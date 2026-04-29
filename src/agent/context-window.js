import { estimateTokens, estimateMessagesTokens } from "./token-counter.js";
import { findSafeSplitPoint } from "./message-utils.js";

/**
 * Automatic context windowing for long conversations.
 * When messages approach the model's context limit, older messages
 * are compressed into summaries while keeping recent messages intact.
 */
export class ContextWindow {
  /**
   * @param {object} opts
   * @param {number} opts.contextLimit - Total model context limit in tokens
   * @param {number} [opts.reserveForResponse=8192] - Tokens reserved for model output
   * @param {number} [opts.recentWindowSize=30] - Number of recent messages to always keep
   */
  constructor({ contextLimit, reserveForResponse = 8192, recentWindowSize = 30, triggerFraction = 0.70 }) {
    this.contextLimit = contextLimit;
    this.reserveForResponse = reserveForResponse;
    this.recentWindowSize = recentWindowSize;
    // Fraction of budget that triggers windowing. v0.5.3 used 0.85 which only
    // fired after runtime was already deep in the danger zone (a subsequent
    // tool result could tip it over before the next check). 0.70 leaves room
    // for one more tool result before hitting the hard ceiling.
    this.triggerFraction = triggerFraction;
  }

  /**
   * Apply windowing to a message array if it exceeds the token budget.
   * @param {Array<object>} messages - Full message history
   * @param {string[]} [phaseSummaries] - Summaries from completed pipeline phases
   * @returns {{ messages: Array, wasWindowed: boolean, removedCount: number }}
   */
  window(messages, phaseSummaries = []) {
    const totalTokens = estimateMessagesTokens(messages);
    const budget = this.contextLimit - this.reserveForResponse;

    // If within budget, return as-is
    if (totalTokens <= budget * this.triggerFraction) {
      return { messages, wasWindowed: false, removedCount: 0 };
    }

    // Split into older and recent. v0.6.3.1: tool-pair atomicity is a
    // bidirectional invariant — recent[0] must not be a `tool` (orphan,
    // its assistant_with_tool_calls got summarized away) AND older[-1]
    // must not be `assistant_with_tool_calls` (its tool results sit at
    // the start of recent and the older summary corrupts that pairing).
    // Use the shared `findSafeSplitPoint` helper from engine.js.
    const desiredSplit = Math.max(0, messages.length - this.recentWindowSize);
    const splitPoint = findSafeSplitPoint(messages, desiredSplit);
    const recentMessages = messages.slice(splitPoint);
    const olderMessages = messages.slice(0, splitPoint);

    if (olderMessages.length === 0) {
      return { messages, wasWindowed: false, removedCount: 0 };
    }

    // Build a compact summary of older messages
    const recentTokens = estimateMessagesTokens(recentMessages);
    const summaryBudget = budget - recentTokens - 500; // 500 tokens buffer
    const compactedSummary = this._compactMessages(olderMessages, phaseSummaries, summaryBudget);

    const windowedMessages = [
      {
        role: "user",
        content: `[Context Summary - Earlier conversation compressed]\n\n${compactedSummary}`,
      },
      {
        role: "assistant",
        content: "Understood. I have the context from the summary above. Continuing with the current work.",
      },
      ...recentMessages,
    ];

    return {
      messages: windowedMessages,
      wasWindowed: true,
      removedCount: olderMessages.length,
    };
  }

  /**
   * Create a mechanical compact summary of messages.
   * Groups into conversational turns and extracts key info.
   * @param {Array<object>} messages
   * @param {string[]} phaseSummaries
   * @param {number} tokenBudget
   * @returns {string}
   */
  _compactMessages(messages, phaseSummaries, tokenBudget) {
    const parts = [];

    // Phase summaries first (high signal)
    if (phaseSummaries.length > 0) {
      parts.push("## Phase History");
      for (const s of phaseSummaries) {
        parts.push(`- ${s}`);
      }
      parts.push("");
    }

    // Extract key events from older messages
    parts.push("## Conversation Summary");
    const turns = this._groupIntoTurns(messages);

    for (const turn of turns) {
      const line = this._summarizeTurn(turn);
      if (line) {
        parts.push(`- ${line}`);
        // Check budget
        if (estimateTokens(parts.join("\n")) > tokenBudget * 0.9) {
          parts.push("- [earlier history truncated]");
          break;
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Group messages into user-turn blocks.
   * Each turn: { user: string, tools: [{name, summary}], assistantSummary: string }
   */
  _groupIntoTurns(messages) {
    const turns = [];
    let current = null;

    for (const msg of messages) {
      if (msg.role === "user") {
        if (current) turns.push(current);
        current = { user: msg.content || "", tools: [], assistant: "" };
      } else if (msg.role === "assistant" && current) {
        if (msg.content) current.assistant = msg.content;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            current.tools.push(tc.function?.name || "unknown");
          }
        }
      }
      // tool results are captured implicitly via tool names
    }
    if (current) turns.push(current);
    return turns;
  }

  /**
   * Summarize a single conversational turn into one line.
   */
  _summarizeTurn(turn) {
    const userSnippet = (turn.user || "").slice(0, 80).replace(/\n/g, " ");
    if (!userSnippet) return null;

    let line = `User: "${userSnippet}"`;
    if (turn.tools.length > 0) {
      line += ` → Tools: ${turn.tools.join(", ")}`;
    }
    if (turn.assistant) {
      const aSnippet = turn.assistant.slice(0, 60).replace(/\n/g, " ");
      line += ` → "${aSnippet}..."`;
    }
    return line;
  }
}
