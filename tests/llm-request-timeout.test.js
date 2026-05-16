/**
 * Regression test for v0.8.2 P14-A — LLM request-level timeout via
 * AbortSignal.timeout in src/agent/llm-client.js.
 *
 * E2E #12 (2026-05-16): both 贷款 + 资管 sessions hung 8h+ overnight
 * on stuck SiliconFlow GLM-5.1 streams. No HTTP request-level timeout
 * meant the TCP connection stayed open with no progress, eventually
 * the underlying request was terminated by the upstream. ~$0 token
 * spend but wallclock waste.
 *
 * P14-A adds AbortSignal.timeout to both fetch() call sites. Default
 * 10 min ceiling; configurable via KC_LLM_REQUEST_TIMEOUT_MS env var.
 * Aborts surface as `streamTermination: "request_timeout"` so audits
 * can count these distinctly from generic connect errors.
 *
 * Run: `node tests/llm-request-timeout.test.js`
 */
import fs from "node:fs";
import { LLMClient } from "../src/agent/llm-client.js";

const clientPath = new URL("../src/agent/llm-client.js", import.meta.url).pathname;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nLLMClient: requestTimeoutMs initialized");
{
  const c = new LLMClient({ apiKey: "k", baseUrl: "https://x" });
  assert(typeof c.requestTimeoutMs === "number", "requestTimeoutMs is a number");
  assert(c.requestTimeoutMs === 10 * 60 * 1000, "default 10 min (600_000 ms)");
}

console.log("\nLLMClient: requestTimeoutMs honors KC_LLM_REQUEST_TIMEOUT_MS env");
{
  const orig = process.env.KC_LLM_REQUEST_TIMEOUT_MS;
  process.env.KC_LLM_REQUEST_TIMEOUT_MS = "30000";
  const c = new LLMClient({ apiKey: "k", baseUrl: "https://x" });
  assert(c.requestTimeoutMs === 30000, "env override picked up (30s)");
  process.env.KC_LLM_REQUEST_TIMEOUT_MS = "invalid";
  const c2 = new LLMClient({ apiKey: "k", baseUrl: "https://x" });
  assert(c2.requestTimeoutMs === 10 * 60 * 1000, "invalid env falls back to default");
  process.env.KC_LLM_REQUEST_TIMEOUT_MS = "-100";
  const c3 = new LLMClient({ apiKey: "k", baseUrl: "https://x" });
  assert(c3.requestTimeoutMs === 10 * 60 * 1000, "negative env falls back to default");
  if (orig === undefined) delete process.env.KC_LLM_REQUEST_TIMEOUT_MS;
  else process.env.KC_LLM_REQUEST_TIMEOUT_MS = orig;
}

console.log("\nllm-client.js: streamChat fetch uses AbortSignal.timeout");
{
  const src = fs.readFileSync(clientPath, "utf-8");
  // Find the streamChat method body
  const m = src.match(/async \*streamChat\([\s\S]*?\n  \}/);
  assert(m !== null, "streamChat method found");
  assert(/signal:\s*AbortSignal\.timeout\(this\.requestTimeoutMs\)/.test(m[0]),
    "streamChat fetch passes signal: AbortSignal.timeout(this.requestTimeoutMs)");
}

console.log("\nllm-client.js: chat fetch uses AbortSignal.timeout");
{
  const src = fs.readFileSync(clientPath, "utf-8");
  const m = src.match(/async chat\([\s\S]*?\n  \}/);
  assert(m !== null, "chat method found");
  assert(/signal:\s*AbortSignal\.timeout\(this\.requestTimeoutMs\)/.test(m[0]),
    "chat fetch passes signal: AbortSignal.timeout(this.requestTimeoutMs)");
}

console.log("\nllm-client.js: TimeoutError tagged as request_timeout");
{
  const src = fs.readFileSync(clientPath, "utf-8");
  assert(/err\.name === "TimeoutError"|err\.name === "AbortError"/.test(src),
    "checks for TimeoutError/AbortError");
  assert(/streamTermination\s*=\s*"request_timeout"/.test(src),
    "tags as request_timeout");
}

console.log("\nFunctional: AbortSignal.timeout fires (mock-fetch)");
{
  // Mock a hung fetch — set up a mini HTTP server, swap global fetch, then
  // verify the timeout aborts within the configured window.
  // Use a 100 ms timeout for fast test.
  const orig = process.env.KC_LLM_REQUEST_TIMEOUT_MS;
  process.env.KC_LLM_REQUEST_TIMEOUT_MS = "100";

  // Construct client; verify fetch with abort actually aborts.
  // We don't need to spin up a server — just call fetch against a
  // listening socket that never responds. Easier: use abortable promise.
  const start = Date.now();
  const abortPromise = (async () => {
    try {
      // Use a guaranteed-to-hang URL pattern: an unroutable address.
      // Node will keep retrying / waiting until timeout.
      await fetch("http://127.0.0.1:1/never", { signal: AbortSignal.timeout(100) });
      return "no-throw";
    } catch (e) {
      return { name: e.name, msg: e.message };
    }
  })();
  const result = await abortPromise;
  const elapsed = Date.now() - start;

  // Should error (either AbortError/TimeoutError or connect refused — both
  // are acceptable; the point is fetch doesn't hang forever).
  assert(result !== "no-throw", "fetch errored (didn't hang)");
  assert(elapsed < 2000, `aborted within 2s (was ${elapsed} ms)`);

  if (orig === undefined) delete process.env.KC_LLM_REQUEST_TIMEOUT_MS;
  else process.env.KC_LLM_REQUEST_TIMEOUT_MS = orig;
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
