# KC Update Design v5 — v0.5.6 patches → v0.6.0 scope

## Current Status

**2026-04-20** — KC v0.5.5 is published (`kc-beta@0.5.5` on npm) and **actually
installed** on the test machine (caveat: through v0.5.4 the user had been running
v0.3.2 from an April-17 install, which invalidated the field trials on v0.4.0–v0.5.4;
see `archive/e2e_test_20260420_observations.md`). 

E2E Test #3 (`archive/test_data_3/`) is currently running against SiliconFlow
Pro/zai-org/GLM-5.1 as conductor + SiliconFlow tier1 workers (GLM-5.1, Kimi-K2.5,
DeepSeek-V3.2). Session `13c019a4e986`. A first xfyun attempt died at 08:28 —
silent empty responses once context grew past ~60K tokens — diagnosed as provider-
side context-window exhaustion, not KC fault. Switched conductor back to GLM-5.1
and resumed. Looking good so far.

Previous design docs:

- `docs/global_update_design_v3.md` — v3 update plan (v0.3.x era)
- `docs/global_update_design_v2.md` — v2 baseline
- `DEV_LOG.md` — release notes per version (v0.3.0 → v0.5.5)
- `archive/e2e_test_20260418_observations.md` — E2E #1 (rental contract) bug inventory
- `archive/e2e_test_20260420_observations.md` — xfyun OOM analysis + v0.3.2 install discovery

**IMPORTANT** — match the rhythm of v3 doc: plan one module, implement after
confirmation, finish, plan next. Don't batch everything.

---

## v0.5.6 — small hardening release (proposed)

Short batch of patches identified during E2E #1, E2E #2, E2E #3 runs. Each under
~25 lines of code. Target: one small commit + publish after test completion.

### - [ ] 0.5.6-1 · Agent-driven `phase_advance` tool doesn't refresh TUI status bar

**Symptom** (observed 2026-04-20 in session `13c019a4e986`): KC's agent called the
`phase_advance` tool and truly advanced `bootstrap → extraction → skill_authoring`
(confirmed in `session-state.json` + 2 `phase_transition` events in logs), but the
TUI status bar kept showing `BOOTSTRAP`. Engine state was correct; only React
state was stale.

**Root cause:** in `src/agent/engine.js` runTurn tool-execution loop (~line 806),
after `tool.execute()` the engine only yields `pipeline_event` when
`pipeline.onToolResult` returns a `phase_ready`. The `phase_advance` tool path
(callback at engine.js:217 → `_advancePhase`) mutates `this.currentPhase` and
logs a `phase_transition` event, but never yields an AgentEvent. The TUI
(cli/index.js:122 `setPhase(nextPhase)` on `pipeline_event`) never gets the signal.
v0.5.5's fix for the manual `/phase advance` slash command addressed a parallel path
but not this one.

**Fix:** capture `beforePhase = this.currentPhase` before `tool.execute()`; if
`this.currentPhase !== beforePhase` after, yield a synthetic `pipeline_event`:

```js
if (this.currentPhase !== beforePhase) {
  yield new AgentEvent({
    type: "pipeline_event",
    data: { type: "phase_changed", nextPhase: this.currentPhase,
            from: beforePhase, reason: `via ${tc.name}` },
  });
}
```

**File:** `src/agent/engine.js` (runTurn tool-execution loop, ~line 810-830).
**Size:** ~6 lines.
**Severity:** Display-only. Engine behavior correct; only UI is stale.

### - [ ] 0.5.6-2 · Per-provider `contextLimit`

**Symptom** (observed 2026-04-20 session `13c019a4e986` first half): conductor = xfyun
astron-code-latest. From msgs=75 onwards, xfyun started returning empty content
(`content=None, toolCalls=[]`, HTTP 200). At msgs=128+ it became permanent. Zero
`context_windowed` events in the log despite obvious history bloat.

**Root cause:** `config.js` defaults `kcContextLimit = 200000` for every provider.
xfyun astron-code-latest appears to have a smaller window (estimated 32K-64K).
KC's v0.5.4 `_maybeWindowAfterToolResult` only triggers at `> budget * 0.70` ≈ 134K
tokens, so with a 32K-limit model it never fires — by the time windowing would
kick in, the provider has long since been silently truncating or rejecting requests.

**Fix:** add `contextLimit` field to each provider entry in `src/providers.js`.
In `src/config.js` `loadSettings()`, prefer `provider.contextLimit` over the
generic 200000 default when no env override is set:

```js
// providers.js — examples
{ id: "xfyun",        contextLimit: 32768, ... },
{ id: "siliconflow",  contextLimit: 200000, ... },    // GLM-5.1 is 200k
{ id: "anthropic",    contextLimit: 200000, ... },    // Sonnet 4 is 200k
{ id: "openai",       contextLimit: 128000, ... },    // gpt-4o
// config.js — loadSettings()
kcContextLimit: parseInt(env.KC_CONTEXT_LIMIT ||
                         providerDef?.contextLimit?.toString() ||
                         "200000", 10),
```

Also surface the effective limit in `/status` slash output so users can see what's
in play.

**Files:** `src/providers.js` (add field to ~10 entries), `src/config.js`
(1-line fallback chain change), `src/cli/index.js` (`/status` addition).
**Size:** ~20 lines total.
**Severity:** Functional. Prevents silent empty-response failures on small-
window providers.

### - [ ] 0.5.6-3 · Detect N consecutive empty LLM responses and stop

**Symptom:** in the xfyun session, once the provider started returning empty
content, KC's runTurn loop kept calling the LLM again next turn with more
accumulated history — burning API calls, time, and (for pay-per-token plans)
money. User had to manually notice "nothing is happening" and intervene.

**Root cause:** runTurn's outer loop treats "no toolCalls + empty content" as a
valid turn_complete. There's no detection of "we made the call, got back
literally nothing useful, probably something is wrong."

**Fix:** track a counter of consecutive empty responses in the engine. If ≥ 2,
emit an `error` event (`{message: "LLM returned empty response 2x in a row;
likely context-length exceeded or provider-side silent failure — stopping this
turn"}`), stop the runTurn loop, let user intervene.

**File:** `src/agent/engine.js` runTurn.
**Size:** ~10 lines.
**Severity:** UX protection. Prevents silent runaway API costs.

### - [ ] 0.5.6-4 · Startup banner with version + path

**Deferred from:** `archive/e2e_test_20260418_observations.md` Bug 7 and action
item 4 of `archive/e2e_test_20260420_observations.md`.

**Symptom:** "v0.5.3 was never actually running — user had v0.3.2 installed from
April 17, and 4 releases of 'fixes' were invisible in the field trials." Easy
to avoid with a one-line banner at launch.

**Fix:** in `bin/kc-beta.js` startup, read package.json version and print:

```
⏵⏵  KC Agent CLI  v0.5.6  ·  /usr/local/lib/node_modules/kc-beta/bin/kc-beta.js
```

Also echo it as a system message in the TUI so it's visible in the scrollback.

**Files:** `bin/kc-beta.js`, `src/cli/index.js` (initial system message).
**Size:** ~8 lines.
**Severity:** Operational. Cheapest win; biggest field-debugging gain.

### - [ ] 0.5.6-5 · SSE accumulator safety cap

**Deferred from:** `archive/e2e_test_20260420_observations.md` action item 5.

**Symptom (hypothetical, not yet reproduced):** if a provider sends an
abnormally large `data: ...` line without a newline terminator, the SSE parser
accumulates into `buffer` until a `\n` arrives. Under pathological input or
rate-limit corruption this could grow to hundreds of MB, triggering O(n²)
`buffer.split("\n")` behavior and OOM.

**Fix:** in `_parseOpenaiSSE` / `_parseAnthropicSSE` at `src/agent/llm-client.js:
262, 314`, cap `buffer.length` at e.g. 8 MB. On overflow, abort the stream with
`"SSE buffer overflow (8MB without newline) — aborting stream"` and emit an
error event.

**File:** `src/agent/llm-client.js`.
**Size:** ~6 lines.
**Severity:** Defensive. Low-probability but high-impact when it hits.

---

## Deferred items — still on the list for v0.6.0 or later

Lower-priority / higher-complexity items that didn't make earlier patches.
Each reviewed as v0.6.0 candidate after observations below.

### From `archive/e2e_test_20260418_observations.md` (Normal severity)

