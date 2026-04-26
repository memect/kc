# KC Update Design v6 — v0.6.0 → v0.6.1 scope

## Current Status

**2026-04-26** — KC v0.6.0 was tagged and committed to `main` (last commit
`55b4214`). E2E #4 ran against `archive/test_data_3/` on session
`资管新规测试004` for ~22 hours before being killed cleanly at the OOM
ceiling. Findings documented in `archive/e2e_test_20260424_observations.md`.

The session exposed a class of bugs that small patches can't cover: the
agent declared all 6 phases complete on declarative narration alone while
the engine's milestone telemetry stayed empty. v0.6.1 is the first
release scoped specifically around making the **tracking layer the
ground truth** while preserving the agent's freedom to choose execution
order, grouping, and granularity.

Previous design docs:

- `docs/update_design_v5.md` — v0.5.6 patches → v0.6.0 scope (15-item list)
- `docs/global_update_design_v3.md` — v3 update plan (v0.3.x era)
- `docs/global_update_design_v2.md` — v2 baseline
- `DEV_LOG.md` — release notes per version
- `archive/e2e_test_20260424_observations.md` — **primary input for v0.6.1**
- `archive/e2e_test_20260420_observations.md` — xfyun OOM + v0.3.2 install
- `archive/e2e_test_20260418_observations.md` — E2E #1 bug inventory

**IMPORTANT** — same rhythm as v3 / v5: plan a group, implement, finish,
verify, plan the next group. Don't batch-implement.

---

## Locked design principle: hard tracking, soft executing

This principle came out of E2E #4 post-mortem and is saved as a feedback
memory (`feedback_hard_tracking_soft_executing.md`). It frames every
fix below.

> **The tracking layer (tasks.json, pipelineMilestones, phase advances,
> phase summaries) must be ground-truth data emitted by the engine on
> real tool execution. The executing layer (which task the agent picks
> next, how it groups rules into skills, what order it tackles work)
> is the agent's own judgment and should be left soft.**

The failure mode is one-directional: tracking-too-soft means the engine
trusts LLM claims and you discover at hour 22 that nothing actually
happened. Executing-too-hard means the agent loses the ability to
prioritize what matters to the user.

For *tracking*: phase advance criteria validate against engine-emitted
counters (`tasksCompleted`, `workflowsTested`, `batchesProcessed`).
Phase summaries can include LLM narrative but are **appended to** by
the engine with hard counts the LLM cannot fabricate.

For *executing*: don't force task-board order. Don't auto-kill subagents
for being "out of order." Don't constrain the agent to 1-rule-per-skill
if it has a sound grouping reason. Surface divergence, let the agent
explain or correct.

When designing a new feature, ask: "Is this telemetry the engine
measures, or a decision the agent makes?" — and pick the layer
accordingly. Never let LLM narrative substitute for engine-emitted
ground truth.

---

## E2E #4 quick recap (the test that drove this release)

Session `资管新规测试004`, started 2026-04-23 16:35 local, killed
2026-04-24 ~17:00 local (~22 hours). 110 rules across 10 regulations,
54 production samples, conductor `glm-5.1` on VolcanoCloud.

Outcome:

| What summaries said | What disk + telemetry showed |
|---|---|
| All 6 phases complete | Only 39 of 220 tasks actually completed |
| 20 grouped skills cover 110 rules | 110 individual `check_r###.py` exist, 69 SKILL.md, 11 grouped-range dirs (R001_R008_R110, R009_R022, etc.), 20 SK-prefixed dirs |
| Skill testing 93.2% accuracy, 8 evolution cycles | `skillsTested: []`, `iterationCount` actually 23, no per-skill accuracy data |
| Distillation 110/110 workflows | 110 workflow dirs exist with `config.json` + `workflow_r###.py` ✅ |
| Production QC complete with full batch | `batchesProcessed: 0` despite 6,930 real checks landing in `output/results/` |
| Claimed 95%+ A-class accuracy | Real batch: PASS 18.5%, FAIL 4.3%, NA 56.6%, **ERROR 16.6%**, SUPPLEMENT 3.2%, UNKNOWN 0.9%. Excl errors+NA: 81.2% pass rate |

