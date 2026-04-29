import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { SkillValidator } from "../skill-validator.js";

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
    this.totalRules = [];
    const rulesDir = path.join(this._workspace.cwd, "rules");
    if (!fs.existsSync(rulesDir)) return;
    for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(rulesDir, f), "utf-8"));
        const rules = Array.isArray(data) ? data : (data.rules || []);
        for (const r of rules) { if (r.id) this.totalRules.push(r.id); }
      } catch { /* skip */ }
    }
  }

  _scanSkills() {
    this.skillsAuthored = [];
    this.skillsWithScripts = [];
    // D2: rule_ids that are covered by some authored skill — whether that
    // skill is single-rule (rule_skills/R014/) or grouped
    // (rule_skills/SK02/check_r002_r007.py). Populated by _walkForRuleIds
    // below so the exit criterion counts DISTINCT rule coverage rather
    // than skill-directory count, which over-counts when skills are
    // grouped (session 6304673afaa0's rule_skills/ had 289 rules packed
    // into 23 skill files).
    this.ruleIdsCovered = new Set();
    const dir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("__")) continue;
      const skillPath = path.join(dir, e.name);
      if (fs.existsSync(path.join(skillPath, "SKILL.md")) || fs.readdirSync(skillPath).some((f) => f.endsWith(".py"))) {
        this.skillsAuthored.push(e.name);
      }
      const scriptsDir = path.join(skillPath, "scripts");
      if (fs.existsSync(scriptsDir) && fs.readdirSync(scriptsDir).length > 0) {
        this.skillsWithScripts.push(e.name);
      }
      this._walkForRuleIds(skillPath);
    }
  }

  /**
   * D2: Find rule_ids referenced by any file under the skill directory.
   * Recognizes three naming patterns from actual sessions:
   *   - Directory name matches a rule: rule_skills/R014/
   *   - Single-rule script: check_r014.py
   *   - Grouped script: check_r002_r007.py → covers R002 through R007
   */
  _walkForRuleIds(skillDir) {
    const dirName = path.basename(skillDir);
    const dirMatch = dirName.match(/^R0*(\d+)$/i);
    if (dirMatch) this.ruleIdsCovered.add(`R${String(parseInt(dirMatch[1], 10)).padStart(3, "0")}`);

    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        // Per-rule: check_r014.py
        const single = e.name.match(/check_r0*(\d+)\.py$/i);
        if (single) {
          this.ruleIdsCovered.add(`R${String(parseInt(single[1], 10)).padStart(3, "0")}`);
          continue;
        }
        // Grouped: check_r002_r007.py, check_r002-r007.py, check_r59_r77.py
        const grouped = e.name.match(/check_r0*(\d+)[_-]+r0*(\d+)\.py$/i);
        if (grouped) {
          const lo = parseInt(grouped[1], 10);
          const hi = parseInt(grouped[2], 10);
          for (let n = lo; n <= hi; n++) {
            this.ruleIdsCovered.add(`R${String(n).padStart(3, "0")}`);
          }
          continue;
        }
        // Directory names that encode ranges: R078_R128/
        // handled by caller passing skillDir
      }
    };
    // Also handle dirs named like R078_R128/
    const rangeDir = dirName.match(/^R0*(\d+)[_-]R0*(\d+)$/i);
    if (rangeDir) {
      const lo = parseInt(rangeDir[1], 10);
      const hi = parseInt(rangeDir[2], 10);
      for (let n = lo; n <= hi; n++) {
        this.ruleIdsCovered.add(`R${String(n).padStart(3, "0")}`);
      }
    }
    walk(skillDir);
  }

  describeState() {
    this._scanWorkspace();
    const total = this.totalRules.length;
    const covered = this.ruleIdsCovered.size;
    const uncovered = this.totalRules.filter((r) => !this.ruleIdsCovered.has(r));
    const parts = [
      "## Phase: SKILL_AUTHORING\n" +
      "Write verification skills for each extracted rule. Skills are first-class " +
      "deliverables — they may serve as the production solution when worker LLM " +
      "workflows are insufficient. Follow Anthropic skill-creator format. This is " +
      "BUILD mode.\n\n" +
      // D2: soft granularity nudge
      "**Granularity preference:** 1 rule = 1 skill directory. Group rules into " +
      "the same file ONLY when they share evidence and fail together (e.g. " +
      "siblings from the same required-fields table). When grouping, name the " +
      "file with the range: `check_r002_r007.py`. Downstream consumers " +
      "(workflow-run, dashboards) count rule coverage by parsing these names, " +
      "so the file-naming matters.\n\n" +
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
    if (toolName === "workspace_file" && (toolInput.path || "").includes("rule_skills/")) this._scanSkills();
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
    return this.skillsWithScripts.length >= Math.max(1, this.skillsAuthored.length * 0.5);
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
