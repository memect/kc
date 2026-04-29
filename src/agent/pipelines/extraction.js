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
    // v0.6.1 A1: track which rules in catalog.json have non-empty
    // source_chunk_ids — D1 grounded skill_authoring prompts on these but
    // exit didn't require them, so a sloppy extraction could leave rules
    // unmoored.
    this.rulesWithChunkRefs = [];
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
    this.rulesWithChunkRefs = [];
    const catalogPath = path.join(this._workspace.cwd, "rules", "catalog.json");
    if (fs.existsSync(catalogPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
        if (Array.isArray(data)) {
          this.rulesExtracted = data.map((r, i) => r.id || `rule_${i}`);
          // A1: collect ids whose entry has non-empty source_chunk_ids
          for (const r of data) {
            const ids = r?.source_chunk_ids;
            if (Array.isArray(ids) && ids.length > 0 && r?.id) {
              this.rulesWithChunkRefs.push(r.id);
            }
          }
        }
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
    const parts = ["## Phase: RULE_EXTRACTION\nRead and decompose regulation documents into atomic, testable verification rules. This is BUILD mode — do the analysis directly. (Distinct from data/entity extraction work that skills perform internally.)"];
    parts.push(`### Progress\n- Regulations scanned: ${this.regulationsScanned ? "yes" : "no"}\n- Rules extracted: ${this.rulesExtracted.length}\n- Rules with test stubs: ${this.rulesWithTests.length}\n- Coverage audit: ${this.coverageAudited ? "done" : "pending"}`);

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nExtraction complete. Proceed to SKILL_AUTHORING.");
    }

    const chunkRefsOk = this._chunkRefsCriterionMet();
    parts.push(
      `### Exit criteria\n` +
      `- [${this.regulationsScanned ? "x" : " "}] All regulations read\n` +
      `- [${this.rulesExtracted.length > 0 ? "x" : " "}] Rules decomposed into atomic units\n` +
      `- [${this.rulesWithTests.length >= Math.max(this.rulesExtracted.length * 0.8, 1) ? "x" : " "}] >=80% of rules have test stubs\n` +
      `- [${this.coverageAudited ? "x" : " "}] Coverage audit completed\n` +
      `- [${chunkRefsOk ? "x" : " "}] Every rule has source_chunk_ids in catalog.json (${this.rulesWithChunkRefs.length}/${this._catalogRuleCount()})`,
    );
    return parts.join("\n\n");
  }

  /**
   * v0.6.1 A1: number of rules currently in catalog.json (not the union with
   * rule_skills/ dirs that rulesExtracted carries). Used by the chunk-refs
   * gate so we compare apples to apples.
   */
  _catalogRuleCount() {
    const catalogPath = path.join(this._workspace.cwd, "rules", "catalog.json");
    if (!fs.existsSync(catalogPath)) return 0;
    try {
      const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      return Array.isArray(data) ? data.length : 0;
    } catch { return 0; }
  }

  /**
   * v0.6.1 A1: pass when every rule in catalog.json has a non-empty
   * source_chunk_ids array. Empty catalog (legacy / pre-D1 sessions) passes
   * trivially so resume of v0.6.0 sessions doesn't get trapped.
   */
  _chunkRefsCriterionMet() {
    const total = this._catalogRuleCount();
    if (total === 0) return true; // backwards-compat for sessions pre-D1
    return this.rulesWithChunkRefs.length >= total;
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
      this.rulesWithTests.length >= Math.max(this.rulesExtracted.length * 0.8, 1) &&
      this.coverageAudited &&
      // v0.6.1 A1: hard tracking — D1 source-context auto-attach requires
      // catalog.json entries to carry source_chunk_ids. Without them the
      // skill_authoring prompts are blind.
      this._chunkRefsCriterionMet();
  }

  /**
   * v0.6.3 (#74): RULE_EXTRACTION should produce rules/catalog.json + per-rule
   * markdown extraction notes, not python check scripts or workflows.
   */
  phaseMisfitHint(toolName, toolInput, result) {
    if (result?.isError) return null;
    const exitText = this.exitCriteriaMet()
      ? "Extraction exit criteria are MET — call phase_advance(to=\"skill_authoring\") to switch phases before continuing."
      : "Extraction exit criteria NOT yet met. Either finish extraction first, or use force:true on phase_advance.";

    if (toolName === "workspace_file" && toolInput?.operation === "write") {
      const p = toolInput.path || "";
      // Writing the actual python check is unambiguous skill-authoring work.
      if (/^rule_skills\/[^/]+\/check_r\d+\.py$/.test(p) || p.endsWith("/SKILL.md") && p.startsWith("rule_skills/")) {
        return `Writing "${p}" is SKILL_AUTHORING-phase work, but engine is in RULE_EXTRACTION. ${exitText}`;
      }
      if (p.startsWith("workflows/")) {
        return `Writing under workflows/ is DISTILLATION-phase work, but engine is in RULE_EXTRACTION. ${exitText}`;
      }
      if (p.startsWith("output/results/")) {
        return `Writing under output/results/ is PRODUCTION_QC-phase work, but engine is in RULE_EXTRACTION. ${exitText}`;
      }
    }

    if (toolName === "workflow_run") {
      return `workflow_run is SKILL_TESTING/PRODUCTION_QC-phase work, but engine is in RULE_EXTRACTION. ${exitText}`;
    }

    return null;
  }

  exportState() {
    return {
      regulationsScanned: this.regulationsScanned,
      rulesExtracted: this.rulesExtracted,
      rulesWithTests: this.rulesWithTests,
      rulesWithChunkRefs: this.rulesWithChunkRefs,
      coverageAudited: this.coverageAudited,
    };
  }

  importState(data) {
    if (data.regulationsScanned) this.regulationsScanned = true;
    if (data.coverageAudited) this.coverageAudited = true;
    // Arrays: use imported as floor, then re-scan will reconcile
    if (Array.isArray(data.rulesExtracted) && data.rulesExtracted.length > this.rulesExtracted.length) {
      this.rulesExtracted = data.rulesExtracted;
    }
    if (Array.isArray(data.rulesWithTests) && data.rulesWithTests.length > this.rulesWithTests.length) {
      this.rulesWithTests = data.rulesWithTests;
    }
    if (Array.isArray(data.rulesWithChunkRefs) && data.rulesWithChunkRefs.length > this.rulesWithChunkRefs.length) {
      this.rulesWithChunkRefs = data.rulesWithChunkRefs;
    }
  }
}
