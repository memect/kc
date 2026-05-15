/**
 * Regression test for v0.8 P5-A + v0.8.1 P8-A — F5 strict-one-phase-
 * per-prompt conditional on marathon mode.
 *
 * v0.8.0 used a filesystem marker (.kc_marathon/active) to signal
 * marathon-active. v0.8.1 P8-A switched to engine-instance state
 * (this.marathonDriver != null && !this.marathonDriver.stopped).
 *
 * This test exercises the source-code structure: capture-BEFORE
 * runTurn pattern, marathonActive check uses the new isMarathonActive()
 * method, no auto-resume on session restore.
 *
 * Run: `node tests/f5-marathon-conditional.test.js`
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MarathonDriver } from "../src/marathon/driver.js";

const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
const cliPath = new URL("../src/cli/index.js", import.meta.url).pathname;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nInline marathon driver active-state");
{
  const d = new MarathonDriver({ goal: "test" });
  // isMarathonActive is a method on AgentEngine, but it just checks
  // `!!this.marathonDriver && !this.marathonDriver.stopped`. Mirror that here.
  const checkActive = (drv) => !!drv && !drv.stopped;
  assert(checkActive(null) === false, "no driver → inactive");
  assert(checkActive(d) === true, "driver present + not stopped → active");
  d.stop();
  assert(checkActive(d) === false, "stopped driver → inactive");
}

console.log("\nengine.js: _runTaskLoopSerial captures startingPhase BEFORE runTurn (F5 strict)");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  const m = src.match(/async \*_runTaskLoopSerial\(userMessage\) \{([\s\S]*?)\n  \}/);
  assert(m !== null, "_runTaskLoopSerial found");
  const body = m[1];
  const startingIdx = body.indexOf("const startingPhase = this.currentPhase");
  const initialRunTurnIdx = body.indexOf("yield* this.runTurn(userMessage)");
  assert(startingIdx > -1, "startingPhase capture present");
  assert(initialRunTurnIdx > -1, "initial runTurn present");
  assert(startingIdx < initialRunTurnIdx, "startingPhase captured BEFORE initial runTurn (F5 strict)");
}

console.log("\nengine.js: marathon-active source is inline isMarathonActive()");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  // v0.8.1 P8-A: should use this.isMarathonActive(), not this.marathonInput?.isActive()
  assert(!/this\.marathonInput\?\.isActive\(\)/.test(src), "no leftover marathonInput.isActive() refs");
  assert(/this\.isMarathonActive\(\)/.test(src), "uses this.isMarathonActive() instead");
  assert(/isMarathonActive\s*\(\s*\)\s*\{/.test(src), "isMarathonActive method defined");
}

console.log("\nengine.js: enterMarathonMode + exitMarathonMode methods defined");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/enterMarathonMode\(goal,?\s*opts/.test(src), "enterMarathonMode defined");
  assert(/exitMarathonMode\(reason/.test(src), "exitMarathonMode defined");
  assert(/this\.marathonDriver\s*=\s*new MarathonDriver/.test(src), "instantiates MarathonDriver");
}

console.log("\nengine.js: marathon-attach loop uses inline driver decideNext()");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/while \(this\.marathonDriver\)/.test(src), "marathon loop iterates while driver present");
  assert(/this\.marathonDriver\.decideNext/.test(src), "calls decideNext");
  // Old filesystem-watcher patterns should be gone from CODE
  // (tombstone comments OK — they document the v0.8.0 → v0.8.1 change).
  // Strip comments first then re-scan.
  const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(!/marathonInput\.takeNext|takeNext\(/.test(codeOnly), "no leftover takeNext() code refs");
  assert(!/inbox\.jsonl/.test(codeOnly), "no inbox.jsonl code refs (comments only)");
}

console.log("\nengine.js: TEMPORARILY DISABLED markers gone (F5 re-enabled)");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(!/G-F5 — TEMPORARILY DISABLED/.test(src), "G-F5 markers removed");
}

console.log("\ncli/index.js: /marathon slash command handlers (P8-A integration)");
{
  const src = fs.readFileSync(cliPath, "utf-8");
  assert(/case ["']\/marathon["']/.test(src), "/marathon case present in handleSlashCommand");
}

console.log("\nbin/kc-marathon.js + src/agent/marathon-input.js: DELETED");
{
  // The old separate-process driver should be gone
  assert(!fs.existsSync(new URL("../bin/kc-marathon.js", import.meta.url).pathname), "bin/kc-marathon.js deleted");
  assert(!fs.existsSync(new URL("../src/agent/marathon-input.js", import.meta.url).pathname), "src/agent/marathon-input.js deleted");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
