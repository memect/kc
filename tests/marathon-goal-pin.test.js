/**
 * Regression test for v0.8.2 P12-A — marathon goal pinned at the
 * system-prompt layer via ContextAssembler.
 *
 * v0.8.1 regression (E2E #12): only the marathon `initial` template
 * embedded the goal in the user_message stream. After context_windowed
 * evicted that message, the agent lost the goal and reverted to default
 * behavior — both 贷款 and 资管 sessions skipped "use worker_llm in v2".
 *
 * v0.8.2 P12-A: the goal lives in the system prompt as a parallel slot
 * to AGENT_IDENTITY. Never windowed. Survives the entire marathon
 * session.
 *
 * Run: `node tests/marathon-goal-pin.test.js`
 */
import fs from "node:fs";
import { ContextAssembler } from "../src/agent/context.js";

const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nContextAssembler.build — marathonGoal slot");
{
  const c = new ContextAssembler();
  const out = c.build({ marathonGoal: "iterate twice, lean into tier1 worker_llm" });
  assert(out.includes("Marathon goal"), "section header present when goal set");
  assert(out.includes("iterate twice, lean into tier1 worker_llm"), "goal text embedded");
  assert(out.includes("pinned for the duration"), "explanatory note present");
}

console.log("\nContextAssembler.build — no slot when goal absent");
{
  const c = new ContextAssembler();
  const out = c.build({});
  assert(!out.includes("Marathon goal"), "no marathon section when goal undefined");

  const out2 = c.build({ marathonGoal: null });
  assert(!out2.includes("Marathon goal"), "no marathon section when goal explicitly null");

  const out3 = c.build({ marathonGoal: "" });
  assert(!out3.includes("Marathon goal"), "no marathon section when goal empty string");
}

console.log("\nContextAssembler.build — marathon section ordering (after AGENT_IDENTITY, before pipelineState)");
{
  const c = new ContextAssembler();
  const out = c.build({
    marathonGoal: "MARATHON_GOAL_TEXT",
    pipelineState: "PIPELINE_STATE_TEXT",
    workspaceState: "WORKSPACE_STATE_TEXT",
  });
  const identityIdx = out.indexOf("KC Agent builds and manages"); // AGENT_IDENTITY first line
  const goalIdx = out.indexOf("MARATHON_GOAL_TEXT");
  const pipelineIdx = out.indexOf("PIPELINE_STATE_TEXT");
  assert(identityIdx > -1 && goalIdx > -1 && pipelineIdx > -1, "all three sections present");
  assert(identityIdx < goalIdx, "AGENT_IDENTITY before marathon goal");
  assert(goalIdx < pipelineIdx, "marathon goal before pipelineState");
}

console.log("\nengine.js: marathonGoal field initialized + lifecycle");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/this\.marathonGoal\s*=\s*null/.test(src), "marathonGoal initialized to null");
  // In enterMarathonMode: set BEFORE constructing the driver
  const enter = src.match(/enterMarathonMode\(goal[\s\S]*?return this\.marathonDriver\.getStatus/);
  assert(enter !== null, "enterMarathonMode body found");
  assert(/this\.marathonGoal\s*=\s*goal/.test(enter[0]), "enterMarathonMode sets marathonGoal");
  // In exitMarathonMode: clear
  const exit = src.match(/exitMarathonMode\(reason[\s\S]*?return status/);
  assert(exit !== null, "exitMarathonMode body found");
  assert(/this\.marathonGoal\s*=\s*null/.test(exit[0]), "exitMarathonMode clears marathonGoal");
}

console.log("\nengine.js: marathonGoal passed to ContextAssembler.build() at both sites");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  const buildCalls = [...src.matchAll(/this\.context\.build\(\{[\s\S]*?\}\)/g)];
  assert(buildCalls.length >= 2, "at least 2 context.build call sites");
  for (let i = 0; i < buildCalls.length; i++) {
    assert(/marathonGoal:\s*this\.marathonGoal/.test(buildCalls[i][0]),
      `context.build call ${i + 1} passes marathonGoal`);
  }
}

console.log("\nengine.js: self-stop in marathon loop clears marathonGoal");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  // The marathon decision loop's stop branch should clear both driver + goal
  const stopBranch = src.match(/if \(!decision\) \{[\s\S]*?break;\s*\}/);
  assert(stopBranch !== null, "stop-condition branch found");
  assert(/this\.marathonDriver\s*=\s*null/.test(stopBranch[0]), "clears marathonDriver");
  assert(/this\.marathonGoal\s*=\s*null/.test(stopBranch[0]), "clears marathonGoal");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
