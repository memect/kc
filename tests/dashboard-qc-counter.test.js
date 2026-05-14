/**
 * Regression test for v0.8 P1-G — dashboard QC counter.
 *
 * Background:
 * 资管 v0.7.5 audit § 9.1 finding 4: dashboard showed `QC Batches: 0`
 * despite production_qc_results.json having 126 pairs of data. Cause:
 * dashboard-render.js read only `output/qc/*.json` top-level, missing
 * 资管's `output/results/production_qc_results.json` shape AND missing
 * 贷款's per-doc reviews at `output/qc/reviews/`.
 *
 * v0.8 P1-G: walk three known agent-write locations, count batches +
 * docs reviewed (deduped from totals).
 *
 * Run: `node tests/dashboard-qc-counter.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DashboardRenderTool } from "../src/agent/tools/dashboard-render.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kc-dash-test-"));
}
function metricsOf(cwd) {
  const tool = new DashboardRenderTool({ cwd });
  return tool._collectMetrics();
}

console.log("\n资管 shape: production_qc_results.json with nested results");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "output", "results"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "results", "production_qc_results.json"), JSON.stringify({
    batch: "production_qc_1",
    total_docs: 9,
    total_rules: 14,
    results: {
      "R01-01": {
        "docA": { verdict: "PASS" },
        "docB": { verdict: "FAIL" },
      },
    },
  }));
  const m = metricsOf(ws);
  assert(m.qc_batches === 1, `qc_batches=1 (got ${m.qc_batches})`);
  assert(m.qc_docs_reviewed === 9, `qc_docs_reviewed=9 from total_docs (got ${m.qc_docs_reviewed})`);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\n贷款 shape: review_001.json + per-doc reviews");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "output", "qc", "reviews"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "qc", "review_001.json"), JSON.stringify({
    batch_id: "production_batch_001",
    documents_reviewed: 16,
  }));
  for (let i = 1; i <= 16; i++) {
    fs.writeFileSync(path.join(ws, "output", "qc", "reviews", `doc_${i}.json`), "{}");
  }
  const m = metricsOf(ws);
  assert(m.qc_batches === 1, `qc_batches=1 (got ${m.qc_batches})`);
  assert(m.qc_docs_reviewed === 16, `qc_docs_reviewed=16 (got ${m.qc_docs_reviewed})`);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nNo QC artifacts: counters stay 0");
{
  const ws = tmpWs();
  const m = metricsOf(ws);
  assert(m.qc_batches === 0, "qc_batches=0");
  assert(m.qc_docs_reviewed === 0, "qc_docs_reviewed=0");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nReal-workspace regression: 资管 v0.7.5");
{
  const ws = "/Users/mac/.kc_agent/workspaces/资管新规测试-075-002";
  if (fs.existsSync(ws)) {
    const m = metricsOf(ws);
    assert(m.qc_batches >= 1, `资管 qc_batches >=1 (got ${m.qc_batches})`);
    assert(m.qc_docs_reviewed >= 9, `资管 qc_docs_reviewed >=9 (got ${m.qc_docs_reviewed})`);
  } else {
    console.log("  (skipped — 资管 absent)");
  }
}

console.log("\nReal-workspace regression: 贷款 v0.7.5");
{
  const ws = "/Users/mac/.kc_agent/workspaces/贷款话术测试-075-002";
  if (fs.existsSync(ws)) {
    const m = metricsOf(ws);
    assert(m.qc_batches >= 1, `贷款 qc_batches >=1 (got ${m.qc_batches})`);
    assert(m.qc_docs_reviewed === 16, `贷款 qc_docs_reviewed=16 (got ${m.qc_docs_reviewed})`);
  } else {
    console.log("  (skipped — 贷款 absent)");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
