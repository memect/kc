/**
 * Regression test for v0.8 P2-B — worker_llm_call batch mode.
 *
 * Background:
 * v0.7.5 audits (贷款 + 资管) found 0-1 worker_llm_call events per
 * session despite extensive LLM workflow building. Agent went direct
 * SiliconFlow HTTP because worker_llm_call didn't support batch.
 *
 * v0.8 P2-B adds `prompts: [...]` batch input with concurrency control.
 * This test verifies the input-schema + dispatch logic without making
 * real HTTP calls (uses a mock-fetch).
 *
 * Run: `node tests/worker-llm-batch.test.js`
 */
import { WorkerLLMCallTool } from "../src/agent/tools/worker-llm-call.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Minimal Workspace stub
const ws = { cwd: "/tmp/kc-fake-ws", projectDir: null };

// Patch fetch globally for tests. Each test sets globalThis.__fakeFetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (globalThis.__fakeFetch) return globalThis.__fakeFetch(url, opts);
  throw new Error("fetch not mocked");
};

console.log("\ninputSchema: batch fields present");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake" });
  const schema = t.inputSchema;
  assert(schema.properties.prompts.type === "array", "prompts is array");
  assert(schema.properties.concurrency.type === "integer", "concurrency is integer");
  assert(schema.required.includes("tier") && !schema.required.includes("prompt"), "only tier required (prompt OR prompts)");
}

console.log("\nDescription mentions batch");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake" });
  assert(/batch/i.test(t.description), "description mentions batch");
  assert(/prompts/i.test(t.description), "description mentions prompts");
}

console.log("\nBatch dispatch: 3 prompts processed in parallel");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake", baseUrl: "https://example.com/v1" });
  // Bypass _loadTiers (it reads workspace .env which doesn't exist)
  t._tierModels = { tier1: ["model-A"] };

  let callCount = 0;
  globalThis.__fakeFetch = async (url, opts) => {
    callCount++;
    return {
      ok: true,
      async json() {
        const body = JSON.parse(opts.body);
        const userMsg = body.messages.find((m) => m.role === "user").content;
        return {
          choices: [{ message: { content: `echo: ${userMsg}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };
  };

  const r = await t.execute({
    tier: "tier1",
    prompts: ["alpha", "beta", "gamma"],
    concurrency: 2,
  });
  assert(!r.isError, "batch succeeded");
  const parsed = JSON.parse(r.content);
  assert(parsed.n_total === 3, `n_total=3 (got ${parsed.n_total})`);
  assert(parsed.n_succeeded === 3, "all 3 succeeded");
  assert(parsed.n_failed === 0, "0 failed");
  assert(parsed.results.length === 3, "3 results");
  assert(parsed.results[0].index === 0, "index preserved");
  assert(parsed.results[2].response === "echo: gamma", "third response correct");
  assert(parsed.total_tokens_in === 30, "tokens aggregated");
  assert(parsed.concurrency === 2, "concurrency echoed");
  assert(callCount === 3, "3 underlying fetch calls");
}

console.log("\nBatch with partial failures: isError only if ALL fail");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake", baseUrl: "https://example.com/v1" });
  t._tierModels = { tier1: ["model-A"] };

  let callCount = 0;
  globalThis.__fakeFetch = async (url, opts) => {
    callCount++;
    // Odd-indexed call fails, even-indexed succeeds
    if (callCount % 2 === 0) return { ok: false, status: 500 };
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        };
      },
    };
  };

  const r = await t.execute({
    tier: "tier1",
    prompts: ["a", "b", "c", "d"],
    concurrency: 1, // serial so call-count parity is deterministic
  });
  assert(!r.isError, "partial failure: NOT isError");
  const parsed = JSON.parse(r.content);
  assert(parsed.n_succeeded === 2, `2 succeeded (got ${parsed.n_succeeded})`);
  assert(parsed.n_failed === 2, "2 failed");
  assert(parsed.results.some((r) => r.error), "results carry per-item error");
}

console.log("\nBatch with all-fail: IS isError");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake", baseUrl: "https://example.com/v1" });
  t._tierModels = { tier1: ["model-A"] };
  globalThis.__fakeFetch = async () => ({ ok: false, status: 500 });
  const r = await t.execute({ tier: "tier1", prompts: ["a", "b"] });
  assert(r.isError, "all-fail: isError=true");
}

console.log("\nConcurrency clamped to 1-10");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake", baseUrl: "https://example.com/v1" });
  t._tierModels = { tier1: ["model-A"] };
  globalThis.__fakeFetch = async () => ({
    ok: true,
    async json() { return { choices: [{ message: { content: "ok" } }], usage: {} }; },
  });
  const r = await t.execute({ tier: "tier1", prompts: ["a"], concurrency: 999 });
  const parsed = JSON.parse(r.content);
  assert(parsed.concurrency === 10, `concurrency clamped to 10 (got ${parsed.concurrency})`);
}

console.log("\nSingle-prompt mode still works (backward compat)");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake", baseUrl: "https://example.com/v1" });
  t._tierModels = { tier1: ["model-A"] };
  globalThis.__fakeFetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: "single ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    },
  });
  const r = await t.execute({ tier: "tier1", prompt: "single" });
  assert(!r.isError, "single-prompt path succeeded");
  const parsed = JSON.parse(r.content);
  assert(parsed.response === "single ok", "single-prompt response shape unchanged");
  assert(typeof parsed.results === "undefined", "no `results` field in single mode");
}

console.log("\nNeither prompt nor prompts: error");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake" });
  const r = await t.execute({ tier: "tier1" });
  assert(r.isError, "no prompt → error");
}

console.log("\nEmpty prompts array: error");
{
  const t = new WorkerLLMCallTool(ws, { apiKey: "fake" });
  t._tierModels = { tier1: ["m"] };
  const r = await t.execute({ tier: "tier1", prompts: [] });
  assert(r.isError, "empty array → error");
}

globalThis.fetch = realFetch;

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
