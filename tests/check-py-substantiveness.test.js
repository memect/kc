/**
 * Regression test for v0.8 P2-F (item 22) — check.py substantiveness audit.
 *
 * Background:
 * 资管 v0.7.5 audit § 3.4: all 14 rule_skills/<id>/check.py files were
 * 29-30 line scaffolds returning `{"verdict": "NOT_APPLICABLE", "evidence":
 * "Check requires worker LLM execution"}` literally. Substantive SKILL.md
 * existed but check.py was a placeholder. Real logic lived in
 * workflows/<rule>/workflow_v1.py — but check.py did NOT import or
 * delegate to it.
 *
 * v0.8 P2-F adds detection in _milestone-derive.js. Stub criteria:
 *   - Returns one of: NOT_APPLICABLE / pass:null / method:stub literal
 *   - AND has no other verdict (PASS/FAIL/WARNING) anywhere
 *   - AND doesn't import a workflow
 *
 * Run: `node tests/check-py-substantiveness.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveSkillAuthoringMilestones } from "../src/agent/pipelines/_milestone-derive.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function tmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-p2f-test-"));
  fs.mkdirSync(path.join(dir, "rule_skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rules", "catalog.json"), JSON.stringify({ rules: [{ id: "R001" }, { id: "R002" }] }));
  return dir;
}
function writeSkill(ws, ruleId, checkPyContent) {
  const skillDir = path.join(ws, "rule_skills", ruleId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Skill\nMethodology here.");
  fs.writeFileSync(path.join(skillDir, "check.py"), checkPyContent);
}

const STUB_RESACE = `"""Verification check script for R001."""
import json
import sys

def check(document_text: str) -> dict:
    # This is a scaffolding check
    return {
        "rule_id": "R001",
        "verdict": "NOT_APPLICABLE",
        "evidence": "Check requires worker LLM execution",
        "confidence": 0.0
    }
`;

const STUB_LEGACY = `def check(doc):
    return {"pass": None, "method": "stub"}
`;

const SUBSTANTIVE_REGEX = `import re

def check(document_text):
    if re.search(r"年化利率\\s*[:：]\\s*\\d+", document_text):
        return {"verdict": "PASS", "evidence": "annual rate disclosed", "confidence": 0.9}
    return {"verdict": "FAIL", "evidence": "missing annual rate", "confidence": 0.85}
`;

const SUBSTANTIVE_DELEGATING = `from workflows.R001.workflow_v1 import verify

def check(document_text):
    return verify(document_text, config={})
`;

console.log("\n资管 shape: stub returning NOT_APPLICABLE only");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", STUB_RESACE);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyTotal === 1, "1 check.py");
  assert(r.checkPyStubCount === 1, "detected as stub");
  assert(r.checkPyStubRatio === 1, "ratio 1.0");
  assert(r.checkPyStubFiles[0] === "R001/check.py", "stub file path correct");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nLegacy v0.7.0 stub: pass:null");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", STUB_LEGACY);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyStubCount === 1, "legacy stub detected");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nSubstantive with PASS/FAIL branches");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", SUBSTANTIVE_REGEX);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyTotal === 1, "1 check.py");
  assert(r.checkPyStubCount === 0, "NOT stub (has PASS + FAIL branches)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nSubstantive: delegates to workflow");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", SUBSTANTIVE_DELEGATING);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyStubCount === 0, "NOT stub (imports workflow)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nMixed: some stub, some substantive");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", STUB_RESACE);
  writeSkill(ws, "R002", SUBSTANTIVE_REGEX);
  writeSkill(ws, "R003", STUB_LEGACY);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyTotal === 3, "3 check.py files");
  assert(r.checkPyStubCount === 2, "2 stubs (R001 + R003)");
  assert(Math.abs(r.checkPyStubRatio - 0.667) < 0.01, `ratio ≈0.667 (got ${r.checkPyStubRatio})`);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nEdge: NOT_APPLICABLE used as fallback (with PASS path) — NOT stub");
{
  const ws = tmpWs();
  writeSkill(ws, "R001", `
import re
def check(doc):
    if re.search(r"PASS", doc):
        return {"verdict": "PASS", "evidence": "found"}
    return {"verdict": "NOT_APPLICABLE", "evidence": "no match"}
`);
  const r = deriveSkillAuthoringMilestones(ws);
  assert(r.checkPyStubCount === 0, "real branching — not a stub even with NOT_APPLICABLE fallback");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nReal-workspace regression: 资管 v0.7.5 (14 stubs / 14)");
{
  const ws = "/Users/mac/.kc_agent/workspaces/资管新规测试-075-002";
  if (fs.existsSync(ws)) {
    const r = deriveSkillAuthoringMilestones(ws);
    assert(r.checkPyTotal === 14, `资管 14 check.py (got ${r.checkPyTotal})`);
    assert(r.checkPyStubCount === 14, `all 14 detected as stubs (got ${r.checkPyStubCount})`);
    assert(r.checkPyStubRatio === 1, "ratio 1.0");
  } else {
    console.log("  (skipped — workspace absent)");
  }
}

console.log("\nReal-workspace regression: 贷款 v0.7.5 (substantive, 0 stubs)");
{
  const ws = "/Users/mac/.kc_agent/workspaces/贷款话术测试-075-002";
  if (fs.existsSync(ws)) {
    const r = deriveSkillAuthoringMilestones(ws);
    assert(r.checkPyTotal === 14, `贷款 14 check.py (got ${r.checkPyTotal})`);
    assert(r.checkPyStubCount === 0, `0 stubs — substantive regex (got ${r.checkPyStubCount})`);
  } else {
    console.log("  (skipped — workspace absent)");
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
