/**
 * Regression test for v0.8 P4-A/B — marathon driver state machine + IPC.
 *
 * Tests the driver in isolation (no real engine). Simulates engine
 * events by appending to a temp events.jsonl, ticks the driver, and
 * verifies inbox.jsonl + decisions.jsonl outputs.
 *
 * Architecture under test:
 *   - Driver tails workspaceCwd/logs/events.jsonl
 *   - Writes prompts to workspaceCwd/.kc_marathon/inbox.jsonl
 *   - Writes decisions to ~/.kc_agent/marathons/<id>/decisions.jsonl
 *   - Creates/removes workspaceCwd/.kc_marathon/active marker
 *
 * Run: `node tests/marathon-driver.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MarathonDriver } from "../src/marathon/driver.js";
import { MarathonInputWatcher } from "../src/agent/marathon-input.js";
import { renderPrompt, PROMPT_TEMPLATES } from "../src/marathon/prompts.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-marathon-test-"));
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

function makeDriver(ws, opts = {}) {
  const sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new MarathonDriver({
    workspaceCwd: ws,
    sessionId,
    goal: "Test goal",
    pollMs: 100,
    log: () => {}, // silence
    ...opts,
  });
}

function readInbox(ws) {
  const p = path.join(ws, ".kc_marathon", "inbox.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map(JSON.parse);
}

function appendEvent(ws, type, data) {
  const p = path.join(ws, "logs", "events.jsonl");
  fs.appendFileSync(p, JSON.stringify({ type, data, ts: new Date().toISOString() }) + "\n");
}

console.log("\nPrompts: all templates render for en + zh");
{
  const state = { goal: "test", currentPhase: "bootstrap", milestones: {}, idleSec: 0 };
  for (const tmpl of PROMPT_TEMPLATES) {
    for (const lang of ["en", "zh"]) {
      const out = renderPrompt(tmpl, state, lang);
      assert(typeof out === "string" && out.length > 10, `${tmpl}/${lang} renders`);
    }
  }
}

console.log("\nFirst tick: sends initial prompt + creates active marker");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  const inbox = readInbox(ws);
  assert(inbox.length === 1, `1 prompt in inbox (got ${inbox.length})`);
  assert(inbox[0].template === "initial", `template=initial (got ${inbox[0].template})`);
  assert(/Test goal/.test(inbox[0].content), "goal embedded in prompt");
  assert(fs.existsSync(path.join(ws, ".kc_marathon", "active")), "active marker exists");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nTeardown: removes active marker");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  d._teardown();
  assert(!fs.existsSync(path.join(ws, ".kc_marathon", "active")), "active marker removed");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nturn_complete event → continue_phase prompt");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick(); // initial
  appendEvent(ws, "turn_complete", {});
  await d.tick();
  const inbox = readInbox(ws);
  assert(inbox.length === 2, `2 prompts (got ${inbox.length})`);
  assert(inbox[1].template === "continue_phase", `2nd is continue_phase (got ${inbox[1].template})`);
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nphase_transition → continue_phase nudge for next phase");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick(); // initial
  appendEvent(ws, "phase_transition", { to: "rule_extraction" });
  await d.tick();
  const inbox = readInbox(ws);
  assert(inbox[1].template === "continue_phase", "phase_transition fires continue_phase");
  assert(d.currentPhase === "rule_extraction", "driver tracks current phase");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nphase_transition to finalization → finalize prompt");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  appendEvent(ws, "phase_transition", { to: "finalization" });
  await d.tick();
  const inbox = readInbox(ws);
  assert(inbox[1].template === "finalize", "finalization → finalize prompt");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nerror event → unstick prompt");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  appendEvent(ws, "error", { message: "fake error" });
  await d.tick();
  const inbox = readInbox(ws);
  assert(inbox[1].template === "unstick", "error → unstick");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nmax_wallclock stop condition fires stop prompt + exits");
{
  const ws = tmpWs();
  const d = makeDriver(ws, { maxWallclockMs: 50 });
  d._setup();
  await d.tick(); // initial
  await new Promise((r) => setTimeout(r, 100));
  const keepRunning = await d.tick();
  assert(keepRunning === false, "tick returns false after max_wallclock");
  assert(d.stopReason === "max_wallclock", "stopReason recorded");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\ndecisions.jsonl + KC events.jsonl both receive marathon_decision");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  // Read decisions log
  const dec = fs.readFileSync(d.decisionsPath, "utf-8").trim().split("\n").map(JSON.parse);
  assert(dec.length >= 1, "decisions.jsonl has entry");
  assert(dec[0].template === "initial", "decision template recorded");
  // Read KC events
  const ev = fs.readFileSync(path.join(ws, "logs", "events.jsonl"), "utf-8")
    .trim().split("\n").map(JSON.parse);
  const marathonEvents = ev.filter((e) => e.type === "marathon_decision");
  assert(marathonEvents.length >= 1, "events.jsonl carries marathon_decision");
  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nMarathonInputWatcher: isActive + takeNext");
{
  const ws = tmpWs();
  const watcher = new MarathonInputWatcher(ws);
  assert(watcher.isActive() === false, "inactive without marker");
  assert(watcher.takeNext() === null, "no prompts when inactive");

  // Driver active
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  assert(watcher.isActive() === true, "active after driver setup");
  const first = watcher.takeNext();
  assert(typeof first === "string" && first.length > 10, "takeNext returns prompt");
  assert(/Test goal/.test(first), "prompt content correct");
  assert(watcher.takeNext() === null, "no more pending after drain");

  d._teardown();
  assert(watcher.isActive() === false, "inactive after teardown");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nMarathonInputWatcher: pendingCount surveys without consuming");
{
  const ws = tmpWs();
  const d = makeDriver(ws);
  d._setup();
  await d.tick();
  appendEvent(ws, "turn_complete", {});
  await d.tick();

  const watcher = new MarathonInputWatcher(ws);
  assert(watcher.pendingCount() === 2, `2 pending (got ${watcher.pendingCount()})`);
  // pendingCount drains the file into memory but doesn't consume
  // (takeNext does that). So a second pendingCount returns same.
  assert(watcher.pendingCount() === 2, "pendingCount stable when not consumed");
  watcher.takeNext();
  assert(watcher.pendingCount() === 1, "drops to 1 after takeNext");

  d._teardown();
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
