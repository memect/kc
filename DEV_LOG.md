# KC Agent CLI — Development Log

## v0.5.6 (2026-04-22)

Small provider-focused release. Wires up **VolcanoCloud's new coding plan**
(`api/coding/v3`, serving `glm-5.1`) as a first-class option alongside the
existing regular-plan Ark endpoint (`api/v3`, doubao/deepseek/glm-4-7).
Shipped on its own because VolcanoCloud is now the team's primary engine —
doesn't wait for the rest of the v0.5.6 patch list in `update_design_v5.md`.

### VolcanoCloud coding plan support

Same dual-key pattern already used by Aliyun: a single provider entry
exposes both the regular base URL and a coding-plan URL, and the onboard
flow asks which key type you're using. No cross-talk with `.env` —
credentials live in `~/.kc_agent/config.json` as usual, keeping onboarding
the one source of truth.

**`src/providers.js` — volcanocloud entry:**
- Added `codingPlanUrl: "https://ark.cn-beijing.volces.com/api/coding/v3"`.
- Added `supportsCodingPlanKey: true` so the onboard flow presents the
  "regular key / coding-plan key" choice.
- Added `{ id: "glm-5.1", ownedBy: "zhipu" }` at the top of
  `curatedModels` (coding plan aliases `glm-5.1` to GLM-4.7 server-side —
  a thinking model that streams `reasoning_content` deltas before regular
  `content`; KC's SSE parser silently drops the reasoning trace, which is
  functionally fine but will need a surfacing fix if we want the think
  trace visible in the TUI later).
- Added `"glm-5.1": 92` to `MODEL_RANKING` (above glm-5's 90) so the
  auto-classifier places it in tier1.

**`src/model-tiers.json` — volcanocloud section:**
- `conductor` → `glm-5.1`.
- `tier1` list now leads with `glm-5.1` and keeps the existing
  doubao/deepseek entries behind it for regular-plan users.
- Added a `_comment` line noting that coding-plan users get `glm-5.1`
  and regular-plan users should pick doubao/deepseek at onboard time.

**Usage:** `kc-beta onboard` → VolcanoCloud → pick "编程套餐专用 API Key"
(choice 2) → paste the `ark-...` key. Writes the coding-plan URL +
`glm-5.1` model into `~/.kc_agent/config.json`. Verified end-to-end
against the live endpoint — non-stream + SSE stream both work; response
reports `model: glm-4.7` per server-side alias.

**Size:** ~10 lines across 2 files. No engine, TUI, or llm-client changes.

---

## v0.5.5 (2026-04-20)

Post-v0.5.4 followup release. Four small bug fixes from an ultra-review pass
(race conditions / API-shape mismatches that would have surfaced on long
sessions) plus one new provider — **iFlytek Astro (xfyun) coding plan** — and
onboarding UX fixes that came out of actually configuring the new provider.

Background context: v0.5.4 itself had been published to npm for 2 days but
the user's machine had never run `npm install -g` since v0.3.2, so all of
v0.4.0 through v0.5.4 were technically shipped but never field-tested. The
v0.5.5 window is the first real trial of the hardening in those releases —
hence the cluster of small fixes found by the ultra-review on top.

### Bug 1 — `_maybeWindowAfterToolResult` wrote a read-only getter

`engine.js:344` was `this.history.messages = windowed.messages`. But
`ConversationHistory.messages` is a getter-only property (backed by
`_messages`); assigning to it is a silent no-op under strict mode and raises
in non-strict. Either way the windowed state was never persisted, so the
post-tool-result windowing fix from v0.5.4 (C.4.b) was half-working: it
correctly computed the windowed slice and emitted the `context_windowed`
event, but `this.history._messages` was never updated and `_save()` was
never called. Next turn's windowing had to redo the same work.

Fix: write `this.history._messages = windowed.messages` and call
`this.history._save()`, matching the pattern `compact()` already used.

### Bug 2 — context window could yield an orphan `tool` message

`context-window.js:41` sliced `messages.slice(splitPoint, ...)` at a
fixed offset from the end without checking the role at the boundary. If
the split landed on a `tool` row (tool-result), the recent slice started
with an orphan tool message — its `tool_call_id` references an assistant
`tool_calls` entry that had just been compressed into the summary. The
LLM provider rejects the request:
- OpenAI: "Messages with role 'tool' must be a response to a preceding
  message with 'tool_calls'."
- Anthropic: unpaired `tool_use` / `tool_result` blocks.

Reproduced during the E2E #3 opening turns where the tool-call density
is high (KC explores the workspace aggressively in the first few minutes).

Fix: walk `splitPoint` forward while `messages[splitPoint].role === "tool"`.
Ensures the recent window always starts on a turn boundary.

### Bug 3 — `/phase <name>` could corrupt engine state on typos

`cli/index.js` `handleSlashCommand` passed any string as a force-jump to
`_advancePhase(sub, "...", {force:true})`. With `force:true` the engine
accepts any string — including typos like `/phase ditillation` — and mutates
`currentPhase` to the bad value. The TUI then shows the wrong phase in its
status bar and the next pipeline lookup returns `undefined`.

Also missing: after a successful `/phase advance`, React state for `phase`
wasn't updated, so the status bar still showed the OLD phase until some
unrelated event (like a context-stats refresh) happened to re-render.

Fix: whitelist valid phase names against `Object.keys(engine.pipelines)`
before calling `_advancePhase`, and `setPhase(engine.currentPhase)` on
success so the TUI status bar refreshes immediately.

### Bug 4 — `/compact` race with concurrent user input

`cli/index.js` fired `compact()` async but left `InputPrompt` active
(`isActive: !streaming` and `streaming` stayed `false`). If the user typed
another message during the 5-20s compact window, it routed into
`runTurn → history.addUser(...)`, appending to `_messages`. When compact
resolved it overwrote `_messages` with `[summary, ack, ...recentMessages]`,
silently dropping the concurrent user turn.

Fix: set `streaming = true` + spinner status before firing compact; clear
in `finally`; drain `queueRef` afterwards. Same pattern as normal LLM
streaming.

### New provider — iFlytek Astro (xfyun) coding plan

Added as a standard OpenAI-compatible provider in `src/providers.js` with
a single curated model (`astron-code-latest`) and no VLM/OCR offering.
Appears as provider #4 in the onboarding picker (zh label:
"科大讯飞 Astro 编程套餐（单模型）"; en: "iFlytek XfYun Astro (coding plan,
single-model)"). Entry in `src/model-tiers.json` marks it tier1-only.

Bearer auth with the provider's `ID:SECRET` composite key format —
nothing special, just passed through as the bearer token. Tested against
the E2E #3 run with KC-as-conductor on xfyun + SiliconFlow as worker
(Worker LLM split, see below).

### Onboarding UX fixes

Found while re-configuring kc-beta to run the new provider:

1. **Worker-provider prompted BEFORE tiers.** Previously the order was
   conductor → tier1-4 → VLM tier1-3 → worker provider. For single-model
   conductors (like xfyun astron-code-latest) the tier defaults came from
   the conductor, so the user saw `TIER1 [astron-code-latest]` defaults
   for worker tiers — wrong if the worker was going to be a different
   provider. Now: conductor → worker provider → tiers (defaulting from
   whichever provider ends up worker).

2. **Worker-key prompt shows masked existing key.** Matches the main-key
   prompt style (`API 密钥 (Worker) (sk-vmv...vyiq) (回车保留当前密钥)`).
   Previously no mask was displayed, so users couldn't confirm a key was
   already saved.

3. **"Keep existing key" guarded against provider change.** Both main
   and worker prompts: if the user picks a different provider than the
   one the saved key belongs to, the mask clears and the prompt forces
   an explicit paste. Previously an accidental Enter after switching
   providers would save the OLD provider's key against the NEW provider's
   base URL — silent authentication breakage.

### Files changed

```
 src/agent/context-window.js | 14 ++++++-
 src/agent/engine.js         |  5 ++-
 src/cli/index.js            | 36 ++++++++++++++++-
 src/cli/onboard.js          | 94 ++++++++++++++++++++++++++++-----------------
 src/model-tiers.json        | 16 ++++++++
 src/providers.js            | 23 +++++++++++
```

---

## Post-v0.5.4 prep — E2E Test #2 corpus (2026-04-18)

No code changes. Spent the afternoon assembling the corpus for the second
end-to-end test — a production-grade 托管定期报告核对 scenario driven by the two
Dec-2025 NFRA regs (《银行保险机构资产管理产品信息披露管理办法》 +
《商业银行托管业务监督管理办法（试行）》) and the 文因互联 article describing
the business pain.

