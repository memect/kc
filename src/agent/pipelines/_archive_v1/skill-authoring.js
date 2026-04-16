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
    }
  }

  describeState() {
    this._scanWorkspace();
    const total = this.totalRules.length;
    const parts = ["## Current Phase: SKILL_AUTHORING"];
    parts.push(`### Progress\n- Rules from extraction: ${total}\n- Skills authored: ${this.skillsAuthored.length}\n- Skills with scripts/: ${this.skillsWithScripts.length}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Ready\nAll rules have skills. Proceed to SKILL_TESTING.");
    } else if (this.skillsAuthored.length === 0) {
      parts.push("### What to do now\nWrite a SKILL.md for each rule in rule_skills/{rule_id}/.\nDescribe: what to check, where to look, what to extract, how to judge.");
    } else {
      const remaining = this.totalRules.filter((r) => !this.skillsAuthored.includes(r));
      parts.push(`### What to do now\n${total - this.skillsAuthored.length} rules still need skills. Remaining: ${remaining.slice(0, 10).join(", ")}`);
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
    return this.skillsAuthored.length >= this.totalRules.length && this.skillsWithScripts.length >= this.skillsAuthored.length * 0.5;
  }
}
