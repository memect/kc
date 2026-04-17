import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./token-counter.js";

// Belt-and-suspenders cap on any single message's content. Block 11 tool-call
// offloading already prevents tool outputs from getting this big in normal use,
// but old/migrated workspaces and edge cases benefit from a hard ceiling that
// keeps a single bloated message from blowing the model's context budget alone.
const DEFAULT_MAX_MESSAGE_TOKENS = 30000;

/**
 * Manages the message list for the OpenAI-compatible API.
 * Persists to <conversationDir>/ on every write.
 *
 * @param {string} [workspacePath] - Workspace directory (default conversation dir is workspacePath/logs/conversation/)
 * @param {object} [opts]
 * @param {string} [opts.conversationDir] - Override absolute path (used for sub-agent isolation, Bug 2)
 * @param {number} [opts.maxMessageTokens] - Per-message content cap (default 30000)
 */
export class ConversationHistory {
  constructor(workspacePath, opts = {}) {
    /** @type {Array<object>} API messages */
    this._messages = [];
    /** @type {Array<object>} Flat display log for replay */
    this._displayLog = [];
    this._workspacePath = workspacePath || null;
    this._conversationDir = opts.conversationDir || (workspacePath ? path.join(workspacePath, "logs", "conversation") : null);
    this._maxMessageTokens = opts.maxMessageTokens ?? DEFAULT_MAX_MESSAGE_TOKENS;

    if (this._conversationDir) this._load();
  }

  get messages() { return this._messages; }
  get displayLog() { return this._displayLog; }

  addUser(text) {
    const capped = this._capContent(text);
    this._messages.push({ role: "user", content: capped });
    this._displayLog.push({ role: "user", content: capped });
    this._save();
  }

  /**
   * Add a pre-built message dict (assistant with tool_calls, tool results, etc.)
   * @param {object} message
   */
  addRaw(message) {
    const msg = { ...message };
    if (typeof msg.content === "string") {
      msg.content = this._capContent(msg.content);
    }
    this._messages.push(msg);

    const role = msg.role || "";
    if (role === "assistant") {
      const content = msg.content || "";
      if (content) {
        this._displayLog.push({ role: "agent", content });
      }
      for (const tc of msg.tool_calls || []) {
        const fn = tc.function || {};
        let toolInput = {};
        try { toolInput = JSON.parse(fn.arguments || "{}"); } catch { /* ignore */ }
        this._displayLog.push({
          role: "tool",
          toolName: fn.name || "",
          toolInput,
        });
      }
    } else if (role === "tool") {
      const content = msg.content || "";
      // Update the last tool entry with output
      for (let i = this._displayLog.length - 1; i >= 0; i--) {
        if (this._displayLog[i].role === "tool" && !("toolOutput" in this._displayLog[i])) {
          this._displayLog[i].toolOutput = content;
          break;
        }
      }
    }

    this._save();
  }

  /**
   * Cap a single message's content if it exceeds maxMessageTokens. Cuts the
   * middle, keeps head + tail, leaves a marker pointing at logs/events.jsonl
   * for the full content (event log keeps everything via appendFileSync).
   *
   * CJK-aware: derives the character budget from a sample-based chars/token
   * ratio. Latin sample ≈ 4 chars/token, CJK ≈ 0.67 chars/token. Iterative
   * tightening converges on the cap; clamping prevents accidental doubling
   * if the heuristic is ever wrong.
   */
  _capContent(content) {
    if (typeof content !== "string" || !content) return content;
    const tokens = estimateTokens(content);
    if (tokens <= this._maxMessageTokens) return content;

    const target = Math.max(100, this._maxMessageTokens - 50); // reserve for marker
    const ratio = this._charsPerToken(content);
    let charBudget = Math.max(100, Math.floor(target * ratio));

    for (let i = 0; i < 5; i++) {
      const head = Math.min(Math.floor(charBudget * 0.6), content.length);
      const tail = Math.min(Math.floor(charBudget * 0.3), Math.max(0, content.length - head));
      // If proposed slices would cover the whole input, truncating creates
      // no savings — return original (the safety-net cap rather doubles than truncates).
      if (head + tail >= content.length) return content;
      const result = content.slice(0, head) + this._truncMarker(tokens) + content.slice(-tail);
      if (estimateTokens(result) <= this._maxMessageTokens) return result;
      charBudget = Math.floor(charBudget * 0.7);
    }

    // Last resort after 5 iterations: head only, no tail.
    const headOnly = Math.min(Math.max(charBudget, 100), content.length);
    return content.slice(0, headOnly) + this._truncMarker(tokens);
  }

  /** Sample-based chars-per-token ratio. Inverse of estimateTokens rate. */
  _charsPerToken(content) {
    const sample = content.slice(0, 2000);
    const t = estimateTokens(sample) || 1;
    return Math.max(0.5, sample.length / t);
  }

  _truncMarker(originalTokens) {
    return `\n\n[…truncated, ${originalTokens} tokens; full content in logs/events.jsonl…]\n\n`;
  }

  /**
   * Re-point this history at a new conversation directory. Used by
   * `engine.renameSession()` (Bug 3) when the workspace is renamed.
   */
  _setWorkspacePath(newWorkspacePath, opts = {}) {
    this._workspacePath = newWorkspacePath;
    this._conversationDir = opts.conversationDir || path.join(newWorkspacePath, "logs", "conversation");
  }

  _save() {
    if (!this._conversationDir) return;
    fs.mkdirSync(this._conversationDir, { recursive: true });
    fs.writeFileSync(
      path.join(this._conversationDir, "messages.json"),
      JSON.stringify(this._messages, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(this._conversationDir, "display.json"),
      JSON.stringify(this._displayLog, null, 2),
      "utf-8",
    );
  }

  _load() {
    if (!this._conversationDir) return;

    const msgPath = path.join(this._conversationDir, "messages.json");
    if (fs.existsSync(msgPath)) {
      try { this._messages = JSON.parse(fs.readFileSync(msgPath, "utf-8")); }
      catch { this._messages = []; }
    }

    const displayPath = path.join(this._conversationDir, "display.json");
    if (fs.existsSync(displayPath)) {
      try { this._displayLog = JSON.parse(fs.readFileSync(displayPath, "utf-8")); }
      catch { this._displayLog = []; }
    }
  }
}