Deliverables, all under `archive/test_data_2/` (gitignored, never shipped):

- **10 regulations** sourced from 中国政府网 / NFRA / 国务院公报 — 2 core 2025 NFRA
  regs + 资管新规 + 4 银行理财侧 + 3 保险资管侧 supporting regulations (~317 KB total).
- **9 real sample pairs** from 工行 托管业务 (`samples/public_fund/`) organized by
  fund type: 1 货币市场基金 + 5 混合类 + 3 权益类. Each pair = `(定期报告, 估值数据)`
  where the docx is the published 基金管理人报告 and the xlsx is 工行估值系统的 XBRL-format
  真值数据. This is exactly the cross-reference 核对 task the article describes.
- **4 `.doc` → `.docx` conversions** via `textutil` so KC's `document-parse` walks
  one code path. Originals preserved as `.doc.orig`.
- **10 synthetic violation samples** (`violations/V01`–`V10`) each with one planted
  compliance issue mapped to a specific article of the 2025 信披办法 (保本保收益,
  业绩基准调整未披露, 穿透后前十缺失, 7日年化缺失, 选择性披露, 关联交易省略,
  年报缺审计, 基准免责声明缺失, 摊余成本法风险缺失, 不可比业绩比较). Answer key in
  `violations/notes.md` lets us compute TP/FP rates on detection without manual review.

Full test plan at `/Users/mac/.claude/plans/please-read-the-project-swift-rossum.md`.
The 12-hour KC run is the next task; its output (rules extracted, skills built,
release bundle, any engine regressions) will drive the next DEV_LOG entry.

