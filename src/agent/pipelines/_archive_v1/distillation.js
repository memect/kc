import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

export class DistillationEngine extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.skillsToDistill = [];
    this.workflowsCreated = {};
    this.workflowsTested = {};
    this.workflowsPassing = [];
    this.tierAssignments = {};
    this._workflowAccuracy = 0.9;
    this._scanWorkspace();
  }

  _scanWorkspace() {
    this._loadConfig();
    this._loadSkills();
    this._scanWorkflows();
  }

  _loadConfig() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      if (line.startsWith("WORKFLOW_ACCURACY=")) try { this._workflowAccuracy = parseFloat(line.split("=")[1]); } catch { /* skip */ }
    }
  }

  _loadSkills() {
    this.skillsToDistill = [];
    const dir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith("__")) this.skillsToDistill.push(e.name);
    }
  }

  _scanWorkflows() {
    this.workflowsCreated = {};
    this.workflowsTested = {};
    this.workflowsPassing = [];
    this.tierAssignments = {};
    const wfDir = path.join(this._workspace.cwd, "workflows");
    if (!fs.existsSync(wfDir)) return;

    for (const e of fs.readdirSync(wfDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const ruleDir = path.join(wfDir, e.name);
        const pyFiles = fs.readdirSync(ruleDir).filter((f) => f.endsWith(".py"));
        if (pyFiles.length > 0) this.workflowsCreated[e.name] = pyFiles.length;
        const cfgPath = path.join(ruleDir, "config.json");
        if (fs.existsSync(cfgPath)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
            if (cfg.tier) this.tierAssignments[e.name] = cfg.tier;
            if (cfg.accuracy != null) {
              const acc = parseFloat(cfg.accuracy);
              this.workflowsTested[e.name] = acc;
              if (acc >= this._workflowAccuracy) this.workflowsPassing.push(e.name);
            }
          } catch { /* skip */ }
        }
      } else if (e.isFile() && e.name.endsWith(".py")) {
        this.workflowsCreated[path.parse(e.name).name] = 1;
      }
    }
  }

  describeState() {
    this._scanWorkspace();
    const total = this.skillsToDistill.length;
    const created = Object.keys(this.workflowsCreated).length;
    const passing = this.workflowsPassing.length;
    const parts = ["## Current Phase: DISTILLATION"];
    parts.push(`### Progress\n- Skills to distill: ${total}\n- Workflows created: ${created}\n- Workflows passing (>=${this._workflowAccuracy}): ${passing}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Ready\nAll workflows passing. Proceed to PRODUCTION_QC.");
    } else if (created === 0) {
      parts.push("### What to do now\nConvert proven skills into worker LLM workflows.\nFor each skill: write workflow script, write prompts, test vs ground truth, tier-downgrade test.");
    } else {
      const notCreated = this.skillsToDistill.filter((s) => !(s in this.workflowsCreated));
      const notPassing = Object.keys(this.workflowsCreated).filter((s) => !this.workflowsPassing.includes(s));
      let guidance = "### What to do now\n";
      if (notCreated.length) guidance += `Create workflows for: ${notCreated.slice(0, 10).join(", ")}\n`;
      if (notPassing.length) guidance += `Improve accuracy for: ${notPassing.slice(0, 10).join(", ")}\n`;
      parts.push(guidance);
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();
    if (toolName === "workspace_file" && ((toolInput.path || "").includes("workflows/") || (toolInput.path || "").includes("output/"))) {
      this._scanWorkflows();
    }
    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Distillation complete. Ready for PRODUCTION_QC.", nextPhase: Phase.PRODUCTION_QC });
    }
    return null;
  }

  exitCriteriaMet() {
    const total = this.skillsToDistill.length;
    if (!total) return false;
    return Object.keys(this.workflowsCreated).length >= total && this.workflowsPassing.length >= total;
  }
}
