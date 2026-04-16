import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

export class RuleExtractionPipeline extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.regulationsScanned = false;
    this.rulesExtracted = [];
    this.rulesWithTests = [];
    this.coverageAudited = false;
    this._scanWorkspace();
  }

  _scanWorkspace() {
    const rulesDir = path.join(this._workspace.cwd, "rules");
    if (fs.existsSync(rulesDir)) {
      const regFiles = fs.readdirSync(rulesDir).filter((f) => !f.endsWith(".json") && fs.statSync(path.join(rulesDir, f)).isFile());
      this.regulationsScanned = regFiles.length > 0;
    }
    this._scanRules();
    this._scanTests();
    this.coverageAudited = fs.existsSync(path.join(this._workspace.cwd, "rules", "coverage_audit.md")) ||
                           fs.existsSync(path.join(this._workspace.cwd, "rules", "coverage_audit.json"));
  }

  _scanRules() {
    this.rulesExtracted = [];
    const catalogPath = path.join(this._workspace.cwd, "rules", "catalog.json");
    if (fs.existsSync(catalogPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
        if (Array.isArray(data)) this.rulesExtracted = data.map((r, i) => r.id || `rule_${i}`);
      } catch { /* skip */ }
    }
    const skillsDir = path.join(this._workspace.cwd, "rule_skills");
    if (fs.existsSync(skillsDir)) {
      for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith("__") && !this.rulesExtracted.includes(e.name)) {
          this.rulesExtracted.push(e.name);
        }
      }
    }
  }

  _scanTests() {
    this.rulesWithTests = [];
    const skillsDir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(skillsDir)) return;
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const testDir = path.join(skillsDir, e.name, "test_cases");
      if (fs.existsSync(testDir) && fs.readdirSync(testDir).length > 0) {
        this.rulesWithTests.push(e.name);
      }
    }
  }

  describeState() {
    this._scanWorkspace();
    const parts = ["## Current Phase: EXTRACTION"];
    parts.push(`### Progress\n- Regulations scanned: ${this.regulationsScanned ? "yes" : "no"}\n- Rules extracted: ${this.rulesExtracted.length}\n- Rules with tests: ${this.rulesWithTests.length}\n- Coverage audit: ${this.coverageAudited ? "done" : "not yet"}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Ready\nExtraction complete. Proceed to SKILL_AUTHORING phase.");
    } else if (this.rulesExtracted.length === 0) {
      parts.push("### What to do now\nDecompose regulations into atomic, testable rules.\n- One rule = one pass/fail outcome\n- Work top-down: major areas → chapters → sections → atomic rules\n- Save rules to rules/catalog.json via rule_catalog tool");
    } else if (!this.coverageAudited) {
      parts.push("### What to do now\nRun a coverage audit: which regulation sections are NOT covered? Save to rules/coverage_audit.md");
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();
    if (toolName === "workspace_file" || toolName === "rule_catalog") {
      this._scanWorkspace();
    }
    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Extraction complete. Ready for SKILL_AUTHORING.", nextPhase: Phase.SKILL_AUTHORING });
    }
    return null;
  }

  exitCriteriaMet() {
    return this.regulationsScanned && this.rulesExtracted.length > 0 &&
      this.rulesWithTests.length >= Math.max(this.rulesExtracted.length * 0.8, 1) && this.coverageAudited;
  }
}
