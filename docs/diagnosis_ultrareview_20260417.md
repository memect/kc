# Ultrareview Diagnosis — v0.5.1 → HEAD (v0.5.2) @ 2026-04-17

Scope: 19 files changed, 793 insertions(+), 118 deletions(-). Reviews the
`852b99b..120658c` range. This replaces the earlier same-day review of the
smaller v0.5.2 draft.

Summary: 6 issues of concern. **1 P0** (path-traversal via LLM-supplied
`task_id`). **4 normal** (invalid-sequence preflight still crashes
Anthropic for an important subclass; auto-advance misfires on resume and
backward transitions; phase-advance tool lets KC skip/regress to any phase;
per-message cap doubles CJK). **1 nit** (scheduler "skipped" list conflates
disabled vs. failed).

Of the 6 prior findings: 5 fixed, 1 partially fixed. See the checklist at
the bottom.

---

## 1. `agent_tool` lets the LLM write anywhere on disk — **P0, security**

**File:** `src/agent/tools/agent-tool.js:57-66` (and `src/agent/engine.js:97-104`).

`execute()` takes `input.task_id` (an LLM-chosen string from the tool
schema, no pattern restriction) and feeds it straight into `path.join`:

```js
const taskId = input.task_id || `task_${crypto.randomUUID().slice(0, 8)}`;
const taskDir = path.join(this._workspace.cwd, "sub_agents", taskId);
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, "task.md"), taskDesc, "utf-8");
```

`engine.js:99` then does the same with `subagentScope`:

```js
const scopeRoot = path.join(this.workspace.cwd, "sub_agents", subagentScope);
fs.mkdirSync(scopeRoot, { recursive: true });
// ...conversationDir, logDir, statePath under scopeRoot
```

**Impact.** A malicious prompt or prompt-injection in a document the agent
parses can call `agent_tool` with `task_id: "../../../../tmp/pwn"` — the
sub-agent then creates that directory, writes `task.md` into it, and
persists its entire conversation / event-log / session-state there. Same
class of bug as CVE-pattern "LLM-controlled path" (the standard agentic
escape). Worse: `Workspace.resolvePath` explicitly guards against this
pattern for every *other* tool. `agent_tool` is the one tool that
bypasses it, because it invents its own path and never calls the guard.

