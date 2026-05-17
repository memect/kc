import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { SkillValidator } from "../skill-validator.js";
import { deriveSkillAuthoringMilestones, canonicalRuleId } from "./_milestone-derive.js";

export class SkillAuthoringPipeline extends Pipeline {
  /**
   * @param {Workspace} workspace
   * @param {TaskManager|null} [taskManager] - v0.6.1 A2: pass the engine's
   *   TaskManager so exitCriteriaMet can require task-completion parity in
   *   addition to D2 filename coverage. Subagents pass null (no taskManager
   *   in subagent scope), in which case the gate falls back to D2-only
   *   behaviour.
   */
  constructor(workspace, taskManager = null) {
    super();
    this._workspace = workspace;
    this._taskManager = taskManager;
    // v0.6.2 I2: skill validator catches malformed check_r###.py at the
    // skill_authoring exit boundary instead of silently passing the
    // phase and breaking in production_qc (E2E #4 unified_qc.py
    // SyntaxError went undiagnosed for hours).
    this._validator = new SkillValidator();
    this._validationFailures = [];
    this._validationSkipped = false;
    this.totalRules = [];
    this.skillsAuthored = [];
    this.skillsWithScripts = [];
    this._scanWorkspace();
  }

  _scanWorkspace() {
    this._loadRules();
    this._scanSkills();
  }