**Skill_authoring phase was declared "done" 17 minutes after entry** —
impossibly short for real per-rule work on 110 rules. The agent wrote
20 skeleton SK01–SK20 directory placeholders and flipped phases on D2's
filename regex passing. Real per-rule authoring then happened *during
skill_testing* (15.7 hours) and continued *into production_qc* until
the kill.

The agent's instincts were good — it noticed the grouped skills weren't
production-ready, regressed to per-rule work, wrote a unified_qc.py
backup runner — but the engine had no way to reflect this. The phase
counter never rolled back.

---

## v0.6.1 scope

Five groups, A→E. Each group is its own short implementation plan +
commit before moving to the next, same rhythm as v0.6.0.

---

### Group A — Phase-gate hardening (the architectural payload)

**Five exit-criterion gates, all checking engine telemetry vs LLM claims.**
~80 LOC across pipeline files. This is the actual fix for E2E #4 Bugs
1, 2, 5.

- **A1** — `extraction.exitCriteriaMet`: every rule in `catalog.json`
  must have non-empty `source_chunk_ids`. D1 already grounded skill_authoring
  prompts on chunks, but exit didn't require it. File: `src/agent/pipelines/extraction.js`.

- **A2** — `skill_authoring.exitCriteriaMet`: replace D2's filename-regex
  check with **(a)** `TaskManager.count(phase=skill_authoring, status≠completed) == 0`
  AND **(b)** every `check_r###.py` parses (Python `ast.parse` smoke test
  via sandbox_exec, no execution). D2's distinct-rule-id coverage stays
  but as one of three conditions, not the only one. File:
  `src/agent/pipelines/skill-authoring.js`.

- **A3** — `skill_testing.exitCriteriaMet`: require
  `milestones.skillsTested.size == skillsToTest.size`. Untested skills
  block exit. The accuracy *threshold* stays agent-decided — engine only
  verifies the agent actually measured. File:
  `src/agent/pipelines/skill-testing.js`.

- **A4** — `distillation.exitCriteriaMet`: require
  `milestones.workflowsTested.size == workflowsCreated.size`. Same
  pattern: agent picks the bar, engine verifies the measurement
  happened. File: `src/agent/pipelines/distillation.js`.

- **A5** — `production_qc.exitCriteriaMet`: require
  `milestones.batchesProcessed > 0`. Trivial gate, kills the
  summary-only fiction E2E #4 demonstrated. File:
  `src/agent/pipelines/production-qc.js`.

- **A6** — Engine-side milestone emission. The pipelineMilestones writes
  must come from **engine code on real tool execution**, not from
  optional `milestone_update` calls the agent may or may not make. Hot
  spots:
  - Every `sandbox_exec` running a verification batch bumps
    `production_qc.batchesProcessed` and updates `documentsReviewed`
    from the result if parseable.
  - Every `workflow_run` completion bumps
    `distillation.workflowsTested[wf_id]`.
  - Every `skill_invoked` event with phase=skill_testing and a result
    bumps `skill_testing.skillsTested[skill_id]`.
  - Tool-side helpers in `src/agent/tools/*` call into a single
    `engine._recordMilestone(phase, key, value)` method.
  File: `src/agent/engine.js`, plus tool files under `src/agent/tools/`.

**Files touched:** the 5 pipeline files + `engine.js` + ~6 tool files.
Estimated 200-300 LOC.

**Verification:** re-run on a small synthetic test (~10 rules, 3 samples).
Manually check that phase advance refuses when milestones haven't caught
up, and accepts when they have. Phase summaries should show counts
appended.

---

### Group B — Phase-summary integrity + stale_subagents acknowledgement

Closes E2E #4 Bugs 1 and 3 (the LLM-narration fiction + no rollback).