**Repro.** A parent KC session calls `agent_tool` with `task_id="../.."`;
the sub-agent's engine writes `session-state.json`, `messages.json`,
`display.json`, `events.jsonl` to the workspace root (trampling the parent's).
`task_id="../../other-session"` targets a peer session. `task_id="/etc/foo"`
on POSIX: `path.join("/ws/cwd", "sub_agents", "/etc/foo")` ⇒
`/ws/cwd/sub_agents/etc/foo` (Node normalizes absolute-as-segment) — so
absolute-paths are safe, but `..` is not.

**Fix.**
1. Sanitize `task_id` before use. The scheduler's `VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`
   pattern in `scheduler.js:7` is the right precedent — reject otherwise.
2. Alternatively, ignore `input.task_id` entirely and always auto-generate
   a UUID suffix. The field's only purpose is human-readability; letting
   the LLM pick was weak UX and now an attack surface. Keep the input
   field for observability but treat it as a *label* stored inside
   `task.md`, not a path component.
3. Defense in depth: in `engine.js:99`, add a traversal check:
   ```js
   const scopeRoot = path.join(this.workspace.cwd, "sub_agents", subagentScope);
   const resolved = path.resolve(scopeRoot);
   if (!resolved.startsWith(path.resolve(this.workspace.cwd) + path.sep)) {
     throw new Error(`sub-agent scope escapes workspace: ${subagentScope}`);
   }
   ```

---

## 2. `_enforceTokenBudget` still produces Anthropic-400 sequences — **normal**

**File:** `src/agent/engine.js:310-352`.

The rewrite addresses the previous review's "orphan tool message" concern
(the assistant-with-tool_calls cleanup at `:332-340` drops the matching
tool replies). **It does not fix Problems 1 and 2 from the previous
review.**

**Problem 1 (summary gets dropped first).** `compact()` at `:383-387` and
`ContextWindow.window()` at `context-window.js:50-60` both produce
`[user(summary), assistant(ack), ...recent]`. The engine prepends `system`
→ `[system, user(summary), assistant(ack), ...]`. `_enforceTokenBudget`
sets `systemIdx = 1` and drops the summary as the first casualty — the
docstring claims to "keep any compaction summary pair if present" but the
code never detects the marker. The `[Previous conversation summary]`
prefix on `compact()` output and the `[Context Summary - Earlier conversation compressed]`
prefix on `ContextWindow` output are both fingerprints the method could
check, but doesn't.

**Problem 2 (first-message-must-be-user violation).** The drop-cleanup at
`:332-340` only handles the case where the dropped message is
`assistant` with `tool_calls`. But the oldest remaining message is
often the `user(summary)` (or a plain `user`). Drop it, and the array
becomes `[system, assistant(...), ...]` — Anthropic's Messages API rejects
with `400 messages: first message must use the user role` (the exact
failure `_enforceTokenBudget` exists to prevent). Triggered path: two
providers in the tree (`llm-client.js`) use `apiFormat: 'anthropic'`.

A third subtle problem: when the drop-assistant branch fires, it drops
the tool replies but does not re-scan whether the new head is still
non-user. Two consecutive assistant-with-tools drops in a row can end
at `[system, tool, tool, ...]` — tool as head is also invalid on
Anthropic.

**Fix.**
1. Detect the summary marker (startsWith test on first 2 content messages)
   and advance `systemIdx` past both the user(summary) and the
   assistant(ack). Same logic for both `[Previous conversation summary]`
   and `[Context Summary - Earlier conversation compressed]`.
2. After every drop, if `messages[systemIdx]?.role !== "user"`, keep
   dropping (or drop an entire user→assistant→tool block, not a single
   message). This is much simpler to implement if you drop in block units:

```js
// pseudocode
while (overBudget) {
  // Find next user boundary at systemIdx (or nothing to drop)
  const end = findNextUserAfter(messages, systemIdx + 1);
  if (end === -1) break;
  messages.splice(systemIdx, end - systemIdx); // drop [user...just-before-next-user]
  recomputeTokens();
}
```
3. Postcondition assert: after the loop, `messages[systemIdx]?.role === "user"` or
   `messages.length === systemIdx`; every `tool` has a preceding assistant
   with matching `tool_call_id`. Throw if violated — better to fail
   loudly than ship a broken request.

---

## 3. `_maybeAutoAdvance` fires on resume + can loop-skip phases — **normal**

**File:** `src/agent/engine.js:783-794`, called from `:679, :741, :911-926`.

Two concrete failure modes:

**(a) Resume reignites advance even though phase was already terminal on last save.**
`AgentEngine.resume()` at `:488-522` restores `currentPhase` from
`session-state.json` and replays `importState` on every pipeline. After
resume, the user sends one message → `runTurn` runs → the `turn_complete`
branch at `:679-680` unconditionally calls `_maybeAutoAdvance`. If the
user is in a phase whose `exitCriteriaMet()` returns `true` but the user
decided to stay (maybe to iterate more rules in EXTRACTION), resume
immediately pushes them to the next phase without any explicit user
action. The previous architecture only advanced when `onToolResult` saw
the transition — tied to an actual state change. The new post-turn
auto-check fires on state that may have been true for days.

Worse for `PRODUCTION_QC`: `exitCriteriaMet()` returns
`monitoringPhase === "stable"`. But `_maybeAutoAdvance` still calls
`NEXT_PHASE[this.currentPhase]` which is `undefined` → returns `null`
(safe). However, the summary label at `:763` is
`[PRODUCTION_QC → undefined]` if anyone wires the next phase in future —
no guard at the `_advancePhase` entry beyond the check already at `:761`.

**(b) Phase-skip on bulk task completion.** `runTaskLoop` at `:915-926`
auto-advances when `_allCurrentPhaseTasksComplete()` returns `true`.
`createTasksForPhase` only runs if `rules/catalog.json` exists — during
BOOTSTRAP there are no rules, so `_allCurrentPhaseTasksComplete()`
returns `false` (guarded on `phaseTasks.length === 0` at `:939`), fine.
But: if a user enters EXTRACTION, tasks are created per rule. The user
cancels all of them (status=skipped) via some manual edit of `tasks.json`
→ next `runTaskLoop` turn sees "all complete", auto-advances to
SKILL_AUTHORING **even if `exitCriteriaMet()` returns false**. Two
triggers (task-completion and exit-criteria) disagree with each other.
This is a design smell: what's the phase-gate actually enforcing?

**Fix.**
- Gate `_maybeAutoAdvance` on `_advancedThisTurn` state so it only
  fires when *this* turn produced new evidence. Equivalent to the old
  `wasReady = exitCriteriaMet()` pattern still present in each pipeline
  at e.g. `initializer.js:169`. Keep the pipelines as the single source of truth
  (they already compute `wasReady` + `newly-ready`), and skip the
  engine-level double-check.
- Or: make `_maybeAutoAdvance` compare against a `_lastAdvanceCheckState`
  snapshot, only transition when the boolean flipped false→true this turn.
- For the task-completion trigger: require `exitCriteriaMet()` AND
  `_allCurrentPhaseTasksComplete()`. Tasks alone aren't a signal; they're
  a ralph-loop convenience.

---

## 4. `phase_advance` tool has no reachability guard — **normal**

**File:** `src/agent/tools/phase-advance.js:41-47` and `src/agent/engine.js:760-776`.

The tool validates that `to` is in `VALID_PHASES` (all six), then calls
`_advancePhase(to, reason)`. `_advancePhase` only refuses the no-op
self-transition. **Nothing prevents `PRODUCTION_QC → BOOTSTRAP`**, or
`BOOTSTRAP → PRODUCTION_QC` skipping four phases of pipeline state.

Consequence of regression: `_createTasksForPhase(BOOTSTRAP)` runs after
going backwards — but BOOTSTRAP doesn't get per-rule tasks (the rule
catalog's tasks are for EXTRACTION+), so no new tasks appear. Session
state now records `currentPhase: "bootstrap"` on a workspace that has
rules, skills, and production data. Next session restart loads
`ProjectInitializer` as the active pipeline — its `describeState()`
re-scans the workspace and reports exits already met, so the very next
turn's `_maybeAutoAdvance` pushes us right back to extraction.
Observable artifact: an orphaned `phase_transition: production_qc →
bootstrap` event in the log.

Consequence of skip: jumping to DISTILLATION without the rule catalog
built in EXTRACTION means `_createTasksForPhase(DISTILLATION)` creates
zero tasks, distill tools register but fail the moment they try to load
missing rule skills. User sees cryptic "ENOENT rule_skills/R001/SKILL.md"
errors and no clear path back.

**Fix.** Either refuse non-adjacent transitions:

```js
// engine.js:760
_advancePhase(nextPhase, reason = "") {
  if (!nextPhase || nextPhase === this.currentPhase) return false;
  const expected = NEXT_PHASE[this.currentPhase];
  if (nextPhase !== expected && reason !== "force") return false; // only forward-by-one
  // ...
}
```

Or: in `phase_advance.execute`, require a second argument `force: true`
to override the linear ordering. Default path is forward-only.

Either way, the tool's `description: "Advance to a different pipeline
phase. Use only when user requests it or auto-detect misses"` should
mention the linear order is enforced, otherwise the LLM may try to jump
and get a confusing refusal.

---

## 5. `_capContent` still doubles CJK content — **normal, CJK workload**

**File:** `src/agent/history.js:89-102`.

Identical to prior-review finding 3 — the cap was moved into a method
and wired through `addUser`/`addRaw`, but the math wasn't corrected.

```js
const charBudget = this._maxMessageTokens * 4; // ~4 chars per token (Latin)
const head = Math.floor(charBudget * 0.6);
const tail = Math.floor(charBudget * 0.3);
return content.slice(0, head) + marker + content.slice(-tail);
```

For CJK content, `token-counter.js:17-20` counts CJK at ~1.5 tokens/char.
Pure-CJK input of 20001 chars:
1. `estimateTokens` = 30002 tokens (cap triggers at 30000).
2. `charBudget = 30000 * 4 = 120000`, `head = 72000`, `tail = 36000`.
3. `content.slice(0, 72000)` returns the entire 20001 chars (JS clamps).
4. `content.slice(-36000)` also returns the entire string.
5. Output = full content + marker + full content ≈ 40003 chars ≈ 60004
   tokens. **The cap doubled the input.**

Worse than before: the cap now fires on *every* `addRaw` with a string
body (assistant messages, `addUser`). So any oversized Chinese tool
result that makes it past offloading (e.g., a user paste via `/ask`)
gets doubled in both `messages.json` and in-memory history. Next
`_enforceTokenBudget` pass sees the doubled content and drops more
messages than it needs to.

**Fix (pick one).**
- One-liner: `const head = Math.min(Math.floor(charBudget * 0.6), content.length);` and same for tail; also short-circuit if `head + tail >= content.length` (return content as-is).
- Proper: compute `charBudget` with the inverse of `estimateTokens` — count CJK characters in the content and back out a character budget that respects the 1.5 tokens/char rate.
- Safest: iterative truncation — start at `head = content.length / 2`, slice, `estimateTokens` the result, shrink until ≤ cap.

---

## 6. `regenerateAllWrappers` return-shape conflates disabled vs. failed — **nit**

**File:** `src/agent/scheduler.js:245-260`.

```js
for (const job of this.list()) {
  if (job.enabled) {
    try { this.renderWrapper(job); out.regenerated.push(job.id); }
    catch { out.skipped.push(job.id); }
  } else {
    out.skipped.push(job.id);           // disabled: same bucket as failed
  }
}
```

Both "disabled" and "render threw" fall into `out.skipped`. The CLI
at `cli/index.js:259-264` only surfaces the `regenerated` count and
doesn't mention skipped at all — so the user has no way to see that a
render failure happened. Low-impact because render failures here are
rare (disk full only), but the signal is lost.

Also: when `regeneratedCount === 0 && skippedCount > 0`, the CLI says
nothing schedule-related after a rename, even though the user may have
jobs they expected to be mentioned.

**Fix.**
- Split into `{ regenerated, skipped, failed }` — or change `skipped`'s
  entries to `{id, reason: 'disabled'|'error', error?}`.
- Mention `skipped.length` in the CLI when at least one wrapper was
  skipped due to error, so the user knows to investigate.

---

## Prior-review checklist

| # | Prior finding | Status |
|---|---|---|
| 1 | `compact()` calls undefined `_chunkMessages` / `_summarizeChunk` | ✅ fixed — both now implemented at `engine.js:412-428` and `:435-461`; mechanical fallback preserved inside `_summarizeChunk` and `_mechanicalSummary` |
| 2 | Sub-agent isolation was dead code (factory didn't thread scope/phase) | ✅ fixed — factory at `engine.js:198-205` now passes `subagentScope + initialPhase`; `agent-tool.js:73-77` calls with the required opts. But see new finding **#1** (task_id traversal) which is the consequence of now-live sub-agent isolation |
| 3 | `_capContent` doubled CJK content | ❌ not fixed — see finding **#5** above, same code, same bug |
| 4 | `_enforceTokenBudget` produced invalid sequences | ⚠️ partially fixed — assistant-with-tool_calls cleanup added (orphan tools avoided), but summary-as-first-casualty and leading-non-user cases still live; see finding **#2** above |
| 5 | `renameSession()` dead code (helpers with no orchestrator) | ✅ fixed — `engine.js:547-578` is the orchestrator, calls all six helpers, `cli/index.js:256` wires `/rename` to it; scheduler regenerate also included |
| 6 | `kcMaxTokens` not configurable + inconsistent fallbacks | ⚠️ unchanged — `engine.js:122` still uses `|| 65536`, `:312` still uses `|| 8192`; `config.js` still has `kcMaxTokens: 65536` hardcoded at `:67` (no env override). Prior nit still stands but is latent until someone sets `KC_MAX_TOKENS=0` |

---

## Suggested fix order

1. **Finding #1 (P0, security)** — path-traversal via `task_id`. One-line
   validator using `scheduler.js`'s `VALID_ID` pattern. Must ship before
   the public v0.5.2 since sub-agents are now active and exploitable.
2. **Finding #2 (normal)** — Anthropic-400 on the preflight preserver.
   Two provider configs use `anthropic` format, so this bites real users.
   Block-wise drop (drop a whole user→assistant→tool group) fixes it and
   simplifies the code.
3. **Finding #5 (normal, CJK)** — one-line clamp (`Math.min(head,
   content.length)`) stops the doubling and is trivial to ship.
4. **Finding #4 (normal)** — add a reachability guard to `_advancePhase`.
   Without it, a well-meaning LLM can corrupt a session's phase state in
   one tool call.
5. **Finding #3 (normal)** — gate `_maybeAutoAdvance` on an edge-
   trigger (`wasReady` check) so resume doesn't auto-fire. The pipelines
   already compute this; just consume their signal instead of re-deriving.
6. **Finding #6 (nit)** — `regenerateAllWrappers` return shape. Cleanup
   whenever scheduler is next touched.

The prior-review findings #1, #2, and #5 are genuinely closed. #4 and #3 still
have open tails. #6 (kcMaxTokens configurability) didn't get touched — not
urgent, but worth bundling with finding #2 since both are in the same
context-management path.
