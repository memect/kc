/**
 * Regression test for v0.8.2 P12-B — user-input queue priority over the
 * marathon driver's continuation prompts.
 *
 * v0.8.1 silent queue-starvation (E2E #12): the TUI queued user-typed
 * messages mid-run, displayed "Queued (1 waiting)", but the message
 * NEVER reached the engine. Cause: the TUI's queueRef drained only
 * after runTurn() generator completed, but runTurn never returned
 * while the marathon decision loop kept yielding driver continuations.
 *
 * v0.8.2 P12-B: the engine owns the input queue. TUI hands off via
 * queueUserInput() when marathon is active. The marathon decision
 * loop drains this queue BEFORE asking the driver — user interrupts
 * always win over autonomy.
 *
 * Run: `node tests/marathon-user-input-priority.test.js`
 */
import fs from "node:fs";

const enginePath = new URL("../src/agent/engine.js", import.meta.url).pathname;
const cliPath = new URL("../src/cli/index.js", import.meta.url).pathname;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nengine.js: inputQueue field initialized");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/this\.inputQueue\s*=\s*\[\]/.test(src), "inputQueue initialized to []");
}

console.log("\nengine.js: queueUserInput + _drainNextQueuedUserInput methods defined");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  assert(/queueUserInput\(text\)\s*\{/.test(src), "queueUserInput(text) defined");
  assert(/_drainNextQueuedUserInput\(\)\s*\{/.test(src), "_drainNextQueuedUserInput() defined");
  assert(/getQueueDepth\(\)\s*\{/.test(src), "getQueueDepth() defined");
}

console.log("\nengine.js: queueUserInput emits user_input_queued event");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  const m = src.match(/queueUserInput\(text\)\s*\{([\s\S]*?)\n  \}/);
  assert(m !== null, "queueUserInput body found");
  assert(/this\.inputQueue\.push\(text\)/.test(m[1]), "pushes onto inputQueue");
  assert(/user_input_queued/.test(m[1]), "emits user_input_queued event");
  assert(/marathonActive/.test(m[1]), "event payload notes marathon-active status");
}

console.log("\nengine.js: _drainNextQueuedUserInput emits user_input_drained event");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  const m = src.match(/_drainNextQueuedUserInput\(\)\s*\{([\s\S]*?)\n  \}/);
  assert(m !== null, "_drainNextQueuedUserInput body found");
  assert(/this\.inputQueue\.shift\(\)/.test(m[1]), "shifts from inputQueue");
  assert(/user_input_drained/.test(m[1]), "emits user_input_drained event");
  assert(/return null/.test(m[1]) || /return undefined/.test(m[1]), "returns null/undefined when empty");
}

console.log("\nengine.js: marathon loop drains user queue BEFORE driver.decideNext()");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  // Find the marathon decision loop body
  const loopMatch = src.match(/while \(this\.marathonDriver\) \{([\s\S]*?)\n    \}/);
  assert(loopMatch !== null, "marathon loop body found");
  const body = loopMatch[1];
  const drainIdx = body.indexOf("_drainNextQueuedUserInput");
  const decideIdx = body.indexOf("decideNext");
  assert(drainIdx > -1, "loop calls _drainNextQueuedUserInput");
  assert(decideIdx > -1, "loop calls decideNext");
  assert(drainIdx < decideIdx, "queue drain happens BEFORE driver decideNext");
}

console.log("\nengine.js: marathon loop yields user input as runTurn (with continue)");
{
  const src = fs.readFileSync(enginePath, "utf-8");
  // The drained user input should be passed to runTurn — same shape as the
  // driver-decision path — and then `continue` to re-evaluate the queue.
  const loopMatch = src.match(/while \(this\.marathonDriver\) \{([\s\S]*?)\n    \}/);
  const body = loopMatch[1];
  // After draining, the loop should yield runTurn with the queued text + continue
  assert(/queuedUserInput[\s\S]*yield\* this\.runTurn\(queuedUserInput\)/.test(body),
    "yields runTurn(queuedUserInput)");
  assert(/queuedUserInput[\s\S]*continue;/.test(body),
    "continues to next iteration after running queued turn");
}

console.log("\ncli/index.js: handleSubmit hands off to engine queue when marathon active");
{
  const src = fs.readFileSync(cliPath, "utf-8");
  // The marathon-active branch should call engine.queueUserInput, not push to queueRef
  assert(/engineRef\.current\?\.isMarathonActive\?\.\(\)/.test(src),
    "checks engineRef.current?.isMarathonActive?.() in handleSubmit");
  assert(/engineRef\.current\?\.queueUserInput/.test(src) || /queueUserInput\(trimmed\)/.test(src),
    "calls engine.queueUserInput in marathon branch");
  // Non-marathon path still uses TUI-local queueRef
  assert(/queueRef\.current\.push\(trimmed\)/.test(src),
    "non-marathon path still uses queueRef (no regression on interactive)");
}

console.log("\nFunctional: queue/drain/depth behavior (in-memory stub)");
{
  // Stand-in for engine without instantiating full AgentEngine — just verify
  // the queue contract semantics by mimicking the methods.
  class Stub {
    constructor() {
      this.inputQueue = [];
      this.events = [];
      this.eventLog = { append: (t, d) => this.events.push({ t, d }) };
    }
    queueUserInput(text) {
      if (!text || typeof text !== "string") return;
      this.inputQueue.push(text);
      this.eventLog.append("user_input_queued", { preview: text.slice(0, 100), queueDepth: this.inputQueue.length });
    }
    _drainNextQueuedUserInput() {
      if (this.inputQueue.length === 0) return null;
      const text = this.inputQueue.shift();
      this.eventLog.append("user_input_drained", { preview: text.slice(0, 100), queueDepth: this.inputQueue.length });
      return text;
    }
    getQueueDepth() { return this.inputQueue.length; }
  }
  const s = new Stub();
  assert(s.getQueueDepth() === 0, "empty queue at start");
  s.queueUserInput("hello");
  s.queueUserInput("world");
  assert(s.getQueueDepth() === 2, "depth 2 after two pushes");
  assert(s._drainNextQueuedUserInput() === "hello", "FIFO: drains 'hello' first");
  assert(s.getQueueDepth() === 1, "depth 1 after one drain");
  assert(s._drainNextQueuedUserInput() === "world", "drains 'world' next");
  assert(s._drainNextQueuedUserInput() === null, "null when empty");
  s.queueUserInput("");
  s.queueUserInput(null);
  assert(s.getQueueDepth() === 0, "empty/null strings ignored");
  assert(s.events.filter(e => e.t === "user_input_queued").length === 2, "2 queued events emitted");
  assert(s.events.filter(e => e.t === "user_input_drained").length === 2, "2 drained events emitted");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