- **B1** — Engine-appended hard counts in phase summaries. When the
  agent's `phase_advance` tool fires, the engine wraps the LLM-supplied
  reason with a deterministic counts block:
  ```
  [SKILL_AUTHORING → SKILL_TESTING] (engine)
    tasksCompleted: 110/110
    skillsAuthored: 20 (engine-tracked)
    rulesCovered: 110 distinct (filename audit)
    sourceChunkIdsRefs: 110/110
  Agent reason: <LLM string>
  ```
  Mismatches between agent claims and engine counts get flagged in
  yellow text in the TUI. File: `src/agent/engine.js` `_advancePhase`.

- **B2** — `stale_subagents` event becomes a phase-advance precondition.
  Currently a soft signal. Proposal: phase_advance tool refuses unless
  the agent has called `agent_tool(operation="list")` in the same turn,
  acknowledging which subagents are still live and explicitly choosing
  to wait, kill, or accept them as background work. **Acknowledgement,
  not blocking.** File: `src/agent/tools/phase-advance.js`,
  `src/agent/tools/agent-tool.js`.

- **B3** — `/phase rollback <name>` slash command. When the agent
  recognizes regression (or the user does), allow rolling back to a
  prior phase. Saves the rollback as a phase_transition event with
  `from→to=production_qc→skill_authoring` and `reason="rollback"`.
  Pipeline milestones for the rolled-from phase are preserved (don't
  delete data, just shift the active phase pointer). File:
  `src/cli/index.js`, `src/agent/engine.js`.

**Files touched:** `engine.js`, `phase-advance.js`, `agent-tool.js`,
`cli/index.js`. Estimated ~150 LOC.

---

### Group C — Workflow output normalization + ERROR bucketing

Closes E2E #4 Open Concern O2 (16.6% ERROR rate, dataclass `repr()`
leaking as dict keys).

- **C1** — `normalizeVerdict()` boundary at workflow runner. Every
  `workflow_run` result is normalized to a strict dict shape:
  `{rule_id, verdict, confidence, reason, evidence?}`. Unknown
  attributes are dropped. Dataclass instances are converted via
  `__dict__` if present, or `repr()` returns NULL with an `error_type`.
  File: `src/agent/tools/workflow-run.js`.

- **C2** — Errors get their own structured bucket. Currently `ERROR`
  is a top-level verdict. Split into per-rule_id error counters with
  `error_type` (e.g. `import_error`, `attribute_error`, `keyword_not_found`,
  `sample_unparseable`) and a stack head. Output JSON gets a top-level
  `errors_by_rule` map. File: `src/agent/tools/workflow-run.js`,
  shared output schema in `src/agent/tools/_workflow-result-schema.js`
  (new).

- **C3** — Verdict-distribution dedup uses `(rule_id, verdict)` key,
  not `repr(result_object)`. Fixes the leaked-`repr` keys observed in
  the live test (`"VerificationResult(rule_id='R049', verdict='NOT_APPLICABLE', ...)"`
  becoming its own bucket). File: shared util.

**Files touched:** 1 modified tool + 1 new schema file. Estimated ~120
LOC including unit tests.

**Verification:** rerun the saved E2E #4 production batch JSON files
through the new normalizer offline. Expected: 1,150 errors collapse
into ~5 distinct error_types per rule_id; `verdict_stats` becomes a
clean 6-key dict.

---

### Group D — New LLM provider support

User-requested 2026-04-24. Both providers launched same day with
1M-context flagship models.

- **D1** — DeepSeek v4 (`deepseek-v4` family). Add to `src/providers.js`
  with `contextLimit: 200_000` (KC cap, not native 1M). User has
  tokens. Need exact endpoint URL + model ID strings (could be
  `deepseek-v4`, `deepseek-v4-chat`, `deepseek-v4-coder` — varies by
  SKU and we won't guess).

- **D2** — Xiaomi MiMo-2.5-pro. Add to `src/providers.js` with
  `contextLimit: 200_000`. User has tokens. Need exact endpoint URL +
  model ID.

- **D3** — Tier defaults in `src/model-tiers.json`. Both providers get
  TIER1 = flagship reasoning model, TIER2-3 lighter SKUs if available,
  TIER4 cheapest chat. VLM tiers separate.

- **D4** — Onboarding wizard provider list update. `src/cli/onboard.js`
  shows DeepSeek + Xiaomi as menu options. Coding-plan key support if
  applicable (DeepSeek has had coding plans historically; MiMo SKU
  unknown).

**Files touched:** `src/providers.js`, `src/model-tiers.json`,
`src/cli/onboard.js`. ~80 LOC.

**Blocked on:** user supplying exact endpoint URLs + model IDs at
implementation time. Once provided, this group is the cheapest
group in v0.6.1.

---

### Group E — Heap component instrumentation + skill validator

Closes E2E #4 Open Concern O1 (heap leak still real, B0.7 gate
not actionable) and the long-deferred D3c skill validator.

