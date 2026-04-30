/**
 * Message-array utilities shared by engine.js (compact) and
 * context-window.js (windowing). Lives in its own module to avoid
 * the circular import that would result if either of those imported
 * from the other.
 */

import { findEventBoundary } from "./history/event-history.js";

/**
 * Find a split point in a message array that won't create orphan tool
 * messages or orphan tool_calls.
 *
 * v0.7.0 E1m (#90): now delegates to findEventBoundary, which operates
 * on derived event boundaries from `history/event-history.js`. The
 * legacy heuristic check (orphan-tool / unpaired-tool_calls walk) is
 * kept as belt-and-braces defense — if the event helper for some
 * reason returns a position that still has a local orphan, the legacy
 * walk forwards past it.
 *
 * Invariant for a clean split at index `s`:
 *   - messages[s] is not role:"tool"   (would orphan a tool result whose
 *                                        preceding assistant_with_tool_calls
 *                                        got summarized into the older slice)
 *   - messages[s-1] is not role:"assistant" with tool_calls   (would orphan
 *     the tool_calls because their tool results sit at start of recent and
 *     the older-side summary breaks the pairing)
 *
 * E2E #5 (2026-04-28) surfaced this: compact() reduced 84 msgs → 12 with
 * msg[2] being an orphan tool message → DeepSeek 400 every subsequent
 * turn. v0.6.3.1 fixed it via the heuristic; v0.7.0 makes the event
 * structure explicit so future event types (sub-agent results, etc.)
 * extend the model rather than the heuristic.
 *
 * @param {Array<object>} messages
 * @param {number} desiredSplit - the split point you'd take naïvely
 * @returns {number} a safe split point ≥ desiredSplit
 */
export function findSafeSplitPoint(messages, desiredSplit) {
  // Primary: ask the event helper for the next event boundary at or
  // after desiredSplit. If events are well-formed (which they
  // always are when produced by the engine's own history.addRaw path),
  // this lands on a clean boundary by construction.
  let s = findEventBoundary(messages, Math.max(0, Math.min(desiredSplit, messages.length)));

  // Defense-in-depth: legacy heuristic walk catches the edge case where
  // the messages array contains a manually-injected orphan (e.g., from
  // a prior buggy compact, or an externally-edited messages.json).
  // Cheap to keep and prevents regressions if a future event-type
  // addition has a bug.
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
