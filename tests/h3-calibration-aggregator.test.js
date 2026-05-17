/**
 * Regression test for v0.8 P0-C — H3 calibration aggregator new shapes.
 *
 * Background:
 * Both v0.7.5 sessions (贷款话术 + 资管新规) shipped
 * `confidence_calibration.json` with empty `{"historical_accuracy": {}}`
 * despite having substantial QC data on disk:
 *   - 贷款: output/qc_results_v1.json (16 docs, per-doc rollup list)
 *   - 资管: output/results/production_qc_results.json (14 rules × 9 docs nested)
 *
 * The v0.7.2 aggregator only recognized rule_stats_v*.json + full_test_results_*.json
 * shapes. v0.8 P0-C adds two more shapes + a catch-all fallback.
 *
 * This test runs the aggregator against synthetic versions of both shapes
 * and asserts populated historical_accuracy.
 *
 * Run: `node tests/h3-calibration-aggregator.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ReleaseTool } from "../src/agent/tools/release.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-h3-test-"));
  fs.mkdirSync(path.join(dir, "output", "results"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  return dir;
}

function runAggregator(workspaceCwd) {
  // Construct a minimal ReleaseTool stand-in to access _aggregateAccuracyFromOutput.
  // The function only needs this._workspace.cwd.
  const tool = new ReleaseTool({ cwd: workspaceCwd });
  return tool._aggregateAccuracyFromOutput();
}

console.log("\nShape 3a: 资管-style nested rule-keyed map");
{
  const ws = makeTempWorkspace();
  fs.writeFileSync(path.join(ws, "output", "results", "production_qc_results.json"), JSON.stringify({
    batch: "production_qc_1",
    total_docs: 3,
    total_rules: 2,
    results: {
      "R01-01": {
        "docA": { verdict: "PASS", evidence: "ok", confidence: 0.9 },
        "docB": { verdict: "FAIL", evidence: "bad", confidence: 0.95 },
        "docC": { verdict: "PASS", evidence: "ok", confidence: 0.8 },
      },
      "R02-01": {
        "docA": { verdict: "PASS", confidence: 0.7 },
        "docB": { verdict: "NOT_APPLICABLE", confidence: 1.0 },
        "docC": { verdict: "WARNING", confidence: 0.6 },
      },
    },
  }, null, 2));

  const result = runAggregator(ws);
  assert(result !== null, "aggregator returned non-null");
  assert(result?.historical_accuracy, "historical_accuracy populated");
  assert(result?.historical_accuracy?.["R01-01"]?.n_samples === 3, "R01-01 sees 3 samples");
  assert(result?.historical_accuracy?.["R01-01"]?.pass_rate === 0.6667, `R01-01 pass_rate ~0.6667 (got ${result?.historical_accuracy?.["R01-01"]?.pass_rate})`);
  assert(result?.historical_accuracy?.["R02-01"]?.n_passed === 1, "R02-01 sees 1 pass");
  assert(result?.historical_accuracy?.["R02-01"]?.n_not_applicable === 2, "R02-01 NA + WARNING both count as NA");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 3b: 贷款-style per-doc rollup with failed_rules");
{
  const ws = makeTempWorkspace();
  fs.writeFileSync(path.join(ws, "rules", "catalog.json"), JSON.stringify({
    rules: [{ id: "R001" }, { id: "R002" }, { id: "R003" }],
  }));
  fs.writeFileSync(path.join(ws, "output", "qc_results_v1.json"), JSON.stringify({
    timestamp: "2026-05-13T21:28:00",
    qc_version: "v1",
    total_tested: 4,
    results: [
      { filename: "doc1.md", correct: true, failed_rules: [] },
      { filename: "doc2.md", correct: false, failed_rules: ["R001"] },
      { filename: "doc3.md", correct: false, failed_rules: ["R001", "R002"] },
      { filename: "doc4.md", correct: true, failed_rules: [] },
    ],
  }, null, 2));

  const result = runAggregator(ws);
  assert(result !== null, "aggregator returned non-null");
  assert(result?.historical_accuracy?.["R001"]?.n_failed === 2, "R001 failed on 2 docs");
  assert(result?.historical_accuracy?.["R001"]?.n_passed === 2, "R001 passed on 2 docs (4 total - 2 failed)");
  assert(result?.historical_accuracy?.["R002"]?.n_failed === 1, "R002 failed on 1 doc");
  assert(result?.historical_accuracy?.["R002"]?.n_passed === 3, "R002 passed on 3 docs");
  assert(result?.historical_accuracy?.["R003"]?.n_passed === 4, "R003 passed on all 4 (no failed_rules entries)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 4 (v0.8.1 P9-A): top-level fail_by_rule + pass_by_rule maps (贷款 v0.8 shape)");
{
  const ws = makeTempWorkspace();
  fs.mkdirSync(path.join(ws, "output", "qc"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "qc", "production_qc_report.json"), JSON.stringify({
    accuracy: 1.0,
    total_checks: 192,
    avg_confidence: 0.8351,
    fail_by_rule: { R001: 11, R002: 10, R003: 4, R004: 2 },
    pass_by_rule: { R001: 5, R002: 6, R003: 12, R004: 14 },
    low_confidence_count: 17,
  }));
  const result = runAggregator(ws);
  assert(result !== null, "Shape 4 detected");
  assert(result?.historical_accuracy?.["R001"]?.n_failed === 11, "R001 fail count");
  assert(result?.historical_accuracy?.["R001"]?.n_passed === 5, "R001 pass count");
  assert(result?.historical_accuracy?.["R004"]?.n_failed === 2, "R004 fail count");
  assert(result?.historical_accuracy?.["R004"]?.n_passed === 14, "R004 pass count");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 5 (v0.8.2 P13-A): doc-keyed → rules-keyed nested (贷款 v0.8.1 shape)");
{
  const ws = makeTempWorkspace();
  // 贷款 v0.8.1 wrote skill_test_v*_results.json + v2_hybrid_results.json
  // + run_all_checks.json all with this shape. Previously none of the
  // four shape recognizers matched and calibration shipped empty.
  fs.writeFileSync(path.join(ws, "output", "skill_test_v2_results.json"), JSON.stringify({
    "合规样本_001.md": {
      channel: "贷款产品介绍页",
      expected: "PASS",
      actual: "PASS",
      match: true,
      rules: {
        R01: { rule_id: "R01", verdict: "PASS", confidence: 0.95, method: "regex" },
        R02: { rule_id: "R02", verdict: "PASS", confidence: 0.90, method: "regex" },
        R03: { rule_id: "R03", verdict: "PASS", confidence: 0.85, method: "regex" },
      },
    },
    "违规样本_001.md": {
      channel: "贷款话术",
      expected: "FAIL",
      actual: "FAIL",
      match: true,
      rules: {
        R01: { rule_id: "R01", verdict: "FAIL", confidence: 0.98, method: "regex" },
        R02: { rule_id: "R02", verdict: "PASS", confidence: 0.80, method: "regex" },
        R03: { rule_id: "R03", verdict: "FAIL", confidence: 0.95, method: "regex" },
      },
    },
    "_meta": "not a doc — should be skipped (no rules field)",
  }));
  const result = runAggregator(ws);
  assert(result !== null, "Shape 5 detected");
  assert(result?.historical_accuracy?.R01?.n_passed === 1, "R01 sees 1 pass across docs");
  assert(result?.historical_accuracy?.R01?.n_failed === 1, "R01 sees 1 fail across docs");
  assert(result?.historical_accuracy?.R02?.n_passed === 2, "R02 sees 2 passes across docs");
  assert(result?.historical_accuracy?.R03?.n_passed === 1 && result?.historical_accuracy?.R03?.n_failed === 1, "R03 split 1/1");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 5 (v0.8.2 P13-A): with outer results wrapper");
{
  const ws = makeTempWorkspace();
  // v2_full_regression.json style — wrapped in {combined, engine, results...}
  // where the actual doc-keyed map is under a nested key
  fs.writeFileSync(path.join(ws, "output", "v2_regression_test.json"), JSON.stringify({
    results: {
      "doc1.md": {
        rules: {
          R01: { verdict: "PASS" },
          R02: { verdict: "FAIL" },
        },
      },
      "doc2.md": {
        rules: {
          R01: { verdict: "PASS" },
        },
      },
    },
  }));
  const result = runAggregator(ws);
  assert(result !== null, "Shape 5 with outer wrapper detected");
  assert(result?.historical_accuracy?.R01?.n_passed === 2, "R01 sees 2 passes through wrapper");
  assert(result?.historical_accuracy?.R02?.n_failed === 1, "R02 sees 1 fail through wrapper");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 6 (v0.8.3 P22-B6): array-of-{doc_id, results: [{rule_id, status}]} (资管 v0.8.2 shape)");
{
  const ws = makeTempWorkspace();
  // 资管 v0.8.2 wrote skill_test_v*.json with this shape — top-level
  // array, per-doc object with results array.
  fs.writeFileSync(path.join(ws, "output", "skill_test_v1.json"), JSON.stringify([
    {
      doc_id: "doc1",
      results: [
        { rule_id: "R01-01", status: "PASS", evidence: "..." },
        { rule_id: "R01-02", status: "FAIL", evidence: "..." },
        { rule_id: "R02-01", status: "WARNING", evidence: "5/7 fields" },
      ],
    },
    {
      doc_id: "doc2",
      results: [
        { rule_id: "R01-01", status: "PASS" },
        { rule_id: "R02-01", status: "NOT_APPLICABLE" },
      ],
    },
  ]));
  const result = runAggregator(ws);
  assert(result !== null, "Shape 6 (top-level array) detected");
  assert(result?.historical_accuracy?.["R01-01"]?.n_passed === 2, "R01-01 sees 2 passes across docs");
  assert(result?.historical_accuracy?.["R01-02"]?.n_failed === 1, "R01-02 sees 1 fail");
  // WARNING counts as PASS per Shape 6 convention
  assert(result?.historical_accuracy?.["R02-01"]?.n_passed === 1, "R02-01 WARNING tallied as pass");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 6: alternative rule-id field name (ruleId, id)");
{
  const ws = makeTempWorkspace();
  fs.writeFileSync(path.join(ws, "output", "workflow_v3_results.json"), JSON.stringify([
    { doc_id: "d1", results: [{ ruleId: "R01", verdict: "PASS" }] },
    { doc_id: "d2", results: [{ id: "R02", status: "FAIL" }] },
  ]));
  const result = runAggregator(ws);
  assert(result !== null, "alternative field names accepted");
  assert(result?.historical_accuracy?.["R01"]?.n_passed === 1, "ruleId field works");
  assert(result?.historical_accuracy?.["R02"]?.n_failed === 1, "id field works");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nShape 7 (fallback): unfamiliar filename with rule-keyed verdicts");
{
  const ws = makeTempWorkspace();
  // Future schema we haven't enumerated explicitly
  fs.writeFileSync(path.join(ws, "output", "verdict_summary.json"), JSON.stringify({
    "R01-01": { "doc1": { verdict: "PASS" }, "doc2": { verdict: "PASS" }, "doc3": { verdict: "FAIL" } },
    "R02-02": { "doc1": { verdict: "PASS" } },
  }));

  const result = runAggregator(ws);
  assert(result !== null, "fallback shape detected");
  assert(result?.historical_accuracy?.["R01-01"]?.n_samples === 3, "R01-01 sees 3 samples via fallback");
  assert(result?.source_files?.some((s) => /fallback shape/.test(s)), "source_files notes fallback");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nNegative: workspace with no QC artifacts returns null");
{
  const ws = makeTempWorkspace();
  const result = runAggregator(ws);
  assert(result === null, "returns null when no recognized QC files");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nRegression: real 资管 v0.7.5 workspace (if present)");
{
  const realWs = path.join(os.homedir(), ".kc_agent", "workspaces", "资管新规测试-075-002");
  if (fs.existsSync(realWs)) {
    const result = runAggregator(realWs);
    assert(result !== null, "aggregator finds something in 资管 v0.7.5 workspace");
    assert(result?.historical_accuracy && Object.keys(result.historical_accuracy).length > 0,
           `historical_accuracy non-empty (got ${Object.keys(result?.historical_accuracy || {}).length} rules)`);
    console.log(`    [info] 资管 aggregated rules: ${Object.keys(result?.historical_accuracy || {}).sort().join(", ")}`);
  } else {
    console.log("  (skipped — 资管 workspace not present)");
  }
}

console.log("\nv0.8.1 P9-D: scope filter — drops rule_ids not in current catalog");
{
  const ws = makeTempWorkspace();
  // Catalog lists only R001 + R002
  fs.writeFileSync(path.join(ws, "rules", "catalog.json"), JSON.stringify({
    rules: [{ id: "R001" }, { id: "R002" }],
  }));
  // QC report mentions 5 rules (R001-R005)
  fs.mkdirSync(path.join(ws, "output", "qc"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "qc", "production_qc_report.json"), JSON.stringify({
    fail_by_rule: { R001: 1, R002: 1, R003: 1, R004: 1, R005: 1 },
    pass_by_rule: { R001: 9, R002: 9, R003: 9, R004: 9, R005: 9 },
  }));

  const result = runAggregator(ws);
  assert(result !== null, "aggregator returned non-null");
  const ruleIds = Object.keys(result.historical_accuracy).sort();
  assert(ruleIds.length === 2, `historical_accuracy has 2 rules (got ${ruleIds.length})`);
  assert(ruleIds[0] === "R001" && ruleIds[1] === "R002", "only catalog rules remain");
  assert(Array.isArray(result.dropped_off_catalog), "dropped_off_catalog surfaced");
  assert(result.dropped_off_catalog.length === 3, "3 off-catalog rules dropped");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nv0.8.1 P9-D: no filter when catalog absent (backward compat)");
{
  const ws = makeTempWorkspace();
  fs.mkdirSync(path.join(ws, "output", "qc"), { recursive: true });
  fs.writeFileSync(path.join(ws, "output", "qc", "production_qc_report.json"), JSON.stringify({
    fail_by_rule: { R001: 1 },
    pass_by_rule: { R001: 5 },
  }));
  // No rules/catalog.json
  const result = runAggregator(ws);
  assert(result !== null, "still aggregates without catalog");
  assert(Object.keys(result.historical_accuracy).includes("R001"), "R001 present");
  assert(typeof result.dropped_off_catalog === "undefined", "no dropped_off_catalog key when no filter");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nRegression: real 贷款 v0.8 workspace (if present — Shape 4 must fire)");
{
  const realWs = path.join(os.homedir(), ".kc_agent", "workspaces", "贷款话术测试-080-001");
  if (fs.existsSync(realWs)) {
    const result = runAggregator(realWs);
    assert(result !== null, "aggregator finds something in 贷款 v0.8 workspace");
    const ruleCount = Object.keys(result?.historical_accuracy || {}).length;
    assert(ruleCount >= 12, `贷款 v0.8 aggregates ≥12 rules (got ${ruleCount})`);
    console.log(`    [info] 贷款 v0.8 aggregated rules: ${Object.keys(result?.historical_accuracy || {}).sort().slice(0, 6).join(", ")}...`);
  } else {
    console.log("  (skipped — 贷款 v0.8 workspace not present)");
  }
}

console.log("\nRegression: real 贷款 v0.7.5 workspace (if present)");
{
  const realWs = path.join(os.homedir(), ".kc_agent", "workspaces", "贷款话术测试-075-002");
  if (fs.existsSync(realWs)) {
    const result = runAggregator(realWs);
    assert(result !== null, "aggregator finds something in 贷款 v0.7.5 workspace");
    assert(result?.historical_accuracy && Object.keys(result.historical_accuracy).length > 0,
           `historical_accuracy non-empty (got ${Object.keys(result?.historical_accuracy || {}).length} rules)`);
    console.log(`    [info] 贷款 aggregated rules: ${Object.keys(result?.historical_accuracy || {}).sort().join(", ")}`);
  } else {
    console.log("  (skipped — 贷款 workspace not present)");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
