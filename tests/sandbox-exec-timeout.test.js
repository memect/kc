/**
 * Regression test for v0.8 P1-F — sandbox_exec timeout model.
 *
 * Background:
 * 资管 v0.7.5 audit § 1.6: 21 sandbox_exec timeouts triggered 9 subagent
 * spawns over 1h 57m (73% of finalization wall-clock). The 30s default
 * timeout was a forcing function for optimization but it blocked batch
 * LLM processing entirely. v0.8 P1-F raises default to 120s (Claude Code
 * parity) and adds per-call `timeout_ms` up to 600000ms ceiling.
 *
 * Run: `node tests/sandbox-exec-timeout.test.js`
 */
import { SandboxExecTool } from "../src/agent/tools/sandbox-exec.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Minimal Workspace stub
const ws = { cwd: "/tmp", projectDir: null };

console.log("\nConstructor: default ms-based config");
{
  const t = new SandboxExecTool(ws);
  assert(t._defaultTimeoutMs === 120_000, "default 120000ms (2 min)");
  assert(t._maxTimeoutMs === 600_000, "max 600000ms (10 min)");
}

console.log("\nConstructor: explicit config object");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 60_000, maxTimeoutMs: 300_000 });
  assert(t._defaultTimeoutMs === 60_000, "default 60000ms");
  assert(t._maxTimeoutMs === 300_000, "max 300000ms");
}

console.log("\nConstructor: legacy numeric form (seconds)");
{
  const t = new SandboxExecTool(ws, 30);
  assert(t._defaultTimeoutMs === 30_000, "30s → 30000ms");
  assert(t._maxTimeoutMs >= 600_000, "max preserved at >=600000ms");
}

console.log("\nConstructor: floor at 1000ms");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 500 });
  assert(t._defaultTimeoutMs === 1000, "floored to 1000ms");
}

console.log("\nConstructor: max can't be below default");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 300_000, maxTimeoutMs: 60_000 });
  assert(t._maxTimeoutMs >= 300_000, "max bumped to >= default");
}

console.log("\ninputSchema: timeout_ms field present");
{
  const t = new SandboxExecTool(ws);
  const schema = t.inputSchema;
  assert(schema.properties?.timeout_ms?.type === "integer", "timeout_ms is integer");
  assert(/timeout_ms/.test(t.description), "description mentions timeout_ms");
}

console.log("\nFast command completes within default");
{
  const t = new SandboxExecTool(ws);
  const r = await t.execute({ command: "echo hello" });
  assert(!r.isError, `echo succeeded (got ${r.content})`);
  assert(/hello/.test(r.content), "stdout captured");
}

console.log("\nCommand at default timeout times out (with custom 1s default for fast test)");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 1000, maxTimeoutMs: 5000 });
  const r = await t.execute({ command: "sleep 3" });
  assert(r.isError, "sleep 3 times out at 1s default");
  assert(/timed out after 1s/.test(r.content), `error names the 1s default (got ${r.content})`);
  assert(/timeout_ms/.test(r.content), "error hints at timeout_ms");
}

console.log("\nPer-call timeout_ms extends the budget");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 1000, maxTimeoutMs: 10_000 });
  const r = await t.execute({ command: "sleep 2 && echo done", timeout_ms: 4000 });
  assert(!r.isError, `succeeded with 4s budget (got: ${r.content?.slice(0, 100)})`);
  assert(/done/.test(r.content), "stdout captured after sleep");
}

console.log("\nPer-call timeout_ms clamped at max");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 1000, maxTimeoutMs: 2000 });
  const r = await t.execute({ command: "echo ok", timeout_ms: 999_999 });
  assert(!r.isError, "echo succeeded");
  assert(/clamped to 2000ms/.test(r.content) || /clamped to 2000/.test(r.content), "note about clamping present");
}

console.log("\nPer-call timeout_ms below floor clamped to 1000ms");
{
  const t = new SandboxExecTool(ws, { defaultTimeoutMs: 1000, maxTimeoutMs: 5000 });
  const r = await t.execute({ command: "echo ok", timeout_ms: 100 });
  assert(!r.isError, "echo succeeded");
  assert(/below 1000ms floor/.test(r.content), "note about floor clamp present");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
