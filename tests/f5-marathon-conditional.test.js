/**
 * Regression test for v0.8 P5-A — F5 strict-one-phase-per-prompt
 * conditional on marathon mode.
 *
 * Tests the conditional logic by directly instantiating
 * MarathonInputWatcher with synthetic active markers. We don't spin up
 * a full engine (that requires LLM mocking + workspace fixture). The
 * key invariant: marathonInput.isActive() returns true iff
 * <workspace>/.kc_marathon/active exists, and the engine's
 * _runTaskLoopSerial/_runTaskLoopParallel use that signal to gate F5.
 *
 * Run: `node tests/f5-marathon-conditional.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MarathonInputWatcher } from "../src/agent/marathon-input.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-f5-test-"));
  fs.mkdirSync(path.join(dir, ".kc_marathon"), { recursive: true });
  return dir;
}

console.log("\nF5 active-state flag flips with marker presence");
{
  const ws = tmpWs();
  const w = new MarathonInputWatcher(ws);

  assert(w.isActive() === false, "no marker → inactive");

  fs.writeFileSync(path.join(ws, ".kc_marathon", "active"), "{}");
  assert(w.isActive() === true, "marker present → active");

  fs.unlinkSync(path.join(ws, ".kc_marathon", "active"));
  assert(w.isActive() === false, "marker removed → inactive again");

  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nF5 source: _runTaskLoopSerial captures startingPhase BEFORE initial runTurn");
{
  const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
  const src = fs.readFileSync(enginePath, "utf-8");
  // Find _runTaskLoopSerial
  const serialMatch = src.match(/async \*_runTaskLoopSerial\(userMessage\) \{([\s\S]*?)\n  \}/);
  assert(serialMatch !== null, "_runTaskLoopSerial found");
  const body = serialMatch[1];
  // Order check: marathonActive + startingPhase assignment must occur BEFORE yield* runTurn
  const startingPhaseIdx = body.indexOf("const startingPhase = this.currentPhase");
  const initialRunTurnIdx = body.indexOf("yield* this.runTurn(userMessage)");
  assert(startingPhaseIdx > -1, "startingPhase capture present");
  assert(initialRunTurnIdx > -1, "initial runTurn present");
  assert(startingPhaseIdx < initialRunTurnIdx, "startingPhase captured BEFORE initial runTurn (F5 strict)");
}

console.log("\nF5 source: _runTaskLoopSerial has marathon-conditional exit");
{
  const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/marathonActive\s*=\s*this\.marathonInput\?\.isActive\(\)/.test(src), "marathonActive flag derived from marathonInput");
  assert(/if\s*\(\s*!marathonActive\s*&&\s*this\.currentPhase\s*!==\s*startingPhase\s*\)/.test(src),
         "F5 exit guards on `!marathonActive && phase changed`");
  assert(/f5_strict_initial_turn/.test(src), "ralph_loop_exit event uses f5_strict_initial_turn reason");
}

console.log("\nF5 source: TEMPORARILY DISABLED markers removed");
{
  const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(!/G-F5 — TEMPORARILY DISABLED/.test(src), "G-F5 TEMPORARILY DISABLED comment markers removed");
}

console.log("\nF5 source: _runTaskLoopParallel also re-enabled");
{
  const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
  const src = fs.readFileSync(enginePath, "utf-8");
  const parallelMatch = src.match(/async \*_runTaskLoopParallel\([^)]*\) \{([\s\S]{0,4000})/);
  assert(parallelMatch !== null, "_runTaskLoopParallel found");
  const head = parallelMatch[1];
  const startingIdx = head.indexOf("const startingPhase = this.currentPhase");
  const runTurnIdx = head.indexOf("yield* this.runTurn(userMessage)");
  assert(startingIdx > -1 && runTurnIdx > -1 && startingIdx < runTurnIdx,
         "parallel loop also captures startingPhase BEFORE runTurn");
  assert(/mode: "parallel"/.test(src), "parallel loop tags its ralph_loop_exit event");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