**Pending from user**: real 银行理财 / 保险资管 sample reports (the 工行 batch is
all 公募基金, which is still in scope for 托管人 responsibility per the 2025 托管业务办法
§3, but it's worth having NFRA-regulated samples too).

---

## v0.5.4 (2026-04-18)

Engine-reliability release driven by a 12-hour rental-contract E2E test of
v0.5.3 (observations archived under `archive/`). The agent intelligence was
fine — GLM-5.1 produced 144 real rules, 6 semantic skills, 9 verifier
iterations — but the **engine around it malfunctioned**: phase stuck on
`bootstrap` the whole session, ralph-loop never ran a single task, TUI
OOM-crashed at the 4 GB heap after ~4.5h, and compaction barely fired.
Five P0 fixes + a user-facing `/phase` slash command.

### Bug 1 — Phase auto-advance stuck on pre-populated workspaces

**Symptom:** launching `kc-beta` from a directory that already had `rules/`
+ `samples/` showed `BOOTSTRAP` in the status bar for the full 12-hour
session, even as the agent produced substantial extraction / skill /
workflow artifacts.

**Root cause:** the engine constructor primed `_lastReady[phase]` by calling
every pipeline's `exitCriteriaMet()`. On pre-populated dirs,
`ProjectInitializer.exitCriteriaMet()` returned `true` immediately, so
`_lastReady.bootstrap = true` was stored before any real work. The
edge-trigger in `_maybeAutoAdvance` then did `if (_lastReady[phase]) return
null` — never fired for the lifetime of the session.

Fix: initialize `_lastReady[phase] = false` for every phase at construction.
The edge-trigger now naturally flips on the first real `onToolResult` after
the user actually does something. `resume()` continues to re-prime from
restored pipeline state (correct there — don't re-fire on already-met
phases).

### Bug 2 — `catalog.json` object shape dropped all tasks

**Symptom:** ralph-loop never ran a single task across the 12-hour session;
TaskManager stayed empty; 0 `task_progress` events.

**Root cause:** `_createTasksForPhase` did `Array.isArray(catalog) ? catalog
: []`. KC the agent had written `catalog.json` as a meta-index (`{version,
total_rules, categories, cross_references, files}`) — an object, not an
array — so `rules` collapsed to `[]` and no tasks were created. Same bug in
`rule_catalog._load()`. `release.js` alone had the right pattern
(`catalog.rules || []`) but it was under-applied.

Fix: new `src/agent/rule-catalog-normalize.js` with `normalizeRuleCatalog()`
that handles four shapes — flat array, `{rules: [...]}`, `{categories: {A:
[...]}}`, and `{categories: {A: {rules: [...]}}}`. Used at all three
call-sites. Parallel-ralph-loop (another item from the observations) is
deferred — tolerance first, architecture second.

### Bug 3 — TUI OOM + typing lag

**Symptom:** Node heap hit 4 GB after ~4.5h and crashed with "Ineffective
mark-compacts near heap limit." User also reported the terminal became
progressively laggy long before the crash — typing at the prompt had
visible delay because Ink was re-rendering a 1000-message tree on every
keystroke.

Two root causes, one underlying problem: nothing bounded the Ink render
tree. Every message (up to 20 lines of tool output per block) stayed in
React state forever.

Fixes modeled on Claude Code's TUI UX:
- **Virtualize the message list** (`src/cli/index.js`): only render the
  last 50 messages into the Ink tree. Earlier messages stay in state (for
  `/compact` to see) but aren't diffed on every render. A single dim hint
  line — `— 前 N 条消息已折叠，完整记录在 logs/events.jsonl —` — tells
  the user where the full history lives.
- **Clear-on-compact**: after a successful `/compact`, reset visible
  messages to a single summary line rather than keeping the pre-compact
  scrollback. Matches Claude Code's behavior; immediate freshness + frees
  Ink tree memory instantly.
- **Truncate tool output** (`src/cli/components.js` `ToolBlock`): show a
  one-line header (tool name + line count + byte count) + a 4-line preview
  with `… N 行已省略` footer. Off-screen tool blocks collapse to header
  only. Errors always render in full (short and critical). Full output is
  always on disk in `logs/events.jsonl`.
- **Heap-pressure diagnostic**: `engine.js` emits a `memory_pressure` event
  when `heapUsed/heapTotal > 0.80`, so operators see it in the event log
  if something is still leaking. One event per crossing (re-armed below
  60%) — no log spam.

### Bug 4 — Compaction fired far too late

**Symptom:** 0 `compact`, 0 `context_windowed` events for the first 12 hours;
then 944 `context_windowed` after the OOM-driven restart (because the
loaded history was already at 313k tokens).

Two root causes:
- `ContextWindow.window()` threshold was `budget * 0.85` — with 200k
  context / 65k reserve, that's a ~114k-token trigger, already in the
  danger zone. A single large tool result could tip the context over AND
  abort the stream before the next iteration's check could window.
- Windowing only ran at the top of the runTurn LLM-call loop; tool results
  appended to history mid-turn had no safety net.

Fixes:
- Lower threshold to `budget * 0.70` (configurable via the new
  `triggerFraction` option on `ContextWindow`). Trigger now fires at ~94k
  tokens, leaving 40k of headroom for the next tool result.
- New `_maybeWindowAfterToolResult()` called immediately after each tool
  result appends to `history.addRaw(...)`. Emits
  `context_windowed { trigger: "post_tool_result" }` when it fires.
- Status bar in `components.js` shows a soft-threshold hint: `💾 建议
  /compact` at ≥60% budget, color-matching the CTX percentage. Prevents
  panic at 85% by giving users action 20 points earlier.

### Bug 5 — `rule_catalog` tool rejected the LLM's natural field shape

**Symptom:** 38+ failed `rule_catalog` calls in a single extraction session.
GLM-5.1 kept sending `{operation: "create", data: {id, source,
description}}` but the tool required `source_ref`; the error message
`Missing required fields: id, source_ref, description` didn't tell the
model which field was actually missing or what was supplied.

Fix:
- **Field aliases**: `source` / 来源 / `reference` / `ref` → `source_ref`;
  `desc` / 描述 → `description`; `rule_id` / `ruleId` → `id`. Normalized
  on ingest in `_create` and `_update`.
- **Precise errors**: "Missing field 'source_ref' in data. Provided keys:
  {id, description}. Accepted aliases: source/来源/reference → source_ref,
  …". Agents self-correct from specific errors.
- **Helpful "Unknown operation"**: lists valid operations and shows a
  concrete `{"operation":"create",...}` example. GLM-5.1 had been sending
  `input: {}` repeatedly without ever learning the right shape.

Deprecating `rule_catalog` in favor of `workspace_file` (another
observations-doc suggestion) is deferred — the tool has useful CRUD
semantics and shipping the field-alias fix is enough for v0.5.4.

### Nit 11 — `/phase` slash command

When auto-advance is broken (or for manual debugging), users previously
had no direct way to move phases — only the LLM could, via the
`phase_advance` tool. Added `/phase` to the TUI slash handler with three
subcommands: `/phase` or `/phase status` prints the current phase and its
auto-next target; `/phase advance` (alias `/phase next`) calls
`_advancePhase(NEXT_PHASE[current])` forward-by-one; `/phase <name>`
force-jumps to any phase (for debugging). `NEXT_PHASE` is now exported
from `engine.js` so the TUI can reach it without redeclaring.

### Model tiers refresh (pre-existing diff picked up with this release)

SiliconFlow tier-1 conductor: `GLM-5` → `GLM-5.1`. VLM tiers migrated
Qwen2.5-VL → Qwen3-VL (235B / 30B / 8B). Unrelated to the five engine fixes
but part of the same working tree.

### Out of scope for v0.5.4

Observations Bugs 6 (CTX bar smoothing), 7 (sub-agent isolation evidence),
8 (stream error events coverage), 9 (sub-agent dedup), 10 (output bloat),
and Nits 12 (context-limit auto-detect) / 13 (evolution-loop exit
criteria) are deferred to v0.5.5+. Parallel ralph-loop is an architectural
change and needs its own RFC.

---

## v0.5.3 (2026-04-17)

Fix-the-fixes release per fresh ultra-review of v0.5.2. **One P0 security
fix** (path traversal via LLM-supplied `task_id`) plus four correctness fixes
in the context-management and phase-transition paths. SOTA-friendly defaults
preserved per user direction (200k context, 65k max output).

### P0 — `agent_tool` path traversal

Sub-agent isolation in v0.5.2 made `task_id` an actively-used path component
in `path.join(workspace.cwd, "sub_agents", taskId)`. An LLM-supplied
`task_id: "../../../../tmp/pwn"` would write the sub-agent's task.md,
conversation, events, and session-state outside the workspace. Same class
as the standard "LLM-controlled path" agentic escape; brand-new attack
surface because v0.5.1's sub-agent isolation was dead code.

Fix:
- `agent-tool.js`: validate `task_id` against `VALID_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`
  (matches scheduler's pattern). Invalid inputs auto-replaced with
  `task_<UUID>`; the requested label is preserved in `requested_id.txt`
  for audit. Tool's response message tells KC the id was sanitized.
- `engine.js` constructor: defense-in-depth check that resolved
  `sub_agents/<scope>/` stays under workspace root. Throws on `../escape`
  even if a future caller bypasses the tool-layer sanitization.
- inputSchema description tightened so the LLM produces valid IDs.

### Bug 2 — `_enforceTokenBudget` Anthropic-400 + summary preservation

Two unfixed sub-issues from prior review:
- Hardcoded `systemIdx = 1` dropped the `[Previous conversation summary]`
  pair as the first casualty, throwing away LLM-summarized prior work.
- After dropping a leading user, the assistant became the head →
  Anthropic Messages API rejects `[system, assistant, …]` with
  `400 messages: first message must use the user role`.

Rewrite drops in **block units** (user + everything until the next user)
so the head is always either a user message or empty. Detects both summary
markers (`[Previous conversation summary]` from `compact()` and
`[Context Summary` from `ContextWindow.window()`) and treats them as
sticky. Defensive postcondition cleanup if input was malformed.

### Bug 3 — `_capContent` CJK doubling

Reproduced: 20001 CJK chars → 40003 chars out (2× the input). Root cause:
`charBudget = maxMessageTokens * 4` assumes Latin chars/token rate; for
CJK at 1.5 tokens/char the budget was 6× too generous and JS clamped
out-of-range slices to the full string.

Rewrite uses a sample-based chars-per-token ratio (CJK gives ~0.67, Latin
~4) to seed the budget, then iteratively tightens until
`estimateTokens(result) <= maxMessageTokens`. Belt-and-suspenders clamp
returns the original content if the proposed slices would cover the
whole input — the cap can never inflate.

Per the SOTA-friendly direction, also bumped `maxMessageTokens` default
**30000 → 60000** for more headroom on 200k-context conductors.

### Bug 4 — `phase_advance` reachability guard

`phase_advance` accepted any phase and `_advancePhase` only refused
self-transitions. An LLM could regress `PRODUCTION_QC → BOOTSTRAP`
(corrupting session state) or skip `BOOTSTRAP → DISTILLATION` (registering
distill tools without skills, hitting cryptic ENOENT errors).

Fix: `_advancePhase(nextPhase, reason, {force = false})`. Default refuses
non-adjacent or backward transitions and logs `phase_advance_refused`.
`phase_advance` tool exposes `force: boolean` for explicit user-driven
non-linear jumps. Tool description states the constraint so the LLM
doesn't try to jump and get a confusing refusal.

### Bug 5 — `_maybeAutoAdvance` resume + task-completion edges

Two failure modes:
- Level-trigger fired on resume — sessions resumed in an
  already-exit-criteria-met state auto-advanced on the next user turn,
  pushing the user out of a phase they wanted to keep iterating in.
- Task-completion bypassed exit criteria — marking all phase tasks
  `skipped` (or completing them while criteria were not met)
  auto-advanced anyway.

Fix:
- Edge-trigger: track `_lastReady` per phase. Auto-advance only fires
  when `exitCriteriaMet()` flips false→true within this run. Primed at
  construction AND after `importState` in `resume()` so resume sees no
  fresh flip.
- Task-completion path now requires BOTH `_allCurrentPhaseTasksComplete()`
  AND `pipeline.exitCriteriaMet()`. Tasks alone are a ralph-loop
  convenience, not authoritative phase signal.

### Bug 6 (nit) — scheduler return shape + `kcMaxTokens` consistency

- `regenerateAllWrappers` now returns `{regenerated, disabled, failed}`
  instead of conflating disabled and failed in one `skipped` bucket.
  CLI surfaces failed count after rename.
- `KC_MAX_TOKENS` env override added (was hardcoded 65536). Default
  unchanged. Single `DEFAULT_KC_MAX_TOKENS = 65536` constant in
  `engine.js` used at both call sites that previously disagreed
  (65536 vs 8192 fallbacks). Now symmetric for `KC_MAX_TOKENS=0`.

### SOTA-friendly defaults — preserved

- `kcContextLimit`: **200000** (unchanged)
- `kcMaxTokens`: **65536** default (env-overridable now)
- `maxMessageTokens`: 30000 → **60000** (raised for SOTA headroom)

### Verification

Each fix smoke-tested:
- P0: malicious `task_id: "../../pwn"` → sanitized to UUID, `/tmp/pwn`
  never created. Defense-in-depth check rejects `../../escape` and `..`
  at engine constructor.
- Bug 2: 5 test cases (summary pair + 3 turns; tool sequences; under
  budget; no summary; adversarial non-user head). All preserve sticky,
  end with user head, no orphan tools.
- Bug 3: 6 test cases — CJK 50k chars within cap, Latin 400k within cap,
  mixed, small unchanged, exactly-at-cap, the original 20k CJK doubling
  reproducer (now produces 18k chars, less than input).
- Bug 4: adjacent forward succeeds; non-adjacent and backward refused
  without force; both succeed with force; events log `forced: true` flag.
- Bug 5: pre-met session does NOT auto-advance on first call; real
  false→true flip DOES advance once; subsequent calls in new phase no-op.
- Regression: 15 tools, 22 en/zh skills, all v0.5.2 helpers present,
  offload, autoCommit, renameSession (with new return shape),
  sub-agent isolation all still work.

### Files changed

| File | Bug | Change |
|------|-----|--------|
| `src/agent/tools/agent-tool.js` | P0 | `VALID_TASK_ID` sanitization, auto-UUID on invalid, inputSchema description |
| `src/agent/engine.js` | P0, 2, 4, 5, kcMaxTokens | scope-escape check in constructor; rewrite `_enforceTokenBudget` (block-unit drops, sticky summary, postcondition cleanup); `_advancePhase({force})`; `_maybeAutoAdvance` edge-trigger w/ `_lastReady` map; task-completion requires `exitCriteriaMet`; `_lastReady` re-prime in `resume()`; `DEFAULT_KC_MAX_TOKENS` const; phase_advance factory forwards `opts`; renameSession returns `{regenerated, disabled, failed}` |
| `src/agent/tools/phase-advance.js` | 4 | `force: boolean` input; description note about linear ordering |
| `src/agent/history.js` | 3 | rewrite `_capContent` (CJK-aware iterative truncation); `_charsPerToken` sample-based ratio; `_truncMarker` |
| `src/agent/scheduler.js` | 6 | `regenerateAllWrappers` returns `{regenerated, disabled, failed}` |
| `src/cli/index.js` | 6 | surface `scheduleWrappersFailed` count after rename |
| `src/config.js` | 3, kcMaxTokens | bump `maxMessageTokens` 30000→60000; add `KC_MAX_TOKENS` env override |
| `package.json` | — | 0.5.2 → 0.5.3 |

---

## v0.5.2 (2026-04-17)

Bug-fix release from manual testing of v0.5.x on real data. Four bugs fixed,
all v3 design TODOs aggregated into a top-of-doc section so the design tracker
reflects current state. No new features.

### Bug 1 (P0) — compact / windowing fails at ~300k context

KC died on long sessions. Three independent failure modes compounded:

- `engine.compact()` blasted the entire older history (250k+ tokens) to the
  LLM as one summarization prompt → 400 → mechanical fallback was useless.
- `ContextWindow.window()` kept the most recent 30 messages intact even when
  those alone exceeded budget → next LLM call also 400'd.
- No pre-flight check meant over-budget requests went out and got rejected.

Fixes:
- **Pre-flight hard ceiling in `runTurn`** (`_enforceTokenBudget`). Before each
  `streamChat`, drops oldest non-system messages until under budget. Logs a
  `context_truncated` event. Drops complete user→assistant→tool turns to keep
  message structure valid (assistant tool_calls require following tool messages).
- **Per-message content cap in `ConversationHistory.addRaw`** (default 30k tokens,
  configurable via `maxMessageTokens`). Belt-and-suspenders: head + tail kept
  with truncation marker pointing at `logs/events.jsonl` for the full content.
  Block 11 offloading already prevents tool outputs this big in normal use; this
  catches old/migrated workspaces and edge cases.
- **Chunked `compact()`**. Old history split into ~30k-token chunks; each
  summarized independently; partials concatenated. Single oversized chunk falls
  back to mechanical for that chunk only. Always succeeds in producing a summary.
- **Context-length detection in `retry.js`**. Recognizes "context_length",
  "maximum context", "too many tokens", etc. in error messages — non-retryable
  regardless of HTTP status. Stops the 10-retry hammer some providers' wrong
  status codes triggered.

### Bug 4 — status bar stuck on `BOOTSTRAP`

Phase transitions only fired from narrow paths in `pipeline.onToolResult`. KC
could work conversationally past bootstrap criteria and the status bar would
still say `BOOTSTRAP`.

Fixes:
- **`_advancePhase(nextPhase, reason)` helper** centralizes the transition.
  All paths route through it: pipeline auto-detect, post-turn re-check, task
  completion, and explicit user request.
- **`_maybeAutoAdvance()` after every turn AND after every tool-result loop**.
  If the current phase's `exitCriteriaMet()` returns true, advance to the next
  phase (per `NEXT_PHASE` map).
- **Task-completion advance in `runTaskLoop`**. Once every task tagged with
  the current phase is in a terminal state (completed | failed | skipped),
  auto-advance.
- **`phase_advance` tool** for the explicit user-request path. Minimal
  description (~2 lines) to avoid bloating the system prompt budget. KC calls
  it when user says "skip ahead". No `/phase` slash command — status bar is
  display-only.

### Bug 3 — `/rename` didn't actually rename

Regression since 0.2.x. Root cause: persistence subsystems (`ConversationHistory`,
`EventLog`, `SessionState`, `TaskManager`, `ConfidenceScorer`, `CornerCaseRegistry`)
captured the workspace path at construction and never updated it. `fs.renameSync`
moved the dir on disk, but subsequent writes from those subsystems re-created
the OLD path's files via `mkdir -p`. From the user's perspective: new dir was
"dead" while old dir kept growing.

Fixes:
- **`_setWorkspacePath(newCwd)` on every persistence subsystem.**
- **`engine.renameSession(newName)` orchestrator.** Calls
  `workspace.rename()`, then cascades the new path to every subsystem.
- **`Scheduler.regenerateAllWrappers()`.** Block 9 cron wrapper scripts bake in
  absolute paths to the workspace; after rename they'd be invalidated. Engine
  calls regen as part of the cascade.
- **`/rename` TUI handler uses orchestrator** and includes a warning when
  schedules exist: "Re-install crontab lines via `schedule_fetch print_crontab`."

### Bug 2 — sub-agent shared-state architecture fault

Team reported "wide subagent failure". Audit found the actual cause was bigger
than lock semantics: `agent_tool` spawned child engines with the same sessionId,
which meant the child's `ConversationHistory`, `EventLog`, `SessionState`, and
`TaskManager` ALL pointed at the parent's workspace files. Child writes
clobbered parent state. Worse: child unconditionally set
`currentPhase = BOOTSTRAP`, persisted that to the shared `session-state.json`,
and registered only BUILD-mode tools — even when parent was in DISTILLATION.

Fixes:
- **Sub-agent isolation refactor.** `AgentEngine` constructor now accepts
  `{ subagentScope, initialPhase }`:
  - When `subagentScope` is set, `ConversationHistory` / `EventLog` /
    `SessionState` redirect their files to `sub_agents/<scope>/`. `TaskManager`
    is **not constructed** for sub-agents (they don't queue further sub-tasks).
  - When `initialPhase` is set, `currentPhase` initializes to it and
    `_registerToolsForPhase(initialPhase)` runs — child gets the same tool
    surface as parent.
  - Workspace files (rules/, rule_skills/, workflows/) stay shared — Block 11's
    git auto-commit serializes those writes; partition-by-rule + last-writer-wins
    is fine.
- **`agent_tool` passes `subagentScope: taskId` and `initialPhase: parentPhase`**
  via the engineFactory. Sharpened tool description to say sub-agents must own
  non-overlapping units of work and not build lock mechanisms.
- **`task-decomposition` skill (en + zh)** gains a "Multi-agent coordination —
  keep it lock-free" subsection capturing the team's lock-failure lesson +
  KC's preferred patterns (single-dispatcher, partition-by-unit).

### v3 design TODOs aggregated

`docs/global_update_design_v3.md` Progress Tracker now opens with an "Outstanding
TODOs (post v0.5.2)" section listing the parked work: Block 6 model-tier
finalization + provider tests, Block 10 deferred supplements, Block 12 Feishu,
Block 13 Hermes/EvoMap research, Block 8 follow-ups (self-test, real serve mode,
batch processor), Block 11 follow-ups (PDF bbox highlighting). Re-prioritize
after v0.5.x manual testing concludes; v0.6 is the post-testing public release.

### Verification

End-to-end smoke (all passing):
- Bug 1: 50k-token message gets capped to 30k with marker; oversized history
  triggers `_enforceTokenBudget` (drops to budget); chunked compact splits 100
  msgs of 500 tokens into 2 chunks.
- Bug 4: `_advancePhase` works idempotently; tool advances; bad phase
  rejected; `_maybeAutoAdvance` fires when criteria met; distill tools register
  on transition into DISTILLATION.
- Bug 3: rename moves dir, all subsequent writes from history/eventLog/state/
  tasks/schedules land at new path; wrapper script regenerated with new abs
  paths; old wrapper gone; clean errors on empty/colliding names.
- Bug 2: 4 sub-agents (one + 3 concurrent) all isolate persistence under
  `sub_agents/<scope>/`; parent state files unchanged; sub inherits parent's
  phase + worker_llm_call tool; sub has no taskManager.
- Regression: 22 en + 22 zh skills still index; 15 tools registered (was 14);
  compact still returns proper result keys; tool offloading still works;
  autoCommit still works; generateTraceId stable.

### Files changed

| File | Bugs | Change |
|------|------|--------|
| `src/agent/engine.js` | 1, 2, 3, 4 | constructor accepts subagentScope/initialPhase; `_enforceTokenBudget`; chunked compact; `_advancePhase` + `_maybeAutoAdvance`; `_allCurrentPhaseTasksComplete`; `renameSession` orchestrator; `NEXT_PHASE` constant |
| `src/agent/history.js` | 1, 2, 3 | `_capContent`; constructor accepts `conversationDir` + `maxMessageTokens`; `_setWorkspacePath` |
| `src/agent/event-log.js` | 2, 3 | constructor accepts `logDir`; `_setWorkspacePath` |
| `src/agent/session-state.js` | 2, 3 | constructor accepts `statePath`; `_setWorkspacePath` |
| `src/agent/task-manager.js` | 3 | `_setWorkspacePath` |
| `src/agent/confidence-scorer.js` | 3 | `_setWorkspacePath` |
| `src/agent/corner-case-registry.js` | 3 | `_setWorkspacePath` |
| `src/agent/workspace.js` | 3 | `rename()` returns `{oldCwd, newCwd, sessionId, changed}` |
| `src/agent/scheduler.js` | 3 | `regenerateAllWrappers()` |
| `src/agent/retry.js` | 1 | `CONTEXT_LENGTH_PATTERNS` regex; non-retryable for context-length errors |
| `src/agent/tools/agent-tool.js` | 2 | engineFactory takes opts; tightened description; new `getCurrentPhase` callback |
| `src/agent/tools/phase-advance.js` (NEW) | 4 | small tool for KC to advance phase on user request |
| `src/cli/index.js` | 3 | `/rename` uses `engine.renameSession`; warns about schedules |
| `src/config.js` | 1 | `maxMessageTokens` (default 30000) |
| `template/skills/{en,zh}/meta-meta/task-decomposition/SKILL.md` | 2 | "Multi-agent coordination — keep it lock-free" subsection |
| `docs/global_update_design_v3.md` | — | Outstanding TODOs aggregated at top |
| `DEV_LOG.md` | — | this entry |
| `package.json` | — | 0.5.1 → 0.5.2 |

---

## v0.5.1 (2026-04-17)

Block 8 — release built workflows as a portable app. Adds the third phase
(**RUN**) beyond BUILD and DISTILL. The `release` tool bundles the current
workspace into a self-contained directory under `output/releases/<slug>/`
that anyone with Python 3 + a worker LLM API key can run via
`python run.py <doc>`. **No `kc-beta` runtime dependency** — same parallel
pattern as Block 9 (cron) and Block 11 (git): the artifact stands on its own.

### What's new

**`release` tool** (`src/agent/tools/release.js`). Inputs: `label`,
optional `notes`, `include` rule allowlist, `fixtures` sample list. Behavior:

1. Snapshots the workspace via `SnapshotTool` (git tag `snap/release-<slug>`,
   tracked manifest at `snapshots/<slug>/snapshot.json`).
2. Reads `rules/catalog.json`, filters by `include` if given.
3. Locates the latest workflow per rule via the same `_findWorkflow` logic
   `workflow-run.js` uses.
4. Builds `output/releases/<slug>/`:

```
manifest.json              ← release metadata (rules, models, snapshot tag)
README.md                  ← auto-generated from template
run.py                     ← standalone Python driver (~210 LOC)
render_dashboard.py        ← re-render HTML from existing result JSON
serve.sh                   ← one-line python -m http.server helper
kc_runtime/
  __init__.py
  confidence.py            ← Python port of ConfidenceScorer.score() — exact parity
  dashboard.py             ← pure-Python HTML emitter (~150 LOC), dark theme
workflows/
  R001/
    workflow_v3.py         ← pinned copy + chmod +x
    prompts/
fixtures/                  ← KC-selected representative samples (optional)
glossary.json              ← frozen
catalog.json               ← frozen
corner_cases.json          ← frozen (used by confidence scoring)
confidence_calibration.json ← frozen historical accuracies
models.json                ← worker LLM tier→model map at release time
```

**Standalone `run.py`** — accepts `<input-doc>`, optional `--rule R001`,
`--output result.json`, `--dashboard`. For each rule: spawns
`python <workflow_path> <doc>`, captures the last-line JSON, scores
confidence via `kc_runtime.confidence.score()`, aggregates. Writes JSON
to stdout or `--output`. Optionally also renders an HTML dashboard.
Reads `LLM_API_KEY` / `LLM_BASE_URL` / `TIER1`–`TIER4` env vars (same
conventions as KC's `.env`). Exits non-zero if any workflow fails (so
cron emails fire).

**Confidence parity.** The Python port matches the JS scorer **exactly**,
including JS `Math.round` half-up rounding (Python `round()` uses
banker's rounding by default — fixed via a `math.floor(x*1000+0.5)/1000`
helper). Verified end-to-end: KC's in-workspace scorer and the bundled
`run.py` produce identical confidence values for the same input.

**End-user dashboard** (`kc_runtime/dashboard.py`). Pure Python, no
Jinja or framework deps — string templates only. Dark-theme port of
`dashboard-render.js` styling. Two tabs (Summary + Per-Rule), inline
JavaScript for tab switching. ~150 LOC.

**`serve.sh`** — wraps `python -m http.server` so users can browse
generated dashboards locally. Not a real serve framework; the mechanic
is one line. KC decides per project whether to mention it (skill text
guides usage; tool doesn't force the flow).

**Skill updates:**
- `skill-to-workflow/SKILL.md` (en + zh) — new "Releasing Workflows"
  section. Describes the capability, when typical triggers apply, and
  notes that what to include is KC's call (full catalog vs `include`
  subset, fixtures or not). Freedom-respecting framing per the
  prescription-vs-freedom feedback.
- `quality-control/SKILL.md` (en + zh) — new "Two Dashboard Surfaces"
  section distinguishing the in-workspace developer dashboard (for
  audit during BUILD/DISTILL) from the bundled end-user dashboard
  (for release recipients).

### What changed under the hood

- `src/agent/tools/release.js` (NEW) — the `release` tool (~250 LOC).
- `src/agent/engine.js` — registers `ReleaseTool` (13 → 14 core tools).
- `template/release-runtime/` (NEW) — Python templates copied verbatim
  into each bundle.

### What's deferred (to v0.5.2+)

- **Self-test mode** (`run.py --selftest` against bundled fixtures).
- **`kc-beta run` subcommand**. Release runs without KC by design.
- **Real HTTP serve framework** (Flask/FastAPI). `serve.sh` covers
  local browsing.
- **Batch processing**. `run.py` takes one doc; users shell a loop.
- **Sandboxing**. `run.py` is plain Python; user trusts their bundle.

### Verification

Smoke tests (all passing):

- 14 tools registered (was 13).
- Bundle directory contains all expected files in correct layout.
- `run.py` executes a fake workflow, parses JSON, scores confidence.
- **Confidence parity exact**: 0.874 from both KC's `ConfidenceScorer`
  and the bundle's `kc_runtime.confidence.score()` for the same input.
- `--rule R001` filter works (returns one result, not all).
- Missing `LLM_API_KEY` / TIER vars exits with code 2 and clean stderr.
- **Portability**: bundle moved to `/tmp/`, runs from there with
  `--dashboard`, emits both JSON and HTML; HTML contains the rule data.
- Snapshot tag `snap/release-v1` created in workspace git.
- `snapshots/release-v1/snapshot.json` tracked in git (metadata
  preserved even if bundle dir is cleaned).
- `output/releases/` correctly gitignored (bundle contents NOT in git).

---

## v0.5.0 (2026-04-17)

Block 9 — cron / heartbeat document fetching. Adds scheduled ingestion to
the production loop. KC defines fetch jobs and writes wrapper scripts; the
user installs the scripts via `crontab -e`. Cron invokes the scripts
directly — **no `kc-beta` runtime dependency**, ingestion works while
kc-beta is closed.

### What's new

**Per-session schedule registry** (`schedules.json`). Each entry is a
shell-type job with `id`, `command`, optional `description`, and
`cron_hint`. Tracked by git via Block 11's auto-commit.

**Per-job wrapper scripts** at `workspace/scripts/ingest/<id>.sh`.
Self-contained POSIX `/bin/sh` scripts. KC regenerates them whenever a job
is added or enabled. Each wrapper:

- Exports `WORKSPACE`, `INPUT_DIR`, `PROJECT_DIR` env vars.
- Drops a sentinel file (`mktemp`), then runs the user's command.
- Uses `find -newer` against the sentinel to detect newly-arrived files in
  `input/` (portable across BSD `find` on macOS and GNU `find` on Linux).
- Prefixes new arrivals with `<job-id>_<UTC-timestamp>_<original-name>`,
  skipping files already prefixed (idempotent re-runs).
- Appends start + exit lines to `logs/ingest.log`.
- Propagates the user command's exit code so cron's failure email fires.

**`schedule_fetch` tool** — KC manages the registry from inside the agent:

| Operation | What it does |
|-----------|--------------|
| `add` | Register a job. Writes `schedules.json` and renders the wrapper script. |
| `list` | Show registered jobs + tail of `logs/ingest.log`. |
| `remove` | Delete a job. Removes its wrapper. |
| `enable` / `disable` | Toggle without removing. Disable removes the wrapper. |
| `print_crontab` | Generate paste-ready crontab lines for all enabled jobs. |

**`/schedule` slash command** — TUI display of jobs, last log entries, and
pending-input file count.

**Welcome banner** — shows `📥 N file(s) pending in input/` when there's
unprocessed material from cron jobs.

### What changed under the hood

- `src/agent/scheduler.js` (NEW) — registry I/O, wrapper rendering, crontab
  formatting, log tailing, pending-input count.
- `src/agent/tools/schedule-fetch.js` (NEW) — the `schedule_fetch` tool.
- `src/agent/engine.js` — registers `ScheduleFetchTool` (12 → 13 core tools).
- `src/cli/index.js` — `/schedule` slash command, `Scheduler` import,
  pending-input count passed to `WelcomeBanner`.
- `src/cli/components.js` — `WelcomeBanner` accepts `pendingInputCount` and
  renders the cyan note when > 0.
- `template/skills/{en,zh}/meta-meta/bootstrap-workspace/SKILL.md` — new
  "Scheduled Ingestion" section.
- `template/skills/{en,zh}/meta-meta/quality-control/SKILL.md` — short note
  in "Batch Processing" mentioning the `<job-id>_<timestamp>_` filename
  convention and `archive_file` cleanup step.

### Why no `kc-beta ingest` subcommand

The OS scheduler invokes the wrapper script directly. KC is involved only
when the user is interacting (defining jobs, viewing status). The wrapper
is plain shell, runs everywhere `/bin/sh` exists, and survives KC upgrades
or breakages.

### Verification

- Wrapper renders correctly for arbitrary user commands; new files arrive
  with `<job-id>_<UTC-timestamp>_` prefix.
- Idempotent — running twice doesn't double-prefix existing files.
- Failing user command propagates exit code (verified with `exit 7`).
- Disable removes the wrapper script.
- `print_crontab` generates paste-ready lines using absolute paths.
- All 22 en + 22 zh skills still index after skill updates.
- 13 tools registered (was 12).

### What's deferred

- **Auto-trigger KC processing on ingest.** Block 8 (release/run mode) is
  the right place for headless processing of fresh batches.
- **OS-specific helpers** (launchd plists, systemd timers, Windows Task
  Scheduler). Cron is the lingua franca; users on other schedulers know
  how to convert.
- **Built-in source-type plugins** (HTTP fetcher, S3 client, Google Drive,
  etc.). Shell command is universal — compose anything via curl/rclone/
  `lark-cli`/python.

---

## v0.4.0 (2026-04-17)

Block 11 — file system refactor. Adopts git as the per-session versioning
backbone, adds tool-call offloading, and ships three new workspace tools
(`copy_to_workspace`, `snapshot`, `archive_file`). Preceded by a design doc
(`docs/file_system_design.md`) reviewed and approved before implementation.

### What's new

**Git-backed per-session workspace.** Each session's workspace directory is
now a git repository. Every write to a tracked path (skills, workflows,
rules, glossary, AGENT.md, tasks.json) is auto-committed by
`Workspace.autoCommit()` with a trace ID in the commit message. KC uses git
directly via `sandbox_exec` for diff, rollback, and branching:

```
sandbox_exec({command: "git log --oneline -10", cwd: "workspace"})
sandbox_exec({command: "git diff HEAD~3 -- rule_skills/R001/SKILL.md", cwd: "workspace"})
sandbox_exec({command: "git checkout HEAD~5 -- rule_skills/R001/", cwd: "workspace"})
```

`.gitignore` ships from `template/workspace.gitignore` and excludes runtime
noise (`logs/`, `sub_agents/`, `input/`, `output/`, `samples/`,
`session-state.json`, `.env`). `git status` shows only meaningful changes.

If git isn't installed, KC prints a one-line warning and continues with
auto-commit disabled — workspace still works, version history is just off.

**Tool-call offloading** (LangChain *Anatomy of an Agent Harness* pattern).
Tool outputs above ~2000 tokens (configurable) are written to
`logs/tool_results/<traceId>.txt`. Conversation history holds a head + tail
digest (~1.6KB) with a pointer; the agent reads the full file with
`workspace_file` only if it needs detail. Errors offload at a smaller
threshold (~500 tokens). The event log keeps the full content regardless,
so audits never lose data.

**Three new workspace tools:**

- `copy_to_workspace` — pull a specific file from the project directory
  into `refs/` with provenance recorded in `refs/manifest.json`. Files
  larger than `largeRefThresholdMB` (default 10 MB) are written but added
  to `.gitignore` so they don't bloat git history. Default behavior remains
  reading project files in place via `scope: "project"`.
- `snapshot` — freeze the current workspace state. Auto-commits any
  pending changes, creates git tag `snap/<slug>`, writes
  `snapshots/<slug>/snapshot.json`. Used for release bundles (Block 8) and
  before risky operations.
- `archive_file` — move a file to an `archived/` subdirectory next to it
  (e.g. `input/doc.pdf` → `input/archived/doc.pdf`). Uses `git mv` for
  tracked files so history is preserved. Reverse moves intentionally use
  plain `sandbox_exec mv` — no separate `unarchive` tool.

### What changed under the hood

- `src/agent/workspace.js` — added `_initGitRepo`, `autoCommit`, `setPhase`,
  `gitAvailable`, static `isGitInstalled`. Constructor now takes
  `{gitAutoCommit}` option.
- `src/agent/version-manager.js` — stripped to just `generateTraceId`
  (now exported as a top-level function and as a class method for back-compat).
  No more `versions.json` writes.
- `src/agent/tools/workspace-file.js` — `_write` now calls
  `workspace.autoCommit()` instead of `versionManager.onWrite()`.
- `src/agent/tools/copy-to-workspace.js`, `snapshot.js`, `archive-file.js` —
  three new tools.
- `src/agent/engine.js` — added `_maybeOffload` for tool-call offloading,
  registered the three new tools, propagates phase to `workspace.setPhase()`
  on transition and resume.
- `src/agent/pipelines/initializer.js` — no longer creates `versions.json`;
  auto-commits AGENT.md after seeding.
- `src/agent/context.js` — AGENT_IDENTITY gains a "File System" section
  describing git, offloading, and the three new tools.
- `src/config.js` — new keys: `gitAutoCommit`, `toolOutputOffloadTokens`,
  `toolOutputOffloadErrorTokens`, `largeRefThresholdMB`.
- `src/cli/index.js` — startup banner if git is missing.
- `template/workspace.gitignore` — new file shipped to every session.
- `template/skills/{en,zh}/meta-meta/version-control/SKILL.md` — new
  "Git Is the Source of Truth" section.

### Verification

Phase-by-phase smoke tests run during implementation:

- Phase 1a: fresh session → `.git/` + initial commit exist; `rules/` write
  triggers auto-commit; `logs/` write does not.
- Phase 1b: 50KB content → 1.7KB digest with pointer; offload file written;
  small content → no offload.
- Phase 1c: small file copied + git-tracked; 12MB file copied but added to
  `.gitignore`; manifest with provenance written; traversal blocked.
- Phase 1d: snapshot creates tag + commit + manifest; archive uses
  `git mv` for tracked files (history preserved) and `fs.rename` fallback
  for ignored files; conflict detection works.
- Phase 2: full engine constructs with 12 tools; system prompt mentions
  every new piece; all 22 en + 22 zh skills still index.

### Migration (additive)

Existing pre-v0.4.0 workspaces auto-init on next launch — initial commit
captures whatever's there as `"Migrated session <id> to git-tracked workspace"`.
Old `versions.json` is left untouched. No data loss; pre-migration history
just isn't reconstructable (old manifest was metadata-only). Going forward,
full git history accumulates.

### Defaults

| Key | Default | Override |
|-----|---------|----------|
| `gitAutoCommit` | `true` | env `GIT_AUTO_COMMIT`, global config `git_auto_commit` |
| `toolOutputOffloadTokens` | `2000` | env `TOOL_OUTPUT_OFFLOAD_TOKENS` |
| `toolOutputOffloadErrorTokens` | `500` | env `TOOL_OUTPUT_OFFLOAD_ERROR_TOKENS` |
| `largeRefThresholdMB` | `10` | env `LARGE_REF_THRESHOLD_MB` |

### Documentation

- New: `docs/file_system_design.md` — design doc (architectural decisions, layout, tool contracts, phased plan).
- New: `docs/file_system.md` — user-facing reference.

---

## v0.3.2 (2026-04-17)

Block 10 partial — project glossary supplement to rule-extraction, rule-graph,
and entity-extraction skills. Pure methodology text changes (same pattern as
Blocks 4 and 5). No code, no scripts, no behavior changes.

### What's added

**Project glossary as a living artifact.** A project-scoped vocabulary of
entities, terms, and patterns the verification system encounters. Built
during EXTRACTION alongside the rule catalog, enriched throughout
BUILD and DISTILL phases as KC sees more samples and refines its own
ground-truth extractions.

- **`rule-extraction/SKILL.md` (en + zh)** — new "Project Glossary"
  section after "Rule Catalog". Covers what the glossary is (canonical
  names + aliases keep entity references consistent across rules), when
  to seed it (during initial extraction), storage shape
  (`rules/glossary.json` next to `catalog.json`, JIT schema), and that
  it is a living document — not frozen at end of extraction.
- **`rule-graph/SKILL.md` (en + zh)** — new "Project Glossary" section
  before "Three Uses". The glossary is the canonical-label registry
  that makes `shares_entity` edges meaningful; without it, rules
  targeting the same entity under different names produce broken
  matches. Edges should reference glossary canonical labels.
- **`entity-extraction/SKILL.md` (en + zh)** — light cross-reference
  near "Schema Design". The glossary is a useful resource for keeping
  entity names schema-aligned. Whether it ever drives pattern-based
  matching is a per-project judgment, not a prescribed pattern.

### Deferred Block 10 supplements (TODO for v0.3.3+)

Three candidates considered during planning but deferred — original Block 10
description was largely covered by Blocks 4-5 already, leaving these as
narrower opportunities:

- **Semantic density preprocessing.** For long regulations, score
  paragraphs cheaply (regulatory phrase markers, threshold density)
  with worker LLM calibration on borderline cases, to focus extraction
  on rule-bearing sections first. From pdf2skills.
- **Cross-document rule deduplication.** When extracting from multiple
  regulations or revisions, similarity-match new rules against the
  existing catalog (merge / link / add). From pdf2skills' SKU-fusion.
- **Sharpen completeness checking.** Label-hierarchy approach for
  coverage validation. From A2O.

### Translation note

`rule-extraction` and `entity-extraction` zh files were already English
placeholders prior to this release; new sections were added in English
to preserve each file's existing language consistency. `rule-graph` zh
is fully translated, so the new section was written in Chinese to match.
A full zh translation pass for the placeholder skills is out of scope for
this release.

### Verification

- All 22 en + 22 zh skills still load via SkillLoader.
- Description frontmatter unchanged on all six modified files (no risk
  of skill-index breakage).
- Cross-references read coherently: rule-extraction → rule-graph →
  entity-extraction → rule-extraction (no orphaned links).

---

## v0.3.1 (2026-04-17)

Audit-and-fix release for the v3 production-readiness work (Blocks 0-7).
No new features — verified each block works end-to-end and patched bugs
the original implementation missed. Adds project README and npm metadata.

### Critical fixes

- **`engine.js`: removed duplicate `compact()` definition.** Block 7 had
  defined a second `compact(keepRecent)` at the end of the file that
  shadowed the working `compact({ recentCount })` from Block 2 of v0.2.0.
  The shadowing version tried `this.history.messages = ...`, which throws
  because `messages` is a getter-only property on `ConversationHistory`.
  Result: `runTaskLoop` would crash on the first auto-continued task once
  history grew past 15 messages. Verified end-to-end with a 25-message
  smoke test post-fix.
- **`runTaskLoop`: pass compact options as object, not positional.**
  Updated the two `compact(...)` callsites inside `runTaskLoop` to use
  the surviving `{ recentCount: 8 }` form. Previously `compact(8)` would
  destructure `8` as an object, get `undefined`, and silently fall back
  to keeping 20 messages instead of 8 — defeating the inter-task
  compaction strategy that prevents context blowup with many rules.
- **`document-parse.js`: stop polluting VLM output when `canvas` package
  is missing.** The previous fallback pushed bare `--- Page N (VLM) ---`
  headers with no content, which inflated the output to look like a
  successful parse. Now returns `null` immediately so the escalation
  chain falls through to MineRU.

### Packaging / publish prep

- **`package.json`**: bumped to **0.3.1**. Added `homepage`, `repository`,
  `bugs` fields pointing at the GitHub repo. Included `README.md` and
  `QUICKSTART.md` in the npm `files` allowlist so they ship with the
  installed package.
- **`README.md`**: new project README describing what KC is, the dual-
  directory architecture, phase model, ralph-loop, provider matrix, and
  pointers to docs.

### Verification

Block-by-block smoke tests against the working tree:

- Block 0 — `loadSettings()` returns `effective*()` worker fallback methods
  that resolve to conductor config when worker config is empty;
  `model-tiers.json` loads correctly via `getModelTierConfig()`.
- Block 1 — `Workspace` resolves dual scopes; `..` traversal blocked for
  both `resolvePath()` and `resolveProjectPath()`.
- Block 2 — `AGENT.md` template copied to workspace at bootstrap;
  `engine._readAgentMd()` returns it; `ContextAssembler.build({agentMd})`
  injects after the agent identity block.
- Block 3 — `SkillLoader` discovers all 22 skills (en); multi-line YAML
  `description: >` is parsed correctly for `pdf-review-dashboard`.
- Block 4 — `document-parse.js` escalation chain (pdfjs → VLM → MineRU)
  intact; `force_method` accepts `pdfjs|vlm|mineru|ocr`.
- Block 5 — Production-experience supplements present in
  `entity-extraction`, `compliance-judgment`, `rule-extraction`,
  `skill-authoring`, `skill-to-workflow`.
- Block 6 — `model-tiers.json` populated for all 10 providers; startup
  warning fires when all worker tiers blank; `auto-model-selection`
  meta-meta skill discoverable.
- Block 7 — `TaskManager` CRUD works; `runTaskLoop` no longer crashes
  during auto-continue; context compaction keeps history bounded between
  tasks (verified 25 → 10 messages, returns proper result keys).

---

## v0.3.0 (2026-04-16)

Production-readiness update implementing v3 design blocks 0-6. Focuses on dual-directory workspace, per-project context, skill improvements, and plugin architecture.

### Block 0: Align Both Versions
- **kc_reborn frozen** — all development on kc_cli (pure Node.js)
- **Separate worker LLM config** — optional worker provider/key/URL, falls back to conductor config
- **`src/model-tiers.json`** — standalone file for LLM (tier1-4) and VLM (tier1-3) per provider, easily editable without touching code
- **VLM tiers** — 3-tier vision model assignments for OCR/document parsing
- `providers.js` reads model selections from `model-tiers.json` instead of hardcoding
- `config.js` gains `effective*()` methods for worker config fallback

### Block 1: Permission Design
- **Dual-directory model** — project dir (CWD at launch) + workspace (`~/.kc_agent/workspaces/{sessionId}/`)
- **`scope` parameter** on `workspace_file`, `document_parse`, `document_search` tools (`"workspace"` | `"project"`)
- **`cwd` parameter** on `sandbox_exec` (`"workspace"` | `"project"`)
- `workspace.js` gains `projectDir` + `resolveProjectPath()` with traversal protection
- Project-aware bootstrap — initializer detects rules/samples in project dir
- Backup recommendation in TUI welcome banner
- Session state persists/restores `projectDir` for `/resume`

### Block 2: AGENT.md
- **Per-project system prompt** — `AGENT.md` created in workspace at bootstrap
- Agent can read and modify it; changes take effect on next turn
- `context.js` accepts `agentMd` param, injected after `AGENT_IDENTITY`

### Block 3: Better Dashboard
- **PDF review dashboard** — two-column HTML: PDF viewer (left) + verification results (right)
- Click result → PDF jumps to page with highlight animation
- Base64 embedded PDF, pdf.js CDN, dark theme, resizable split pane
- Packaged as meta-meta skill `pdf-review-dashboard` (optional plugin)
- Fixed `skill-loader.js` multi-line YAML description parsing

### Block 4: Improve Skills for Doc Parsing & Data Extraction
- **entity-extraction** — reframed method selection as cost-accuracy search (regex is "smallest model")
- **compliance-judgment** — removed fixed method ordering, KC picks per rule
- **document-parsing** — rearranged escalation: pdfjs → provider VLM → MineRU (optional)
- **document-parse.js** — implemented `_tryVlm()` with provider VLM API call
- **NEW `document-chunking`** — fast/cheap batch chunking meta skill
- **tree-processing** — refocused on production chunking (observe → pattern → code)
- **rule-extraction** — clarified one-off (fuzzy) vs data extraction (repeating, unified schema)
- **AGENT_IDENTITY** — updated extraction guidance to cost-accuracy framing

### Block 5: Polish Meta Skills from Historical Docs
- 6 targeted supplements from production experience (2025-11 summary doc + SAM design doc):
  - 3-part rule decomposition (location → extraction → judgment) + scope classification
  - Post-processing > prompt negation anti-pattern
  - Pipeline node decomposition principle
  - Exit criteria design-first pattern
  - Chain optimization goal (shortest chain → smallest model → shortest prompt)

### Block 6: Model Selection for Different Tiers
- Baseline criteria verified (5/5 met)
- Startup warning when all worker tiers blank
- **NEW `auto-model-selection`** meta-meta skill — Context7 CLI for auto model discovery (optional plugin)
- Broad trigger: anytime KC needs model knowledge (tier assignment, workflow design, model comparison)

---

## v0.2.1 (2026-04-10)

Provider registry alignment with kc_reborn.

- **Aligned `src/providers.js` with `kc_reborn/providers.py`**: Same model ranking system (0-100 scores), same tier distribution logic (>=85 tier1, >=70 tier2, >=55 tier3, rest tier4), same default model assignments per provider.
- **VolcanoCloud defaults fixed**: Now uses actual coding plan model IDs (`doubao-seed-2-0-pro-260215`, `deepseek-v3-2-251201`, `glm-4-7-251222`, etc.) instead of outdated generic names.
- **Curated model lists**: Providers without `/models` endpoint (Aliyun Bailian, VolcanoCloud, Anthropic) now ship curated model lists used during onboarding for auto-discovery and tier proposal.
- **Aliyun Bailian coding plan**: Conductor defaults to `glm-5`, tier1 worker to `qwen3.6-plus` (has vision/OCR capability), tiers 2-4 left blank — a capable tier1 worker handles all tasks.
- **Bedrock**: Updated to use `anthropic` apiFormat, model IDs match Bedrock ARN format.
- **Onboard flow**: Checks curated model lists before querying `/models` endpoint, so providers that don't support the endpoint still get model discovery during setup.
- Added `getCuratedModels()` export and `rankModel()` utility.

---

## v0.2.0 (2026-04-10)

Major update addressing stability, multi-provider support, and UX improvements. Implements all 6 items from `global_update_design_v2.md`.

### 1. Multi-LLM Provider Support

- **10 provider presets**: SiliconFlow, Aliyun Bailian (with coding plan key support), Anthropic, OpenAI, VolcanoCloud (ByteDance), Zhipu GLM, MiniMax, OpenRouter, AWS Bedrock (stub), Custom
- **Full Anthropic Messages API support**: SSE stream normalization (content_block_delta, input_json_delta, tool_use blocks) mapped to OpenAI chunk shape so the engine needs no changes
- **Auto-discovery**: After entering API key during onboard, KC probes `GET /models` to discover available models and proposes tier assignments automatically
- **Provider-agnostic config**: `LLM_API_KEY` / `LLM_BASE_URL` replace `SILICONFLOW_*` keys (old keys still accepted)
- **Aliyun coding plan**: Sub-option during onboard for subscription-based access with separate base URL
- New file: `src/providers.js` — provider registry with model classification heuristics

### 2. Context Engineering

- **Retry mechanism** (`src/agent/retry.js`): 10 retries with exponential backoff (1s-60s), jitter, Retry-After header support. Retries transient errors (429, 5xx, network), fails fast on auth/validation errors (400, 401, 403)
- **Event log** (`src/agent/event-log.js`): Append-only JSONL log (`logs/events.jsonl`) with sequence numbers and timestamps. Every agent event (user messages, LLM calls, tool executions, phase transitions, errors) is persisted. Source of truth for session history.
- **Token estimation** (`src/agent/token-counter.js`): Character-based heuristic (~4 chars/token for Latin, ~1.5 tokens/CJK character). Used for context display and windowing thresholds.
- **Context display**: Status bar shows `CTX: 45.2k/200k (23%)` with color coding (green < 60%, yellow < 80%, red >= 80%)
- **`/compact` command**: Summarizes older messages via conductor LLM call, keeps recent 20 messages intact. Falls back to mechanical summary if LLM call fails.
- **Automatic context windowing** (`src/agent/context-window.js`): When messages approach 85% of context limit, older messages are mechanically compressed with phase summaries injected. Applied transparently before each LLM call.
- **Session persistence** (`src/agent/session-state.js`): Saves `session-state.json` with current phase, pipeline milestones, phase summaries. Saved on phase transitions, turn completion, `/compact`, and graceful exit (Ctrl+C, Ctrl+D, `/exit`).
- **`/resume <name>` command**: Fully functional session resume. Reconstructs engine from persisted conversation history + session state. Restores phase, pipeline milestones, and phase summaries.
- **Pipeline export/import**: All 6 pipeline subclasses now implement `exportState()` / `importState()` for cross-session persistence.

### 3. Better Configuration Interaction

- **`kc-beta config` command**: New category-based config editor (LLM Provider, Model Tiers, Quality Thresholds, Language). Edit settings in categories, saves after each change.
- **Simplified onboard**: Threshold prompts removed from onboard flow (moved to `kc-beta config`). Onboard now focuses on: language, provider, API key, model discovery, conductor model, worker tiers.
- **UX hints**: Grey "(Press Enter to keep)" / "(Press Enter to use default)" hints on all prompts.
- **Post-onboard hint**: Tells user about `kc-beta config` for advanced settings.

### 4. Session Language Override

- **`--en` / `--zh` flags**: `kc-beta --en` or `kc-beta --zh` overrides language for one session only without changing global config.

### 5. Web Search Tool

- **`web_search` tool** (`src/agent/tools/web-search.js`): Tavily API integration. Supports `query`, `search_depth` (basic/advanced), `max_results` (max 10).
- **Domain priority guardrail**: Tool description explicitly instructs the LLM to prioritize user-provided documents over web results.
- **Graceful degradation**: Returns informative error if `TAVILY_API_KEY` is not configured.
- Config: `TAVILY_API_KEY` in `.env` or global config.

### 6. Always-Visible Activity Indicator

- **Persistent spinner**: Activity indicator now shows whenever KC is working, not just during initial LLM response wait.
- **Contextual status**: "Thinking..." (LLM streaming), "Running [tool_name]..." (tool execution), "Analyzing results..." (between tool result and next LLM call).

### Breaking Changes

- `.env` template now uses `LLM_API_KEY` / `LLM_BASE_URL` instead of `SILICONFLOW_API_KEY` / `SILICONFLOW_BASE_URL`. Old keys are still accepted via fallback in `src/config.js`.
- `kc-beta onboard` no longer prompts for advanced thresholds. Use `kc-beta config` instead.

### Files Added (8)

| File | Purpose |
|------|---------|
| `src/providers.js` | Provider registry, model classification |
| `src/agent/retry.js` | Exponential backoff retry |
| `src/agent/event-log.js` | JSONL event log |
| `src/agent/token-counter.js` | Token estimation |
| `src/agent/context-window.js` | Automatic context windowing |
| `src/agent/session-state.js` | Session state persistence |
| `src/cli/config.js` | Category-based config editor |
| `src/agent/tools/web-search.js` | Tavily web search tool |

---

## v0.1.2 (2026-04-08)

Initial beta release. Pure Node.js CLI agent for document verification.

- 6-phase pipeline: Bootstrap, Extraction, Skill Authoring, Skill Testing, Distillation, Production QC
- BUILD mode (agent does all work) + DISTILL mode (worker LLMs)
- 14 tools: sandbox_exec, workspace_file, document_parse, document_search, rule_catalog, evolution_cycle, dashboard_render, agent_tool, worker_llm_call, workflow_run, tier_downgrade, qc_sample
- Ink/React terminal UI with streaming, tool blocks, status bar
- Meta-methodology skills (en/zh) bundled in template/
- SiliconFlow + Aliyun + Anthropic + OpenAI provider presets
- Session management: /sessions, /rename, /clear
