/**
 * Regression test for v0.8 P0-E — prescriptive refusal hints.
 *
 * Background:
 * 资管 v0.7.5 audit: 5/6 forced phase advances (83% force ratio). Engine
 * refused phase_advance with descriptive engineCounts (`workflowsTested:
 * 0/14 — gate not met`), agent did 3 min of cleanup, then forced past.
 * The engine signal was being consumed but the descriptive hint didn't
 * tell the agent WHAT to write. Prescriptive hints fix this.
 *
 * Run: `node tests/prescriptive-hints.test.js`
 */
import { getPrescriptiveHint } from "../src/agent/pipelines/_advance-hints.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nEvery phase produces a non-empty prescriptive hint");
{
  const phases = ["bootstrap", "rule_extraction", "skill_authoring", "skill_testing", "distillation", "production_qc", "finalization"];
  for (const p of phases) {
    const hint = getPrescriptiveHint(p, null, "");
    assert(hint && hint.length > 50, `${p}: hint is substantive (${hint.length} chars)`);
  }
}

console.log("\nHints name concrete artifacts (file paths + filename patterns)");
{
  const ruleExtraction = getPrescriptiveHint("rule_extraction", null, "");
  assert(/rules\/catalog\.json/i.test(ruleExtraction), "rule_extraction names rules/catalog.json");

  const skillAuthoring = getPrescriptiveHint("skill_authoring", null, "");
  assert(/rule_skills\/<rule_id>\/SKILL\.md/i.test(skillAuthoring), "skill_authoring names rule_skills/<rule_id>/SKILL.md");
  assert(/uppercase/i.test(skillAuthoring), "skill_authoring teaches uppercase SKILL.md (P0-B integration)");

  const distillation = getPrescriptiveHint("distillation", null, "");
  assert(/workflows\/<rule_id>\/workflow_v1\.py/i.test(distillation), "distillation names workflows/<rule_id>/workflow_v1.py");

  const productionQc = getPrescriptiveHint("production_qc", null, "");
  assert(/production_qc_results\.json/i.test(productionQc), "production_qc names production_qc_results.json (matches v0.8 P0-C aggregator)");
}

console.log("\nengineCountsLine is integrated into the output when present");
{
  const hint = getPrescriptiveHint("distillation", null, "workflowsTested: 0/14");
  assert(/workflowsTested: 0\/14/.test(hint), "engineCountsLine appears in hint");
  assert(/Engine telemetry:/.test(hint), "telemetry has a labeled header");
}

console.log("\nUnknown phase returns a generic fallback");
{
  const hint = getPrescriptiveHint("not_a_real_phase", null, "");
  assert(hint && hint.length > 0, "fallback hint is non-empty");
}

console.log("\nFinalization (terminal) gives a no-op hint");
{
  const hint = getPrescriptiveHint("finalization", null, "");
  assert(/terminal/i.test(hint), "finalization hint identifies as terminal");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
