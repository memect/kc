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
      // v0.7.0 #98: actionable error. The previous "no workflows found
      // for any selected rule" message left agents confused (E2E #5 GLM
      // dismissed it with "不影响系统功能" and shipped anyway, with a
      // broken bundle). Spell out the canonical layout, the accepted
      // alternatives, and where the agent's actual files are.
      return new ToolResult(
        `Release tool found no workflows for the selected rules.\n\n` +
        `Missing: ${missingWorkflows.slice(0, 10).join(", ")}` +
        (missingWorkflows.length > 10 ? ` (+ ${missingWorkflows.length - 10} more)` : "") + "\n\n" +
        `Accepted layouts (release tool checks all three):\n` +
        `  workflows/<ruleId>/workflow_v1.py    (canonical)\n` +
        `  workflows/<ruleId>_workflow.py       (flat)\n` +
        `  workflows/<ruleId>.json              (regex_skill manifest with .entry path)\n\n` +
        `If your workflow files exist under a different layout, either ` +
        `relocate them or write a workflows/<ruleId>.json manifest pointing ` +
        `at the actual file. Do NOT ship the release without workflows — ` +
        `the run.py harness needs them at runtime.`,
        true,
      );
    }

    // 5. Frozen workspace artifacts
    this._copyIfExists(catalogPath, path.join(bundleAbs, "catalog.json"));
    this._copyIfExists(path.join(this._workspace.cwd, "rules", "glossary.json"),
                       path.join(bundleAbs, "glossary.json"), { fallback: '{"version":1,"entries":[]}\n' });
    this._copyIfExists(path.join(this._workspace.cwd, "corner_cases.json"),
                       path.join(bundleAbs, "corner_cases.json"), { fallback: '[]\n' });
    // v0.7.2 1c: auto-aggregate from output/ if no calibration file at
    // workspace root. Both v0.7.1 audit runs (DS + GLM) shipped releases
    // with empty `historical_accuracy: {}` despite having per-rule QC
    // data on disk under output/ — the release tool just passed the
    // file through and emitted a stub on miss. We try to populate from
    // known QC artifact shapes here; if nothing matches, fall through
    // to the existing stub fallback.
    const calibSrc = path.join(this._workspace.cwd, "confidence_calibration.json");
    if (!fs.existsSync(calibSrc)) {
      const aggregated = this._aggregateAccuracyFromOutput();
      if (aggregated && Object.keys(aggregated.historical_accuracy).length > 0) {
        fs.writeFileSync(calibSrc, JSON.stringify(aggregated, null, 2) + "\n", "utf-8");
      }
    }
    this._copyIfExists(calibSrc,
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

    // v0.7.2 1d: clean up the template scaffold dir if a customized
    // release was just written alongside it. Both v0.7.1 audit runs
    // shipped with `output/releases/v1/` (template-derived, .tmpl
    // files lingering) AND `output/releases/v1-0/` (or v1-0-hybrid/)
    // — the customized release. The pre-scaffold is meant as a hint;
    // once the agent calls `release(label="v1-0")` and we've written
    // the real bundle, the unedited scaffold is just clutter.
    //
    // Conservative gate: only delete a sibling `v1/` if BOTH (a) we
    // didn't just write to v1/ ourselves, AND (b) it still contains
    // .tmpl files (signature of unedited template). If the agent
    // intentionally edited v1/ in place (removing .tmpl), our cleanup
    // leaves it alone.
    if (slug !== "v1") {
      const tmplScaffold = path.join(this._workspace.resolvePath(path.join("output", "releases")), "v1");
      if (fs.existsSync(tmplScaffold) && fs.statSync(tmplScaffold).isDirectory()) {
        let hasTmpl = false;
        try { hasTmpl = fs.readdirSync(tmplScaffold).some((f) => f.endsWith(".tmpl")); } catch { /* ignore */ }
        if (hasTmpl) {
          try { fs.rmSync(tmplScaffold, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
    }

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
    // Canonical: workflows/<ruleId>/workflow_v#.py (subdirectory layout)
    const wfDir = path.join(this._workspace.cwd, "workflows", ruleId);
    if (fs.existsSync(wfDir) && fs.statSync(wfDir).isDirectory()) {
      const entries = fs.readdirSync(wfDir).sort();
      const versioned = entries.filter((f) => /^workflow_v\d+\.py$/.test(f));
      if (versioned.length > 0) return path.join(wfDir, versioned[versioned.length - 1]);
      const any = entries.find((f) => f.endsWith(".py") && f.toLowerCase().includes("workflow"));
      if (any) return path.join(wfDir, any);
      const py = entries.find((f) => f.endsWith(".py"));
      if (py) return path.join(wfDir, py);
    }

    // v0.7.0 #98: fall back to flat layouts seen in E2E #5 — both DS
    // and GLM produced workflows that release.js's strict per-dir check
    // missed. Accept these so the release tool actually packages the
    // agent's work instead of returning "no workflows found".
    const flatRoot = path.join(this._workspace.cwd, "workflows");
    if (fs.existsSync(flatRoot)) {
      // GLM-style flat: workflows/R001_workflow.py
      const flat = path.join(flatRoot, `${ruleId}_workflow.py`);
      if (fs.existsSync(flat) && fs.statSync(flat).isFile()) return flat;
      // DS-style manifest: workflows/R001.json (regex_skill pointer)
      const manifest = path.join(flatRoot, `${ruleId}.json`);
      if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
        try {
          const data = JSON.parse(fs.readFileSync(manifest, "utf-8"));
          if (data?.entry) {
            const entryPath = path.isAbsolute(data.entry)
              ? data.entry
              : path.join(this._workspace.cwd, data.entry);
            if (fs.existsSync(entryPath)) return entryPath;
          }
        } catch { /* manifest unreadable; skip */ }
      }
    }
    return null;
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

  // v0.7.2 1c: walk output/ for QC artifacts and aggregate per-rule
  // accuracy. Recognized shapes (covering DS + GLM v0.7.1 audit runs):
  //
  //   rule_stats_v*.json — {<rule_id>: {PASS: N, FAIL: N, NOT_APPLICABLE: N, ERROR: N}}
  //     (GLM produced 4 versions; pick the highest)
  //   full_test_results_v*.json — {<sample_id>: {results: {<rule_id>: {verdict}}}}
  //     (GLM; accumulate verdicts per rule across samples)
  //   skill_test_*.json — {<doc_name>: {<rule_id>: bool}} (DS shape)
  //
  // Returns null if no recognized artifact, or an object with
  //   { historical_accuracy: {<rule_id>: {pass_rate, n_samples, ...}}, computed_at, source_files }
  // suitable for confidence_calibration.json.
  _aggregateAccuracyFromOutput() {
    const ruleIdShape = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
    const isRuleId = (s) => typeof s === "string" && ruleIdShape.test(s) && /\d/.test(s);
    const tally = new Map();  // rule_id -> {pass, fail, na, n}
    const sourceFiles = [];
    const bump = (rid, kind) => {
      if (!isRuleId(rid)) return;
      const t = tally.get(rid) || { pass: 0, fail: 0, na: 0, n: 0 };
      t[kind] += 1;
      t.n += 1;
      tally.set(rid, t);
    };
    const outputDir = path.join(this._workspace.cwd, "output");
    if (!fs.existsSync(outputDir)) return null;

    // Collect all .json files under output/ (depth limited)
    const files = [];
    const stack = [{ dir: outputDir, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "__pycache__") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 6) stack.push({ dir: p, depth: depth + 1 });
        } else if (e.isFile() && e.name.endsWith(".json")) {
          files.push({ path: p, name: e.name });
        }
      }
    }

    // 1) Prefer rule_stats_v<N>.json (highest version) — direct counts
    const ruleStatsFiles = files
      .filter((f) => /^rule_stats(?:_v\d+)?\.json$/i.test(f.name))
      .map((f) => ({ ...f, ver: (f.name.match(/_v(\d+)/) || [0, 0])[1] | 0 }))
      .sort((a, b) => b.ver - a.ver);
    if (ruleStatsFiles.length > 0) {
      const top = ruleStatsFiles[0];
      try {
        const d = JSON.parse(fs.readFileSync(top.path, "utf-8"));
        for (const [rid, stats] of Object.entries(d)) {
          if (!isRuleId(rid) || !stats || typeof stats !== "object") continue;
          const pass = stats.PASS | 0, fail = stats.FAIL | 0;
          const na = stats.NOT_APPLICABLE | stats.NA | 0;
          const t = tally.get(rid) || { pass: 0, fail: 0, na: 0, n: 0 };
          t.pass += pass; t.fail += fail; t.na += na; t.n += pass + fail + na;
          tally.set(rid, t);
        }
        sourceFiles.push(path.relative(this._workspace.cwd, top.path));
      } catch { /* fall through to other shapes */ }
    }

    // 2) Fallback: full_test_results*.json with nested {sample_id: {results: {rid: {verdict}}}}
    if (tally.size === 0) {
      const ftrFiles = files
        .filter((f) => /^full_test_results(?:_v\d+)?\.json$/i.test(f.name))
        .map((f) => ({ ...f, ver: (f.name.match(/_v(\d+)/) || [0, 0])[1] | 0 }))
        .sort((a, b) => b.ver - a.ver);
      for (const f of ftrFiles.slice(0, 1)) {
        try {
          const d = JSON.parse(fs.readFileSync(f.path, "utf-8"));
          for (const sample of Object.values(d)) {
            if (!sample || typeof sample !== "object") continue;
            const results = sample.results;
            if (!results || typeof results !== "object") continue;
            for (const [rid, r] of Object.entries(results)) {
              if (!isRuleId(rid) || !r || typeof r !== "object") continue;
              const verdict = (r.verdict || "").toString().toUpperCase();
              if (verdict === "PASS") bump(rid, "pass");
              else if (verdict === "FAIL") bump(rid, "fail");
              else if (verdict === "NOT_APPLICABLE" || verdict === "NA") bump(rid, "na");
            }
          }
          sourceFiles.push(path.relative(this._workspace.cwd, f.path));
        } catch { /* try next shape */ }
      }
    }

    if (tally.size === 0) return null;

    const historical_accuracy = {};
    for (const [rid, t] of tally.entries()) {
      const fired = t.pass + t.fail;
      historical_accuracy[rid] = {
        pass_rate: fired > 0 ? +(t.pass / fired).toFixed(4) : null,
        n_passed: t.pass,
        n_failed: t.fail,
        n_not_applicable: t.na,
        n_samples: t.n,
      };
    }
    return {
      historical_accuracy,
      computed_at: new Date().toISOString(),
      source_files: sourceFiles,
    };
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