- [ ] **Bug 6** — CTX status bar shows misleading peak numbers. Show 30-sec
  smoothed value AND a peak indicator; label as "estimated" vs "API-reported".
  Partially mitigated by v0.5.4 C.4.c soft-threshold hint but root cause remains.
- [ ] **Bug 8** — Stream "terminated" errors not all logged as `error` events.
  Inconsistent error capture when the abort happens mid-token. Wrap `streamChat`
  for-await in stronger try/catch + finally.
- [ ] **Bug 9** — Sub-agent dedup. When parent doesn't see child's `status.txt`
  flip to `completed`, KC re-spawns. Combined with no parent-side child-progress
  visibility → over-spawning. Fix: `agent_tool` exposes `wait` or `poll`
  operation so parent checks status without spawning duplicates.
- [ ] **Bug 10** — Workspace bloat. Retries route to versioned subfolders
  instead of sibling files (`output/distillation/14b_A/run_1/` not `14b_A.log` +
  `14b_A_v2.log`).

### From `archive/e2e_test_20260418_observations.md` (Nits)

- [ ] **Nit 13** — `evolution-loop` skill text: add exit condition "if iteration
  N+1 changes accuracy by <1%, stop and proceed to release." Currently KC kept
  iterating v5→v12 past "good enough." Skill text change, not engine fix.

### From v0.5.4 observations (deferred architecture)

- [ ] **Parallel ralph-loop** (v0.5.4 DEV_LOG Bug 2 followup). Distillation work
  wants parallelism; ralph-loop is serial-only. KC reached for sub-agents because
  ralph-loop couldn't parallelize. This is an architecture change — should be
  its own RFC. Scope: `runTaskLoop({parallelism: N})` with lock-free partitioning
  by rule_id. Keep Block 2 guidance: no shared mutable coordination.

### From v0.5.4 Bug 5 followup

- [ ] **Deprecate `rule_catalog` tool** in favor of `workspace_file`. v0.5.4
  added aliases + precise errors. But `workspace_file` already does the job for
  catalog.json directly. Evaluate: keep rule_catalog as a thin CRUD wrapper, or
  remove and update skills to use workspace_file? Migration doc needed.

### From E2E #3 running session (13c019a4e986) — observations 2026-04-21

- [ ] **memory_pressure detector latches silently** (engine.js v0.5.4 C.3.d).
  `_memPressureLogged = true` gets set once heap crosses 0.80 threshold and
  only re-arms if it drops back below 0.60. In the E2E #3 session, last
  `memory_pressure` event fired at seq 1350 (13:13 on day 1) with
  `heap=327/406MB`. 17 hours later RSS is now 3788MB (92% of 4GB ceiling)
  but zero further signals. Detector is "working as designed" but giving
  zero visibility once we're past the threshold. **Fix:** emit a recurring
  signal every ~15min while still above threshold, not one-shot. ~5 lines.

