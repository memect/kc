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
      "tier4 is cheapest. Returns response with model used and token counts."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["tier1", "tier2", "tier3", "tier4"], description: "Worker LLM tier to use" },
        prompt: { type: "string", description: "The user/task prompt to send" },
        system_prompt: { type: "string", description: "Optional system prompt for context" },
        max_tokens: { type: "integer", description: "Maximum tokens in response (default 4096)" },
      },
      required: ["tier", "prompt"],
    };
  }

  async execute(input) {
    const tier = input.tier || "tier2";
    const prompt = input.prompt || "";
    const systemPrompt = input.system_prompt;
    const maxTokens = input.max_tokens || 4096;

    if (!prompt) return new ToolResult("No prompt provided", true);
    if (!this._apiKey) return new ToolResult("Worker LLM API key not configured", true);

    this._loadTiers();
    const models = this._tierModels[tier] || [];
    if (models.length === 0) {
      return new ToolResult(`No models configured for ${tier}. Check .env TIER1-TIER4 settings.`, true);
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
          const result = {
            response: data.choices[0].message.content,
            model_used: model,
            tier,
            tokens_in: usage.prompt_tokens || 0,
            tokens_out: usage.completion_tokens || 0,
          };
          return new ToolResult(JSON.stringify(result, null, 2));
        }
        lastError = `${model}: HTTP ${resp.status}`;
      } catch (e) {
        lastError = `${model}: ${e.message}`;
      }
    }

    return new ToolResult(`All models for ${tier} failed. Last error: ${lastError}`, true);
  }
}
