// v0.8 P0-E: prescriptive refusal hints for phase_advance gate failures.
//
// 资管 + 贷款 v0.7.5 audits both observed the force-bypass pattern:
// engine refuses phase_advance with `engineCounts: workflowsTested: 0/14`,
// agent does ~3 min of cleanup, then forces past anyway. Cleanup happens
// (signal IS being consumed) but force always wins because the descriptive
// "exit criteria not met" hint doesn't tell the agent WHAT to write.
//
// v0.8 P0-E replaces the descriptive hint with a prescriptive one. The
// hint text below derives from the same artifact paths + filename patterns
// that _milestone-derive.js walks, so the agent's instructions match what
// the engine will check next turn.
//
// Design contract (matches v0.8 design doc Q20 user lean):
//   - Single shared helper here; engine.js + phase-advance.js both call it.
//   - Each hint is one or two concrete sentences naming a path, a filename
//     pattern, and a script to run (where applicable).
//   - Hint output is plain text, suitable to drop into a tool result.
//
// To extend: edit the per-phase hint generators below. Keep the artifact
// paths in sync with the corresponding derive function in _milestone-derive.js.

/**
 * Build a prescriptive refusal hint for a phase_advance gate failure.
 *
 * @param {string} fromPhase — the phase the agent is trying to leave
 * @param {object} engineCounts — raw engine counts (or null)
 * @param {string} [engineCountsLine] — formatted summary string from _buildEngineCountsBlock
 * @returns {string} a multi-line hint suitable for the LLM tool result
 */
export function getPrescriptiveHint(fromPhase, engineCounts, engineCountsLine = "") {
  const header = engineCountsLine
    ? `Engine telemetry: ${engineCountsLine}\n\n`
    : "";

  const hint = HINTS_BY_PHASE[fromPhase];
  if (!hint) {
    return header + "Check the system prompt's phase state block for missing milestones. The engine derives milestones from filesystem facts.";
  }
  return header + hint;
}

const HINTS_BY_PHASE = {
  bootstrap:
    "To advance to rule_extraction:\n" +
    "  • Verify <workspace>/source_docs/ contains the regulation file(s) you're extracting rules from.\n" +
    "  • Verify <workspace>/samples/ contains at least one sample document for testing.\n" +
    "  • Ensure AGENT.md exists at workspace root with project context filled in.\n" +
    "Engine reads filesystem facts; no need to call any 'mark bootstrap complete' tool — just produce the artifacts.",

  rule_extraction:
    "To advance to skill_authoring:\n" +
    "  • For each rule in the source regulation, write an entry to rules/catalog.json with {id, source_ref, falsifiability_statement, applicable_sections}.\n" +
    "  • Use rule_catalog tool (operation: 'write') for catalog entries; engine derives `rulesExtracted` from this file.\n" +
    "  • For chunk traceability: each catalog entry should reference its source chunk via applicable_sections.\n" +
    "  • Write rule_skills/coverage_report.md or rules/coverage_report.md to mark coverageAudited=true (a per-rule × per-section table).",

  skill_authoring:
    "To advance to skill_testing:\n" +
    "  • For each rule_id in rules/catalog.json, create rule_skills/<rule_id>/SKILL.md (uppercase! engine path-match is case-sensitive on Linux).\n" +
    "  • Each SKILL.md needs frontmatter (id, name, description) + a body describing verification logic.\n" +
    "  • Pair each SKILL.md with rule_skills/<rule_id>/check.py — substantive logic, NOT a 'return NOT_APPLICABLE' stub. If logic lives in workflows/, check.py must import + call the workflow.\n" +
    "  • For grouped skills covering multiple rules, frontmatter MUST include `source_rules: [R001, R005, ...]` so engine credits each rule_id.\n" +
    "  • Engine counts `rulesCovered` from rule_skills/ walk; aim for catalog.json's full rule list.",

  skill_testing:
    "To advance to distillation:\n" +
    "  • For each rule_id, write test results to output/results/skill_test_round<N>.json or output/results/<rule_id>_<sample>.json.\n" +
    "  • Each test result needs `verdict` (PASS/FAIL/NOT_APPLICABLE) plus per-rule accuracy.\n" +
    "  • Engine counts `skillsTested` from these files. Aim for ≥1 result per rule, with ≥90% accuracy on labeled samples.\n" +
    "  • If a rule consistently fails, iterate the SKILL.md + check.py before advancing (this is the evolution-loop pattern).",

  distillation:
    "To advance to production_qc:\n" +
    "  • For each rule_id, write workflows/<rule_id>/workflow_v1.py (regex-only or hybrid regex+worker_llm).\n" +
    "  • Each workflow.py needs a `verify(document_text, config)` function returning {verdict, evidence, confidence, ...}.\n" +
    "  • Engine counts `workflowsCreated` from workflows/<rule_id>/workflow_v*.py walk.\n" +
    "  • Run scripts/v1_regression.py (or equivalent) to populate output/results/v1_regression.json — engine counts `workflowsTested` from this.\n" +
    "  • For grouped workflows (one workflow covering multiple rules), declare `source_rules: [...]` in workflow's docstring or sidecar config.",

  production_qc:
    "To advance to finalization:\n" +
    "  • Write output/results/production_qc_results.json (preferred shape: {results: {<rule_id>: {<doc_id>: {verdict, evidence, confidence}}}}).\n" +
    "  • OR write output/qc/review_<batch>.json with `documents_reviewed: N` for each batch — engine sums across files.\n" +
    "  • Engine counts `batchesProcessed` and `documentsReviewed`. Each batch should cover the full doc set OR a meaningful sample.\n" +
    "  • If accuracy is below threshold, run evolution-loop on the failing rules before advancing.",

  finalization:
    "(Finalization is the terminal phase — no forward advance.)",
};

export default getPrescriptiveHint;