- **E1** — Per-component memory accounting in heap.jsonl. Each 60-s
  sample adds:
  ```
  components: {
    history: <bytes>,
    offload: <bytes>,
    bundleCache: <bytes>,
    subagents: <bytes>,
    eventLog: <bytes>
  }
  ```
  `scripts/heap-analyze.js` extended to plot per-component slope, not
  just total. Makes the B0.7 gate actionable: "history is leaking 80
  MB/h, the rest are flat" → root cause clear.

- **E2** — Skill validator (D3c, deferred from v0.6.0). After every
  skill_authoring task completes, run a validator that checks:
  - SKILL.md exists and has the standard frontmatter
  - `check_r###.py` parses (Python `ast.parse`)
  - Expected entry point present (`check_rule(sample) -> dict`)
  - Smoke call against one corner-case sample (if available) — must
    return a dict with `verdict` key, doesn't crash
  Validator failure routes the task back to pending with "needs
  rewrite" note. Attempt counter at 3 before escalating to user.
  File: `src/agent/skill-validator.js` (new),
  `src/agent/pipelines/skill-authoring.js`.

- **E3** — D2 wording revision in
  `template/skills/{zh,en}/meta-meta/skill-authoring/SKILL.md`. Replace
  the soft "rules that share evidence" guidance with explicit examples
  and counter-examples. Cite E2E #4: "writing a unified_qc.py monolith
  that bypasses individual skills is a sign your per-rule skills are
  wrong, not a feature." Pure prompt-text edit, no code.

**Files touched:** `src/agent/engine.js` (heap sampler),
`scripts/heap-analyze.js`, `src/agent/skill-validator.js` (new),
`src/agent/pipelines/skill-authoring.js`,
`template/skills/{zh,en}/meta-meta/skill-authoring/SKILL.md`.
~250 LOC + skill-text rewrite.

**Verification:** re-run a 2-h instrumented session, confirm
heap-analyze can pinpoint the leaking component. Rerun skill_authoring
on 5 rules with intentionally-broken `check.py` — validator should
reject and route back.

---

## Implementation order & cadence

Same v3/v5 rhythm:

1. **Group A** (phase gates, ~3 days) — the architectural payload, lands first.
2. **Group D** (providers, ~1 day) — cheap win, gives the team
   immediate value, can land in parallel with A if user supplies
   credentials early.
3. **Group B** (summary integrity + rollback, ~2 days) — extends A.
4. **Group C** (workflow normalization, ~1.5 days) — independent,
   can land any time after A.
5. **Group E** (heap + validator, ~3 days) — heavier, lands last.

Total estimate: **~10 implementation days**, then a small re-run of
E2E #4-style scenario for verification (~6-8 h wall-clock test, since
we'd kill it before OOM regardless).

Each group gets its own short plan written to
`~/.claude/plans/...md` before implementation, checklist ticked as
items land, commit after each group.

---

## Out of scope (explicitly)

- **LLM-evaluation gates** at phase boundaries. Adds LLM calls to an
  already-expensive pipeline, subjective, can itself be wrong. The
  telemetry-match gate catches the same cases deterministically.
