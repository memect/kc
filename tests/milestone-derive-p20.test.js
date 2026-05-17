/**
 * Regression test for v0.8.3 P20-B1 + P20-B2 — engine derivation bugs
 * that blocked 资管's natural skill_testing advance in E2E #13.
 *
 * P20-B1 (rules/*.json dedup): agent wrote sibling `rules/difficulty.json`
 *   (15 entries, same IDs as catalog.json + judgment-type metadata
 *   inspired by the v0.8.2 P15-D logic-type taxonomy teaching).
 *   `deriveRuleExtractionMilestones` walked all rules/*.json and pushed
 *   IDs without dedup → 15 + 15 = 30 entries in `rulesExtracted`.
 *   Engine telemetry then showed `rulesCovered: 0/30` instead of 0/15.
 *
 * P20-B2 (compound rule IDs in canonicalRuleId): 资管 catalog used
 *   compound IDs following regulation subsection numbering: R01-01,
 *   R01-02, ..., R02-03, R03-01, R07-01. canonicalRuleId() only
 *   matched `^R0*(\d+)$` (bare-numeric) → all 15 compound IDs returned
 *   null → 0/15 numerator. Combined with B1's 30 denominator gave the
 *   bogus `rulesCovered: 0/30` that blocked skill_testing advance.
 *
 * Run: `node tests/milestone-derive-p20.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  deriveRuleExtractionMilestones,
  deriveSkillAuthoringMilestones,
  canonicalRuleId,
} from "../src/agent/pipelines/_milestone-derive.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kc-p20-test-"));
}

console.log("\nP20-B1: rules/*.json dedup across multiple files");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  // catalog.json: 15 rules with compound IDs (资管 shape)
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify([
      { id: "R01-01", chunk_ids: ["c1"] },
      { id: "R01-02", chunk_ids: ["c2"] },
      { id: "R01-03", chunk_ids: ["c3"] },
      { id: "R02-01", chunk_ids: ["c4"] },
      { id: "R02-02", chunk_ids: ["c5"] },
    ]),
  );
  // difficulty.json: same IDs + judgment-type metadata
  fs.writeFileSync(
    path.join(ws, "rules", "difficulty.json"),
    JSON.stringify([
      { id: "R01-01", judgment_type: "Threshold" },
      { id: "R01-02", judgment_type: "Decision-Tree" },
      { id: "R01-03", judgment_type: "Heuristic" },
      { id: "R02-01", judgment_type: "Process" },
      { id: "R02-02", judgment_type: "Threshold" },
    ]),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesExtracted.length === 5, `dedup'd to 5 (was ${m.rulesExtracted.length}, would be 10 without dedup)`);
  assert(m.rulesWithChunkRefs.length === 5, `chunk-ref count credited from first-seen file (was ${m.rulesWithChunkRefs.length})`);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP20-B1: dedup preserves order-of-first-seen across files");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "rules", "01_catalog.json"),
    JSON.stringify([{ id: "R01", chunk_ids: ["c1"] }, { id: "R02", chunk_ids: ["c2"] }]),
  );
  fs.writeFileSync(
    path.join(ws, "rules", "02_extra.json"),
    JSON.stringify([{ id: "R02", chunk_ids: [] }, { id: "R03", chunk_ids: ["c3"] }]),
  );
  const m = deriveRuleExtractionMilestones({ cwd: ws });
  assert(m.rulesExtracted.length === 3, "3 unique IDs across both files");
  assert(m.rulesExtracted.includes("R01") && m.rulesExtracted.includes("R02") && m.rulesExtracted.includes("R03"), "all 3 IDs present");
  assert(m.rulesWithChunkRefs.length === 3, "R02's chunk_ref credit from FIRST file (which had c2), not second (empty)");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP20-B2: canonicalRuleId — compound forms");
{
  // Bare-numeric still works
  assert(canonicalRuleId("R14") === "R014", "R14 → R014 (zero-pad to 3 digits)");
  assert(canonicalRuleId("r014") === "R014", "lowercase normalized");
  assert(canonicalRuleId("R0014") === "R014", "extra leading zero stripped");
  // Compound forms
  assert(canonicalRuleId("R01-01") === "R001-01", "R01-01 → R001-01 (major zero-pad 3, minor zero-pad 2)");
  assert(canonicalRuleId("R02-03") === "R002-03", "R02-03 → R002-03");
  assert(canonicalRuleId("R07-01") === "R007-01", "R07-01 → R007-01");
  assert(canonicalRuleId("R001-005") === "R001-05", "minor 005 → 05 (2-digit canonical)");
  assert(canonicalRuleId("R1-1") === "R001-01", "R1-1 → R001-01");
  assert(canonicalRuleId("R01_01") === "R001-01", "underscore separator → canonical dash");
  // Non-matching
  assert(canonicalRuleId("account_identity") === null, "thematic name returns null");
  assert(canonicalRuleId("") === null, "empty string returns null");
  assert(canonicalRuleId(null) === null, "non-string returns null");
  assert(canonicalRuleId("R01-01-extra") === null, "extra trailing junk returns null");
}

console.log("\nP20-B2: deriveSkillAuthoringMilestones credits compound-ID dirs");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rule_skills"), { recursive: true });
  // 资管-style: dirs named with compound IDs
  for (const rid of ["R01-01", "R01-02", "R02-03", "R07-01"]) {
    const dir = path.join(ws, "rule_skills", rid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${rid}\n`);
    fs.writeFileSync(path.join(dir, "check.py"), "def check(): return {'verdict': 'PASS'}\n");
  }
  const m = deriveSkillAuthoringMilestones({ cwd: ws });
  assert(m.skillsAuthored.length === 4, "4 dirs counted as authored");
  assert(m.ruleIdsCovered.length === 4, "4 compound IDs credited");
  // Verify canonical form is what's in ruleIdsCovered
  assert(m.ruleIdsCovered.includes("R001-01"), "R001-01 (canonical of R01-01) credited");
  assert(m.ruleIdsCovered.includes("R001-02"), "R001-02 (canonical of R01-02) credited");
  assert(m.ruleIdsCovered.includes("R002-03"), "R002-03 (canonical of R02-03) credited");
  assert(m.ruleIdsCovered.includes("R007-01"), "R007-01 (canonical of R07-01) credited");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nP20-B1+B2 combined: 资管 v0.8.2 reproduction case");
{
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, "rules"), { recursive: true });
  fs.mkdirSync(path.join(ws, "rule_skills"), { recursive: true });

  // Catalog: 15 compound-ID rules
  const compoundIds = ["R01-01", "R01-02", "R01-03", "R01-04", "R01-05",
                       "R01-06", "R01-07", "R01-08", "R01-09", "R01-10",
                       "R02-01", "R02-02", "R02-03", "R03-01", "R07-01"];
  fs.writeFileSync(
    path.join(ws, "rules", "catalog.json"),
    JSON.stringify(compoundIds.map(id => ({ id, chunk_ids: [`c_${id}`] }))),
  );
  // difficulty.json: same 15 IDs (Bug B1 trigger)
  fs.writeFileSync(
    path.join(ws, "rules", "difficulty.json"),
    JSON.stringify(compoundIds.map(id => ({ id, judgment_type: "Threshold" }))),
  );
  // 15 skill dirs (Bug B2 trigger)
  for (const rid of compoundIds) {
    const dir = path.join(ws, "rule_skills", rid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${rid}\n`);
    fs.writeFileSync(path.join(dir, "check.py"), "def check(): pass\n");
  }

  const re = deriveRuleExtractionMilestones({ cwd: ws });
  assert(re.rulesExtracted.length === 15, `B1 fix: 15 unique rules (not 30 with double-count). Got: ${re.rulesExtracted.length}`);

  const sa = deriveSkillAuthoringMilestones({ cwd: ws });
  assert(sa.ruleIdsCovered.length === 15, `B2 fix: 15 compound-ID dirs credited. Got: ${sa.ruleIdsCovered.length}`);

  // Verify what an engine telemetry comparison would show:
  // canonical catalog IDs == canonical ruleIdsCovered
  const canonCatalog = new Set(compoundIds.map(id => canonicalRuleId(id)));
  const covered = new Set(sa.ruleIdsCovered);
  const allCatalogCovered = [...canonCatalog].every(id => covered.has(id));
  assert(allCatalogCovered, "all 15 catalog IDs match covered set after canonicalization");

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
