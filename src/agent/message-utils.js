/**
 * Message-array utilities shared by engine.js (compact) and
 * context-window.js (windowing). Lives in its own module to avoid
 * the circular import that would result if either of those imported
 * from the other.
 */

/**
 * v0.6.3.1: Find a split point in a message array that won't create
 * orphan tool messages or orphan tool_calls.
 *
 * Invariant for a clean split at index `s`:
 *   - messages[s] is not role:"tool"   (would orphan a tool result whose
 *                                        preceding assistant_with_tool_calls
 *                                        got summarized into the older slice)
 *   - messages[s-1] is not role:"assistant" with tool_calls   (would orphan
 *     the tool_calls because their tool results sit at start of recent and
 *     the older-side summary breaks the pairing)
 *
 * Walks forward from `desiredSplit` until both conditions hold. Returns
 * messages.length if no safe split exists.
 *
 * E2E #5 (2026-04-28) surfaced this: compact() reduced 84 msgs → 12 with
 * msg[2] being an orphan tool message → DeepSeek 400 every subsequent
 * turn. All three alive sessions hit the same trap on /compact.
 *
 * @param {Array<object>} messages
 * @param {number} desiredSplit - the split point you'd take naïvely
 * @returns {number} a safe split point ≥ desiredSplit
 */
export function findSafeSplitPoint(messages, desiredSplit) {
  let s = Math.max(0, Math.min(desiredSplit, messages.length));
  while (s < messages.length) {
    const recentStart = messages[s];
    const olderEnd = s > 0 ? messages[s - 1] : null;
    const recentStartsWithOrphanTool = recentStart?.role === "tool";
    const olderEndsWithUnpairedToolCalls =
      olderEnd?.role === "assistant" &&
      Array.isArray(olderEnd?.tool_calls) &&
      olderEnd.tool_calls.length > 0;
    if (!recentStartsWithOrphanTool && !olderEndsWithUnpairedToolCalls) return s;
    s++;
  }
  return s;
}
