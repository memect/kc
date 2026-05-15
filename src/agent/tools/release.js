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

    // v0.8.1 P9-C: defer the snapshot (git tag) until AFTER the bundle
    // is written + verified. v0.8.0 ordered snapshot-first to "lock in
    // commit + tag regardless of bundle outcome," but E2E #11 资管 v0.8
    // audit found `release-v1` tags with no corresponding bundle dir —
    // tag without bundle confuses downstream consumers. New order:
    //   1. Build bundle (catalog read, copy template, write fixtures, manifest, README)
    //   2. Verify bundle (manifest.json + README.md exist + non-empty)
    //   3. ONLY THEN snapshot (creates the git tag) + back-fill manifest
    //      with snapshot tag/commit
    // If verification fails, a `.failed_release` marker is written into
    // the bundle dir and NO tag is created.
    let snapshotTag = null;
    let snapshotCommit = null;

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
    // v0.7.5 G-H3: aggregator now runs if calibSrc is MISSING **or** has
    // empty `historical_accuracy`. v0.7.4 audit (both 贷款 + 资管) shipped
    // empty stubs despite QC data on disk — root cause was the v0.7.2
    // gate only checked file existence; a stub written earlier (e.g., on
    // finalization phase entry) kept the aggregator from firing later.
    const calibSrc = path.join(this._workspace.cwd, "confidence_calibration.json");
    let shouldAggregate = !fs.existsSync(calibSrc);
    if (!shouldAggregate) {
      try {
        const existing = JSON.parse(fs.readFileSync(calibSrc, "utf-8"));
        const ha = existing?.historical_accuracy;
        if (!ha || (typeof ha === "object" && Object.keys(ha).length === 0)) {
          shouldAggregate = true;
        }
      } catch { shouldAggregate = true; } // corrupt → re-aggregate
    }
    if (shouldAggregate) {
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

    // v0.7.5 G-H4: sweep any leftover `.tmpl` files from the bundle dir.
    // template/release/v1/ contains manifest.json.tmpl, catalog.json.tmpl,
    // README.md.tmpl. _copyDir's exclude list (line 119) only filters
    // README.md.tmpl; the other two ride along and persist alongside their
    // populated counterparts. Audit (v0.7.4 贷款) confirmed this regression
    // of v0.7.2 G1d which only handled the v1/ scaffold case.
    this._sweepTmplFiles(bundleAbs);

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

    // v0.8.1 P9-C: bundle verification + transactional snapshot.
    // The manifest + README were written above. Verify they exist with
    // substance (≥200 bytes README, valid JSON manifest with `slug` field).
    // If verification fails, write `.failed_release` marker and skip
    // the git-tag step — no tag-without-bundle.
    const manifestPath = path.join(bundleAbs, "manifest.json");
    const readmePath = path.join(bundleAbs, "README.md");
    let verifyError = null;
    try {
      const mStat = fs.statSync(manifestPath);
      const rStat = fs.statSync(readmePath);
      if (!mStat.isFile() || mStat.size < 50) verifyError = "manifest.json missing or too small";
      else if (!rStat.isFile() || rStat.size < 200) verifyError = "README.md missing or too small";
      else {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (m.slug !== slug) verifyError = `manifest.slug=${m.slug} doesn't match expected ${slug}`;
      }
    } catch (e) {
      verifyError = `bundle verification threw: ${e.message}`;
    }

    if (verifyError) {
      try {
        fs.writeFileSync(
          path.join(bundleAbs, ".failed_release"),
          JSON.stringify({
            failed_at: new Date().toISOString(),
            reason: verifyError,
            label,
            slug,
          }, null, 2),
        );
      } catch { /* best-effort */ }
      return new ToolResult(
        `Release bundle verification failed (${verifyError}). NO git tag created. ` +
        `See .failed_release marker in ${bundleRel}/ for details. Fix the bundle issue and re-run.`,
        true,
      );
    }

    // Bundle verified. NOW snapshot — creates the durable git tag.
    const snapResult = await this._snapshot.execute({
      label: `release-${slug}`,
      notes: `Release ${label} bundle source`,
    });
    if (snapResult.isError) {
      // Bundle exists but tagging failed. Surface but don't roll back —
      // the bundle is still usable; the user can manually tag later.
      return new ToolResult(
        `Release '${label}' bundled at ${bundleRel} but snapshot tag FAILED: ${snapResult.content}. ` +
        `Bundle is valid; create the snapshot tag manually if needed.`,
      );
    }
    const meta = this._readSnapshotMeta(`release-${slug}`);
    snapshotTag = meta.tag;
    snapshotCommit = meta.commit;

    // Back-fill the manifest with the now-known snapshot tag/commit.
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      m.snapshot_tag = snapshotTag;
      m.snapshot_commit = snapshotCommit;
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
      // Also back-fill the README's snapshot placeholders if still placeholder.
      const readme = fs.readFileSync(readmePath, "utf-8");
      const updated = readme
        .replace(/\(no tag — git unavailable\)/g, snapshotTag || "")
        .replace(/\(unknown\)/g, snapshotCommit || "(unknown)");
      if (updated !== readme) fs.writeFileSync(readmePath, updated);
    } catch { /* best-effort back-fill */ }

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

  /**
   * v0.7.5 G-H4: recursively remove any `*.tmpl` files from a directory.
   * Used after populating a release bundle to drop template stubs that
   * weren't filtered by the initial copy's exclude list. Idempotent.
   */
  _sweepTmplFiles(dir) {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this._sweepTmplFiles(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".tmpl")) {
          try { fs.unlinkSync(entryPath); } catch { /* best-effort */ }
        }
      }
    } catch { /* best-effort */ }
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

      // v0.7.5 G-H2: master / grouped workflow pattern. Agent shipped a
      // single workflow folder (e.g., workflows/master/ or workflows/
      // bank_wm_compliance/) declaring `source_rules: [R001, R002, ...]`
      // in its SKILL.md / workflow.md / config.json. The manifest writer
      // should credit this rule_id as covered by that workflow.
      //
      // Walk workflows/ subdirs looking for a source_rules declaration
      // that includes this ruleId. Return the first matching workflow file.
      // Audit (v0.7.4 贷款 session) confirmed manifest under-counted:
      // catalog had 15 rules; manifest only listed R001 because R002-R015
      // weren't found as standalone workflows.
      for (const entry of fs.readdirSync(flatRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ruleId) continue; // already checked above
        const subDir = path.join(flatRoot, entry.name);
        const declaredRules = this._readWorkflowSourceRules(subDir);
        if (declaredRules.includes(ruleId)) {
          // Find the workflow entry file in this dir
          const subFiles = fs.readdirSync(subDir);
          const versioned = subFiles.filter((f) => /^workflow_v\d+\.py$/.test(f)).sort();
          if (versioned.length > 0) return path.join(subDir, versioned[versioned.length - 1]);
          const any = subFiles.find((f) => f.endsWith(".py"));
          if (any) return path.join(subDir, any);
        }
      }
    }
    return null;
  }

  /**
   * v0.7.5 G-H2: read a workflow directory's source_rules declaration.
   * Checks SKILL.md / workflow.md frontmatter (`source_rules: [...]`)
   * and config.json (`source_rules`, `rules`, or `rule_ids` field).
   * Returns array of canonical rule IDs.
   */
  _readWorkflowSourceRules(workflowDir) {
    const ids = new Set();
    try {
      const files = fs.readdirSync(workflowDir);

      // Frontmatter sources
      for (const fname of files) {
        if (!/^(skill|workflow)\.md$/i.test(fname)) continue;
        let content;
        try { content = fs.readFileSync(path.join(workflowDir, fname), "utf-8"); } catch { continue; }
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fm = fmMatch[1];
        // Inline form
        const inlineMatch = fm.match(/^source_rules\s*:\s*\[([^\]]*)\]\s*$/m);
        if (inlineMatch) {
          inlineMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean).forEach(s => {
              const m = s.match(/^R0*(\d+)$/i);
              if (m) ids.add(`R${String(parseInt(m[1], 10)).padStart(3, "0")}`);
            });
        }
        // Block form
        const blockMatch = fm.match(/^source_rules\s*:\s*\n((?:[ \t]+-\s+\S+\s*\n?)+)/m);
        if (blockMatch) {
          blockMatch[1].split("\n").forEach(line => {
            const m = line.match(/^[ \t]+-\s+["']?(R0*\d+)["']?\s*$/i);
            if (m) {
              const n = m[1].match(/R0*(\d+)/i);
              if (n) ids.add(`R${String(parseInt(n[1], 10)).padStart(3, "0")}`);
            }
          });
        }
      }

      // Config.json sources
      const configPath = path.join(workflowDir, "config.json");
      if (fs.existsSync(configPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const rules = Array.isArray(data?.source_rules) ? data.source_rules :
                        Array.isArray(data?.rules) ? data.rules :
                        Array.isArray(data?.rule_ids) ? data.rule_ids : [];
          for (const r of rules) {
            const m = String(r).match(/^R0*(\d+)$/i);
            if (m) ids.add(`R${String(parseInt(m[1], 10)).padStart(3, "0")}`);
          }
        } catch { /* ignore */ }
      }
    } catch { /* dir unreadable */ }
    return [...ids];
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

    // 3) v0.8 P0-C: production_qc_results.json + qc_results_v*.json shapes
    // (资管 + 贷款 v0.7.5 audits both shipped empty historical_accuracy
    // because the v0.7.2 aggregator only recognized rule_stats / full_test_results).
    if (tally.size === 0) {
      const qcFiles = files
        .filter((f) =>
          /^production_qc(?:_results)?(?:_v\d+)?\.json$/i.test(f.name) ||
          /^qc_results(?:_v\d+)?\.json$/i.test(f.name)
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of qcFiles.slice(0, 5)) {
        try {
          const d = JSON.parse(fs.readFileSync(f.path, "utf-8"));
          const results = d.results;
          if (!results) continue;

          // Shape 3a (资管): nested rule-keyed map
          //   {results: {<rid>: {<doc_id>: {verdict, ...}}}}
          if (typeof results === "object" && !Array.isArray(results)) {
            for (const [rid, docs] of Object.entries(results)) {
              if (!isRuleId(rid) || !docs || typeof docs !== "object") continue;
              for (const r of Object.values(docs)) {
                if (!r || typeof r !== "object") continue;
                const verdict = (r.verdict || "").toString().toUpperCase();
                if (verdict === "PASS") bump(rid, "pass");
                else if (verdict === "FAIL") bump(rid, "fail");
                else if (verdict === "NOT_APPLICABLE" || verdict === "NA" || verdict === "WARNING") bump(rid, "na");
              }
            }
            if (tally.size > 0) sourceFiles.push(path.relative(this._workspace.cwd, f.path));
          }
          // Shape 3b (贷款): per-doc rollup list with failed_rules
          //   {results: [{filename, actual, correct, failed_rules: [...]}], total_tested: N}
          // For each rule: failures counted from failed_rules union; passes
          // inferred as (total_tested - failures) for rules that appear in the catalog.
          else if (Array.isArray(results)) {
            const catalogPath = path.join(this._workspace.cwd, "rules", "catalog.json");
            let catalogRules = [];
            try {
              const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              const list = Array.isArray(cat) ? cat : Array.isArray(cat?.rules) ? cat.rules : [];
              catalogRules = list.map((r) => r?.id || r?.rule_id).filter((x) => isRuleId(x));
            } catch { /* catalog optional */ }

            const failCountByRule = new Map();
            let docCount = 0;
            for (const row of results) {
              if (!row || typeof row !== "object") continue;
              docCount += 1;
              const failed = Array.isArray(row.failed_rules) ? row.failed_rules : [];
              for (const rid of failed) {
                if (!isRuleId(rid)) continue;
                failCountByRule.set(rid, (failCountByRule.get(rid) || 0) + 1);
              }
            }
            if (docCount > 0) {
              const ruleSet = new Set([...catalogRules, ...failCountByRule.keys()]);
              for (const rid of ruleSet) {
                const fails = failCountByRule.get(rid) || 0;
                const passes = Math.max(0, docCount - fails);
                const t = tally.get(rid) || { pass: 0, fail: 0, na: 0, n: 0 };
                t.pass += passes; t.fail += fails; t.n += docCount;
                tally.set(rid, t);
              }
              if (tally.size > 0) sourceFiles.push(path.relative(this._workspace.cwd, f.path));
            }
          }
        } catch { /* try next file */ }
        if (tally.size > 0) break;
      }
    }

    // 4) v0.8.1 P9-A: top-level fail_by_rule + pass_by_rule maps (贷款
    // v0.8 production_qc_report.json shape). Direct per-rule counts —
    // no per-doc rollup, no verdict literals to scan.
    //   {accuracy, total_checks, fail_by_rule: {<rid>: N}, pass_by_rule: {<rid>: N}}
    if (tally.size === 0) {
      for (const f of files) {
        if (!/qc|prod|report|result/i.test(f.name)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(f.path, "utf-8"));
          const failMap = d?.fail_by_rule;
          const passMap = d?.pass_by_rule;
          if (
            failMap && typeof failMap === "object" && !Array.isArray(failMap) &&
            passMap && typeof passMap === "object" && !Array.isArray(passMap)
          ) {
            const allRules = new Set([...Object.keys(failMap), ...Object.keys(passMap)]);
            let matched = false;
            for (const rid of allRules) {
              if (!isRuleId(rid)) continue;
              const fails = Number(failMap[rid]) || 0;
              const passes = Number(passMap[rid]) || 0;
              if (fails + passes === 0) continue;
              const t = tally.get(rid) || { pass: 0, fail: 0, na: 0, n: 0 };
              t.pass += passes;
              t.fail += fails;
              t.n += passes + fails;
              tally.set(rid, t);
              matched = true;
            }
            if (matched) {
              sourceFiles.push(path.relative(this._workspace.cwd, f.path));
              break;
            }
          }
        } catch { /* skip non-JSON */ }
      }
    }

    // 5) Fallback (belt-and-suspenders per v0.8 plan Risk #7):
    // walk any output/*.json with a top-level rule_id-keyed shape that has
    // verdict-like leaf objects. Catches future schema drift before the
    // next audit cycle.
    if (tally.size === 0) {
      for (const f of files) {
        if (!/qc|verdict|result/i.test(f.name)) continue;
        try {
          const d = JSON.parse(fs.readFileSync(f.path, "utf-8"));
          const root = d?.results || d;
          if (!root || typeof root !== "object" || Array.isArray(root)) continue;
          let matched = false;
          for (const [rid, val] of Object.entries(root)) {
            if (!isRuleId(rid) || !val || typeof val !== "object") continue;
            // val might be {verdict, ...} OR {<doc>: {verdict, ...}}
            const probe = val.verdict ? [val] : Object.values(val);
            for (const r of probe) {
              if (!r || typeof r !== "object") continue;
              const verdict = (r.verdict || "").toString().toUpperCase();
              if (verdict === "PASS") { bump(rid, "pass"); matched = true; }
              else if (verdict === "FAIL") { bump(rid, "fail"); matched = true; }
              else if (verdict === "NOT_APPLICABLE" || verdict === "NA") { bump(rid, "na"); matched = true; }
            }
          }
          if (matched) {
            sourceFiles.push(path.relative(this._workspace.cwd, f.path) + " (fallback shape)");
            break;
          }
        } catch { /* skip non-JSON */ }
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
