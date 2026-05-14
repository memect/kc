import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Call a worker LLM at a specified tier for verification tasks.
 * Reads tier-to-model mapping from workspace .env. Routes through
 * the configured API provider.
 */
export class WorkerLLMCallTool extends BaseTool {
  constructor(workspace, { apiKey, baseUrl, authType = "bearer" } = {}) {
    super();
    this._workspace = workspace;
    this._apiKey = apiKey || "";
    this._baseUrl = (baseUrl || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    this._authType = authType;
    this._tierModels = {};
    this._loadTiers();
  }

  _buildHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this._authType === "x-api-key") {
      headers["x-api-key"] = this._apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${this._apiKey}`;
    }
    return headers;
  }

  _loadTiers() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      for (const tier of ["TIER1", "TIER2", "TIER3", "TIER4"]) {
        if (line.startsWith(`${tier}=`)) {
          const models = line.split("=")[1].split(",").map((m) => m.trim()).filter(Boolean);
          this._tierModels[tier.toLowerCase()] = models;
        }
      }
    }
  }

  get name() { return "worker_llm_call"; }

  get description() {
    return (
      "Call a worker LLM at a specified tier (tier1-tier4) for extraction, " +
      "judgment, or other verification tasks. Tier1 is most capable/expensive, " +
      "tier4 is cheapest. Pass `prompt` for a single call OR `prompts: [...]` " +
      "for batch (parallel up to concurrency=5). Returns response(s) with " +
      "model used and token counts. v0.8 P2-B: batch mode keeps the engine " +
      "visible to LLM usage instead of agents bypassing via direct HTTP."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["tier1", "tier2", "tier3", "tier4"], description: "Worker LLM tier to use" },
        prompt: { type: "string", description: "The user/task prompt to send (single-call mode)" },
        prompts: {
          type: "array",
          items: { type: "string" },
          description: "Batch mode: array of prompts processed in parallel (up to concurrency=5). All share the same tier + system_prompt. Mutually exclusive with `prompt`.",
        },
        system_prompt: { type: "string", description: "Optional system prompt for context (shared across all prompts in batch mode)" },
        max_tokens: { type: "integer", description: "Maximum tokens per response (default 4096)" },
        concurrency: { type: "integer", description: "Batch mode only: max parallel requests (default 5, max 10)" },
      },
      required: ["tier"],
    };
  }

  async execute(input) {
    const tier = input.tier || "tier2";
    const systemPrompt = input.system_prompt;
    const maxTokens = input.max_tokens || 4096;

    if (!this._apiKey) return new ToolResult("Worker LLM API key not configured", true);

    // v0.8 P2-B: batch mode dispatch
    if (Array.isArray(input.prompts)) {
      return this._executeBatch(input.prompts, { tier, systemPrompt, maxTokens, concurrency: input.concurrency });
    }

    const prompt = input.prompt || "";
    if (!prompt) return new ToolResult("No prompt provided (pass `prompt` for single-call or `prompts: [...]` for batch)", true);

    const result = await this._executeOne({ prompt, tier, systemPrompt, maxTokens });
    if (result.error) return new ToolResult(result.error, true);
    return new ToolResult(JSON.stringify(result.payload, null, 2));
  }

  /**
   * v0.8 P2-B: process N prompts in parallel with concurrency control.
   * Returns aggregated results as a JSON array under "results" with
   * summary stats (total_in, total_out, n_failed). Partial failures don't
   * fail the whole call — individual results carry their own error flag.
   */
  async _executeBatch(prompts, { tier, systemPrompt, maxTokens, concurrency }) {
    if (prompts.length === 0) return new ToolResult("Empty prompts array", true);
    this._loadTiers();
    const models = this._tierModels[tier] || [];
    if (models.length === 0) {
      return new ToolResult(`No models configured for ${tier}. Check .env TIER1-TIER4 settings.`, true);
    }

    const limit = Math.max(1, Math.min(10, Number.isFinite(concurrency) ? concurrency : 5));
    const results = new Array(prompts.length);
    let cursor = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let nFailed = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= prompts.length) break;
        const r = await this._executeOne({ prompt: prompts[idx], tier, systemPrompt, maxTokens });
        if (r.error) {
          results[idx] = { index: idx, error: r.error };
          nFailed++;
        } else {
          results[idx] = { index: idx, ...r.payload };
          tokensIn += r.payload.tokens_in || 0;
          tokensOut += r.payload.tokens_out || 0;
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));

    const summary = {
      n_total: prompts.length,
      n_succeeded: prompts.length - nFailed,
      n_failed: nFailed,
      total_tokens_in: tokensIn,
      total_tokens_out: tokensOut,
      tier,
      concurrency: limit,
      results,
    };
    return new ToolResult(JSON.stringify(summary, null, 2), nFailed > 0 && nFailed === prompts.length);
  }

  /**
   * Single-prompt path. Returns {error?: string, payload?: {...}}.
   * Used by both single-call and batch modes; batch dedups the tier
   * lookup and shares concurrency with multiple in-flight invocations.
   */
  async _executeOne({ prompt, tier, systemPrompt, maxTokens }) {
    if (!prompt) return { error: "Empty prompt" };
    this._loadTiers();
    const models = this._tierModels[tier] || [];
    if (models.length === 0) {
      return { error: `No models configured for ${tier}. Check .env TIER1-TIER4 settings.` };
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    let lastError = "";
    for (const model of models) {
      try {
        const resp = await fetch(`${this._baseUrl}/chat/completions`, {
          method: "POST",
          headers: this._buildHeaders(),
          body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(120000),
        });

        if (resp.ok) {
          const data = await resp.json();
          const usage = data.usage || {};
          return {
            payload: {
              response: data.choices[0].message.content,
              model_used: model,
              tier,
              tokens_in: usage.prompt_tokens || 0,
              tokens_out: usage.completion_tokens || 0,
            },
          };
        }
        lastError = `${model}: HTTP ${resp.status}`;
      } catch (e) {
        lastError = `${model}: ${e.message}`;
      }
    }

    return { error: `All models for ${tier} failed. Last error: ${lastError}` };
  }
}
