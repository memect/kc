import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./token-counter.js";

/**
 * Append-only JSONL event log for KC agent sessions.
 * Each line is a JSON object: { seq, ts, type, data }
 *
 * This is the source of truth for session history. ConversationHistory
 * and display logs become views over this log.
 */
export class EventLog {
  /**
   * @param {string} workspacePath - Session workspace directory
   */
  constructor(workspacePath) {
    this._dir = path.join(workspacePath, "logs");
    this._logPath = path.join(this._dir, "events.jsonl");
    this._seq = 0;
    this._estimatedTokens = 0;
    this._initFromExisting();
  }

  /** Current sequence number */
  get currentSeq() { return this._seq; }

  /** Estimated total tokens across all events */
  get estimatedTokens() { return this._estimatedTokens; }

  /** Path to the log file */
  get logPath() { return this._logPath; }

  /**
   * Initialize sequence counter and token estimate from existing log file.
   */
  _initFromExisting() {
    if (!fs.existsSync(this._logPath)) return;
    try {
      const content = fs.readFileSync(this._logPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.seq > this._seq) this._seq = event.seq;
          this._estimatedTokens += this._eventTokens(event);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file read error, start fresh */ }
  }

  /**
   * Append an event to the log.
   * @param {string} type - Event type
   * @param {object} [data] - Event payload
   * @returns {number} The sequence number of the appended event
   */
  append(type, data = {}) {
    this._seq++;
    const event = {
      seq: this._seq,
      ts: new Date().toISOString(),
      type,
      data,
    };

    fs.mkdirSync(this._dir, { recursive: true });
    fs.appendFileSync(this._logPath, JSON.stringify(event) + "\n", "utf-8");

    this._estimatedTokens += this._eventTokens(event);
    return this._seq;
  }

  /**
   * Read events from the log with optional filtering.
   * @param {object} [opts]
   * @param {number} [opts.fromSeq] - Start reading from this sequence (inclusive)
   * @param {number} [opts.toSeq] - Stop reading at this sequence (inclusive)
   * @param {string[]} [opts.types] - Only return events of these types
   * @returns {Array<object>}
   */
  read({ fromSeq = 0, toSeq = Infinity, types } = {}) {
    if (!fs.existsSync(this._logPath)) return [];

    const events = [];
    const content = fs.readFileSync(this._logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.seq < fromSeq || event.seq > toSeq) continue;
        if (types && !types.includes(event.type)) continue;
        events.push(event);
      } catch { /* skip */ }
    }

    return events;
  }

  /**
   * Estimate tokens for a single event (for running total).
   * @param {object} event
   * @returns {number}
   */
  _eventTokens(event) {
    const dataStr = typeof event.data === "string"
      ? event.data
      : JSON.stringify(event.data || {});
    return estimateTokens(dataStr);
  }
}
