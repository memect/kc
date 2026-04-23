import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

export class SkillAuthoringPipeline extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
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
    parts.push(
      `### Progress (rule-id coverage, D2)\n` +
      `- Total rules in catalog: ${total}\n` +
      `- Rule ids covered by some skill: ${covered}\n` +
      `- Skill directories authored: ${this.skillsAuthored.length}\n` +
      `- Skills with scripts/: ${this.skillsWithScripts.length}` +
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
    return this.skillsWithScripts.length >= Math.max(1, this.skillsAuthored.length * 0.5);
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
