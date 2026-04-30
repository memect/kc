import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { normalizeRuleCatalog } from "../rule-catalog-normalize.js";
import { deriveFinalizationMilestones } from "./_milestone-derive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// v0.7.0 N: ship template/release/v1/ from the npm package; copy into
// the workspace at finalization phase entry.
const RELEASE_TEMPLATE_DIR = path.resolve(__dirname, "../../../template/release/v1");

/**
 * E1: FINALIZATION — the 7th phase. Runs after PRODUCTION_QC has shown
 * the system working. Goal: turn the working system into a shippable
 * deliverable.
 *
 * Responsibilities (observed via this pipeline's describeState + exit
 * criteria; the agent does the actual work using workspace_file +
 * sandbox_exec):
 *   1. rule_skills/README.md  — inventory + how-to-run section.
 *   2. rule_skills/coverage_report.md  — rule-id → skill-file mapping,
 *      including which rules are "not_applicable" per D6 classification.
 *   3. output/final_dashboard.html  — snapshot of the final metrics.
 *   4. (Optional) Reorganized rule_skills/<rule_id>/ canonical layout:
 *      when skills were written grouped (check_r002_r007.py), create
 *      thin-link dirs for each constituent rule_id pointing at the
 *      grouped file. Skipped if rule_skills/ is already per-rule.
 *
 * Exit criteria: all three deliverable files exist. The agent is free
 * to produce more artifacts; these are the minimum-viable finalization
 * set the pipeline requires before marking the release-ready.
 *
 * No successor phase — this is the terminal state. The agent can
 * continue working in this phase (e.g. producing additional dashboards
 * on request), but auto-advance stops here.
 */
