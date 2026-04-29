import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

export class SkillTestingPipeline extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.skillsToTest = [];
    this.skillsTested = {};
    this.skillsPassing = [];
    this.iterationCount = 0;
    this._accuracyThreshold = 0.9;
    this._maxIterations = 20;
    this._scanWorkspace();
  }

  _scanWorkspace() {
    this._loadConfig();
    this._loadSkills();
    this._loadTestResults();
    this._loadEvolutionLog();
  }

  _loadConfig() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      if (line.startsWith("SKILL_ACCURACY=")) try { this._accuracyThreshold = parseFloat(line.split("=")[1]); } catch { /* skip */ }
      if (line.startsWith("MAX_ITERATIONS=")) try { this._maxIterations = parseInt(line.split("=")[1]); } catch { /* skip */ }
    }
  }

  _loadSkills() {
    this.skillsToTest = [];
    const dir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith("__")) {
        const p = path.join(dir, e.name);
        if (fs.existsSync(path.join(p, "SKILL.md")) || fs.readdirSync(p).some((f) => f.endsWith(".py"))) {
          this.skillsToTest.push(e.name);
        }
      }
    }
  }

  _loadTestResults() {
    this.skillsTested = {};
    this.skillsPassing = [];
    const outDir = path.join(this._workspace.cwd, "output");
    if (!fs.existsSync(outDir)) return;
    for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf-8"));
        if (data.accuracy != null) {
          const ruleId = data.rule_id || path.parse(f).name;
          const acc = parseFloat(data.accuracy);
          this.skillsTested[ruleId] = Math.max(this.skillsTested[ruleId] || 0, acc);
        }
      } catch { /* skip */ }
    }
    this.skillsPassing = Object.entries(this.skillsTested).filter(([, acc]) => acc >= this._accuracyThreshold).map(([id]) => id);
  }

  _loadEvolutionLog() {
    const logDir = path.join(this._workspace.cwd, "logs", "evolution");
    if (!fs.existsSync(logDir)) { this.iterationCount = 0; return; }
    this.iterationCount = fs.readdirSync(logDir).filter((f) => f.endsWith(".json")).length;
  }

  describeState() {
    this._scanWorkspace();
    const total = this.skillsToTest.length;
    const tested = Object.keys(this.skillsTested).length;
    const passing = this.skillsPassing.length;
    const failing = Object.entries(this.skillsTested).filter(([, acc]) => acc < this._accuracyThreshold);
    const untested = this.skillsToTest.filter((s) => !(s in this.skillsTested));

    const parts = ["## Phase: SKILL_TESTING\nTest skills against sample documents, iterate via evolution loop until accuracy threshold is met. This is BUILD mode — the results established here become the accuracy baseline for distillation."];
    parts.push(`### Progress\n- Skills to test: ${total}\n- Tested: ${tested}\n- Passing (>=${this._accuracyThreshold}): ${passing}\n- Evolution iterations: ${this.iterationCount}/${this._maxIterations}`);
    if (untested.length) parts.push(`- Untested: ${untested.slice(0, 10).join(", ")}`);
    if (failing.length) parts.push(`- Below threshold:\n${failing.map(([id, acc]) => `  - ${id}: ${acc.toFixed(2)}`).join("\n")}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nAll skills passing. Proceed to DISTILLATION.");
    } else if (this.iterationCount >= this._maxIterations) {
      parts.push(`### Max iterations (${this._maxIterations}) reached. Discuss remaining failures with the developer user.`);
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();
    if (toolName === "workspace_file" || toolName === "evolution_cycle") this._scanWorkspace();
    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Skill testing complete. Ready for DISTILLATION.", nextPhase: Phase.DISTILLATION });
    }
    return null;
  }

  exitCriteriaMet() {
    const total = this.skillsToTest.length;
    if (!total) return false;
    return Object.keys(this.skillsTested).length >= total && this.skillsPassing.length >= total * this._accuracyThreshold;
  }

  /**
   * v0.6.3 (#74): SKILL_TESTING runs check scripts against test samples and
   * measures accuracy. Writing distillation outputs or production results
   * here means phase boundaries got skipped.
   */
  phaseMisfitHint(toolName, toolInput, result) {
    if (result?.isError) return null;
    const exitText = this.exitCriteriaMet()
      ? "Skill-testing exit criteria are MET — call phase_advance(to=\"distillation\")."
      : "Skill-testing not yet complete.";

    if (toolName === "workspace_file" && toolInput?.operation === "write") {
      const p = toolInput.path || "";
      if (p.startsWith("workflows/")) {
        return `Writing under workflows/ is DISTILLATION-phase work, but engine is in SKILL_TESTING. ${exitText}`;
      }
      if (p.startsWith("output/results/")) {
        return `Writing under output/results/ is PRODUCTION_QC-phase work, but engine is in SKILL_TESTING. ${exitText}`;
      }
    }
    return null;
  }

  exportState() {
    return {
      skillsToTest: this.skillsToTest,
      skillsTested: this.skillsTested,
      skillsPassing: this.skillsPassing,
      iterationCount: this.iterationCount,
    };
  }

  importState(data) {
    if (typeof data.iterationCount === "number" && data.iterationCount > this.iterationCount) this.iterationCount = data.iterationCount;
    if (Array.isArray(data.skillsToTest) && data.skillsToTest.length > this.skillsToTest.length) this.skillsToTest = data.skillsToTest;
    if (Array.isArray(data.skillsPassing) && data.skillsPassing.length > this.skillsPassing.length) this.skillsPassing = data.skillsPassing;
    if (data.skillsTested && typeof data.skillsTested === "object") {
      for (const [k, v] of Object.entries(data.skillsTested)) {
        if (!this.skillsTested[k] || v > this.skillsTested[k]) this.skillsTested[k] = v;
      }
    }
  }
}
