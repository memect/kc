/**
 * v0.7.0 E1m (#90): minimal event-atomic context.
 *
 * History is conceptually a sequence of *events*. Each event encapsulates
 * one or more chat messages that must travel together — splitting one
 * event mid-flight produces the orphan-tool / orphan-tool_calls failure
 * mode that DeepSeek's strict API rejects with HTTP 400.
 *
 * Yibo's framing (E2E #5 post-mortem): "history message and context
 * management... should be managed by events, like agent message, llm
 * call, tool use, etc. By design, a cut in the middle of an event
 * shouldn't happen."
 *
 * Scope (v0.7.0 minimal): events are a *derived view*, computed from
 * the existing flat messages array on demand. The flat array stays as
 * the canonical store. compact() and windowing use event boundaries
 * to find safe cut points; they never split mid-event.
 *
 * Future v0.8.x may invert this and make events the canonical store.
 * The reversible helpers (messagesToEvents / eventsToMessages) make
 * that migration cheap when the time comes.
 */

export const EventType = Object.freeze({
  USER_TURN: "user_turn",
  ASSISTANT_TURN: "assistant_turn",
  TOOL_CALL_PAIR: "tool_call_pair",
  SYSTEM_REMINDER: "system_reminder",
});

/**
 * Group a flat OpenAI-shape messages array into atomic events.
 *
 * Event types and shapes:
 *   user_turn        — { type, messages: [{role: "user", ...}] }
 *   assistant_turn   — { type, messages: [{role: "assistant", content: "...", reasoning_content?, ...}] }
 *                       (no tool_calls; if tool_calls present, becomes tool_call_pair)
 *   tool_call_pair   — { type, messages: [
 *                          {role: "assistant", tool_calls: [...], ...},
 *                          {role: "tool", tool_call_id: ...},
 *                          {role: "tool", tool_call_id: ...},  // 1+ tool results
 *                       ] }
 *   system_reminder  — { type, messages: [{role: "system", content: "..."}] }
 *                       (mid-session system messages — kept for
 *                       v0.6.3 phase-misfit-nudge etc.; the bootstrap
 *                       system prompt is NOT in messages, lives separately)
 *
 * Unmatched tool messages (no preceding assistant_with_tool_calls)
 * become a degenerate one-message tool_call_pair with no anchor. They
 * mark a problematic split — caller can decide whether to drop or warn.
 *
 * @param {Array<object>} messages - flat OpenAI-shape array
 * @returns {Array<{type: string, messages: object[], startIdx: number, endIdx: number}>}
 *   Events with original-index ranges so callers can map event boundaries
 *   back to slice cut points in the source messages array.
 */
export function messagesToEvents(messages) {
  const events = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m || typeof m !== "object") { i++; continue; }

    if (m.role === "system") {
      events.push({
        type: EventType.SYSTEM_REMINDER,
        messages: [m],
        startIdx: i,
        endIdx: i,
      });
      i++;
      continue;
    }

    if (m.role === "user") {
      events.push({
        type: EventType.USER_TURN,
        messages: [m],
        startIdx: i,
        endIdx: i,
      });
      i++;
      continue;
    }

    if (m.role === "assistant") {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (!hasToolCalls) {
        events.push({
          type: EventType.ASSISTANT_TURN,
          messages: [m],
          startIdx: i,
          endIdx: i,
        });
        i++;
        continue;
      }
      // Assistant with tool_calls — collect the matching tool result(s)
      // that follow. Tool results may not appear in tool_calls order;
      // we just consume contiguous tool messages until a non-tool
      // appears or the array ends. Real OpenAI/Anthropic tool result
      // sequences are always contiguous and immediate.
      const expected = new Set(m.tool_calls.map((tc) => tc.id));
      const group = [m];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        group.push(messages[j]);
        // Don't enforce match strictly — Anthropic-format collapse
        // can produce tool messages with synthesized IDs. Just consume
        // contiguously; consumer of the event can validate IDs if needed.
        j++;
      }
      events.push({
        type: EventType.TOOL_CALL_PAIR,
        messages: group,
        startIdx: i,
        endIdx: j - 1,
        // Diagnostic: did we collect all expected tool results?
        completePair: expected.size === 0 ||
          group.slice(1).every((tm) => expected.has(tm.tool_call_id)),
      });
      i = j;
      continue;
    }

    if (m.role === "tool") {
      // Orphan tool message (no preceding assistant_with_tool_calls).
      // Record as degenerate event so callers can spot + handle.
      events.push({
        type: EventType.TOOL_CALL_PAIR,
        messages: [m],
        startIdx: i,
        endIdx: i,
        completePair: false,
        orphan: true,
      });
      i++;
      continue;
    }

    // Unknown role — pass through as a singleton event with the role
    // as type. Defensive: don't drop.
    events.push({
      type: m.role || "unknown",
      messages: [m],
      startIdx: i,
      endIdx: i,
    });
    i++;
  }
  return events;
}

/**
 * Inverse of messagesToEvents. Concatenates each event's messages
 * array. Used by callers that work in the events space and need to
 * hand a flat messages array to the LLM client.
 *
 * @param {Array<object>} events
 * @returns {Array<object>}
 */
export function eventsToMessages(events) {
  const out = [];
  for (const ev of events) {
    if (Array.isArray(ev?.messages)) {
      for (const m of ev.messages) out.push(m);
    }
  }
  return out;
}

/**
 * Find the message index of the first event boundary at or after
 * `desiredSplit` such that splitting there produces two halves where
 * neither half contains a partial event.
 *
 * Used by compact() and windowing as the canonical cut-point chooser.
 * Backwards-compatible drop-in for findSafeSplitPoint (same signature
 * + same return semantics).
 *
 * Algorithm: convert messages to events, find the event whose endIdx
 * is the largest value < desiredSplit (everything up to and including
 * that event goes to "older"). Return that event's endIdx + 1 (the
 * first index of the "recent" half). If desiredSplit is at or before
 * the first event, return 0. If past the last event, return messages.length.
 *
 * @param {Array<object>} messages
 * @param {number} desiredSplit - the cut point you'd take naïvely
 * @returns {number} a cut point that lands on an event boundary
 */
export function findEventBoundary(messages, desiredSplit) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const target = Math.max(0, Math.min(desiredSplit, messages.length));
  if (target === 0) return 0;
  if (target >= messages.length) return messages.length;

  const events = messagesToEvents(messages);
  // Walk forward — find the first event whose startIdx >= target.
  // The cut goes BEFORE that event (so the prior event is intact in
  // the "older" half). If no event satisfies, all events are before
  // target → cut at messages.length.
  for (const ev of events) {
    if (ev.startIdx >= target) return ev.startIdx;
  }
  return messages.length;
}

/**
 * Diagnostic: count event types in a messages array. Used by tests
 * and the heap analyzer to surface event-shape statistics.
 *
 * @param {Array<object>} messages
 * @returns {Record<string, number>}
 */
export function countEvents(messages) {
  const events = messagesToEvents(messages);
  const counts = {};
  for (const ev of events) {
    counts[ev.type] = (counts[ev.type] || 0) + 1;
  }
  return counts;
}