  _loadRules() {
    // v0.8.3 P20-B1+B2: dedup rule IDs across all rules/*.json files AND
    // canonicalize them so the rulesCovered comparison against
    // ruleIdsCovered (which now goes through canonicalRuleId) works for
    // BOTH bare-numeric (R14) AND compound (R01-01, R02-03) forms.
    // E2E #13 资管 used compound IDs + wrote a sibling difficulty.json;
    // the raw-string + no-dedup pre-v0.8.3 path produced rulesCovered:
    // 0/30 (compound IDs unmatched + double-counted).
    this.totalRules = [];
    const seen = new Set();
    const rulesDir = path.join(this._workspace.cwd, "rules");
    if (!fs.existsSync(rulesDir)) return;
    for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(rulesDir, f), "utf-8"));
        const rules = Array.isArray(data) ? data : (data.rules || []);
        for (const r of rules) {
          if (!r || !r.id) continue;
          // Canonicalize to match ruleIdsCovered which is built from
          // canonicalRuleId() output. If canonicalRuleId returns null
          // (non-rule-shaped string), preserve the raw trimmed string.
          const canon = canonicalRuleId(r.id) || String(r.id).trim();
          if (seen.has(canon)) continue;
          seen.add(canon);
          this.totalRules.push(canon);
        }
      } catch { /* skip */ }
    }
  }

  _scanSkills() {
    // v0.7.0 A1: route through filesystem-derived milestone helper. The
    // helper centralizes the ruleId extraction patterns (R### dirs,
    // check_r###.py, range dirs R078_R128, grouped check_r###_r###.py)
    // and recognizes both root-level check_*.py AND scripts/check*.py
    // (per A6 — XM E2E #5 used scripts/ subdir).
    const m = deriveSkillAuthoringMilestones(this._workspace);
    this.skillsAuthored = [...m.skillsAuthored];
    this.skillsWithScripts = [...m.skillsWithScripts];
    this.ruleIdsCovered = new Set(m.ruleIdsCovered);
    // v0.8 P2-F (item 22): stub-shape audit for check.py files.
    this._checkPyStubRatio = m.checkPyStubRatio || 0;
    this._checkPyStubFiles = m.checkPyStubFiles || [];
    this._checkPyTotal = m.checkPyTotal || 0;
  }

  // v0.7.0 A1: ruleId extraction moved to _milestone-derive.js
  // (deriveSkillAuthoringMilestones). Pattern recognition is identical
  // — single rule (R014, check_r014.py), grouped scripts
  // (check_r002_r007.py), range dirs (R078_R128). Kept as a single
  // canonical implementation rather than duplicating across pipelines.

  describeState() {
    this._scanWorkspace();
    const total = this.totalRules.length;
    const covered = this.ruleIdsCovered.size;
    const uncovered = this.totalRules.filter((r) => !this.ruleIdsCovered.has(r));
    const parts = [
      "## Phase: SKILL_AUTHORING\n" +
      "Write verification skills for each extracted rule. Skills are first-class " +
      "deliverables — they may serve as the production solution when worker LLM " +
      "workflows are insufficient. Follow the canonical skill-folder layout " +
      "(below). This is BUILD mode.\n\n" +
      // v0.7.0 D1: inline the canonical folder structure spec so the
      // agent sees it in every system prompt of this phase. E2E #5
      // showed three of four contestants ignored the meta-meta spec
      // because it required navigating to read the SKILL.md file
      // separately. Inlining costs ~250 tokens and dramatically improves
      // first-attempt structural compliance.
      "### Canonical skill folder layout\n" +
      "```\n" +
      "rule_skills/\n" +
      "  R014/                                # one dir per rule (or grouped range)\n" +
      "    SKILL.md                           # YAML frontmatter (name+description) + methodology\n" +
      "    check_r014.py                      # entry point: def check_rule|verify|check|evaluate(...)\n" +
      "    references/regulation.md           # verbatim regulation text (optional)\n" +
      "    references/interpretation.md       # edge-case notes (optional)\n" +
      "    assets/test_cases.json             # annotated samples + expected verdicts (optional)\n" +
      "```\n" +
      "Validator-accepted alternatives: `scripts/check_r###.py` (under scripts/) " +
      "instead of root-level. SKILL.md filename is case-insensitive (skill.md " +
      "is also accepted). The check.py just needs a top-level `def` at module " +
      "level — entry-point name does not have to match a strict pattern.\n\n" +
      // D2: soft granularity nudge
      "**Granularity preference:** 1 rule = 1 skill directory. Group rules into " +
      "the same file ONLY when they share evidence and fail together (e.g. " +
      "siblings from the same required-fields table). When grouping, name the " +
      "file with the range: `check_r002_r007.py`. Downstream consumers " +
      "(workflow-run, dashboards, release tool) count rule coverage by parsing " +
      "these names, so the file-naming matters. (Read `meta-meta/work-decomposition` " +
      "for the full grouping/ordering decision framework + PATTERNS.md memory " +
      "discipline.)\n\n" +
      "**Do not write to rules/catalog.json via sandbox_exec.** Use the " +
      "`rule_catalog` tool for any catalog edits — sandbox_exec bypasses the " +
      "workspace file lock and races with parallel workers."
    ];
    // v0.6.1 A2: surface task-completion parity so the agent sees the gate
    let taskLine = "";
    if (this._taskManager) {
      const totalT = this._taskManager.countByPhase("skill_authoring");
      const doneT = this._taskManager.countByPhase("skill_authoring", "completed");
      const failedT = this._taskManager.countByPhase("skill_authoring", "failed");
      if (totalT > 0) {
        taskLine = `\n- Per-rule tasks completed: ${doneT}/${totalT}` +
          (failedT > 0 ? ` (+${failedT} failed)` : "");
      }
    }
    // v0.6.2 I2: validation status (only meaningful after first
    // exitCriteriaMet call populates _validationFailures)
    let validationLine = "";
    if (this._validationSkipped) {
      validationLine = `\n- Skill validation: SKIPPED (python3 not on PATH — install to enable)`;
    } else if (this._validationFailures.length > 0) {
      const f = this._validationFailures.slice(0, 5).map(({ filePath, error }) =>
        `\n  - ${path.relative(this._workspace.cwd, filePath)}: ${error.split("\n")[0]}`,
      ).join("");
      validationLine = `\n- Skills failing validation (${this._validationFailures.length}):${f}` +
        (this._validationFailures.length > 5 ? `\n  - … and ${this._validationFailures.length - 5} more` : "");
    }
    parts.push(
      `### Progress (rule-id coverage, D2)\n` +
      `- Total rules in catalog: ${total}\n` +
      `- Rule ids covered by some skill: ${covered}\n` +
      `- Skill directories authored: ${this.skillsAuthored.length}\n` +
      `- Skills with scripts/: ${this.skillsWithScripts.length}` +
      taskLine +
      validationLine +
      (uncovered.length > 0
        ? `\n- Missing coverage (${uncovered.length}): ${uncovered.slice(0, 15).join(", ")}${uncovered.length > 15 ? "…" : ""}`
        : ""),
    );

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nAll rule ids are covered by some skill. Proceed to SKILL_TESTING.");
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();
    const writeToSkill = toolName === "workspace_file" &&
      toolInput?.operation === "write" &&
      (toolInput.path || "").includes("rule_skills/");
    if (writeToSkill) {
      this._scanSkills();
      // v0.7.0 A4: validate this specific file immediately if it looks
      // like a check.py. Surfaces syntax/entry-point issues in the next
      // describeState rather than waiting for the phase boundary —
      // E2E #5 had skill_authoring force-bypassed before exitCriteriaMet
      // ever fired, so the v0.6.2 boundary-only validator never ran in
      // practice.
      const p = toolInput.path || "";
      if (/\/check[_a-zA-Z0-9-]*\.py$/i.test(p) && /^rule_skills\//.test(p)) {
        const abs = path.join(this._workspace.cwd, p);
        // Invalidate any stale mtime cache entry for this path then
        // re-validate. Folds the result into _validationFailures so
        // describeState picks it up.
        this._validator.invalidate(abs);
        const r = this._validator.validateFile(abs);
        if (!r.ok) {
          // Replace any prior failure record for this path
          this._validationFailures = this._validationFailures.filter(
            (f) => f.filePath !== abs,
          );
          this._validationFailures.push({ filePath: abs, error: r.error || "unknown" });
        } else {
          this._validationFailures = this._validationFailures.filter(
            (f) => f.filePath !== abs,
          );
        }
      }
    }
    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Skill authoring complete. Ready for SKILL_TESTING.", nextPhase: Phase.SKILL_TESTING });
    }
    return null;
  }

  exitCriteriaMet() {
    if (!this.totalRules.length) return false;
    // D2: exit requires distinct rule-id coverage, not skill-dir count.
    // Original heuristic (skillsAuthored >= totalRules) passed the phase
    // even when KC grouped many rules into one file — a false signal when
    // the user wants per-rule verification. Now every rule id in the
    // catalog must appear in some skill name. The scripts/ heuristic is
    // preserved as a secondary gate on skill depth.
    const allCovered = this.totalRules.every((r) => this.ruleIdsCovered.has(r));
    if (!allCovered) return false;
    // v0.6.1 A2: tasks-parity gate. The 17-minute skill_authoring transition
    // in E2E #4 happened because D2 fired on 20 skeleton SK01-SK20 dirs
    // covering all 110 rule_ids by filename, while only ~5 of 110 per-rule
    // skill_authoring tasks had actually been worked on. Now require every
    // per-rule task in TaskManager to be in a terminal state (completed or
    // failed). Subagents (no taskManager) skip this gate.
    if (this._taskManager) {
      const total = this._taskManager.countByPhase("skill_authoring");
      if (total > 0) {
        const completed = this._taskManager.countByPhase("skill_authoring", "completed");
        const failed = this._taskManager.countByPhase("skill_authoring", "failed");
        if (completed + failed < total) return false;
      }
    }
    // v0.6.2 I2: skill validator — every check_r###.py must parse and
    // expose an entry point. Catches the unified_qc.py-style monolith
    // and other malformed scripts before they break in production_qc.
    // mtime cache keeps this O(1) in steady state. Failures preserved
    // in this._validationFailures for describeState rendering.
    const checkFiles = this._collectCheckScripts();
    const v = this._validator.validateAll(checkFiles);
    this._validationFailures = v.failures;
    this._validationSkipped = v.skipped;
    if (!v.ok) return false;
    if (this.skillsWithScripts.length < Math.max(1, this.skillsAuthored.length * 0.5)) {
      return false;
    }

    // v0.8 P2-F (item 22): optional enforcement of check.py substantiveness.
    // SOFT-by-default — the stub ratio is always computed (visible in
    // describeState / events) but only blocks phase advance if
    // KC_ENFORCE_CHECK_PY_SUBSTANTIVE=1 is set. Default-off because
    // the heuristic may over-fire on legitimate scaffolds; v0.8 ships
    // the detection + reporting, v0.8.x revisits enforcement after audit
    // data shows whether the signal is reliable.
    const enforce = process.env.KC_ENFORCE_CHECK_PY_SUBSTANTIVE === "1";
    if (enforce && this._checkPyTotal > 0 && this._checkPyStubRatio > 0.5) {
      this._validationFailures = this._validationFailures || [];
      this._validationFailures.push({
        file: "<check_py_substantiveness>",
        reason:
          `${this._checkPyStubCount || this._checkPyStubFiles.length}/${this._checkPyTotal} check.py files are stub-shaped ` +
          `(return NOT_APPLICABLE / pass:null with no workflow import + ≤20 lines). ` +
          `Examples: ${this._checkPyStubFiles.slice(0, 3).join(", ")}${this._checkPyStubFiles.length > 3 ? "..." : ""}. ` +
          `See skill-authoring SKILL.md anti-pattern section. ` +
          `Set KC_ENFORCE_CHECK_PY_SUBSTANTIVE=0 to bypass this gate if intentional.`,
      });
      return false;
    }
    return true;
  }

  /**
   * v0.6.2 I2: gather every check_r###.py path under rule_skills/. Used by
   * the skill validator. Walks one level into each skill directory.
   */
  /**
   * v0.6.3 (#74): SKILL_AUTHORING writes per-rule check scripts under
   * rule_skills/. Workflow runs against production samples or distillation
   * outputs are later-phase work.
   */
  phaseMisfitHint(toolName, toolInput, result) {
    if (result?.isError) return null;
    const exitText = this.exitCriteriaMet()
      ? "Skill-authoring exit criteria are MET — call phase_advance(to=\"skill_testing\") to proceed."
      : "Skill-authoring not yet complete (see describeState).";

    if (toolName === "workspace_file" && toolInput?.operation === "write") {
      const p = toolInput.path || "";
      if (p.startsWith("workflows/")) {
        return `Writing under workflows/ is DISTILLATION-phase work, but engine is in SKILL_AUTHORING. ${exitText}`;
      }
      if (p.startsWith("output/results/")) {
        return `Writing under output/results/ is PRODUCTION_QC-phase work, but engine is in SKILL_AUTHORING. ${exitText}`;
      }
    }

    return null;
  }

  _collectCheckScripts() {
    const out = [];
    const dir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(dir)) return out;
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name.startsWith("__")) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.isFile() && /^check_r[\d_-]+\.py$/i.test(e.name)) {
          out.push(p);
        }
      }
    };
    walk(dir);
    return out;
  }

  exportState() {
    return {
      totalRules: this.totalRules,
      skillsAuthored: this.skillsAuthored,
      skillsWithScripts: this.skillsWithScripts,
    };
  }

  importState(data) {
    if (Array.isArray(data.totalRules) && data.totalRules.length > this.totalRules.length) this.totalRules = data.totalRules;
    if (Array.isArray(data.skillsAuthored) && data.skillsAuthored.length > this.skillsAuthored.length) this.skillsAuthored = data.skillsAuthored;
    if (Array.isArray(data.skillsWithScripts) && data.skillsWithScripts.length > this.skillsWithScripts.length) this.skillsWithScripts = data.skillsWithScripts;
  }
}
