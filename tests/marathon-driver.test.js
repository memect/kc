/**
 * Regression test for v0.8.1 P8-A — inline marathon driver state machine.
 *
 * v0.8.0 shipped a separate-process driver with filesystem-watcher IPC.
 * E2E #11 found both drivers died silently within 10 min (terminal
 * close → SIGHUP/SIGTERM unhandled). v0.8.1 redesigned the driver as
 * an inline state machine activated via /marathon slash command. No
 * polling loop, no inbox.jsonl, no active marker — pure state machine
 * the engine queries on each turn boundary.
 *
 * Run: `node tests/marathon-driver.test.js`
 */
import { MarathonDriver } from "../src/marathon/driver.js";
import { renderPrompt, PROMPT_TEMPLATES } from "../src/marathon/prompts.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nPrompts: all 6 templates render in both languages");
{
  const state = { goal: "test", currentPhase: "bootstrap", milestones: {}, idleSec: 0 };
  for (const tmpl of PROMPT_TEMPLATES) {
    for (const lang of ["en", "zh"]) {
      const out = renderPrompt(tmpl, state, lang);
      assert(typeof out === "string" && out.length > 10, `${tmpl}/${lang} renders`);
    }
  }
}

console.log("\nConstructor requires goal");
{
  let threw = null;
  try { new MarathonDriver({}); } catch (e) { threw = e; }
  assert(threw !== null, "throws on missing goal");

  const d = new MarathonDriver({ goal: "test goal" });
  assert(d.goal === "test goal", "goal stored");
  assert(d.language === "en", "default language en");
  assert(d.maxWallclockMs === 12 * 60 * 60 * 1000, "default 12h wall-clock");
  assert(d.stuckAfterMs === 30 * 60 * 1000, "default 30 min stuck");
}

console.log("\ngetInitialPrompt: first decision is the 'initial' template");
{
  const d = new MarathonDriver({ goal: "Verify regulation against samples" });
  const p = d.getInitialPrompt();
  assert(typeof p === "string" && p.length > 10, "returns a substantive prompt");
  assert(/Verify regulation against samples/.test(p), "goal embedded in initial prompt");
  assert(d.initialDelivered === true, "marks initialDelivered");
  assert(d.decisionCount === 1, "decisionCount=1");
  assert(d.decisions[0].template === "initial", "decision history shows initial");
}

console.log("\ndecideNext: same phase + turn_complete → continue_phase");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  const r = d.decideNext({ currentPhase: "bootstrap", milestones: {} });
  assert(r !== null, "returns a decision");
  assert(r.template === "continue_phase", `template=continue_phase (got ${r.template})`);
  assert(typeof r.prompt === "string" && r.prompt.length > 10, "prompt is non-empty");
}

console.log("\ndecideNext: phase change → continue_phase for next phase");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  d.currentPhase = "bootstrap";
  const r = d.decideNext({ currentPhase: "rule_extraction", phaseChanged: true });
  assert(r.template === "continue_phase", "continue_phase for non-finalization phase");
  assert(d.currentPhase === "rule_extraction", "driver updates currentPhase");
}

console.log("\ndecideNext: phase change to finalization → finalize template");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  d.currentPhase = "production_qc";
  const r = d.decideNext({ currentPhase: "finalization", phaseChanged: true });
  assert(r.template === "finalize", "finalize template fires");
}

console.log("\ndecideNext: errorSeen → unstick");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  const r = d.decideNext({ currentPhase: "skill_authoring", errorSeen: true });
  assert(r.template === "unstick", "unstick on error");
}

console.log("\ndecideNext: stop conditions — max_wallclock");
{
  const d = new MarathonDriver({ goal: "g", maxWallclockMs: 50 });
  d.getInitialPrompt();
  // simulate wall-clock past max
  d.startedAt = Date.now() - 100;
  const r = d.decideNext({ currentPhase: "bootstrap" });
  assert(r !== null, "returns a stop prompt (not null)");
  assert(r.template === "stop", "stop template");
  assert(d.stopReason === "max_wallclock", "stop reason recorded");
  // subsequent decideNext returns null
  const r2 = d.decideNext({ currentPhase: "bootstrap" });
  assert(r2 === null, "subsequent decideNext returns null");
}

console.log("\ndecideNext: stop conditions — finalization_settled after 5 turns in finalization");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  d.currentPhase = "finalization";
  for (let i = 0; i < 4; i++) {
    d.decideNext({ currentPhase: "finalization" });
  }
  // 5th call should trigger stop
  const r = d.decideNext({ currentPhase: "finalization" });
  // turnsThisPhase was 0 initial then 1/2/3/4 → after 5 calls turnsThisPhase=5
  assert(r?.template === "stop", `stop fires on 5th finalization turn (got ${r?.template})`);
  assert(d.stopReason === "finalization_settled", "reason=finalization_settled");
}

console.log("\nstop(): manual user-off");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  d.stop("user_off");
  assert(d.stopped === true, "stopped flag set");
  assert(d.stopReason === "user_off", "reason recorded");
  const r = d.decideNext({ currentPhase: "bootstrap" });
  assert(r === null, "decideNext returns null after stop");
}

console.log("\ngetStatus(): returns snapshot for /marathon status command");
{
  const d = new MarathonDriver({ goal: "verify rules" });
  d.getInitialPrompt();
  d.decideNext({ currentPhase: "rule_extraction", phaseChanged: true });
  const s = d.getStatus();
  assert(s.active === true, "active=true while running");
  assert(s.goal === "verify rules", "goal preserved");
  assert(s.decisionCount === 2, "2 decisions made");
  assert(s.currentPhase === "rule_extraction", "currentPhase reflected");
  assert(Array.isArray(s.recentDecisions), "recentDecisions is array");
  assert(s.recentDecisions.length === 2, "all 2 decisions in recent");
  d.stop();
  assert(d.getStatus().active === false, "active=false after stop");
}

console.log("\ntoJSON(): serializable for session-state.json");
{
  const d = new MarathonDriver({ goal: "g", language: "zh", maxWallclockMs: 60000 });
  d.getInitialPrompt();
  const j = d.toJSON();
  assert(j.goal === "g", "goal serialized");
  assert(j.language === "zh", "language serialized");
  assert(j.maxWallclockMs === 60000, "maxWallclockMs serialized");
  assert(j.initialDelivered === true, "state serialized");
  // recentDecisions should NOT be in toJSON (in-memory only)
  assert(typeof j.decisions === "undefined", "decisions array not in toJSON");
}

console.log("\nLanguage propagation: zh goal renders zh prompts");
{
  const d = new MarathonDriver({ goal: "测试目标", language: "zh" });
  const p = d.getInitialPrompt();
  assert(/测试目标/.test(p), "goal in zh appears in prompt");
  // zh template "initial" has "marathon 模式" while en has "marathon mode"
  assert(/marathon|模式/.test(p), "zh prompt references marathon (any form)");
}

console.log("\nDecision history bounded to 100 entries");
{
  const d = new MarathonDriver({ goal: "g" });
  d.getInitialPrompt();
  for (let i = 0; i < 150; i++) d.decideNext({ currentPhase: "bootstrap" });
  assert(d.decisions.length === 100, `decisions capped at 100 (got ${d.decisions.length})`);
  assert(d.decisionCount === 151, "decisionCount still counts all (151 = initial + 150)");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