- [ ] **TUI input lock + missing spinner after long runs** (observed ~18h
  into E2E #3). User reported "can still type but no response, no spinner."
  KC was actually mid-LLM-call (normal behavior, InputPrompt disabled via
  `isActive: !streaming`). But the spinner wasn't rendering — possibly
  v0.5.5's `/compact` spinner-clear finally-block interacts badly when
  compact completes and ralph-loop immediately starts the next task. Race:
  `setSpinnerStatus(null)` fires from compact's finally BEFORE next task's
  `streaming=true` triggers spinner render again. Users see dead TUI.
  **Fix:** ensure ralph-loop re-enters spinner state before
  compact-finally clears; or use a dedicated spinner state per task
  boundary.

- [ ] **2 tasks/hour is too slow at 378-task scale.** E2E #3 has
  189 rules × 2 phases = 378 tasks. At 2 tasks/hour (observed steady rate
  across 17h, spanning both skill-writing days), 340 pending tasks = 7+
  days wall-clock. Ralph-loop is functioning correctly (35 compact events,
  only 4 sub-agents, no over-spawning). It's just serial. **This is the
  strongest argument to promote parallel ralph-loop out of "deferred" and
  into v0.6.0 scope.** 4 parallel workers ≈ 8 tasks/hr = ~42h for 340 tasks.
  Still not fast but feasible.

- [ ] **Occasional empty-response pattern on GLM-5.1 (not just xfyun).**
  Over 30 recent assistant turns: 7 productive (content+tool), 16 tool-only
  (normal), **7 truly empty (no content, no tools)**. ~23% empty rate on
  GLM-5.1/SiliconFlow — way better than xfyun's 100% but still costing API
  calls + time. Each empty turn recovers within 1-2 turns. Reinforces
  v0.5.6-3 (detect N consecutive empty responses). Also worth instrumenting
  the rate so we can see "is this model behaving?" at a glance.



---

## User observations during E2E #3 (for user to fill)

This section is for notes from me, Yibo.

**IMPORTANT** In these notes are the updates that I, Yibo (developer of kc_cli) would like to implement in 0.5.x, together with some observations and questions I raised during end2end test (see KC session '资管新规测试001', '资管新规测试002', '9bfaf331ff72'). Focus on this part, explain in details how things are done to me in Claude Code session based on this note. Ask me anything and then plan in details. This is going to be a huge update, adopt taskboard, subagents, ralph-loop, etc. accordingly. Upon finishing and testing, we will publish this new release as 0.6.0

Following items are arranged in the order of observation, not importance and priority. You, claude, can rearrange accordingly and discuss the priority with me in Claude Code.

Also, if a few of these issues are already addressed and fixed previously during and right after tests, the problems may not exist now. But please double check carefully anyway.

### **1. Number limit of subagents**

- Check the limit of how many subagents can KC create. What is the current number? Since most of our user, including me, use coding plan provided LLM to power KC, the parallel LLM call numbers are usaully low (like 5, 3, or even 1). Not too much to worry here, if rate limit KC will handle itself as well. As I have observed, KC will reduce subagent numbers or carry out the task itself.

- Investigate first, don't change the limit or overkill with more restrictions without my permissions.

### **2. Phase forward and control**

- Explain to me in details how phase is recognized and controlled. After previous fixations, getting into rule extraction phase is okay now, with bootstrap phase quickly flying by. But I am still witnessing phase indicator in status bar stuck in extraction when KC is clearly already working on skill authoring. I can confirm that KC called phase_advance in tool_use, but status bar didn't change.

- I need to know where the problem is, status bar or the phase control itself. Since we register different tools to different phase, and if KC is actually working in later stages, while necessary tools are not avialable to KC because phase control is broken, then this is a serious one.

- Also witnessed 'Configure OCR models in .env for image-based documents.' a lot. Maybe it's also related to phase control? Because OCR models are registered as worker model and thus not available to KC main agent if it is stuck in early phases.

### **3. User cannot input when KC is working**

- User cannot type in the input bar if KC is working at the moment. Not only user cannot send, user cannot type either. This is kinda uncomfortable and inconsistent with other CLI tools user might be familiar with, like Claude Code.

- I wish to have the feature that user can type in the input bar and hit enter anytime in the session, whether KC is working or not. The input message with not stop by force what KC is working right now. Instead, it will be inserted as user input in the next main agent llm call in agent loop.

- Please refer to Claude Code's source code design at: https://github.com/Janlaywss/cloud-code

### **4. Simple new session user guide**

- Now each time user enters kc, a new session is created, blank. Users might not know what to do next. They won't even ask KC to check bootstrap status and tell them what to do, what files and data to put to where.

- Instead of autostart bootstrap everytime, since that will waste token, we show a short guide each time kc is launched a new session is created. something like 'to start a new project, you can say please check bootstrap status and tell me what to do. to rename the session, use /rename. to resume a previous session, use /resume'. both english and chinese.

- When checking bootstrap status, logically KC should also check the availability of worker LLM api, see if it is callable. In order not to conflict with our design of restricting worker LLM to distillation and afterward phases, we should restrict worker llm call tool_use once bootstrap phase is over. During worker LLM api testing in phase 1 bootstrap, if worker llm is not available, KC should have the right to ask user if user would like to change provide/api key/model name or use same provider as KC main agent (I mean if this problem can be discovered, that means main agent llm call is good.). KC can also confirm worker llm provider and selection with user, together with other bootstrap status like files, agent.md, etc.

### **5. KC needs to know that samples may contain incorrect ones**

- KC works in the most meta level and serves as the ground truth. So naturally, samples provided initially are guaranteed to be mix of correct and incorrect ones. KC determine and label the correctness based on its own judgement. This is not a per user request thing, but a default setting. In previous test we addressed this problem
by writing this in an AGENT.md. KC should know this in system and design level.

### **6. up/down/left/right button support for kc_cli**

- the input area now have no support for the four direction button input. I would like it to have the features in most cli tools. left/right to move the input indicator. up/down to use previous/next history input when input bar is empty, and move up/down lines if input bar has already text.

### **7. List of all installable tools**

- I remembered that during previous development, we created several tools (like context7) that user can choose to install. I kind of lost track of all of them. Please list these tools and their status. Are they implemented or not? Does KC have them by default or not?

### **8. Check the final output in workspace**

- I manually checked the workspaces after end2end test completed. Honestly it is kinda messy. I cannot quickly figure out where are the skills and where are the workflows. Skills and workflows are not laying flat and not arranged by rules. Please walk me through how KC build the final output in workspace, and do we need to add a finalization phase where KC sort out and pack everything for production and further development.

### **9. Keep in mind that we have naturally extracted rules as granularity**

- When watching KC working and examining the final output, I found that KC tends to combine multiple rules into one skill/workflow, which is a little bit aggressive. Rule-based document verification system, in most cases, requires results per rule. The granularity by definition of these rules is the job of rule-extraction phases and we should trust KC's work in this phase to be appropriate, accurate and following MECE principle.

- However, some are okay if these rules have similar content/chapter as input and share some judgemental logic. Check how KC is doing this now and let's see what we should do.

### **10. From AMC rules app, we know that parser and chunker design are too thin**

- Explain to me what the SOP is now for KC to parse and chunk documents in projects. In most doc verification projects KC will be dealing with, the documents are almost certain to be very long, reaching half a million characters and over 100 pages. So, a good parser and chunker mechanism is important for KC main agent, for workflows created by KC, and for how KC creates these workflows.

- Try search the memory, claude code sessions and read code base of AMC rules app at: /Users/mac/Desktop/kc_cli/archive/pr_verify_app. In it we talked about several designs, like markdown better than txt, using MarkItDown, onion peeler from A2O project, wrap outter layer based on files, tree structure, RAG, keywords and glossary, etc. If you cannot find relevant information, have questions or better design, don't act alone. Please discuss with me in this part.

### **11. What we can take away from the 2 apps we built**

- The two apps we built, especially the AMC rule one. We actually put in some great effort to make it work. At least we created a good wrapper around the output of kc, making it usable to the very end users. What can we summarize from them? Some reusable tools for what KC may produce in the future? Some new meta skills? Some more tools for KC? Open exploration here, no pressure.

- For example, in AMC rule app, the first version of workflows performed not well, giving a huge number of 'require human double check' result with no evidence. And it turned that the retrieval of original context was poor because keywords/glossary is not good and there is no embedding model or reranker or vectordb for kc as the RAG infra when design the workflow. We can systematically enrich this part by giving KC more skills.

### **12. Rules in NL too concise**

- I examined a few results of rule extraction phase and saw the rules are concise. This is good, make no mistake. These rules will not be executed, compared to rules as skills/workflows. I want to know how these rules are passed down to skill authoring and other modules/phases. At least when authoring skills, rules in NL should not be the single source. At least some of the original context should also be provided.

### **13. How Meta-Meta and Meta Skills and skill-creator are loaded to KC**

- Please walk me through how these skills are loaded and called during KC working. How can we make sure correct skills are called in correct phase? Can we trace the call of skills like how we trace the use of tools?

- In another session when KC main agent is powered by Kimi K2.6 (not GLM-5.1 as we recommend, so this might be the main cause), I witnessed huge mistakes during skill-authoring. Kimi KC was writting skills in .py, and clearly not following skill-creator.

### **14. Simple MD format report end of every phase or important output produced**

- KC now only reports in short messages in CLI and the final dashboard. The report and feedback to users should be more frequent and lighter for KC in terms of workload (dashboards count as heavier ones). KC should write markdown files at important nodes of the project like end of every phase or finishing a job with important output like a batch of test.

- Since writing in markdown and create files in workspace is natural for KC, should this should be a 'soft' instruction in prompt/skill/tool level, not a hard-coded one.

- By default KC write this markdown in its own workspace, and only in user's directory per user request.

### **15. Easter Egg**

- A new slash command '/meme' for an easter egg, some lyrics and the signature of my team. Show on TUI directly, press exit to exit. Content as follow:

```
I'll wait and soon
We're stranded on the beach
In our dream
We part too soon
But in our lies
There's a truth to find
The end is new
A tomorrow we must reach for
To be heard

Here's to all the smart minds that are/were part of our team: @kitchen-engineer42, @Xigua, @Amelia, @01Fish, @zyxthetroll, @theon, @DivisionDirectorXu, @AnselKocen, @CarolineCRL, @GraceGuo, @XY🌟, @HalfM, @GreenOrange, @LilyHuang, @Qianlili, @songmao, @yhhm, @Atreus, @Maruko, @zoezoe
```

---


Below are notes summarized by claude in monitoring session of e2e test

### Health-check snapshots during the run

**2026-04-20 ~18:30** (first check, ~11h into session):
- Process RSS 311MB (8% of heap ceiling) — healthy
- 5 compact events, textbook ralph-loop cadence
- msgs grew 2 → 16 between compacts, never approaching windowing threshold
- 23% occasional-empty-response on GLM-5.1 (spread out, self-recovers)
- Conclusion: context not rotting, slow but steady

**2026-04-21 ~10:00** (morning check, ~17h into session):
- Process RSS **3788MB (92% of 4GB heap ceiling)** ⚠️ — OOM risk in 1-3h
- 35 compact events total (ralph-loop compacting ~1×/30min overnight)
- msgs count after each compact drops to 8-16 (health signal — history
  itself is fine)
- Disk history file only 8.7KB / ~2K tokens (compact is doing its job)
- RSS creep is NOT from conversation history; likely Ink render tree OR
  event-log in-memory queue OR offloaded-tool-result pointer accumulation
- memory_pressure detector stopped signaling after seq 1350 (see deferred
  items above)
- **Mac did NOT sleep overnight.** Event rate actually went UP
  (350-500/30min overnight vs 150-200/30min daytime). Power settings held.
- Task progress: 38/378 complete, pace **~2 tasks/hr steady**

### Coverage check (2026-04-21 10:00) — per user question "are the 2 latest regs covered?"

Rule catalog (189 total) breakdown by regulation:

| Source regulation | Rules | ~IDs |
|---|---:|---|
| **《银行保险机构资管产品信息披露管理办法》(2025年第10号, 信披办法)** | **77** | R001–R077 |
| **《商业银行托管业务监督管理办法(试行)》(2025年第9号, 托管办法)** | **51** | R078–R128 |
| 资管新规 (2018) | 10 | R129–R138 |
| 理财业务办法 (2018) | 13 | R139–R151 |
| 理财子公司办法 (2018) | 4 | R152–R155 |
| 理财产品销售办法 (2021) | 2 | R156–R157 |
| 现金管理类通知 (2021) | 16 | R158–R173 |
| 保险资管公司规定 (2022) | 2 | R174–R175 |
| 保险资管产品办法 (2020) | 8 | R176–R183 |
| 组合类保险资管通知 (2020) | 6 | R184–R188 |
| **2 CORE (2025 newest) — TOTAL** | **128** | |
| **SUPPORT (2018-2022) — TOTAL** | **61** | |

Each rule has 2 tasks: `-extraction` (refine the rule) and `-skill_authoring`
(write the detect.py). Total pipeline = 189 × 2 = 378 tasks.

As of 2026-04-21 10:00:

| Regulation | Extraction | Skill Authoring | Notes |
|---|---:|---:|---|
| 《信披办法》 R001-R077 | 38/77 (49%) | **0/77 (0%)** | |
| 《托管办法》 R078-R128 | 0/51 (0%) | 0/51 (0%) | |
| Support regs R129-R188 | 0/61 (0%) | 0/61 (0%) | |
| **TOTAL** | 38/189 (20%) | 0/189 (0%) | |

**Coverage answer (initial, based on task tracker)**: not yet covered.
Extraction for 2 core regs is 30% done (38/128). Skill authoring has
**not started** for any rule. To finish just the 2 core regs (not
support): still need 90 extraction tasks + 128 skill-authoring tasks =
**218 tasks ≈ 109h ≈ 4.5 days** at current pace.

### Coverage recheck (2026-04-21 afternoon) — tracker misread

User pushed back ("I am seeing it looking at samples and writing regex").
Correct. Direct filesystem inspection of
`~/.kc_agent/workspaces/13c019a4e986/rule_skills/` shows KC has in fact
written detect.py skill code for **all 189 rules**, not zero:

| Dir | Rules covered | Size | Shape |
|---|---|---|---|
| `SK02_required_fields/` | R001–R077 (77 rules, all 信披办法) | 520KB, 23 files | Mix of per-rule (`check_r001.py`, `check_r014.py`..`check_r025.py`) and grouped (`check_r002_r007.py`, `check_r059_r077.py`) |
| `SK03_custody_rules/R078_R128/` | R078–R128 (51 rules, all 托管办法) | 15KB, 1 file | Grouped multi-rule detect |
| `SK04_supporting_rules/R129_R189/` | R129–R189 (61 supporting regs) | 25KB, 1 file | Grouped |
| `common/` | shared utilities | — | `read_file.py`, `normalize_result.py` |
| `run_all_checks.py` | orchestrator | — | top-level runner |

Sample from `SK02_required_fields/R001/check_r001.py`: real executable
Python — HOLIDAYS table for 2024-2026, workday diff calculation against
季度末披露日期, exit with structured `{compliant, evidence, reason}` dict.
Module imports cleanly; exposes `check_r001()` + `add_workdays()`.

**Both 2025 flagship regs (信披办法 + 托管办法) are fully covered by real
Python verification code.** The task tracker saying "0 skill_authoring
done" is misleading — see next item.

### The "rule refinement" / `-extraction` task was auto-generated by a design mismatch

User's question 2026-04-21: *"what is the rule refinement task anyway?
I don't recall defining this task. These rules are already extracted if
ralph-loop taskboard can be set up, right?"*

Correct. Tracing the code:

- `src/agent/engine.js:903` — every call to `_advancePhase(nextPhase)`
  invokes `this._createTasksForPhase(this.currentPhase)`.
- `engine.js:976` — `_createTasksForPhase(phase)` reads
  `rules/catalog.json`, calls `TaskManager.createRuleTasks(rules, phase)`.
- `task-manager.js:95` — **blindly creates one task per rule for whatever
  phase was just entered**, with id `${ruleId}-${phase}`.

So the moment the session entered EXTRACTION, it generated 189
`R00N-extraction` tasks. But `test_data_3` ships with a pre-built
`rules/catalog.json` (189 rules already decomposed) — extraction is
*already done* by definition. The `-extraction` tasks have no real work
to do.

What KC actually did during each `-extraction` iteration: re-read the
rule, read samples, and **wrote detect.py skill code ahead of schedule**.
That's why the filesystem has 520KB of skills while the tracker says
`skill_authoring: 189 pending`. Code was written against `-extraction`
ticket numbers.

**Design mismatch**: per-rule tasks only make sense for phases where the
unit of work is a rule (`skill_authoring`, `skill_testing`). For BOOTSTRAP
and EXTRACTION, the unit of work is a *regulation* — one 信披办法 PDF
decomposes into dozens of rules. Generating N tasks per rule for those
phases is backwards: the rules don't exist yet (or are the OUTPUT, not
the input).

