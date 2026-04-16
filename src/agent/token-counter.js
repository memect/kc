/**
 * Lightweight token estimation without external dependencies.
 * Uses character-based heuristics: ~4 chars per token for Latin text,
 * ~1.5 tokens per CJK character.
 */

// CJK Unified Ideographs and extensions
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/**
 * Estimate the number of tokens in a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4) + Math.ceil(cjkCount * 1.5);
}

/**
 * Estimate total tokens for an array of OpenAI-format messages.
 * Accounts for per-message overhead (~4 tokens for role/formatting).
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + formatting overhead
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      // Anthropic-style content blocks
      for (const block of msg.content) {
        if (block.text) total += estimateTokens(block.text);
        if (block.content) total += estimateTokens(block.content);
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function?.name || "");
        total += estimateTokens(tc.function?.arguments || "");
      }
    }
  }
  return total;
}

/**
 * Format a token count for display (e.g., "45.2k").
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokenCount(tokens) {
  if (tokens >= 1000) {
    return (tokens / 1000).toFixed(1) + "k";
  }
  return tokens.toString();
}
