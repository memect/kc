/**
 * Regression test for v0.8.2 P13-C + P13-D — milestone derivation
 * gaps surfaced by E2E #12.
 *
 * P13-C: catalog field-name drift. 贷款 v0.8.1 catalog wrote
 *        `chunk_ids` (the form agents naturally pick); engine derivation
 *        looked only for `source_chunk_ids`. Result: rulesWithChunkRefs=0/12
 *        phantom. Fix: accept source_chunk_ids OR chunk_ids OR chunk_refs.
 *
 * P13-D: thematic overlay dirs in rule_skills/. 资管 v0.8.1 wrote 6
 *        overlays (R01_periodic_report, R02_custodian_core, etc.) with
 *        rule_mapping.json instead of per-rule check.py. The mapping
 *        points at engine-level verify_v*.py functions. Without
 *        recognizing rule_mapping.json, the dirs don't credit any rules.
 *        Fix: read rule_mapping.json keys, credit each as a covered rule.
 *
 * Run: `node tests/milestone-derive-p13.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  deriveRuleExtractionMilestones,
  deriveSkillAuthoringMilestones,
} from "../src/agent/pipelines/_milestone-derive.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kc-p13-test-"));
}

console.log("\nP13-C: rulesWithChunkRefs accepts chunk_ids");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  // 贷款 v0.8.1 style — top-level array with `chunk_ids` field per rule
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify([
      { id: "R01", source_ref: "x", chunk_ids: ["file00_c002"] },
      { id: "R02", source_ref: "y", chunk_ids: ["file00_c005", "file01_c001"] },
      { id: "R03", source_ref: "z", chunk_ids: [] }, // empty array — should NOT credit
      { id: "R04", source_ref: "w" }, // no chunk field at all — should NOT credit
    ]),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesExtracted.length === 4, "all 4 rules extracted");
  assert(m.rulesWithChunkRefs.length === 2, "2 rules have non-empty chunk_ids");
  assert(m.rulesWithChunkRefs.includes("R01"), "R01 credited");
  assert(m.rulesWithChunkRefs.includes("R02"), "R02 credited");
  assert(!m.rulesWithChunkRefs.includes("R03"), "R03 not credited (empty array)");
  assert(!m.rulesWithChunkRefs.includes("R04"), "R04 not credited (no field)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-C: rulesWithChunkRefs accepts source_chunk_ids (canonical)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify({
      rules: [
        { id: "R01", source_chunk_ids: ["c1"] },
        { id: "R02" },
      ],
    }),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesWithChunkRefs.length === 1, "canonical source_chunk_ids still works");
  assert(m.rulesWithChunkRefs.includes("R01"), "R01 credited via canonical field");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-C: rulesWithChunkRefs accepts chunk_refs (legacy alias)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify([
      { id: "R01", chunk_refs: ["c1", "c2"] },
    ]),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesWithChunkRefs.length === 1, "legacy chunk_refs accepted");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-C: mixed field names across rules");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify([
      { id: "R01", chunk_ids: ["c1"] },
      { id: "R02", source_chunk_ids: ["c2"] },
      { id: "R03", chunk_refs: ["c3"] },
      { id: "R04" },
    ]),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesWithChunkRefs.length === 3, "3 rules credited via mixed field names");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-D: rule_mapping.json credits rule_ids in thematic overlay dirs");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills", "R01_periodic_report"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rule_skills", "R01_periodic_report", "SKILL.md"),
    "# R01_periodic_report\n\n## Description\nThematic overlay covering R01-05..R01-09\n",
  );
  fs.writeFileSync(
    path.join(ws, "rule_skills", "R01_periodic_report", "rule_mapping.json"),
    JSON.stringify({
      "R01-05": "verify_v3.check_R01_05",
      "R01-06": "verify_v3.check_R01_06",
      "R01-07": "verify_v3.check_R01_07",
    }),
  );
  // Also create the leaf Rxx-NN dirs that the overlay covers, so the
  // derivation has a realistic shape
  for (const rid of ["R01-05", "R01-06", "R01-07"]) {
    fs.mkdirSync(path.join(ws, "rule_skills", rid), { recursive: true });
    fs.writeFileSync(path.join(ws, "rule_skills", rid, "SKILL.md"), "# " + rid);
    fs.writeFileSync(path.join(ws, "rule_skills", rid, "check.py"), "def check(): pass\n");
  }

  const m = deriveSkillAuthoringMilestones({ cwd: ws });
  assert(m.skillsAuthored.includes("R01_periodic_report"),
    "overlay dir counted as authored (has SKILL.md)");
  // The overlay dir's rule_mapping.json should credit R01-05/06/07.
  // v0.8.3 P20-B2: canonicalRuleId now normalizes compound IDs to
  // 3-digit-major form (R01-05 → R001-05), so check the canonical form.
  assert(m.ruleIdsCovered.includes("R001-05"), "rule_mapping.json credited R001-05 (canonical of R01-05)");
  assert(m.ruleIdsCovered.includes("R001-06"), "rule_mapping.json credited R001-06 (canonical of R01-06)");
  assert(m.ruleIdsCovered.includes("R001-07"), "rule_mapping.json credited R001-07 (canonical of R01-07)");

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-D: rule_mapping.json works even without SKILL.md (overlay-only dir)");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills", "R02_custodian_core"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rule_skills", "R02_custodian_core", "rule_mapping.json"),
    JSON.stringify({ "R02-01": "verify.f", "R02-02": "verify.g" }),
  );

  const m = deriveSkillAuthoringMilestones({ cwd: ws });
  // v0.8.3 P20-B2: canonicalized
  assert(m.ruleIdsCovered.includes("R002-01"), "R002-01 (canonical of R02-01) credited via mapping (no SKILL.md)");
  assert(m.ruleIdsCovered.includes("R002-02"), "R002-02 (canonical of R02-02) credited via mapping (no SKILL.md)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP13-D: malformed rule_mapping.json (not an object) skipped gracefully");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills", "weird_overlay"), { recursive: true });
  fs.writeFileSync(path.join(ws, "rule_skills", "weird_overlay", "SKILL.md"), "# weird");
  fs.writeFileSync(
    path.join(ws, "rule_skills", "weird_overlay", "rule_mapping.json"),
    JSON.stringify(["R01", "R02"]), // array, not object
  );
  let threw = null;
  try {
    deriveSkillAuthoringMilestones({ cwd: ws });
  } catch (e) {
    threw = e;
  }
  assert(threw === null, "no throw on malformed mapping");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