**Consequence for v0.6.0 parallel ralph-loop**: if the task generator
isn't fixed, parallel workers will fight over fake `-extraction` tasks
that should never have been created. The fix and the parallelism change
need to land together.

**Fix sketch** (for v0.5.6 or v0.6.0):

```js
// task-manager.js — createRuleTasks()
const PER_RULE_PHASES = new Set(["skill_authoring", "skill_testing"]);
createRuleTasks(rules, phase) {
  if (!PER_RULE_PHASES.has(phase)) return;  // no-op for bootstrap/extraction
  for (const rule of rules) { /* existing logic */ }
}
```

For BOOTSTRAP and EXTRACTION, tasks should be per-regulation (one per
PDF in `rules/`), generated at session init — not per-rule, not on phase
entry.

**Size:** ~20 lines in `task-manager.js` + `engine.js` initialization.
**Severity:** Functional — controls the shape of the entire ralph-loop
work queue. Blocking issue for parallel ralph-loop.

Add as **v0.5.6-6** (or promote to v0.6.0 alongside parallel ralph-loop,
since they're coupled).

### Decisions taken after coverage check

**2026-04-21 afternoon — Option A chosen, with revised understanding.**

- KC session `13c019a4e986` shut down by user.
- Salvage is much richer than initially scored: 189/189 rules have
  detect.py code for both 2025 core regs.
- Next step: build a standalone verification app against the salvaged
  rules + skills (see `archive/pr_verify_app/` plan — separate side
  job, not KC source changes).
- v0.5.6 patch list grows by one (the task-generator fix above).
- v0.6.0 scope: parallel ralph-loop + task-generator fix as a coupled
  pair.

---



## v0.6.0 scope — to be planned after E2E #3 + user supplements

Once the test finishes and the observations above are filled in, we'll plan
v0.6.0 in a separate section (or fresh doc). Likely inputs:

1. **v0.5.6 patches** (above) — assume merged as baseline
2. **User observations** (section above)
3. **Promoted deferred items** — probably Bug 6 (CTX UX), Bug 8 (error capture),
   Bug 9 (sub-agent dedup), Nit 13 (evolution-loop exit criteria). Parallel
   ralph-loop may or may not land in 0.6.0; bigger scope.
4. **New architectural items** emerging from real E2E #3 experience
5. **PR / launch concerns** — v0.6.0 is the "first intentionally-beta-tested
   release." Quality bar is higher.

Don't plan v0.6.0 specifics here yet; leave the space for informed planning
after data arrives.

---

## Planning discipline

Per v3 doc norms:

- **Plan one module, implement after user confirmation, finish, plan the next.**
  Not batch-planning everything.
- Each checkbox item above has enough detail to implement on its own.
- When we pick an item, it moves from this doc's checklist → its own short
  plan at `/Users/mac/.claude/plans/please-read-the-project-swift-rossum.md`
  → implementation commit → this doc gets a `✅` tick or link to commit.
- `[x]` = done. `[ ]` = pending. No in-flight middle state in this doc — that
  lives in the active plan file.

---

*Draft 2026-04-20. Will keep appending observations until E2E #3 completes
and user hands back for v0.6.0 planning.*

---
---

# ─── APPENDIX: v0.6.0 FULL PLAN (approved 2026-04-23) ───

Full v0.6.0 implementation plan, copied verbatim from
`~/.claude/plans/please-read-the-project-swift-rossum.md` on 2026-04-23
after user approval. Kept inline here so that if we need to re-plan any
sub-module mid-implementation, the big picture + decisions + coverage audit
are not lost when the working plan file gets overwritten for the next group.

---

# Plan: KC CLI v0.6.0 — architectural update

## Context

KC CLI has shipped v0.3.x–v0.5.6 as an iterative series of small releases. E2E #3
(session `13c019a4e986`, 378 tasks, ~2 days wall-clock) surfaced a 15-item list
of architectural gaps in `docs/update_design_v5.md` that small patches can no
longer cover. v0.6.0 is the first intentional architectural release — the user
will beta-test with their team once shipped. Quality bar is higher than prior
releases.

v0.6.0 folds in the v0.5.6 patch list (items 1–5) as baseline, promotes parallel
ralph-loop out of "deferred", and lifts the AMC verification app's chunker/RAG
logic into KC as native tools. Rhythm follows v3 doc norms: plan each group,
implement, finish, plan next — NOT batch-implement.

## Decisions taken (locked via AskUserQuestion)

| # | Decision |
|---|---|
| D1 | Parallel ralph-loop **in scope** for v0.6.0 |
| D2 | Granularity: **soft nudge + coverage audit** (not hard 1:1) |
| D3 | RAG/chunker: **port AMC app's logic as native KC tools** |
| D4 | Add new **FINALIZATION phase** (7th phase) |
| D5 | Parallel workers: **in-process async pool** (not fork / worker_threads) |
| D6 | Source context: **catalog back-refs + auto-attach** to skill_authoring prompts |
| D7 | v0.5.6 patches: **folded into v0.6.0** (no bridge release) |

## Scope

Seven groups, A→G. Each group is its own short implementation plan + commit
before moving to the next. Items cross-reference the 15-item list from
`docs/update_design_v5.md`.

---

### Group A — Engine correctness (folded v0.5.6 + E2E #3 fixes)

Small, high-leverage patches. Land first because they de-risk everything else.

- **A1** — `phase_advance` tool emits synthetic `pipeline_event` (v0.5.6-1, item 2).
  `src/agent/engine.js` runTurn tool-execution loop (~line 810-830): capture
  `beforePhase`, yield `pipeline_event {type:"phase_changed"}` if
  `currentPhase` differs after `tool.execute()`. Fixes stuck status bar.
- **A2** — Per-provider `contextLimit` (v0.5.6-2). `src/providers.js` adds
  `contextLimit` field per provider; `src/config.js` `loadSettings()` prefers
  it over generic 200000 default; `/status` surfaces effective limit.
- **A3** — Empty-response guard (v0.5.6-3 + E2E #3 observation). Engine counter
  of consecutive empty LLM responses; ≥ 2 → emit `error` event and stop.
  Instrument rate into `cost_updated`-style telemetry so we can see "is this
  model behaving" at a glance.
- **A4** — Startup banner (v0.5.6-4). `bin/kc-beta.js` prints version + path
  at launch. Also echo in TUI as system message.
- **A5** — SSE accumulator safety cap (v0.5.6-5). `src/agent/llm-client.js`
  `_parseOpenaiSSE` / `_parseAnthropicSSE`: cap buffer at 8 MB, abort stream
  on overflow.
- **A6** — Task-generator design mismatch fix (v0.5.6-6, item 2 adjacent).
  `src/agent/task-manager.js` `createRuleTasks()`: gate per-rule task creation
  to `PER_RULE_PHASES = {skill_authoring, skill_testing}`. For
  bootstrap/extraction, create per-regulation tasks (one per PDF in `rules/`)
  at session init, not per-rule on phase entry. This is a **hard prerequisite
  for Group B** — parallel workers would otherwise fight over fake
  `-extraction` tasks.
- **A7** — OCR error message phase-gating (item 2c). `src/agent/tools/document-parse.js:117`:
  suppress "Configure OCR models in .env" in non-distill phases, or reword
  to "VLM fallback unavailable in this phase (only used in DISTILLATION)".
- **A8** (was deferred **Bug 8**) — Stream "terminated" error capture.
  `src/agent/llm-client.js` `streamChat` for-await: wrap in stronger
  try/catch + `finally`. Every stream termination (clean EOS, mid-token
  abort, timeout, 429-retry) should yield exactly one `error` event with a
  tagged reason. Today the abort-mid-token case is inconsistently logged.
  Adjacent to A3 (empty-response guard) but different — A3 detects a LACK
  of content; A8 detects malformed/interrupted content.
- **A9** (was deferred **memory_pressure latching**, E2E #3 §observation).
  `src/agent/engine.js` C.3.d block: change the one-shot `_memPressureLogged`
  latch to emit a repeating signal every ~15min while heap is above 0.80,
  re-arming to silent on drop below 0.60. ~5 lines. Without it, the TUI
  goes silent for hours past the threshold (observed 17h silence while RSS
  climbed to 3.8GB).

**Files:** `src/agent/engine.js`, `src/providers.js`, `src/config.js`,
`src/cli/index.js`, `src/agent/llm-client.js`, `src/agent/task-manager.js`,
`src/agent/tools/document-parse.js`, `bin/kc-beta.js`. ~110 lines total.

---

### Group B — Parallel ralph-loop (in-process async pool)

Core architectural change. Coupled with A6 (task-generator fix) — cannot land
independently.

**CRITICAL PREREQ (B0)** — The E2E #3 observations recorded RSS climbing from
311 MB at 11h to 3788 MB at 17h with parallelism=1. At parallelism=4 the same
leak rate hits the 4 GB ceiling in ~4h, OOM-killing the process mid-run. A
failed 4-worker run burns ~$100+ tokens and ~20 h wall-clock. Root-cause fix
is a **hard prerequisite** for enabling any `parallelism > 1`; we do NOT ship
parallelism as a best-effort knob.

- **B0.1** — Heap instrumentation (permanent feature, no flag).
  `src/agent/engine.js`: append `process.memoryUsage()` + active-task count
  + offloaded-pointer-count to `<workspace>/logs/heap.jsonl` every 60 s.
  Add a small analysis script `scripts/heap-analyze.js` that charts the
  trajectory. Always on, cheap (one fs.appendFile/min).
- **B0.2** — Baseline measurement. Run a 2 h instrumented serial session on
  `archive/test_data_3/` (~25-30 tasks, enough for trend visibility).
  Produce a root-cause tag: heap-growing (JS allocation leak) vs RSS-growing-
  but-heap-flat (native / Ink render tree). Commit the heap.jsonl to the
  session archive for reference.
- **B0.3** — Fix root cause #1: **event-log in-memory queue**. Suspected
  location: whatever sink `EventEmitter.emit` accumulates into for
  `/sessions` / event replay. Convert to a bounded ring buffer
  (last 10 000 events or 50 MB cap, whichever first) + always-flush to
  `events.jsonl` on disk. On replay, re-read from disk instead of RAM.
  Lifecycle events (`session_completed`, `phase_transition`, `task_completed`,
  `finding`, `error`) bypass the ring cap so they can never be evicted.
- **B0.4** — Fix root cause #2: **offloaded tool-result pointer accumulation**.
  Every time a tool result exceeds the offload threshold, its metadata
  pointer (path, size, hash, turn_id) is kept in-memory. After 1000s of
  tool calls these accumulate. Fix: LRU-cap at N=500 active pointers; on
  eviction, the data stays on disk but the metadata is re-hydrated from
  disk on demand. Add a `ToolResultStore` class in
  `src/agent/tool-result-store.js` that owns this cache. Replace all direct
  pointer-array mutation sites with calls into the store.
- **B0.5** — Fix root cause #3: **Ink render tree accumulation**. The TUI
  maps over `history.messages` / events on every render; with N=10 000
  messages, every re-render builds a 10 000-node virtual tree that Ink
  then diffs. Fix: TUI components (`AgentMessageFeed`, `ToolCallStream`,
  `Taskboard`) render only the last 200 messages / 50 tool calls / 30
  tasks; everything older is accessible via a new `/scrollback` slash
  command that pages through the on-disk jsonl. Memoize per-row
  components with `React.memo`.
- **B0.6** — Hard guard: `src/config.js` clamps `parallelism` to 1 unless
  `KC_PARALLELISM_VERIFIED=1` is set in env AND a heap.jsonl file in the
  current workspace shows ≥ 2 h of flat RSS under load (within 10 % drift).
  Prevents accidental "set it to 4, cross fingers" runs. The
  `--parallelism=N` flag silently downgrades to 1 with a warning message
  if the guard trips.
- **B0.7** — Conformance gate. Before turning on parallelism in E2E #4:
  run the 2 h instrumented serial again (post-fix) and confirm RSS stays
  flat within ±10 %. Then run a 4 h parallelism=2 instrumented session
  and confirm total RSS scales sub-linearly with workers (target: RSS(N=2)
  < 1.6 × RSS(N=1), not 2×). Only after both pass, set `KC_PARALLELISM_VERIFIED=1`
  and run full E2E #4 at parallelism=4. This is a blocking release criterion.

Budget note: each verification run is 2-4 h, ~$20-40 tokens. Three runs
(serial baseline, serial post-fix, N=2 conformance) ≈ $60-120 total.
Catches the leak regression at 3 % of the cost of a failed full E2E.

- **B1** — `runTaskLoop({parallelism: N})`. `src/agent/engine.js`: spawn N
  concurrent `_worker()` async loops. Each worker pulls from
  `taskManager.getNextPending()` atomically (single-thread JS → no lock
  needed, but mark task in-progress BEFORE releasing event loop).
  Workers share `ConversationHistory` / workspace / `emitter` but own their
  own turn lifecycle. Promise.allSettled to join.
- **B2** — TaskManager atomic pull. `src/agent/task-manager.js`:
  `getNextPending()` must atomically mark a task `in_progress` under concurrent
  callers. Add `markDone(task_id)`, `markFailed(task_id, err)`.
- **B3** — CLI flag `--parallelism=N` (default 1, max 8 — prevents runaway API
  spend). Persist last-used value in session config. Surface in `/status`.
  Also accept `/parallelism N` slash command for runtime adjustment.
- **B4** — Per-task event isolation. Emitter already tags events with
  `task_id`; verify every engine path propagates it so the TUI taskboard can
  show N concurrent rows. Fix any paths that drop it.
- **B5** — Workspace git commit serialization. Multiple workers may write to
  `rule_skills/` simultaneously; `workspace._autoCommit` must serialize
  (lock + queue, or single dedicated commit loop). The existing auto-commit
  path at `workspace.js` around the tracked-path write is the hotspot.
- **B6** — Rate-limit handling. When a worker's LLM call gets 429, back off
  THAT worker only (exponential), not the pool. If ≥3 concurrent 429s,
  reduce effective parallelism adaptively.
- **B7** — TUI taskboard updates. `src/cli/components.js` Taskboard: render
  N concurrent `in_progress` rows (today's assumes 1). Worker slot column
  optional.
- **B8** (was deferred **Bug 9** — sub-agent dedup). Parent re-spawns children
  when it misses `status.txt` flip to `completed`. Dangerous under parallelism
  (multiplies duplicates). Fix: `src/agent/tools/agent-tool.js` — add
  `operation` input field with values `spawn` (current, default), `wait`
  (block until child done or timeout), `poll` (non-blocking status read),
  `list` (enumerate running subagents). Parent uses `poll`/`wait` to check
  before spawning a same-task child. Closes the dedup gap without hard-capping.

**Files:** `src/agent/engine.js`, `src/agent/task-manager.js`, `src/agent/workspace.js`,
`src/agent/tools/agent-tool.js`, `src/agent/tool-result-store.js` (new, B0.4),
`src/cli/index.js`, `src/cli/components.js`, `scripts/heap-analyze.js` (new, B0.1),
`src/config.js` (B0.6). ~600-800 lines. Largest group by a wide margin.

**Verification:** E2E #4 run on same 378-task catalog, ONLY after B0.7
conformance gate passes. Target: 4 workers finish inside 48 h (vs 189 h
serial). Taskboard shows 4 in-flight rows. No workspace git conflicts.
heap.jsonl shows flat RSS throughout. No OOM. No silent parallelism
downgrade (if `KC_PARALLELISM_VERIFIED` unset, run aborts early with clear
message, not wastes $100 on a silent downgrade).

---

### Group C — Chunker / RAG infrastructure (port from AMC app)

Port `archive/pr_verify_app/backend/shared/` (chunker, classifier, keyword
search) to Node.js as native KC tools. These become the foundation for D1
(source-context auto-attach) and for every authored skill.

- **C1** — New tool `document_chunk`. Node port of
  `backend/shared/chunker.py`. Onion-peeler header-based hierarchical split,
  max 2000 tokens per leaf. Output: `BundleTree` JSON with `.outline()`,
  `.get(chunk_id)`, `.search(keywords)`, `.all_leaves()`. Cache at
  `<workspace>/cache/bundles/<sha256(files)>.json` — re-chunking the same
  bundle is free.
- **C2** — New tool `bundle_search`. Bigram (CJK 2-grams + English words)
  keyword index over a BundleTree. Input: keywords, optional chunk_id
  filter. Output: ranked (chunk_id, score, snippet) list. No embedding
  model required.
- **C3** — New tool `document_classify`. One-shot LLM classifier: reads
  file names + first ~5K chars of each file, calls worker LLM, returns
  `{product_type, report_type, confidence, reasoning, source}`. Keyword
  fallback when LLM fails. Result cached per bundle hash.
- **C4** — ~~Extraction phase integration~~ **Moved to Group D** (2026-04-23,
  implementation-time scope adjustment). When extraction writes
  `rules/catalog.json`, each rule gets `source_chunk_ids: [...]` and
  `source_ref: "..."` back-refs. Coupled with D1 (skill_authoring
  context auto-attach) — back-refs with nothing that reads them is a
  half-wired state, so both land together. See the Group D section
  (new bullet D1b) for the consolidated plan.
- **C5** — ~~Applicability pre-filter~~ **Moved to Group D** (same
  adjustment as C4). Check overlap between `applicable_product_types` /
  `report_types` and bundle classification before dispatching a
  skill_authoring task; mark `not_applicable` and skip if no match.
  Natural home: D1's task-dispatch path where the filter actually
  runs. See Group D bullet D6 (renumbered) for the consolidated plan.

**Files:** `src/agent/tools/document-chunk.js` (new), `src/agent/tools/bundle-search.js`
(new), `src/agent/tools/document-classify.js` (new),
`src/agent/pipelines/extraction.js` (integrate C4),
`src/agent/engine.js` (register new tools). ~500-700 lines including tests.

**Reference files** (read-only, source material):
- `archive/pr_verify_app/backend/shared/chunker.py` — onion-peeler logic
- `archive/pr_verify_app/backend/shared/classifier.py` — classifier + fallback
- `archive/pr_verify_app/backend/shared/file_reader.py` — parser dispatch

---

### Group D — Skill system hardening

- **D1** (item 12) — Source-context auto-attach in skill_authoring task prompts.
  `src/agent/engine.js` task prompt assembly (~line 1018-1035): when dispatching
  a skill_authoring task, read `task.ruleId`, look up `source_chunk_ids` from
  catalog, fetch chunks via `BundleTree.get()`, build prompt:
  ```
  Rule R014: <NL description>
  Source: 信披办法 §15.2 (pages 23-24)
  <2000-token chunk text>
  Sibling rules in this section: R013, R015
  Task: author rule_skills/R014/check_r014.py and SKILL.md
  ```
  No tool call required — agent sees context in first message.
- **D1b** (absorbed from C4) — Extraction pipeline writes
  `source_chunk_ids: [...]` and `source_ref: "..."` back-refs into
  `rules/catalog.json` for every rule, using Group C's `bundle_search`
  over the cached BundleTree. The back-ref field is what D1 reads; they
  have to land together or D1 has nothing to read. Update
  `src/agent/rule-catalog-normalize.js` so the normalized schema carries
  the fields forward, and extend the extraction skill text so the LLM
  populates them when emitting rules.
- **D6** (absorbed from C5) — Applicability pre-filter at task dispatch.
  In `_createTasksForPhase` for `skill_authoring` (or inside the D1
  prompt assembly), for each rule check `applicable_product_types` /
  `report_types` overlap with the bundle classification (produced by
  Group C's `document_classify`, cached alongside the BundleTree). If
  no overlap, mark the rule `not_applicable` and skip task creation for
  it — consistent with AMC app behavior. Update the finalization phase
  (E1) coverage report to show "not applicable" rules separately.
- **D2** (item 9) — Soft granularity nudge + coverage audit.
  (a) System prompt for skill_authoring phase: "Prefer 1 rule = 1 skill dir.
  Group only when rules share evidence and logic (e.g. siblings from the same
  table of required fields)."
  (b) `src/agent/pipelines/skill-authoring.js` `exitCriteriaMet()`: count
  DISTINCT rule_ids covered via file-path regex (`check_r\d+\.py`,
  `check_r\d+_r\d+\.py`), not skills-authored count. Fails if any rule_id
  is missing.
  (c) Coverage report written by finalization phase (Group E1) lists which
  rule → which skill file.
- **D3** (item 13) — Skill tracing + phase-gating + validation.
  (a) Add `skill_invoked` event type in `src/agent/events.js`. `skill-loader.js`
  emits when an on-demand SKILL.md read happens.
  (b) Phase-gate skills: `_registerSkillsForPhase(phase)` — mirror
  `_registerToolsForPhase`. meta-meta skills always visible; skill-creator only
  in skill_authoring; workflow-creator only in distillation.
  (c) Skill validator: after skill_authoring task completes, run a validator
  that checks (i) SKILL.md exists, (ii) detect script is syntactically valid
  Python (ast.parse in sandbox_exec), (iii) expected entry points present.
  Validator failure routes task back to pending with "needs rewrite" note.
- **D4** (item 5) — "Samples may be a mix of correct and incorrect; KC is
  ground truth." Bake into the baseline system prompt built at
  `src/agent/engine.js` init, so it applies regardless of whether user
  customized AGENT.md.
- **D5** (was deferred **Nit 13**) — `evolution-loop` skill text: add exit
  condition "if iteration N+1 changes accuracy by <1%, stop and proceed to
  release." Pure skill-text edit to
  `template/skills/*/meta/evolution-loop/SKILL.md`. Prevents the
  observed v5→v12 over-iteration past "good enough."

**Files:** `src/agent/engine.js`, `src/agent/events.js`, `src/agent/skill-loader.js`,
`src/agent/pipelines/skill-authoring.js`, `src/agent/pipelines/extraction.js`
(D1b), `src/agent/rule-catalog-normalize.js` (D1b), `src/agent/task-manager.js`
(D6 applicability gate), `src/agent/skill-validator.js` (new),
`template/skills/*/meta-meta/*/SKILL.md` (prompt updates),
`template/skills/*/meta/evolution-loop/SKILL.md` (D5). ~350 lines (grew from
260 after absorbing C4+C5).

---

### Group E — Workspace outputs & reports

- **E1** (item 8) — New FINALIZATION phase as 7th phase. Add after PRODUCTION_QC
  in `src/agent/pipelines/index.js`. Responsibilities:
  (a) Reorganize `rule_skills/` to canonical layout: `rule_skills/<rule_id>/`
  with SKILL.md + detect script; when files are grouped (e.g. check_r002_r007),
  create symlinks/pointers from each rule_id dir to the grouped file.
  (b) Write `rule_skills/README.md` — coverage table, file inventory, entry
  point (`run_all_checks.py` usage).
  (c) Write `rule_skills/coverage_report.md` — each rule_id → skill file
  mapping, which are tested, which are flagged `not_applicable` from C5.
  (d) Final dashboard snapshot to `output/final_dashboard.html`.
  New pipeline file: `src/agent/pipelines/finalization.js`.
- **E2** (item 14) — Markdown reports at phase boundaries. Soft instruction
  in baseline system prompt: "At end of each phase, write a short markdown
  summary to `logs/phase_<name>_<timestamp>.md` with what was done, what's
  next, open questions." Not a tool; just a prompt-level nudge. User's
  explicit request: "soft instruction, not hard-coded."
- **E3** (was deferred **Bug 10** — workspace bloat on retries). Current
  behavior: a failed workflow retry writes to
  `output/distillation/14b_A/run_1/` subfolder, creating deeply nested
  directories. Expected: sibling files `14b_A.log` + `14b_A_v2.log` +
  `14b_A_v3.log` at the same level. Fix: `src/agent/tools/workflow-run.js`
  retry path + `src/agent/workspace.js` retry-output resolver — on
  collision, increment a `_vN` suffix on the file, don't nest. Finalization
  phase (E1) can then glob `*_v*.log` to present retry history.

**Files:** `src/agent/pipelines/finalization.js` (new),
`src/agent/pipelines/index.js`, `src/agent/engine.js` (baseline prompt),
`src/agent/tools/workflow-run.js`, `src/agent/workspace.js` (E3). ~230 lines.

---

### Group F — UX, guidance, polish

- **F1** (item 4) — Bilingual new-session guide + worker-LLM healthcheck.
  (a) `src/cli/components.js` WelcomeBanner: on new session, print a short
  multilingual guide with `请先告诉 KC "检查 bootstrap 状态并告诉我下一步该做什么"`
  and the `/rename` / `/resume` tips.
  (b) Bootstrap pipeline healthcheck: make ONE ping call to each configured
  TIER (worker LLM). On failure, prompt user in TUI: "Worker LLM tier1
  unreachable. Change provider/key/model, or use same provider as main
  agent?" Worker-LLM tool use remains restricted to DISTILLATION onward
  (already enforced in current code; confirmed in Group A7 adjacent).
- **F2** (item 3) — Input unlock + queue. `src/cli/index.js`: flip
  `InputPrompt` prop at line 565 — keep `isActive: true` always.
  On submit while streaming: push to existing queue (lines 54, 461-462).
  TUI shows a subtle "(N queued)" indicator bottom-right. Queue flushes
  FIFO into `runTurn` at lines 154-157. Reference: Claude Code's
  type-ahead pattern.
- **F3** (item 6) — Arrow key + history. `src/cli/components.js` InputPrompt:
  add cursor position state, left/right arrow handling. Up/down arrows
  navigate session input history when input empty; scroll lines when
  multiline. Session history lives in-memory (`inputHistoryRef`), flushed
  on `/clear` and on session end. Not persisted across sessions in v0.6.0
  (keep simple).
- **F4** (item 1) — Subagent limit. **No code change.** Research confirmed
  no hard cap exists; behavior is implicitly LLM-rate-limit-driven. Just
  document in DEV_LOG that this is intentional.
- **F5** (item 7) — Tool inventory via `/tools` slash command.
  `src/cli/index.js` handleSlashCommand: add `/tools` → lists all registered
  tools, which phase each is gated to, and current-phase availability.
  Surfaces the 19-tool inventory so users can see what they have.
  Clarifies: KC has no installable-tools system today (context7 search
  returned no matches). Document this decision explicitly.
- **F6** (item 15) — `/meme` easter egg. Full-screen Ink render of the
  lyrics + team credit. Press ESC or Enter to dismiss. Self-contained in a
  new `src/cli/meme.js` component. Do NOT add to `/help` listing (easter
  egg = hidden).
- **F7** (was deferred **Bug 6** — CTX status bar misleading peak numbers).
  Replace raw instantaneous token count in the TUI status bar with a
  30-second smoothed rolling average AND a separate peak indicator. Label
  each number as "estimated" (KC-computed) vs "API-reported" (from last
  provider response). `src/cli/index.js` CTX status computation +
  `src/cli/components.js` status bar render. v0.5.4 C.4.c soft-threshold
  hint already mitigated; this is the root-cause fix.
- **F8** (was deferred **TUI spinner race after /compact**). Observed
  ~18h into E2E #3: spinner disappeared while KC was mid-LLM-call because
  `/compact` finally-block fires `setSpinnerStatus(null)` BEFORE the next
  ralph-loop task's `streaming=true` re-triggers the spinner render.
  User perceives a dead TUI. Fix: `src/cli/index.js` — guard the
  `setSpinnerStatus(null)` in compact's finally with a check that
  `streamingRef.current === false` at call time; or use a dedicated
  per-task spinner state that naturally re-renders on next task entry.

**Files:** `src/cli/index.js`, `src/cli/components.js`,
`src/agent/pipelines/bootstrap.js` (healthcheck), `src/cli/meme.js` (new).
~240 lines.

---

### Group G — Release hygiene

- Update `DEV_LOG.md` with v0.6.0 entry — cover all 7 groups, credit E2E #3
  observations.
- Update `README.md` + `QUICKSTART.md` for new capabilities (parallelism flag,
  new tools, new phase).
- Update `docs/update_design_v5.md` — check off completed items 1-15, mark
  any deferred-to-v0.6.1.
- Bump `package.json` to 0.6.0, tag `v0.6.0`, `npm publish`.
- Verify `npm install -g kc-beta@0.6.0` lands the banner printing (A4)
  so the v0.3.2-ghost-install problem cannot recur.

---

## Implementation order & cadence

Per v3 doc discipline, implement one group, finish, verify, then move on:

1. **Group A** (small patches, ~1-2 days) — land first, de-risks everything.
2. **Group C** (chunker/RAG tools, ~3-4 days) — foundation for D1.
3. **Group B** (parallel ralph-loop, **~7-9 days** — B0 prereq + B1-B8).
   - **B0.1-B0.2** (~1 day): instrumentation + baseline serial measurement.
   - **B0.3-B0.5** (~2-3 days): fix the three candidate leak root causes.
   - **B0.7** (~1 day wall-clock of instrumented runs): conformance gate.
   - **B1-B8** (~3-4 days): parallel loop implementation.
   - Full E2E #4 at parallelism=4 is downstream of B0.7 passing.
4. **Group D** (skill hardening, ~3 days) — uses C's BundleTree.
5. **Group E** (finalization + reports, ~2 days) — uses D's coverage data.
6. **Group F** (UX polish, ~2-3 days) — can partially overlap with earlier
   groups but final wiring waits until others are stable.
7. **Group G** (release, ~1 day).

Total estimate: **~19-24 implementation days**, then **E2E #4 beta trial** of
~2 days wall-clock (target 48 h for 378 tasks at parallelism=4), then publish.
B0 prereq runs add ~$60-120 of LLM spend for heap verification; cheap insurance
vs. the $100+ risk of a full failed run.

Each group gets its own short plan file written to
`~/.claude/plans/please-read-the-project-swift-rossum.md` before implementation,
checklist ticked as items land, commit after each group.

---

## Critical files touched (summary)

**Engine core:** `src/agent/engine.js`, `src/agent/task-manager.js`,
`src/agent/events.js`, `src/agent/workspace.js`, `src/agent/llm-client.js`,
`src/agent/skill-loader.js`, `src/agent/skill-validator.js` (new).

**Pipelines:** `src/agent/pipelines/index.js`, `.../bootstrap.js`,
`.../extraction.js`, `.../skill-authoring.js`, `.../finalization.js` (new).

**New tools:** `src/agent/tools/document-chunk.js`, `.../bundle-search.js`,
`.../document-classify.js`. Modified: `.../document-parse.js`.

**CLI/TUI:** `src/cli/index.js`, `src/cli/components.js`,
`src/cli/meme.js` (new), `bin/kc-beta.js`.

**Config:** `src/providers.js`, `src/config.js`, `src/model-tiers.json`.

**Templates/docs:** `template/skills/*/meta-meta/*/SKILL.md`,
`template/AGENT.md`, `DEV_LOG.md`, `README.md`, `QUICKSTART.md`,
`docs/update_design_v5.md`.

---

## Verification — E2E #4 trial

**Pre-flight (gate — must pass before E2E #4 starts):**
- B0.7 conformance: `heap.jsonl` from 2 h serial post-fix run stays within
  ±10 % RSS. `heap.jsonl` from 4 h parallelism=2 run shows
  RSS(N=2) < 1.6 × RSS(N=1). `KC_PARALLELISM_VERIFIED=1` set in env.
- Without this gate, `--parallelism=4` silently clamps to 1 and E2E #4 is
  not meaningful. DO NOT skip.

After Group G lands AND pre-flight passes, run a full E2E against
`archive/test_data_3/`:

1. Fresh install: `npm install -g kc-beta@0.6.0`. Banner prints correct
   version + path (A4).
2. New session: welcome banner shows bilingual guide (F1a). User asks
   "check bootstrap status". Bootstrap auto-runs, healthcheck pings all
   tiers, reports status (F1b).
3. Invoke `document_classify` on the regulation bundle — returns
   `{product_type, report_type, confidence}` with LLM reasoning (C3).
4. Extraction phase: catalog.json written with `source_chunk_ids` per rule
   (C4).
5. Skill_authoring with `--parallelism=4`: taskboard shows 4 concurrent
   rows (B7). First task prompt in logs includes chunk text, not just rule NL
   (D1). Phase status bar transitions correctly when engine advances (A1).
6. Skill_validator rejects at least one malformed skill; task routes back
   to pending (D3c).
7. Finalization phase runs: `rule_skills/README.md`, `coverage_report.md`,
   canonical per-rule-id directory layout all present (E1).
8. Parallelism smoke test: user types "status?" mid-run, message appears
   in queue indicator, processed on next natural pause (F2).
9. 378 tasks complete inside 48h wall-clock. RSS stays <1GB. No workspace
   git conflicts. No session empty-response stall (A3).
10. `/meme` renders easter egg (F6). `/tools` lists 22 registered tools (F5).

**Success criteria:** all 10 points pass. Any miss blocks release until fixed.

---

## Coverage audit vs. update_design_v5.md

Every checkbox / bullet in the design doc is accounted for below. This is
what lets the release credibly close out v0.5.x:

| Source section | Item | Plan home |
|---|---|---|
| v0.5.6 patches | 0.5.6-1 phase_advance TUI | A1 |
| v0.5.6 patches | 0.5.6-2 contextLimit | A2 |
| v0.5.6 patches | 0.5.6-3 empty-response guard | A3 |
| v0.5.6 patches | 0.5.6-4 startup banner | A4 |
| v0.5.6 patches | 0.5.6-5 SSE buffer cap | A5 |
| v0.5.6 patches | 0.5.6-6 task-gen mismatch | A6 |
| Deferred Normal | Bug 6 CTX status bar | F7 |
| Deferred Normal | Bug 8 stream errors | A8 |
| Deferred Normal | Bug 9 sub-agent dedup | B8 |
| Deferred Normal | Bug 10 workspace bloat | E3 |
| Deferred Nits | Nit 13 evolution-loop exit | D5 |
| Deferred v0.5.4 arch | parallel ralph-loop | Group B |
| Deferred v0.5.4 Bug 5 | deprecate rule_catalog | **Out of scope** (below) |
| E2E #3 obs | memory_pressure latching | A9 |
| E2E #3 obs | TUI spinner race | F8 |
| E2E #3 obs | 2 tasks/hr too slow | Group B |
| E2E #3 obs | GLM-5.1 empty-response rate | A3 (instrumentation included) |
| User 15-item 1 | subagent limit | F4 (no code change, documented) |
| User 15-item 2 | phase control | A1 + A7 |
| User 15-item 3 | input lock | F2 |
| User 15-item 4 | session guide + worker LLM healthcheck | F1 |
| User 15-item 5 | samples may be incorrect | D4 |
| User 15-item 6 | arrow keys | F3 |
| User 15-item 7 | tools inventory | F5 |
| User 15-item 8 | workspace finalization | E1 |
| User 15-item 9 | rule granularity | D2 |
| User 15-item 10 | parser/chunker SOP | C1-C3 |
| User 15-item 11 | AMC app takeaways | C1-C3 + D1b + D6 (C4/C5 absorbed into D) |
| User 15-item 12 | rule NL → skill context | D1 + D1b |
| User 15-item 13 | skill loading + tracing | D3 |
| User 15-item 14 | MD reports at phase boundaries | E2 |
| User 15-item 15 | /meme easter egg | F6 |

No checkbox from the design doc is uncovered.

---

## Out of scope (explicitly)

- Multi-session dashboard / history UI beyond what `/sessions` already shows.
- Auth / rate limiting at CLI level (user is trusted).
- Rule catalog editing UI — catalog.json stays hand/LLM-editable.
- Persistent cross-session input history (F3) — in-memory only.
- Vector embeddings / reranker (item 10/11) — bigram keyword is enough
  for v0.6.0; revisit in v0.7.0 if AMC-app-equivalent accuracy is insufficient.
- Subagent hard cap (item 1) — intentionally unchanged; documented.
- Worker LLM *tool* gating change (already correct; only healthcheck added
  in F1b).
- **Deprecate `rule_catalog` tool in favor of `workspace_file`** (deferred
  v0.5.4 Bug 5 followup). Reason: doc itself framed this as "evaluate:
  keep rule_catalog as a thin CRUD wrapper, or remove and update skills to
  use workspace_file? Migration doc needed." The migration doc is itself
  out of scope for v0.6.0; revisit in v0.6.1 once chunker/RAG tools (C1-C3)
  have shaken out any remaining rule_catalog usage patterns.

---

## Open risks

1. **Parallel ralph-loop + shared workspace git auto-commit** (Group B5). If
   serialization is wrong, commits can race and the workspace git tree breaks.
   Mitigation: dedicated commit queue, tested with stress test before E2E #4.
2. **Chunker port accuracy** (Group C1). Node port must match Python output
   byte-for-byte on the same input, otherwise cached BundleTrees from Python
   tooling won't be compatible. Mitigation: conformance test suite — feed same
   PDF through both, assert chunk IDs identical.
3. ~~In-process async pool heap pressure~~ **Addressed at root by B0.1-B0.7**.
   Moved from "risk" to "explicit blocking prereq" — parallelism cannot turn
   on until heap.jsonl shows flat RSS under load. If we can't identify the
   leak via B0.2 instrumentation, v0.6.0 ships with parallelism still clamped
   to 1 (A-F groups still provide substantial value) rather than shipping
   an unsafe knob.
4. **Skill validator false-rejects** (D3c). Too-strict validator could
   infinite-loop tasks. Add attempt counter; escalate to user after 3 retries.
5. **Heap leak turns out to be upstream (Ink / React 19 / pdfjs)**. If
   B0.3-B0.5 don't flatten RSS, the leak may be in a dependency we can't
   patch. Fallback: clamp parallelism to 1 for v0.6.0, file upstream bug,
   revisit in v0.6.1 — **but** B0.6 guard ensures we never ship a broken
   parallel mode, and B0.1 instrumentation stays on so we keep gathering
   data for the fix.

---

*Drafted 2026-04-23. Sources: `docs/update_design_v5.md` (15-item list +
E2E #3 observations), three parallel Explore-agent codebase audits
(2026-04-23), user-locked decisions D1-D7 via AskUserQuestion rounds 1+2.*
