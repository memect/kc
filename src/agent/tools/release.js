import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseTool, ToolResult } from "./base.js";
import { SnapshotTool } from "./snapshot.js";
import { normalizeRuleCatalog } from "../rule-catalog-normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "../../../template/release-runtime");

/**
 * Bundle the current workspace into a portable, self-contained release for
 * end users. The bundle has no kc-beta dependency — anyone with Python +
 * a worker LLM API key can run `python run.py <doc>`.
 *
 * Sequence:
 *   1. Snapshot the workspace (git tag + snapshots/<slug>/snapshot.json)
 *   2. Read rules/catalog.json, filter by `include` if given
 *   3. For each rule, find the latest workflow under workflows/<rule_id>/
 *   4. Build output/releases/<slug>/ from template/release-runtime/ + workspace
 *      artifacts (workflows, glossary, catalog, corner_cases, calibration, models)
 *   5. Write manifest.json + auto-generated README.md
 *   6. Optionally include KC-selected fixtures from samples/
 */
export class ReleaseTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {object} [opts]
   * @param {string} [opts.kcVersion]
   */
  constructor(workspace, { kcVersion = "0.5.1" } = {}) {
    super();
    this._workspace = workspace;
    this._snapshot = new SnapshotTool(workspace);
    this._kcVersion = kcVersion;
  }

  get name() { return "release"; }

  get description() {
    return (
      "Bundle the current workspace into a portable release at " +
      "output/releases/<slug>/. The bundle is self-contained — anyone with " +
      "Python 3 and a worker LLM API key can run it via `python run.py <doc>`. " +
      "Snapshots the workspace as a git tag (snap/release-<slug>) for reproducibility. " +
      "Use when workflows have met accuracy thresholds and the system is ready " +
      "to be handed off to end users or deployed for production runs."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Human-readable release name, e.g. 'v1' or 'q2-2026'. Slugified for the directory name.",
        },
        notes: {
          type: "string",
          description: "Optional release notes embedded in the manifest and README.",
        },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Optional rule-id allowlist. Default: all rules in catalog.json.",
        },
        fixtures: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of sample file paths (relative to samples/ or project) to bundle as fixtures/. KC should pick 1-3 representative samples.",
        },
      },
      required: ["label"],
    };
  }

  async execute(input) {
    const label = (input.label || "").trim();
    if (!label) return new ToolResult("label required", true);
    const slug = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) return new ToolResult("label produced empty slug", true);

    if (!fs.existsSync(TEMPLATE_DIR)) {
      return new ToolResult(`release template missing at ${TEMPLATE_DIR}`, true);
    }

    // 1. Snapshot first — locks in commit + tag, regardless of whether bundle build succeeds
    const snapResult = await this._snapshot.execute({
      label: `release-${slug}`,
      notes: `Release ${label} bundle source`,
    });
    if (snapResult.isError) return new ToolResult(`snapshot failed: ${snapResult.content}`, true);
    const { tag: snapshotTag, commit: snapshotCommit } = this._readSnapshotMeta(`release-${slug}`);

    // 2. Read catalog and filter
    const catalogPath = path.join(this._workspace.cwd, "rules", "catalog.json");
    if (!fs.existsSync(catalogPath)) {
      return new ToolResult("rules/catalog.json not found — extract rules before releasing", true);
    }
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); }
    catch (e) { return new ToolResult(`catalog.json invalid: ${e.message}`, true); }
    catalog = normalizeRuleCatalog(catalog);

    const includeSet = Array.isArray(input.include) && input.include.length > 0
      ? new Set(input.include) : null;
    const selectedRules = catalog.filter((r) => !includeSet || includeSet.has(r.id));
    if (selectedRules.length === 0) {
      return new ToolResult("no rules selected for release (empty catalog or include filter matched nothing)", true);
    }

    // 3. Build bundle dir
    const bundleRel = path.join("output", "releases", slug);
    const bundleAbs = this._workspace.resolvePath(bundleRel);
    fs.mkdirSync(bundleAbs, { recursive: true });

    // Copy Python runtime (run.py, render_dashboard.py, serve.sh, kc_runtime/)
    this._copyDir(TEMPLATE_DIR, bundleAbs, { exclude: ["README.md.tmpl"] });
    // Make .py executable, .sh executable
    this._chmodPlusX(path.join(bundleAbs, "run.py"));
    this._chmodPlusX(path.join(bundleAbs, "render_dashboard.py"));
    this._chmodPlusX(path.join(bundleAbs, "serve.sh"));

    // 4. Per-rule workflows
    const ruleEntries = [];
    const missingWorkflows = [];
    for (const rule of selectedRules) {
      const ruleId = rule.id;
      const found = this._findLatestWorkflow(ruleId);
      if (!found) {
        missingWorkflows.push(ruleId);
        continue;
      }
      const destRuleDir = path.join(bundleAbs, "workflows", ruleId);
      fs.mkdirSync(destRuleDir, { recursive: true });
      // Copy the workflow file
      const wfFile = path.basename(found);
      fs.copyFileSync(found, path.join(destRuleDir, wfFile));
      this._chmodPlusX(path.join(destRuleDir, wfFile));
      // Copy prompts/ if present
      const promptsDir = path.join(this._workspace.cwd, "workflows", ruleId, "prompts");
      if (fs.existsSync(promptsDir) && fs.statSync(promptsDir).isDirectory()) {
        this._copyDir(promptsDir, path.join(destRuleDir, "prompts"));
      }
      ruleEntries.push({
        id: ruleId,
        title: rule.title || rule.description || "",
        workflow: `workflows/${ruleId}/${wfFile}`,
      });
    }

    if (ruleEntries.length === 0) {
      return new ToolResult(
        `no workflows found for any selected rule. Missing: ${missingWorkflows.join(", ")}`,
        true,
      );
    }

    // 5. Frozen workspace artifacts
    this._copyIfExists(catalogPath, path.join(bundleAbs, "catalog.json"));
    this._copyIfExists(path.join(this._workspace.cwd, "rules", "glossary.json"),
                       path.join(bundleAbs, "glossary.json"), { fallback: '{"version":1,"entries":[]}\n' });
    this._copyIfExists(path.join(this._workspace.cwd, "corner_cases.json"),
                       path.join(bundleAbs, "corner_cases.json"), { fallback: '[]\n' });
    this._copyIfExists(path.join(this._workspace.cwd, "confidence_calibration.json"),
                       path.join(bundleAbs, "confidence_calibration.json"),
                       { fallback: '{"historical_accuracy":{}}\n' });

    // 6. models.json — pull tier mappings from workspace .env (worker tiers)
    const models = this._readWorkerTiers();
    fs.writeFileSync(path.join(bundleAbs, "models.json"),
      JSON.stringify(models, null, 2) + "\n", "utf-8");

    // 7. Optional fixtures
    const fixtures = Array.isArray(input.fixtures) ? input.fixtures : [];
    const bundledFixtures = [];
    if (fixtures.length > 0) {
      const fixDir = path.join(bundleAbs, "fixtures");
      fs.mkdirSync(fixDir, { recursive: true });
      for (const f of fixtures) {
        const src = this._resolveFixture(f);
        if (!src) continue;
        const dst = path.join(fixDir, path.basename(src));
        fs.copyFileSync(src, dst);
        bundledFixtures.push(path.basename(src));
      }
    }

    // 8. Manifest
    const manifest = {
      label,
      slug,
      snapshot_tag: snapshotTag,
      snapshot_commit: snapshotCommit,
      created_at: new Date().toISOString(),
      notes: input.notes || "",
      rules: ruleEntries,
      models,
      fixtures: bundledFixtures,
      kc_beta_version: this._kcVersion,
    };
    fs.writeFileSync(path.join(bundleAbs, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n", "utf-8");

    // 9. README from template
    const readmeTmpl = fs.readFileSync(path.join(TEMPLATE_DIR, "README.md.tmpl"), "utf-8");
    const rulesList = ruleEntries.map((r) => `- \`${r.id}\` — ${r.title || "(no title)"}`).join("\n");
    const notesBlock = input.notes ? `> ${input.notes}\n` : "";
    const readme = readmeTmpl
      .replace(/\{LABEL\}/g, label)
      .replace(/\{SLUG\}/g, slug)
      .replace(/\{CREATED_AT\}/g, manifest.created_at)
      .replace(/\{SNAPSHOT_TAG\}/g, snapshotTag || "(no tag — git unavailable)")
      .replace(/\{SNAPSHOT_COMMIT\}/g, snapshotCommit || "(unknown)")
      .replace(/\{KC_VERSION\}/g, this._kcVersion)
      .replace(/\{NOTES_BLOCK\}/g, notesBlock)
      .replace(/\{RULES_LIST\}/g, rulesList);
    fs.writeFileSync(path.join(bundleAbs, "README.md"), readme, "utf-8");

    // Bundle dir is in output/ (gitignored). Snapshot manifest in snapshots/ IS tracked.
    const lines = [
      `Release '${label}' bundled at ${bundleRel}`,
      `  rules included: ${ruleEntries.length}` +
        (missingWorkflows.length ? ` (skipped, no workflow: ${missingWorkflows.join(", ")})` : ""),
      `  snapshot tag:   ${snapshotTag || "(none)"}`,
      `  fixtures:       ${bundledFixtures.length > 0 ? bundledFixtures.join(", ") : "(none)"}`,
      ``,
      `Run from anywhere:`,
      `  LLM_API_KEY=... TIER1=... python ${bundleRel}/run.py <doc>`,
      `Open dashboards:`,
      `  ${bundleRel}/serve.sh && open http://localhost:8080/`,
      ``,
      `Not in this release: HTTP serve framework, batch processor, sandboxing.`,
      `Bundle is regenerable from the snapshot tag (output/releases/ is gitignored).`,
    ];
    return new ToolResult(lines.join("\n"));
  }

  // --- helpers ---

  _readSnapshotMeta(slug) {
    const p = path.join(this._workspace.cwd, "snapshots", slug, "snapshot.json");
    if (!fs.existsSync(p)) return { tag: null, commit: null };
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      return { tag: d.tag || null, commit: d.commit || null };
    } catch {
      return { tag: null, commit: null };
    }
  }

  _findLatestWorkflow(ruleId) {
    const wfDir = path.join(this._workspace.cwd, "workflows", ruleId);
    if (!fs.existsSync(wfDir) || !fs.statSync(wfDir).isDirectory()) return null;
    const entries = fs.readdirSync(wfDir).sort();
    const versioned = entries.filter((f) => /^workflow_v\d+\.py$/.test(f));
    if (versioned.length > 0) return path.join(wfDir, versioned[versioned.length - 1]);
    const any = entries.find((f) => f.endsWith(".py") && f.toLowerCase().includes("workflow"));
    if (any) return path.join(wfDir, any);
    const py = entries.find((f) => f.endsWith(".py"));
    return py ? path.join(wfDir, py) : null;
  }

  _resolveFixture(rel) {
    // Try samples/ first (workspace, then project), then plain workspace path
    const candidates = [];
    candidates.push(path.join(this._workspace.cwd, "samples", rel));
    if (this._workspace.projectDir) {
      candidates.push(path.join(this._workspace.projectDir, "samples", rel));
      candidates.push(path.join(this._workspace.projectDir, rel));
    }
    candidates.push(path.join(this._workspace.cwd, rel));
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  }

  _readWorkerTiers() {
    const envPath = path.join(this._workspace.cwd, ".env");
    const out = { tier1: "", tier2: "", tier3: "", tier4: "" };
    if (!fs.existsSync(envPath)) return out;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      for (const t of ["TIER1", "TIER2", "TIER3", "TIER4"]) {
        if (line.startsWith(`${t}=`)) {
          out[t.toLowerCase()] = line.split("=").slice(1).join("=").trim();
        }
      }
    }
    return out;
  }

  _copyDir(src, dst, { exclude = [] } = {}) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (exclude.includes(entry.name)) continue;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        this._copyDir(srcPath, dstPath, { exclude });
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  _copyIfExists(src, dst, { fallback = null } = {}) {
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    } else if (fallback !== null) {
      fs.writeFileSync(dst, fallback, "utf-8");
    }
  }

  _chmodPlusX(p) {
    try {
      const stat = fs.statSync(p);
      fs.chmodSync(p, stat.mode | 0o111);
    } catch { /* file may not exist; ignore */ }
  }
}