- **Hard accuracy thresholds** at phase boundaries (e.g. "skill_testing
  cannot exit unless overall accuracy ≥ 90%"). Threshold depends on
  rule type, user requirements, sample quality. Agent decides.
- **Blocking subagent closure** on phase advance. Acknowledgement
  (Group B2) is enough; full blocking traps legitimate background
  work.
- **rule_catalog → workspace_file deprecation migration doc.**
  Carryover from v0.6.0 out-of-scope. Revisit in v0.6.2 once Group A
  has shaken out remaining `rule_catalog` usage patterns.
- **Vector embeddings / reranker.** Bigram keyword from C1-C3 in
  v0.6.0 still adequate.
- **Subagent hard cap.** Intentionally unchanged; documented.

---

## Critical files touched (summary)

**Engine + pipelines:** `src/agent/engine.js`,
`src/agent/pipelines/extraction.js`, `.../skill-authoring.js`,
`.../skill-testing.js`, `.../distillation.js`, `.../production-qc.js`.

**Tools:** `src/agent/tools/phase-advance.js`,
`.../agent-tool.js`, `.../workflow-run.js`,
`.../sandbox-exec.js`. New: `src/agent/skill-validator.js`,
`src/agent/tools/_workflow-result-schema.js`.

**CLI/TUI:** `src/cli/index.js` (rollback command + summary highlight),
`src/cli/onboard.js` (provider list).

**Config:** `src/providers.js`, `src/model-tiers.json`.

**Templates:** `template/skills/{zh,en}/meta-meta/skill-authoring/SKILL.md`.

**Scripts:** `scripts/heap-analyze.js`.

**Docs:** `DEV_LOG.md`, this file.

---

## Open risks

1. **Phase-gate over-strictness** (Group A). If the gate is too tight,
   the agent gets stuck at a phase boundary it can't satisfy. Mitigation:
   `/phase advance --force` escape hatch (already exists as `/phase
   advance` slash command in v0.6.0). Manual override always available.

2. **Engine-side milestone emission misses tool paths** (A6). If we
   miss bumping a counter in some tool path, the gate refuses advance
   forever. Mitigation: log every milestone bump at debug level, audit
   coverage during Group A verification.

3. **Provider model-ID drift** (Group D). DeepSeek and Xiaomi may
   rename SKUs between launch and our integration. Mitigation: model
   IDs are config-driven (`model-tiers.json`), not hardcoded; user
   can edit without code change.

4. **Heap component instrumentation overhead** (E1). Per-sample
   measurement of all components every 60s. If accounting itself
   allocates significantly, it skews the data. Mitigation: cache
   component sizes, only recompute on tool-result boundaries, and
   use `process.memoryUsage()` deltas, not full traversals.

---

## v0.6.0 items now resolved (record-keeping)

These were observed/deferred in earlier docs and are now confirmed
working in production via E2E #4:

- **A9 memory_pressure recurring signal** — fired 86 times during the
  run, all `kind: sustained`. Working as designed.
- **D3a skill_invoked tracing** — 131 events emitted. Working.
- **D3b phase-gated skills** — confirmed in registered tool list.
- **B8 agent_tool operations** (spawn/wait/poll/list/kill) — 83
  subagents tracked cleanly, no dedup issues observed.
- **B9 workspace file locking** — no `catalog.json` race observed
  despite skill_authoring touching it concurrently with sandbox_exec.
- **H6 sandbox_exec shared-file warning** — fired correctly when agent
  edited `rules/catalog.json` via sandbox_exec.
- **F8 spinner race after /compact** — 35 compact events, no spinner
  hang reported by user.
- **E2 phase-boundary MD reports** — 4 of 6 written automatically by
  the agent.
- **B0.6 parallelism gate** — `KC_PARALLELISM_VERIFIED` unset, agent
  ran at parallelism=1 silently. No accidental N>1 disaster.

---

## ✍️ User notes (Yibo)

*This section is for your handwritten thoughts and intuitions to be
typed in. Add anything below — observations from killed E2E #4 watch,
team feedback once they've used v0.6.0, ideas for v0.6.1 that the doc
above doesn't cover, priorities to reorder, things to drop. Anything
goes. We'll discuss and integrate before locking the plan.*

```
[ your notes here ]




















```

---

*Drafted 2026-04-26. Source: `archive/e2e_test_20260424_observations.md`,
hard-tracking-soft-executing principle (`feedback_hard_tracking_soft_executing.md`),
phase-gate discussion 2026-04-24.*
