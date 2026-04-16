import fs from "node:fs";
import path from "node:path";

/**
 * Manages the message list for the OpenAI-compatible API.
 * Persists to workspace/logs/conversation/ on every write.
 * Loads existing history when workspacePath is provided.
 */
export class ConversationHistory {
  /**
   * @param {string} [workspacePath] - Workspace directory for persistence
   */
  constructor(workspacePath) {
    /** @type {Array<object>} API messages */
    this._messages = [];
    /** @type {Array<object>} Flat display log for replay */
    this._displayLog = [];
    this._workspacePath = workspacePath || null;

    if (this._workspacePath) this._load();
  }

  get messages() { return this._messages; }
  get displayLog() { return this._displayLog; }

  addUser(text) {
    this._messages.push({ role: "user", content: text });
    this._displayLog.push({ role: "user", content: text });
    this._save();
  }

  /**
   * Add a pre-built message dict (assistant with tool_calls, tool results, etc.)
   * @param {object} message
   */
  addRaw(message) {
    this._messages.push(message);

    const role = message.role || "";
    if (role === "assistant") {
      const content = message.content || "";
      if (content) {
        this._displayLog.push({ role: "agent", content });
      }
      for (const tc of message.tool_calls || []) {
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
      const content = message.content || "";
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

  _save() {
    if (!this._workspacePath) return;
    const convDir = path.join(this._workspacePath, "logs", "conversation");
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(
      path.join(convDir, "messages.json"),
      JSON.stringify(this._messages, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(convDir, "display.json"),
      JSON.stringify(this._displayLog, null, 2),
      "utf-8",
    );
  }

  _load() {
    if (!this._workspacePath) return;
    const convDir = path.join(this._workspacePath, "logs", "conversation");

    const msgPath = path.join(convDir, "messages.json");
    if (fs.existsSync(msgPath)) {
      try { this._messages = JSON.parse(fs.readFileSync(msgPath, "utf-8")); }
      catch { this._messages = []; }
    }

    const displayPath = path.join(convDir, "display.json");
    if (fs.existsSync(displayPath)) {
      try { this._displayLog = JSON.parse(fs.readFileSync(displayPath, "utf-8")); }
      catch { this._displayLog = []; }
    }
  }
}
