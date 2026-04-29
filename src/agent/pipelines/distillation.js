import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { deriveDistillationMilestones } from "./_milestone-derive.js";

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
    // v0.7.0 A1: route through filesystem-derived helper. The helper
    // recognizes all three workflow layouts seen in E2E #5:
    //   workflows/<id>/workflow_v#.py  (canonical, release.js's expectation)
    //   workflows/<id>_workflow.py     (DS + GLM flat layout)
    //   workflows/<id>.json            (DS regex_skill manifest)
    // Engine-emitted entries (v0.6.1 A6) are still preserved as a soft
    // overlay — disk wins on counter membership, but accuracy /
    // tier-assignment data set by tool wrappers is kept.
    const engineWfTested = { ...this.workflowsTested };
    const engineWfPassing = [...this.workflowsPassing];

    const m = deriveDistillationMilestones(this._workspace);
    // workflowsCreated becomes a {ruleId: 1} dict for backwards-compat
    // with downstream code that uses Object.keys() / `id in workflows`.
    this.workflowsCreated = {};
    for (const id of m.workflowsCreated) this.workflowsCreated[id] = 1;

    this.workflowsTested = {};
    this.workflowsPassing = [];
    this.tierAssignments = {};

    // Layered: also read per-rule config.json for tier + accuracy
    // metadata — this is auxiliary signal not represented on the
    // filesystem at the workflow-existence level.
    const wfDir = path.join(this._workspace.cwd, "workflows");
    if (fs.existsSync(wfDir)) {
      for (const e of fs.readdirSync(wfDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const cfgPath = path.join(wfDir, e.name, "config.json");
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
      }
    }
    // Helper-derived workflowsTested too (per-workflow test_results/ etc.)
    for (const id of m.workflowsTested) {
      if (!(id in this.workflowsTested)) this.workflowsTested[id] = 1.0;
      if (!this.workflowsPassing.includes(id)) this.workflowsPassing.push(id);
    }

    // Re-merge engine-emitted entries (v0.6.1 A6 carry-forward)
    for (const [k, v] of Object.entries(engineWfTested)) {
      if (!(k in this.workflowsTested)) this.workflowsTested[k] = v;
    }
    for (const id of engineWfPassing) {
      if (!this.workflowsPassing.includes(id)) this.workflowsPassing.push(id);
    }
  }

  describeState() {
    this._scanWorkspace();
    const total = this.skillsToDistill.length;
    const created = Object.keys(this.workflowsCreated).length;
    const passing = this.workflowsPassing.length;
    const notCreated = this.skillsToDistill.filter((s) => !(s in this.workflowsCreated));
    const notPassing = Object.keys(this.workflowsCreated).filter((s) => !this.workflowsPassing.includes(s));

    const parts = ["## Phase: DISTILLATION\nConvert proven skills into worker LLM workflows that run cheaply at scale. Skill results from the testing phase are the accuracy baseline — workflow results must match them. Worker LLM tools (worker_llm_call, tier_downgrade, workflow_run) are now available."];
    parts.push(`### Progress\n- Skills to distill: ${total}\n- Workflows created: ${created}\n- Workflows passing (>=${this._workflowAccuracy}): ${passing}`);
    if (notCreated.length) parts.push(`- Need workflows: ${notCreated.slice(0, 10).join(", ")}`);
    if (notPassing.length) parts.push(`- Below threshold: ${notPassing.slice(0, 10).join(", ")}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nAll workflows passing. Proceed to PRODUCTION_QC.");
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

  exportState() {
    return {
      skillsToDistill: this.skillsToDistill,
      workflowsCreated: this.workflowsCreated,
      workflowsTested: this.workflowsTested,
      workflowsPassing: this.workflowsPassing,
      tierAssignments: this.tierAssignments,
    };
  }

  importState(data) {
    if (Array.isArray(data.skillsToDistill) && data.skillsToDistill.length > this.skillsToDistill.length) this.skillsToDistill = data.skillsToDistill;
    if (Array.isArray(data.workflowsPassing) && data.workflowsPassing.length > this.workflowsPassing.length) this.workflowsPassing = data.workflowsPassing;
    if (data.workflowsCreated && typeof data.workflowsCreated === "object") Object.assign(this.workflowsCreated, data.workflowsCreated);
    if (data.workflowsTested && typeof data.workflowsTested === "object") Object.assign(this.workflowsTested, data.workflowsTested);
    if (data.tierAssignments && typeof data.tierAssignments === "object") Object.assign(this.tierAssignments, data.tierAssignments);
  }
}
