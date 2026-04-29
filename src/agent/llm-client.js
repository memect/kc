import { withRetry } from "./retry.js";

// A5: SSE accumulator safety cap. If a provider ever sends an abnormally
// large `data: ...` line without a newline terminator, the parser's
// `buffer += decoder.decode(chunk)` + `buffer.split("\n")` would grow
// unbounded and trigger O(n²) splitting once it gets into the hundreds
// of MB. 8 MB is multiple orders of magnitude above any legitimate single
// SSE frame (largest seen in the wild: ~80 KB for multi-tool-call deltas).
const SSE_BUFFER_CAP_BYTES = 8 * 1024 * 1024;

class SseOverflowError extends Error {
  constructor(bytes) {
    super(`SSE buffer overflow (${bytes} bytes without newline) — aborting stream`);
    this.code = "SSE_BUFFER_OVERFLOW";
  }
}

/**
 * Multi-protocol LLM client using native fetch + SSE parsing.
 * Supports OpenAI-compatible APIs and Anthropic Messages API.
 */
export class LLMClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.baseUrl - e.g. "https://api.siliconflow.cn/v1" or "https://api.anthropic.com"
   * @param {string} [opts.authType] - "bearer" (default) | "x-api-key" (Anthropic)
   * @param {string} [opts.apiFormat] - "openai" (default) | "anthropic"
   */
  constructor({ apiKey, baseUrl, authType = "bearer", apiFormat = "openai" }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authType = authType;
    this.apiFormat = apiFormat;
  }

  /**
   * Build auth headers based on provider type.
   * @returns {object}
   */
  _buildHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this.authType === "x-api-key") {
      headers["x-api-key"] = this.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (this.authType === "aws-sigv4") {
      throw new Error(
        "AWS Bedrock authentication (SigV4) is not yet supported. " +
        "Please use a different provider or an OpenAI-compatible proxy."
      );
    } else {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Get the chat endpoint for the configured API format.
   * @returns {string}
   */
  _getEndpoint() {
    if (this.apiFormat === "anthropic") {
      return `${this.baseUrl}/v1/messages`;
    }
    return `${this.baseUrl}/chat/completions`;
  }

  /**
   * Build request body for the configured API format.
   * @param {object} opts
   * @returns {object}
   */
  _buildStreamBody({ model, messages, tools, maxTokens }) {
    if (this.apiFormat === "anthropic") {
      return this._buildAnthropicBody({ model, messages, tools, maxTokens, stream: true });
    }
    return this._buildOpenaiBody({ model, messages, tools, maxTokens, stream: true });
  }

  _buildNonStreamBody({ model, messages, maxTokens }) {
    if (this.apiFormat === "anthropic") {
      return this._buildAnthropicBody({ model, messages, tools: null, maxTokens, stream: false });
    }
    return this._buildOpenaiBody({ model, messages, tools: null, maxTokens, stream: false });
  }

  _buildOpenaiBody({ model, messages, tools, maxTokens, stream }) {
    const body = { model, messages, stream };
    if (maxTokens) body.max_tokens = maxTokens;
    if (tools && tools.length > 0) body.tools = tools;

    // Hybrid reasoning models (GLM-5.1, DeepSeek v4, MiMo v2.5, Qwen3, ...)
    // emit `reasoning_content` by default. KC's history layer doesn't round-
    // trip that field yet, so DeepSeek's strict API rejects subsequent turns
    // ("reasoning_content in the thinking mode must be passed back to the
    // API"). Set KC_DISABLE_THINKING=1 to opt out cleanly — providers that
    // don't recognize the field ignore it. Proper round-trip support is a
    // v0.6.3 item.
    if (process.env.KC_DISABLE_THINKING === "1" || process.env.KC_DISABLE_THINKING === "true") {
      body.thinking = { type: "disabled" };
    }

    return body;
  }

  _buildAnthropicBody({ model, messages, tools, maxTokens, stream }) {
    // Anthropic: system message is a top-level field, not in messages array
    let system = undefined;
    const filteredMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        system = (system ? system + "\n\n" : "") + msg.content;
      } else if (msg.role === "tool") {
        // Anthropic expects tool results as user messages with tool_result content blocks
        filteredMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
      } else if (msg.role === "assistant" && msg.tool_calls) {
        // Convert OpenAI tool_calls to Anthropic content blocks
        const content = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore */ }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        filteredMessages.push({ role: "assistant", content });
      } else {
        filteredMessages.push(msg);
      }
    }

    const body = {
      model,
      messages: filteredMessages,
      max_tokens: maxTokens || 8192,
      stream,
    };
    if (system) body.system = system;
    if (tools && tools.length > 0) {
      // Convert OpenAI tool schema to Anthropic tool schema
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));
    }
    return body;
  }

  /**
   * Streaming chat completion. Yields parsed SSE chunk objects
   * normalized to OpenAI shape: { choices: [{ delta: { content?, tool_calls? } }] }
   * @param {object} opts
   * @param {string} opts.model
   * @param {Array} opts.messages
   * @param {Array} [opts.tools]
   * @param {number} [opts.maxTokens]
   * @yields {object} Normalized chunk
   */
  async *streamChat({ model, messages, tools, maxTokens }) {
    const body = this._buildStreamBody({ model, messages, tools, maxTokens });

    let resp;
    try {
      resp = await withRetry(async () => {
        const r = await fetch(this._getEndpoint(), {
          method: "POST",
          headers: this._buildHeaders(),
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          const err = new Error(`LLM API error ${r.status}: ${text}`);
          err.status = r.status;
          err.retryAfter = r.headers.get("retry-after");
          err.streamTermination = "http_error";
          throw err;
        }
        return r;
      });
    } catch (err) {
      // A8: Any pre-stream failure (network, auth, 4xx/5xx after retry) is
      // tagged and re-thrown. Engine's outer catch sees exactly one tagged
      // error event.
      if (!err.streamTermination) err.streamTermination = "connect_error";
      throw err;
    }

    // A8: Wrap the SSE consumption so ALL termination paths — clean EOS,
    // mid-token abort, SSE overflow, provider disconnect — surface as a
    // single tagged error the engine can report consistently. The inner
    // parsers throw for overflow (A5) and return silently on clean EOS;
    // mid-stream socket errors (undici "terminated") raise here.
    try {
      if (this.apiFormat === "anthropic") {
        yield* this._parseAnthropicSSE(resp.body);
      } else {
        yield* this._parseOpenaiSSE(resp.body);
      }
    } catch (err) {
      if (!err.streamTermination) {
        if (err.code === "SSE_BUFFER_OVERFLOW") err.streamTermination = "sse_overflow";
        else if (err.name === "AbortError") err.streamTermination = "aborted";
        else if (/terminated|reset|ECONNRESET|UND_ERR_ABORTED/i.test(err.message || err.code || ""))
          err.streamTermination = "stream_terminated";
        else err.streamTermination = "stream_error";
      }
      throw err;
    } finally {
      // Best-effort: cancel the body so the underlying socket returns to the
      // connection pool even if the consumer bailed mid-stream.
      try { await resp.body?.cancel?.(); } catch { /* ignore */ }
    }
  }

  /**
   * Non-streaming chat completion. Returns the full response
   * normalized to OpenAI shape.
   * @param {object} opts
   * @returns {object}
   */
  async chat({ model, messages, maxTokens }) {
    const body = this._buildNonStreamBody({ model, messages, maxTokens });

    const resp = await withRetry(async () => {
      const r = await fetch(this._getEndpoint(), {
        method: "POST",
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        const err = new Error(`LLM API error ${r.status}: ${text}`);
        err.status = r.status;
        err.retryAfter = r.headers.get("retry-after");
        throw err;
      }
      return r;
    });

    const data = await resp.json();

    if (this.apiFormat === "anthropic") {
      // Normalize Anthropic response to OpenAI shape
      const textParts = [];
      for (const block of data.content || []) {
        if (block.type === "text") textParts.push(block.text);
      }
      return {
        choices: [{
          message: {
            role: "assistant",
            content: textParts.join(""),
          },
        }],
        usage: data.usage ? {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
        } : undefined,
      };
    }

    return data;
  }

  /**
   * List available models from the provider.
   * @returns {Promise<Array<{id: string, name: string, ownedBy: string}>>}
   */
  async listModels() {
    let endpoint;
    if (this.apiFormat === "anthropic") {
      endpoint = `${this.baseUrl}/v1/models`;
    } else {
      endpoint = `${this.baseUrl}/models`;
    }

    try {
      const resp = await fetch(endpoint, {
        method: "GET",
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || []).map((m) => ({
        id: m.id,
        name: m.id,
        ownedBy: m.owned_by || "",
      }));
    } catch {
      return [];
    }
  }

  // --- OpenAI SSE parsing ---

  /**
   * Parse SSE stream from OpenAI-compatible API.
   * @param {ReadableStream} body
   * @yields {object} Parsed chunk
   */
  async *_parseOpenaiSSE(body) {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      // A5: bail out before O(n²) split explodes on pathological input.
      if (buffer.length > SSE_BUFFER_CAP_BYTES) throw new SseOverflowError(buffer.length);
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6).trim();
        if (data !== "[DONE]") {
          try { yield JSON.parse(data); } catch { /* skip */ }
        }
      }
    }
  }

  // --- Anthropic SSE parsing + normalization ---

  /**
   * Parse Anthropic SSE stream and normalize to OpenAI chunk shape.
   * Anthropic SSE uses event types: message_start, content_block_start,
   * content_block_delta, content_block_stop, message_delta, message_stop.
   *
   * Normalizes everything to: { choices: [{ delta: { content?, tool_calls? } }] }
   * so engine.js needs no changes.
   *
   * @param {ReadableStream} body
   * @yields {object} Normalized OpenAI-shaped chunk
   */
  async *_parseAnthropicSSE(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = "";

    // State for accumulating tool call content blocks
    let toolCallIndex = -1;

    for await (const rawChunk of body) {
      buffer += decoder.decode(rawChunk, { stream: true });
      // A5: cap applies to both SSE parsers.
      if (buffer.length > SSE_BUFFER_CAP_BYTES) throw new SseOverflowError(buffer.length);
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed.startsWith("event: ")) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6).trim();
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }

          const normalized = this._normalizeAnthropicEvent(currentEventType, data, { toolCallIndex });
          if (normalized) {
            // Update tool call index tracking
            if (normalized._newToolCallIndex !== undefined) {
              toolCallIndex = normalized._newToolCallIndex;
              delete normalized._newToolCallIndex;
            }
            yield normalized;
          }
        }
      }
    }
  }

  /**
   * Normalize a single Anthropic SSE event into OpenAI chunk shape.
   * @param {string} eventType
   * @param {object} data
   * @param {object} state - Mutable state for tracking across events
   * @returns {object|null} Normalized chunk or null if no output needed
   */
  _normalizeAnthropicEvent(eventType, data, state) {
    switch (eventType) {
      case "content_block_start": {
        const block = data.content_block;
        if (block?.type === "text") {
          // Text block starting — no content yet
          return null;
        }
        if (block?.type === "tool_use") {
          state.toolCallIndex++;
          const chunk = {
            choices: [{
              delta: {
                tool_calls: [{
                  index: state.toolCallIndex,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: "" },
                }],
              },
            }],
            _newToolCallIndex: state.toolCallIndex,
          };
          return chunk;
        }
        return null;
      }

      case "content_block_delta": {
        const delta = data.delta;
        if (delta?.type === "text_delta") {
          return {
            choices: [{ delta: { content: delta.text } }],
          };
        }
        if (delta?.type === "input_json_delta") {
          return {
            choices: [{
              delta: {
                tool_calls: [{
                  index: state.toolCallIndex,
                  function: { arguments: delta.partial_json },
                }],
              },
            }],
          };
        }
        return null;
      }

      case "message_delta": {
        // End of message — contains stop_reason and usage
        return {
          choices: [{
            delta: {},
            finish_reason: data.delta?.stop_reason === "end_turn" ? "stop" : (data.delta?.stop_reason || null),
          }],
        };
      }

      case "message_start":
      case "content_block_stop":
      case "message_stop":
      case "ping":
        return null;

      default:
        return null;
    }
  }
}
