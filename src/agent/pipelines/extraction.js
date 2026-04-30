import fs from "node:fs";
import path from "node:path";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { deriveRuleExtractionMilestones, deriveSkillAuthoringMilestones } from "./_milestone-derive.js";

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
    // v0.7.0 A1: route through filesystem-derived milestone helper.
    // Existing instance state (rulesExtracted, rulesWithChunkRefs,
    // coverageAudited) becomes a cache of disk facts rather than a
    // running record of which tools fired. Tool-wrapper recorders can
    // still bump these via engine._recordMilestone but disk wins on
    // any rescan.
    const m = deriveRuleExtractionMilestones(this._workspace);
    this.rulesExtracted = [...m.rulesExtracted];
    this.rulesWithChunkRefs = [...m.rulesWithChunkRefs];
    this.coverageAudited = m.coverageAudited;

    // regulationsScanned: presence of any non-JSON file in rules/. Kept
    // local to this pipeline (not in the helper) because "did the agent
    // copy regs into the workspace" is a cheap heuristic specific to
    // this phase.
    const rulesDir = path.join(this._workspace.cwd, "rules");
    if (fs.existsSync(rulesDir)) {
      try {
        const regFiles = fs.readdirSync(rulesDir).filter(
          (f) => !f.endsWith(".json") && fs.statSync(path.join(rulesDir, f)).isFile(),
        );
        this.regulationsScanned = regFiles.length > 0;
      } catch { /* skip */ }
    }

    // Union with rule_skills/ dirs — sometimes agents create skill dirs
    // before adding to catalog.json (XM E2E #5 stranded-catalog case).
    // Pulled from the skill-authoring helper so we share the canonical
    // skill dir scan.
    const sa = deriveSkillAuthoringMilestones(this._workspace);
    for (const dirName of sa.skillsAuthored) {
      if (!this.rulesExtracted.includes(dirName)) {
        this.rulesExtracted.push(dirName);
      }
    }

    this._scanTests();
  }

  _scanTests() {
    // v0.7.0 A1: rulesWithTests now accepts multiple test shapes (was
    // form-prescriptive on test_cases/ only — none of E2E #5's three
    // alive contestants used that exact path; the gate refused all).
    // Now: a rule is "tested" iff it has ANY of:
    //   rule_skills/<id>/test_cases/   (canonical, original)
    //   rule_skills/<id>/tests/        (alt spelling)
    //   rule_skills/<id>/check*.py     (check IS the test for many rules)
    //   rule_skills/<id>/scripts/check*.py (XM-style nested scripts)
    //   rule_skills/<id>/assets/test_cases.json
    // Spirit of the gate is "did the agent leave test artifacts behind"
    // not "did they use this exact directory name."
    this.rulesWithTests = [];
    const skillsDir = path.join(this._workspace.cwd, "rule_skills");
    if (!fs.existsSync(skillsDir)) return;
    for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const skillPath = path.join(skillsDir, e.name);
      const testDirA = path.join(skillPath, "test_cases");
      const testDirB = path.join(skillPath, "tests");
      const assetsTests = path.join(skillPath, "assets", "test_cases.json");

      let hasTest = false;
      if (fs.existsSync(testDirA) && fs.readdirSync(testDirA).length > 0) hasTest = true;
      if (!hasTest && fs.existsSync(testDirB) && fs.readdirSync(testDirB).length > 0) hasTest = true;
      if (!hasTest && fs.existsSync(assetsTests)) hasTest = true;
      // Check files: any check*.py at root or under scripts/
      if (!hasTest) {
        try {
          const files = fs.readdirSync(skillPath);
          if (files.some((f) => /^check.*\.py$/i.test(f))) hasTest = true;
          else if (files.includes("scripts")) {
            const scriptsDir = path.join(skillPath, "scripts");
            try {
              if (fs.readdirSync(scriptsDir).some((f) => /^check.*\.py$/i.test(f))) hasTest = true;
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
      if (hasTest) this.rulesWithTests.push(e.name);
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
    // v0.7.0 A1: dropped explicit `regulationsScanned` gate — rulesExtracted
    // > 0 already implies the agent read regulations from somewhere
    // (catalog.json wouldn't exist otherwise). The old criterion measured
    // "did the agent copy regs into workspace/rules/" — ceremonial work
    // none of E2E #5's three contestants did because they read directly
    // from projectDir/rules/.
    return this.rulesExtracted.length > 0 &&
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

    // v0.7.1 2a/2b: when agent attempts phase_advance from rule_extraction,
    // surface advisories for the two soft-but-load-bearing artifacts the
    // gate criteria require (chunk_refs and coverage_audit). v0.7.0 GLM
    // session forced through with both missing — gate refused for the
    // right reason but the refusal text was generic. Name them inline.
    if (toolName === "phase_advance" && toolInput?.to === "skill_authoring") {
      const advisories = [];
      if (this.rulesExtracted.length > 0 && this.rulesWithChunkRefs.length === 0) {
        advisories.push(
          `Advancing rule_extraction with rulesWithChunkRefs=0/${this.rulesExtracted.length}. ` +
          `The skill_authoring phase's prompts use source_chunk_ids to ground ` +
          `skill explanations against regulation text. Without them, skill authoring ` +
          `runs blind. Either populate chunk refs via the rule_catalog tool, or ` +
          `accept that skill_authoring's generated content won't cite source regulation.`,
        );
      }
      if (this.rulesExtracted.length > 0 && !this.coverageAudited) {
        advisories.push(
          `Advancing rule_extraction without rules/coverage_audit.md (or .json). ` +
          `Coverage audit identifies regulation articles you didn't extract a rule ` +
          `for — without it, gaps go silent through to production. If your ` +
          `extraction is genuinely complete, write a one-paragraph audit confirming so.`,
        );
      }
      if (advisories.length > 0) return advisories.join("\n\n");
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
