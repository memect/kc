/**
 * Regression test for v0.7.5 → v0.8 P0-A — consult_skill init-order bug.
 *
 * Background:
 * v0.7.5 shipped with an init-order bug in src/agent/engine.js where
 *   this._buildTools = this._createAllTools();   // runs FIRST
 *   ...
 *   this._skillLoader = new SkillLoader();        // runs SECOND
 * meant ConsultSkillTool received `undefined` as its skillLoader and threw
 *   "Cannot read properties of undefined (reading 'getPhaseSkillSet')"
 * on every consult_skill invocation. 5/5 failure rate observed in the
 * 资管 v0.7.5 session (archive/e2e_test_20260514_v075_资管新规_session_audit.md
 * § 9.1 finding 1).
 *
 * The fix: reorder so SkillLoader is constructed BEFORE _createAllTools
 * (engine.js:238 now precedes :241). This regression test pins:
 *   - Positive: ConsultSkillTool with a real SkillLoader works
 *   - Defensive: ConsultSkillTool with null/malformed skillLoader returns
 *     a ToolResult error rather than throwing an uncaught exception
 *
 * Run: `node tests/consult-skill-init-order.test.js`
 * Pass: process exits 0.
 * Fail: process exits 1 with stack trace.
 */
import { ConsultSkillTool } from "../src/agent/tools/consult-skill.js";
import { SkillLoader } from "../src/agent/skill-loader.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function test(name, fn) {
  console.log(`\n${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.error(`  ✗ threw: ${e.message}\n${e.stack}`);
  }
}

await test("Positive: ConsultSkillTool with real SkillLoader", async () => {
  const loader = new SkillLoader("en");
  const tool = new ConsultSkillTool(
    null,                            // workspace (unused for this path)
    loader,
    () => "bootstrap",               // getCurrentPhase
    null,                            // eventLog (best-effort)
  );

  const result = await tool.execute({ name: "bootstrap-workspace" });
  assert(result && typeof result === "object", "returns a ToolResult-shaped object");
  assert(result.isError === false || result.isError === undefined, "not isError (bootstrap-workspace is always-loaded in bootstrap)");
  assert(typeof result.content === "string" && result.content.length > 0, "returns non-empty content (hint or body)");
});

await test("Positive: load body for an available (non-always-loaded) skill", async () => {
  const loader = new SkillLoader("en");
  const tool = new ConsultSkillTool(
    null,
    loader,
    () => "bootstrap",               // bootstrap has 'data-sensibility' in available
    null,
  );

  const result = await tool.execute({ name: "data-sensibility" });
  assert(result.isError === false || result.isError === undefined, "not isError");
  assert(result.content && result.content.length > 100, "returns substantive body content");
});

await test("Defensive (init-order regression): skillLoader=null returns ToolResult error", async () => {
  // Simulate the v0.7.5 bug: ConsultSkillTool constructed with undefined skillLoader
  // because _createAllTools ran before _skillLoader was initialized.
  const tool = new ConsultSkillTool(null, null, () => "bootstrap", null);

  let thrown = null;
  let result = null;
  try {
    result = await tool.execute({ name: "bootstrap-workspace" });
  } catch (e) {
    thrown = e;
  }

  assert(thrown === null, "did NOT throw (the v0.7.5 failure mode was uncaught exception)");
  assert(result !== null && result.isError === true, "returned ToolResult with isError=true");
  assert(/misconfigured|skillLoader/i.test(result?.content || ""), "error message references the misconfiguration");
});

await test("Defensive: skillLoader is malformed object (no getPhaseSkillSet) returns ToolResult error", async () => {
  const tool = new ConsultSkillTool(null, {}, () => "bootstrap", null);

  let thrown = null;
  let result = null;
  try {
    result = await tool.execute({ name: "bootstrap-workspace" });
  } catch (e) {
    thrown = e;
  }

  assert(thrown === null, "did NOT throw");
  assert(result !== null && result.isError === true, "returned ToolResult with isError=true");
});

await test("Defensive: missing name returns ToolResult error", async () => {
  const loader = new SkillLoader("en");
  const tool = new ConsultSkillTool(null, loader, () => "bootstrap", null);

  const result = await tool.execute({});
  assert(result.isError === true, "isError=true on missing name");
});

await test("Phase-scoping: skill not in current phase's available set returns isError", async () => {
  const loader = new SkillLoader("en");
  const tool = new ConsultSkillTool(
    null,
    loader,
    () => "bootstrap",  // bootstrap does NOT have 'evolution-loop' available
    null,
  );

  const result = await tool.execute({ name: "evolution-loop" });
  assert(result.isError === true, "isError=true for out-of-phase skill");
  assert(/not available in phase/i.test(result.content), "message explains phase mismatch");
});

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