export class FinalizationPipeline extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.readmeWritten = false;
    this.coverageReportWritten = false;
    this.finalDashboardWritten = false;
    this.canonicalLayoutDone = false;
    this._scanWorkspace();
  }

  _scanWorkspace() {
    // v0.7.0 A1: route through filesystem-derived helper. The helper
    // accepts multiple shipping locations (output/releases/v#/README.md,
    // rule_skills/README.md, workspace-root README.md) and enforces a
    // ≥500-byte threshold to defeat empty stub files. Dashboard check
    // requires sha256-distinct HTMLs in dashboards/ (Group C dedup).
    const m = deriveFinalizationMilestones(this._workspace);
    this.readmeWritten = m.readmeWritten;
    this.coverageReportWritten = m.coverageReportWritten;
    this.finalDashboardWritten = m.finalDashboardWritten;
    this._dashboardDuplicatesDetected = m.dashboardDuplicatesDetected;

    // Canonical layout: every rule_id in the catalog has a dedicated
    // directory OR a thin-link stub under rule_skills/<rule_id>/. Kept
    // here (not in helper) because it requires reading catalog.json
    // and matching against existing dirs — pipeline-specific logic.
    this.canonicalLayoutDone = this._checkCanonicalLayout();
  }

  _checkCanonicalLayout() {
    const cwd = this._workspace.cwd;
    const catalogPath = path.join(cwd, "rules", "catalog.json");
    const skillsDir = path.join(cwd, "rule_skills");
    if (!fs.existsSync(catalogPath) || !fs.existsSync(skillsDir)) return false;
    let rules;
    try {
      rules = normalizeRuleCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf-8")));
    } catch { return false; }
    if (rules.length === 0) return false;

    let existingDirs;
    try {
      existingDirs = new Set(
        fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name),
      );
    } catch { return false; }

    // Every rule id should have a matching directory. Directory name
    // matches rule id (R014) OR falls inside a range dir (R078_R128).
    const rangeDirs = [...existingDirs].map((name) => {
      const m = name.match(/^R0*(\d+)[_-]R0*(\d+)$/i);
      if (m) return { name, lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) };
      return null;
    }).filter(Boolean);

    for (const r of rules) {
      if (!r.id) continue;
      if (existingDirs.has(r.id)) continue;
      const m = r.id.match(/^R0*(\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (rangeDirs.some((rd) => rd.lo <= n && n <= rd.hi)) continue;
      }
      return false;
    }
    return true;
  }

  describeState() {
    this._scanWorkspace();
    const checklist = [
      `- ${this.readmeWritten ? "✅" : "⏳"}  rule_skills/README.md`,
      `- ${this.coverageReportWritten ? "✅" : "⏳"}  rule_skills/coverage_report.md`,
      `- ${this.finalDashboardWritten ? "✅" : "⏳"}  output/final_dashboard.html`,
      `- ${this.canonicalLayoutDone ? "✅" : "⏳"}  rule_skills/ canonical per-rule layout`,
    ];
    const parts = [
      "## Phase: FINALIZATION\n" +
      "Turn the working verification system into a shippable deliverable. The " +
      "pipeline has completed end-to-end; now package it for handoff. This is " +
      "the terminal phase — no successor. You can continue producing artifacts " +
      "here on request.\n\n" +
      "**Tasks to complete** (the pipeline considers the phase done when all " +
      "four checkmarks are green):\n\n" +
      checklist.join("\n") + "\n\n" +
      "### What each artifact should contain\n\n" +
      "- **README.md**: top of `rule_skills/` with file inventory, how to run " +
      "  `run_all_checks.py` (if present), input format, expected output format, " +
      "  dependencies, and a short 'what this does' for a reader who hasn't " +
      "  seen the project.\n" +
      "- **coverage_report.md**: one row per rule_id in catalog.json. Columns: " +
      "  rule_id, source_ref, skill file (`check_r014.py` or `check_r002_r007.py`), " +
      "  tested (Y/N), latest accuracy, retries, applicable-to-this-bundle " +
      "  (Y/N from D6 classification). Rules marked not_applicable should be " +
      "  grouped at the bottom with a note explaining which bundle-type " +
      "  filtered them out.\n" +
      "- **final_dashboard.html**: single-page snapshot. Reuse the " +
      "  `dashboard_render` tool — it knows the metrics shape. This is the " +
      "  hand-off artifact the developer user opens to see the final state.\n" +
      "- **canonical layout**: the simplest check is `ls rule_skills/ | " +
      "  wc -l` ≈ number of rules in the catalog. When grouped files exist " +
      "  (`check_r002_r007.py`), create stub `rule_skills/R002/` through " +
      "  `rule_skills/R007/` each containing a one-line SKILL.md that points " +
      "  at the grouped file. This keeps downstream per-rule lookups simple.",
    ];
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();
    const touchedPath = String(
      toolInput?.path || toolInput?.command || "",
    );
    // Re-scan when the agent writes to any relevant path
    if (
      touchedPath.includes("rule_skills/") ||
      touchedPath.includes("output/final_dashboard") ||
      touchedPath.includes("coverage_report")
    ) {
      this._scanWorkspace();
    }
    if (!wasReady && this.exitCriteriaMet()) {
      // Terminal phase — no nextPhase. Pipeline event signals "done."
      return new PipelineEvent({
        type: "phase_ready",
        message: "Finalization artifacts complete. Session deliverable is ready.",
        nextPhase: null,
      });
    }
    return null;
  }

  exitCriteriaMet() {
    return this.readmeWritten &&
      this.coverageReportWritten &&
      this.finalDashboardWritten &&
      this.canonicalLayoutDone &&
      // v0.7.0 N (#94): pre-flight — every required file run.py loads
      // must exist. Without this, finalization can declare "done" with
      // a release dir that bombs on first invocation (E2E #5 DS shipped
      // run.py requiring manifest.json which didn't exist).
      this._releaseBundlePreflightOk();
  }

  /**
   * v0.7.0 N (#94): copy `template/release/v1/` into
   * `output/releases/v1/` at phase entry so the agent has a runnable
   * skeleton to fill in. Skips if the release dir already exists with
   * non-template content (resume case — preserve agent edits).
   *
   * Called from engine._advancePhase after the phase transitions to
   * finalization.
   */
  onPhaseEnter({ fromPhase, workspace } = {}) {
    if (!fs.existsSync(RELEASE_TEMPLATE_DIR)) return; // template not bundled (dev edge case)
    const releaseRoot = path.join((workspace || this._workspace).cwd, "output", "releases", "v1");
    if (fs.existsSync(releaseRoot)) {
      // Don't overwrite existing release dir (resume / repeat phase entry).
      // Re-rerunning the populator on existing files is safe but the agent
      // may have hand-edited; leave alone.
      return;
    }
    try {
      this._copyTemplateRecursive(RELEASE_TEMPLATE_DIR, releaseRoot);
      // Populate .tmpl files from session-state where we can.
      this._populateRelease(releaseRoot);
    } catch (e) {
      // Defensive: never let template setup break phase transition.
      // The agent can re-run via /phase finalization or recover manually.
      // eslint-disable-next-line no-console
      console.warn(`[finalization] release template copy failed: ${e?.message || e}`);
    }
  }

  _copyTemplateRecursive(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        this._copyTemplateRecursive(src, dst);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dst);
        // Preserve executable bits on shipped scripts
        if (/\.(py|sh)$/.test(entry.name)) {
          try { fs.chmodSync(dst, 0o755); } catch { /* not critical */ }
        }
      }
    }
  }

  _populateRelease(releaseRoot) {
    // Best-effort populator — fills the .tmpl placeholders with what
    // session-state currently knows. Agent can re-edit afterwards.
    const cwd = this._workspace.cwd;
    const sessionId = path.basename(cwd);
    const generatedAt = new Date().toISOString();

    // catalog.json: copy from rules/catalog.json if present
    const catalogSrc = path.join(cwd, "rules", "catalog.json");
    if (fs.existsSync(catalogSrc)) {
      try {
        fs.copyFileSync(catalogSrc, path.join(releaseRoot, "catalog.json"));
      } catch { /* ignore */ }
    }

    // manifest.json: scan workflows/ for rule -> file mappings
    const workflowsRoot = path.join(cwd, "workflows");
    const workflows = {};
    let ruleCount = 0;
    let workflowCount = 0;
    if (fs.existsSync(workflowsRoot)) {
      for (const entry of fs.readdirSync(workflowsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const subFiles = fs.readdirSync(path.join(workflowsRoot, entry.name));
          const py = subFiles.find((f) => /workflow.*\.py$/i.test(f) || /^check.*\.py$/i.test(f));
          if (py) {
            workflows[entry.name] = `workflows/${entry.name}/${py}`;
            workflowCount++;
          }
        } else if (entry.isFile()) {
          const m = entry.name.match(/^(.+)_workflow\.py$/i);
          if (m) {
            workflows[m[1]] = `workflows/${entry.name}`;
            workflowCount++;
          }
        }
      }
    }
    try {
      const catalog = fs.existsSync(catalogSrc)
        ? JSON.parse(fs.readFileSync(catalogSrc, "utf-8"))
        : [];
      ruleCount = Array.isArray(catalog) ? catalog.length : (catalog?.rules?.length || 0);
    } catch { /* ignore */ }

    const manifest = {
      release_version: "v1",
      kc_version: this._readKcVersion(),
      generated_at: generatedAt,
      session_id: sessionId,
      rules_count: ruleCount,
      workflows_count: workflowCount,
      workflows,
      calibration_source: "confidence_calibration.json",
      documentation: "README.md",
    };
    fs.writeFileSync(
      path.join(releaseRoot, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // README.md: substitute placeholders in README.md.tmpl
    const readmeTmplPath = path.join(releaseRoot, "README.md.tmpl");
    if (fs.existsSync(readmeTmplPath)) {
      let readme = fs.readFileSync(readmeTmplPath, "utf-8");
      readme = readme
        .replaceAll("{{kc_version}}", this._readKcVersion())
        .replaceAll("{{session_id}}", sessionId)
        .replaceAll("{{generated_at}}", generatedAt)
        .replaceAll("{{rule_count}}", String(ruleCount))
        .replaceAll("{{workflow_count}}", String(workflowCount))
        .replaceAll("{{project_description}}", "(Agent: replace with project-specific description.)")
        .replaceAll("{{known_limitations}}", "(Agent: replace with known limitations from this run.)");
      fs.writeFileSync(path.join(releaseRoot, "README.md"), readme, "utf-8");
    }
  }

  _readKcVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, "../../../package.json"), "utf-8",
      ));
      return pkg.version || "unknown";
    } catch { return "unknown"; }
  }

  /**
   * v0.7.0 N (#94): pre-flight — confirm every file `run.py` loads via
   * `_load_json(..., required=True)` exists in the bundle. Without this
   * the agent can declare finalization done with a bundle that bombs
   * at runtime.
   */
  _releaseBundlePreflightOk() {
    const releaseRoot = path.join(this._workspace.cwd, "output", "releases", "v1");
    if (!fs.existsSync(releaseRoot)) return false;
    const required = ["run.py", "manifest.json", "README.md", "kc_runtime/doc_parser.py", "kc_runtime/confidence.py"];
    for (const rel of required) {
      const p = path.join(releaseRoot, rel);
      if (!fs.existsSync(p)) return false;
    }
    return true;
  }

  exportState() {
    return {
      readmeWritten: this.readmeWritten,
      coverageReportWritten: this.coverageReportWritten,
      finalDashboardWritten: this.finalDashboardWritten,
      canonicalLayoutDone: this.canonicalLayoutDone,
    };
  }

  importState(data) {
    if (typeof data?.readmeWritten === "boolean") this.readmeWritten = data.readmeWritten;
    if (typeof data?.coverageReportWritten === "boolean") this.coverageReportWritten = data.coverageReportWritten;
    if (typeof data?.finalDashboardWritten === "boolean") this.finalDashboardWritten = data.finalDashboardWritten;
    if (typeof data?.canonicalLayoutDone === "boolean") this.canonicalLayoutDone = data.canonicalLayoutDone;
  }
}
