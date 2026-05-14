/**
 * Regression test for v0.8 P1-A — milestone derivation gaps.
 *
 * Background:
 * - 贷款 v0.7.5 audit: wrote output/qc/review_001.json with `documents_reviewed: 16`
 *   and 16 per-doc reviews at output/qc/reviews/doc_*.json, but engine's
 *   `deriveProductionQcMilestones` returned documents_reviewed=0. Result:
 *   forced final phase advance.
 * - 资管 v0.7.5 audit: wrote rule_skills/coverage_report.md, but engine's
 *   `deriveFinalizationMilestones` checked only rules/ and output/, returning
 *   coverageReportWritten=false.
 *
 * v0.8 P1-A fixes:
 *   - New findFileAcrossKnownPaths helper.
 *   - deriveFinalizationMilestones + deriveRuleExtractionMilestones accept
 *     rule_skills/coverage_report.md, rules/coverage_audit.md, plus several
 *     future-proofing variants.
 *   - deriveProductionQcMilestones reads per-doc reviews at output/qc/reviews/
 *     and recognizes top-level numeric `documents_reviewed: N` claims.
 *
 * Run: `node tests/milestone-derive-p1a.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  deriveProductionQcMilestones,
  deriveFinalizationMilestones,
  deriveRuleExtractionMilestones,
} from "../src/agent/pipelines/_milestone-derive.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kc-p1a-test-"));
}

console.log("\nproduction_qc: per-doc reviews at output/qc/reviews/");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "output", "qc", "reviews"), { recursive: true });
  for (let i = 1; i <= 16; i++) {
    fs.writeFileSync(
      path.join(ws, "output", "qc", "reviews", `doc_${String(i).padStart(3, "0")}.json`),
      JSON.stringify({ review_id: `doc_${i}`, document: `合规样本_${i}`, verdict: "通过", confidence: 0.9 }),
    );
  }
  // Also write the batch summary file
  fs.writeFileSync(path.join(ws, "output", "qc", "review_001.json"), JSON.stringify({
    review_id: "qc_review_001",
    batch_id: "production_batch_001",
    documents_reviewed: 16,
    accuracy: 1.0,
  }));

  const m = deriveProductionQcMilestones(ws);
  assert(m.batchesProcessed >= 1, "batchesProcessed counts the batch summary");
  assert(m.documentsReviewed === 16, `documentsReviewed=16 (got ${m.documentsReviewed})`);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nproduction_qc: numeric documents_reviewed claim used as fallback");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "output", "qc"), { recursive: true });
  // No per-doc reviews; only the summary with the numeric claim
  fs.writeFileSync(path.join(ws, "output", "qc", "review_001.json"), JSON.stringify({
    batch_id: "b1",
    documents_reviewed: 12,
  }));

  const m = deriveProductionQcMilestones(ws);
  assert(m.documentsReviewed === 12, `documentsReviewed=12 from numeric claim (got ${m.documentsReviewed})`);
  assert(m.documentsReviewedDeclared === 12, "documentsReviewedDeclared echoes the claim when bigger than set");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nproduction_qc: deduped doc set wins when bigger than claim");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "output", "qc", "reviews"), { recursive: true });
  for (let i = 1; i <= 20; i++) {
    fs.writeFileSync(
      path.join(ws, "output", "qc", "reviews", `doc_${i}.json`),
      JSON.stringify({ document: `d${i}`, verdict: "PASS" }),
    );
  }
  fs.writeFileSync(path.join(ws, "output", "qc", "review_001.json"), JSON.stringify({
    batch_id: "b1",
    documents_reviewed: 10, // smaller than actual
  }));

  const m = deriveProductionQcMilestones(ws);
  assert(m.documentsReviewed === 20, `deduped set wins (got ${m.documentsReviewed})`);
  assert(m.documentsReviewedDeclared === 0, "documentsReviewedDeclared=0 when set already exceeds claim");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nfinalization: coverage_report.md at rule_skills/ (资管)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills"), { recursive: true });
  fs.writeFileSync(path.join(ws, "rule_skills", "coverage_report.md"), "# coverage");
  const m = deriveFinalizationMilestones(ws);
  assert(m.coverageReportWritten === true, "rule_skills/coverage_report.md accepted");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nfinalization: coverage_audit.md at rules/ (贷款)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.writeFileSync(path.join(ws, "rules", "coverage_audit.md"), "# audit");
  const m = deriveFinalizationMilestones(ws);
  assert(m.coverageReportWritten === true, "rules/coverage_audit.md accepted");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nrule_extraction: same flexibility (consistency)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills"), { recursive: true });
  fs.writeFileSync(path.join(ws, "rule_skills", "coverage_report.md"), "# coverage");
  const m = deriveRuleExtractionMilestones(ws);
  assert(m.coverageAudited === true, "rule_extraction also accepts rule_skills/coverage_report.md");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nReal-workspace regression: 贷款 v0.7.5");
{
  const ws = "/Users/mac/.kc_agent/workspaces/贷款话术测试-075-002";
  if (fs.existsSync(ws)) {
    const q = deriveProductionQcMilestones(ws);
    const f = deriveFinalizationMilestones(ws);
    assert(q.documentsReviewed === 16, `贷款 docs=16 (got ${q.documentsReviewed})`);
    assert(f.coverageReportWritten === true, "贷款 coverageReportWritten=true");
  } else {
    console.log("  (skipped — 贷款 workspace absent)");
  }
}

console.log("\nReal-workspace regression: 资管 v0.7.5");
{
  const ws = "/Users/mac/.kc_agent/workspaces/资管新规测试-075-002";
  if (fs.existsSync(ws)) {
    const f = deriveFinalizationMilestones(ws);
    assert(f.coverageReportWritten === true, "资管 coverageReportWritten=true");
  } else {
    console.log("  (skipped — 资管 workspace absent)");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
