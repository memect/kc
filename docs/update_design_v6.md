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

## v0.6.4 deferred — skill loading mechanism & gating tightness

**Surfaced by E2E #5 audit (2026-04-28).** All three alive contestants (GLM, DeepSeek, Xiaomi MiMo) produced rule_skills/ outputs that violated KC's own meta-meta/skill-authoring spec in different ways: GLM had methodology-only markdown (no python), DS aggregated multiple rules per skill (D2 anti-pattern), XM put scripts under `scripts/` matching the spec but invisible to the v0.6.2 I2 validator. None used proper YAML frontmatter consistently.

### Current skill loading mechanism (`src/agent/skill-loader.js`)

- Skills under `template/skills/{en,zh}/{meta-meta,meta,skill-creator}/` — peer-level directories.
  - `meta-meta/` — system architecture skills: skill-authoring, rule-extraction, evolution-loop, version-control, ...
  - `meta/` — verification domain skills: compliance-judgment, entity-extraction, document-parsing, document-chunking, dashboard-reporting, ...
  - `skill-creator/` — Anthropic's official skill creation toolkit (full eval/iterate workflow).
- `PHASE_RELEVANT_SKILLS` map gates each skill to its relevant phases. `skill-creator: ["skill_authoring"]` is already scoped.
- **Progressive disclosure**: only skill `name + description` injected into the system prompt skill index. Full `SKILL.md` is read on-demand via `workspace_file`.
- **Soft filter**: agents CAN read any skill regardless of phase relevance — the gating just controls auto-listing.

### Why agents bypass skill-creator format despite gating

Even though skill-creator is correctly scoped to skill_authoring phase, all three E2E #5 sessions produced non-compliant skill artifacts. Reasons we can hypothesize:

1. **Generic description**: skill-creator's frontmatter description is "Create new skills, modify and improve existing skills..." — doesn't urgently signal "you MUST use this format right now."
2. **Progressive disclosure trade-off**: agents may grok the primary phase skill (`meta-meta/skill-authoring`) and skip reading the secondary skill-creator entirely. The gating index shows both, but the agent reads what it sees as primary.
3. **No engine compliance check**: nothing structurally enforces SKILL.md frontmatter, scripts/ presence, or per-rule granularity. The v0.6.2 I2 validator only checks parseability + function name.
4. **Visually peer-level layout** (skill-creator at same depth as meta/meta-meta) implies equal weight; agents prioritize what feels architecturally central.

### Two design options for v0.6.4

**Option G — `describeState` inline expansion (low risk, recommended first)**

Pipeline `describeState()` for skill_authoring inlines the Skill Folder Structure spec (from meta-meta/skill-authoring/SKILL.md) directly into the phase block:

```
## Phase: SKILL_AUTHORING
... existing exit criteria ...

### Required skill structure (per meta-meta/skill-authoring)
Each rule_skills/<rule-id>/ must contain:
  SKILL.md              — YAML frontmatter (name, description) + methodology
  scripts/check.py      — Deterministic verification logic
  references/regulation.md  — Verbatim regulation text (optional but recommended)

The SKILL.md frontmatter is REQUIRED:
  ---
  name: <lowercase-rule-id>
  description: <when to use this skill, ≥1 sentence>
  ---

If you're tempted to write a unified runner combining multiple rules
into one script: stop. Per-rule discipline matters for distillation.
```

Agent sees the spec in every system prompt of that phase. Doesn't change skill loading mechanism. Cheap to ship — pure prose addition to a method already called.

**Option H — engine-side compliance gate (medium risk, after G if needed)**

Extend the v0.6.2 I2 skill validator (`src/agent/skill-validator.js`) to enforce structural compliance:

- SKILL.md exists at skill root
- SKILL.md has YAML frontmatter with `name` and `description` fields
- One rule per skill directory unless filename declares grouping (`check_r013_r017.py`)
- Function inside check_r###.py is named `check_rule | verify | check_r###` (per task #83 loosening)

Failed checks listed by rule in describeState. The (post-#81 fix) forward gate refuses advance until violations fixed. Forces what the meta-meta spec demands.

**Recommendation**: ship Option G first because it's pure documentation injection with no behavior risk. Re-audit after G is in for a session — if agents still bypass the spec, escalate to Option H. Don't ship both at once: G alone may suffice and adds zero enforcement burden on KC's agility (per the user's "don't over-engineer for weak models" mandate).

### Should we also restrict skill-creator visibility further?

E2E #5 audit suggests skill-creator's mere presence in the index isn't accomplishing what we hoped. Options:

- **Keep current scoping** — skill-creator listed during skill_authoring as a secondary reference. Recommendation if Option G works.
- **Remove from auto-list, keep readable on-demand** — only `meta-meta/skill-authoring` shown by default; agent reads skill-creator only if explicitly directed. Could reduce confusion if agents mistake skill-creator for the primary spec.
- **Rename skill-creator to something more imperative** — e.g., `skill-iteration-toolkit` — to clarify it's about iterate/improve, not "create from scratch."

Defer this decision to post-Option-G observation.

---

## v0.6.4 deferred — difficulty-first rule ordering + PATTERNS.md project memory

**Surfaced from E2E #5 cross-session comparison (DS bottom-up regex sprawl vs GLM accidentally-top-down distillation iteration). Recorded from a `/btw` design conversation with the user during the run.**

### The Shannon/Huffman analogy

Huffman builds the optimal prefix-free code by processing the *least frequent* symbols first — but that's because the cost function is "minimize bits per message" and frequencies are known up front. KC's cost function is different (minimize total cognitive/code complexity across the rule set) and the difficulty distribution isn't known in advance. The underlying principle still holds: **let the structure of the hard cases dictate the encoding scheme, then let the easy cases inherit it cheaply.**

The deeper point connects to information theory: the hardest rule contains the most information about the rule space itself. R028 (托管职责 with multi-party logic) tells you what the chunker has to handle, what the classifier has to disambiguate, what the verdict shape has to support, what the worker LLM has to be capable of. If you can encode R028 cleanly, R001 (channel-name string match) falls out as a degenerate case of the same pipeline. The reverse isn't true — building R001 first teaches you nothing transferable about R028. The "改完的东西不能复用" failure mode is exactly the symptom of starting at low-information rules: every step's output is local, nothing accumulates.

### JIT vs interpreter framing

The bottom-up "from simple to complex" path is interpreter-like: every rule visits the parser fresh, every change ripples backward through everything already done, and the abstraction layer is the last thing to crystallize because you only see the right shape after touching everything. Top-down from the hardest is JIT: pay the cost of building the most general machinery once, on the case that actually demands it, and the easier cases compile down to a subset of that machinery for free.

There's a related principle from compiler design: don't optimize the common case until you've handled the worst case correctly. The common case being fast doesn't matter if the worst case requires a redesign.

### Empirical evidence from E2E #5

DS started simple — wrote 70 regex check scripts bottom-up — and ended up with a baseline where 78% of verdicts are NOT_APPLICABLE and the genuinely hard rules (R028, R017) ship with confidence < 0.5 flagged as "需要 LLM 辅助判断". The shape of the regex pipeline can't carry the hard cases. GLM, by accident more than design, spent 21 of its 22 hours in distillation iterating on workflow shape on a smaller set — and produced a real PASS/FAIL distribution with an actual 92% verification rate on 1,951 verdicts. The hard cases forced the better shape.

This isn't proof, but it's a non-trivial signal that bottom-up sprawl shipped cheaply-but-fragile, while iteration-first-on-shape (even accidentally) shipped expensively-but-substantively.

### Implementation — three pieces

The mechanism splits into difficulty estimation, scheduling, and accumulating reference knowledge.

**Difficulty estimation.** After `rule_extraction`, before `skill_authoring`, run a "rule difficulty triage" step where the conductor scores each extracted rule on three axes:

1. Chain-of-thought depth — how many sequential judgments
2. Module count — how many distinct sub-checks
3. Interaction with other rules — does it cross-reference R013, require external time data, etc.

One LLM call per rule, tier3 worker. Output: difficulty rank for the whole rule set. This becomes the canonical task ordering for `skill_authoring` and `skill_testing`.

**Scheduling.** Plug into `TaskManager.createRuleTasks(rules, phase)`. Today it creates tasks in extraction order. Change it to accept a difficulty-sorted rule list and create tasks in **descending difficulty**. Hard rules get worked on first, when context is fresh and the agent is willing to design carefully. Easy rules get processed last, ideally as variations of patterns already in memory.

**Reference knowledge — the load-bearing part.** After each hard rule is worked through, the agent writes a structured note to a project-scoped knowledge file — `rules/PATTERNS.md` — capturing the transferable shape:
- chunker granularity that worked
- verdict shape used
- worker LLM tier needed and why
- edge cases that broke the first attempt

This file gets included in skill_authoring system prompt for every subsequent rule. Easy rules, processed last, look at PATTERNS.md and write `check.py` by analogy rather than from scratch. KC's existing skill-loading mechanism (the meta-meta SKILL.md) is the natural place to wire this — add a project-scoped patterns block alongside the per-rule SKILL.md.

This is functionally a poor-man's RAG over project-internal pattern memory, but it doesn't need vectors — the file is small (one paragraph per pattern, maybe 20 patterns max for a 70-rule project), the agent reads it whole, and it's authored deliberately rather than scraped. The cost is one extra LLM call per hard rule to write the pattern note, plus the prompt-token cost of including PATTERNS.md in subsequent skill_authoring messages. Both negligible at the scale of a 20-hour KC run.

### Risks

**Difficulty ranking might be wrong.** If R028 is ranked hardest but R013 is actually the conceptual root, the agent designs the framework around R028's quirks and R013 doesn't fit cleanly. Mitigation: keep the patterns file append-only and revisable. When a later rule reveals a better abstraction, the agent updates the relevant pattern entry rather than locking the early framework in. JIT compilers do the same thing — they recompile when profile data invalidates the original assumption.

**Patterns memory could become noise** if the agent overfits to the first hard rule and writes too-specific patterns. Pilot on a small subset (10 rules) before rolling out at scale. Empirical signal to watch: do later (easier) rules land in fewer iterations than earlier rules, and does the variance in skill quality drop?

### Where this fits in the v0.6.4 backlog

Genuinely new — not just a fix to an existing pain point. Slots in alongside the skill-loading discipline cluster (#86) and naturally wants to land before any future E2E that tests rule-set quality. The difference between "70 regex skills, 78% NOT_APPLICABLE" (DS) and "70 well-shaped skills with shared abstractions" is exactly what difficulty-first ordering plus PATTERNS.md should produce.

Implementation is small (difficulty triage + sorted task creation + project-scoped patterns file). The philosophical argument from Shannon/Huffman generalizes: **the hardest case carries the most information about the encoding, so encode it first and let the rest inherit.**

---

## v0.6.4 deferred — thin harness / fat skills: agent owns TaskBoard + methodology lives in meta-meta skill

**Architectural follow-on to the difficulty-first proposal above.** The Shannon/Huffman piece spec'd *what* methodology should be applied. This section spec's *where it lives in KC's architecture* and what engine changes fall out. Surfaced from a discussion with the user (Yibo) on 2026-04-29.

### Design principle: agent decides decomposition, engine verifies coverage

KC's two ground-truth principles — "thin harness, fat skills" and "hard tracking, soft executing" — both say: push complexity into agent-readable knowledge (skills), keep engine-side enforcement narrow and disk-derived. The current TaskBoard auto-population violates this. Three corrections fall out.

### 1. TaskBoard ownership flips to the agent

Today `TaskManager.PER_RULE_PHASES = {skill_authoring, skill_testing}` and the engine auto-creates one task per rule at phase entry. That's the engine pre-deciding the unit of work, which is the opposite of fat-skills.

**Proposed change:**

- Empty out `PER_RULE_PHASES`. Engine stops creating per-rule tasks anywhere.
- `describeState()` surfaces the **rule list** plus **engine milestones** for the current phase. Agent reads, plans grouping, calls `TaskCreate` with whatever shape it judges right:
  - Single rule per task (today's behavior)
  - Multi-rule grouping when rules share evidence/chapter/judgment table (R013 / R015 / R017 example from D2 wording)
  - Non-rule decomposition for phases where rules aren't the unit (distillation: "build batch_runner → run baseline → write report"; production_qc: "sample → audit → report")
- Hard-tracking is preserved via the v0.6.4 filesystem-derived milestones (task #87). Engine still checks `rule_skills/R*/check_*.py` exists per rule on disk regardless of how the agent grouped its tasks. Coverage is engine-verified; grouping is agent-decided.

This makes the existing #97 (phase-skeleton tasks for non-per-rule phases) **obsolete in its current form** — the meta-meta skill teaches the agent to do this, the engine doesn't.

### 2. Methodology lives in a new meta-meta skill, not the system prompt

System prompt is the wrong home for ordering / grouping / memory methodology:

- **Always loaded** — burns tokens during distillation/QC when the methodology is already chosen and frozen
- **Hard to iterate** — every wording revision is a code change
- **Single-shot teaching** — agent reads it on first turn and may not return to it; a skill auto-injected at phase boundary stays salient and can be re-read on demand
- **Phase-scope unavailable** — system prompt can't easily gate "this guidance applies to rule_extraction + skill_authoring only"

**Proposed location:** new `template/skills/{zh,en}/meta-meta/work-decomposition/SKILL.md` (or `rule-prioritization`), gated via `PHASE_RELEVANT_SKILLS` to `rule_extraction` + `skill_authoring`.

**Skill contents:**

- **Ordering methodologies** — Shannon/Huffman (hardest first, encoding inherits), depth-first vs breadth-first, binary partition, "easiest first to validate the pipeline shape". With explicit when-to-use-which guidance and one-paragraph rationale per strategy.
- **Grouping rules** — concrete examples of when to bundle (shared chapters in source doc, shared input format like a required-fields table, identical judgment logic) vs split (different evidence chains, different worker LLM tiers needed, conceptually unrelated). Pull the v0.6.2 D2 wording examples into here as authoritative reference.
- **Difficulty estimation** — the three-axis triage (CoT depth, module count, cross-rule interactions) from the difficulty-first section above. Concrete scoring guidance, not abstract.
- **Memory discipline** — what goes in PATTERNS.md (transferable shapes, project-level constraints discovered during work, anti-patterns), what doesn't (completion logs, conversation summaries, file lists). Bad-example, good-example pairs in the body.

### 3. PATTERNS.md memory discipline is taught *inside* that skill, not as a separate concept

The skill owns the discipline of memory writing. Teaching what to write needs to live next to teaching how to decide ordering — same agent action, same moment in the loop. Splitting them risks the agent reading the methodology and forgetting the memory part, or writing memory entries without the methodology context that makes them transferable.

Examples to bake into the skill body:

```
✅ Good entry — transfers across rules:
   "R028 (托管职责) needed multi-party verdict shape: {primary_party: PASS|FAIL, ...}.
   Adopted as default for all rules with multiple liable entities."

✅ Good entry — project-level constraint:
   "This corpus has bilingual table headings (EN+ZH). Chunker must split on
   the ZH heading boundary, not the EN one — verified on 5 sample docs."

✅ Good entry — anti-pattern:
   "Tried tier4 for JSON-output verdicts → empty responses 80% of the time.
   tier3 hallucinates field names. Settled on tier2 for any structured output."

❌ Bad entry — log dump:
   "R001 done. R002 done. R003 partial pass."

❌ Bad entry — already in tool history:
   "Called workspace_file to write check_R013.py with the new regex."

❌ Bad entry — file paths (filesystem is authoritative):
   "Workflows live under workflows/R001_workflow.py"
```

The "what NOT to write" half is as important as the "what to write" half. Without it, PATTERNS.md becomes a log file and stops being useful as a knowledge layer the agent re-reads.

### Engine implications

Concrete code surface for v0.6.4:

- `src/agent/task-manager.js` — `PER_RULE_PHASES` set to empty (or feature-flagged off behind `KC_AGENT_OWNS_TASKBOARD=1` for staged rollout)
- `src/agent/engine.js` — `_phaseEntered()` no longer calls `createRuleTasks`. `describeState()` for skill_authoring / skill_testing surfaces the rule list explicitly so the agent can read and decompose.
- `src/agent/skill-loader.js` — `PHASE_RELEVANT_SKILLS` adds `work-decomposition` to `rule_extraction` + `skill_authoring`.
- `template/skills/{zh,en}/meta-meta/work-decomposition/SKILL.md` — new skill, full body per section 2 above.
- `src/agent/pipelines/skill-authoring.js` + `skill-testing.js` — `exitCriteriaMet` no longer relies on TaskManager phase-task counts (those won't exist). Switch entirely to filesystem-derived parity (task #87).
- `src/agent/pipelines/initializer.js` (or new pipeline) — surfaces PATTERNS.md as a project-scoped reference in describeState whenever the file exists. Doesn't write it; the agent owns the file.

### The tradeoff to flag

**More freedom widens the strong/weak conductor gap.** E2E #5 evidence: GLM did spontaneous worker-tier exploration (a good agent decision); DS shortcut to regex-only (cheap-but-narrow agent decision). With agent-owned tasking and methodology-via-skill, KC becomes more capability-sensitive, not less. Strong conductors will produce well-grouped tasks and lean useful PATTERNS.md entries. Weak conductors will produce flat per-rule tasks and noise-filled memory.

**Mitigation: hard-tracking is the floor.** Regardless of how the agent decomposes, the v0.6.4 filesystem-derived milestone layer (#87) verifies that every rule has its artifacts on disk. A weak conductor's bad grouping fails the gate; user sees missing milestones in `/status`; force-bypass logs flag the gap honestly. The principle is consistent: **agent decides shape, engine verifies coverage.**

### Where this fits in the v0.6.4 backlog

This is the synthesis section that ties together:
- #87 (filesystem-derived milestones) — the hard-tracking floor that makes agent freedom safe
- #86 (skill-loading discipline) — the mechanism the new meta-meta skill plugs into
- #97 (phase-skeleton tasks) — obsoleted by this change; the skill teaches the agent to write them
- v0.6.4 difficulty-first section above — the methodology this skill teaches
- v0.6.4 release tool layout convention (#98) — same shape: agent invents, engine should validate-via-disk-not-instrumentation

Implementation order: ship #87 first (hard floor), then the meta-meta skill + TaskManager change (agent freedom on top of the floor). Don't ship the freedom without the floor — that's where E2E #5's force-bypass epidemic came from.

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

---

# Static Bug Audit — 2026-04-28

Three parallel `Explore` subagents performed a read-only static review of
the codebase on `main` (no git diff scope; whole-tree). Scopes were
non-overlapping:

- **Agent core** — `src/agent/{engine,llm-client,retry,session-state,context-window,task-manager,skill-loader,message-utils}.js`, `src/agent/tools/*.js`
- **Pipelines** — `src/agent/pipelines/*.js`
- **CLI + config** — `src/cli/*.js`, `src/config.js`, `src/providers.js`, `src/model-tiers.json`

Findings are bugs only — no stylistic nits, no proposed fixes. Severity
is the agents' assessment of failure-mode impact, not effort to fix.

**Totals: 31 findings — 3 critical, 9 high, 13 medium, 6 low.**

Triage recommendation: the 3 criticals plus the four exit-gate bugs
(`skill-testing.js:107`, `skill-authoring.js:238`, `production-qc.js:105`,
and the three `importState` length-compare bugs) are the highest-leverage
to address — they are precisely the class of failure that lets bad work
slip through phase boundaries silently, which is the v0.6.1 thesis.

---

## Critical (3)

### C1 — `src/agent/engine.js:2164` — Worker-pool `Promise.race` leaves dangling promises

`Promise.race()` discards losers without cleanup. When `eventArrival` wins,
the corresponding `workerCompletion` promise never resolves — its chain
hangs indefinitely. On the next loop iteration a new `workerCompletion` is
built from `inFlight.values()`, potentially including stale promises from
earlier iterations.

**Failure scenario.** Parallel task loop with frequent events: event wins
race → loop continues → same worker slot is reused with a new task → old
worker eventually completes and resolves with the *old* taskId/subId
pair. Loop processes it as the new task → wrong task marked done, real
task never completes.

### C2 — `src/agent/pipelines/skill-testing.js:107` — Exit gate allows skill failures

```js
return Object.keys(this.skillsTested).length >= total
    && this.skillsPassing.length >= total * this._accuracyThreshold;
```

The second clause multiplies `total` by `_accuracyThreshold` (default
~0.9) instead of asserting that *every tested skill* passes the
threshold. With 10 skills and threshold 0.9, only 9 need pass for the
gate to fire. The intent (per the comment in the file) is "all skills
passing" — the math is wrong.

**Failure scenario.** Phase advances out of skill-testing while ~10% of
skills are still failing. Downstream phases (distillation, production-QC)
inherit broken skills as if they were validated.

### C3 — `src/cli/components.js:92-104` — `StatusBar` mutates refs during render

```js
samplesRef.current.push(value);   // line 98
peakRef.current = Math.max(...);  // line 99 / 103
```

Mutations happen inside the function body of the render — outside any
`useEffect` or event handler. React may invoke renders multiple times
(StrictMode, concurrent rendering, suspense replay).

**Failure scenario.** During a replayed render the same value is pushed
to `samples` twice, or `peak` is bumped against a stale comparison.
Context-smoothing and peak readouts drift away from reality. Hard to
notice, hard to reproduce — exactly the bug class that hides in TUIs.

---

## High (9)

### H1 — `src/agent/engine.js:2144-2149` — Tracked-promise wrapping doesn't catch synchronous throws

The `.then` wrapper converts rejection into a resolved `{ ok: false }`,
but if `entry.promise` rejects *before* the `.then` is attached (e.g.
synchronous throw in the worker body), the rejection escapes as an
`UnhandledPromiseRejectionWarning` — terminating the process under
strict Node settings.

### H2 — `src/agent/engine.js:840-876` — `resume()` calls `history._save?.()` without await

`resume()` is `async`, but the history save is fire-and-forget. Resume
returns and the first turn can mutate history before the save lands → the
slow save then overwrites the new turn's mutations with the pre-resume
snapshot. Classic write-after-write race on session state.

### H3 — `src/agent/workspace.js:252` — `withSyncFileLock` is path-traversal-unsafe

```js
const lockPath = path.join(this.path, `${relPath}.lock`);
```

The async sibling `withFileLock` calls `this.resolvePath(relPath)`. The
sync version concatenates raw input. A caller passing `relPath =
"../../shared.json"` writes a lockfile outside the workspace root. Cross-
session contamination becomes possible.

### H4 — `src/agent/pipelines/skill-authoring.js:238` — Exit gate accepts bare `scripts/` dirs

`skillsWithScripts` is populated when a `scripts/` subdirectory exists
(line 71) — *not* when actual `check_r###.py` files are present. The exit
gate fires when 50% of authored skills have a `scripts/` dir, regardless
of whether any check exists in it. (The 50% threshold itself is also
suspicious — should be 100% per the D2 criterion the file references.)

### H5 — `src/agent/pipelines/production-qc.js:105` — Vacuous-truth flips `monitoringPhase` to "stable"

```js
Object.values(this.accuracyByRule).every(a => a >= this._accuracyThreshold)
```

On an empty object `every()` returns `true`. If accuracyByRule fails to
parse from QC output, the phase silently flips to "stable" with zero
data. Combined with `batchesProcessed > 0` (line 145) this is enough to
satisfy `exitCriteriaMet` — production-QC exits with no actual QC.

### H6 — `src/cli/index.js:57` — `showWelcome` never set `false`

`showWelcome` is initialized `true` and there is no caller of
`setShowWelcome(false)`. The welcome banner renders on every frame for
the entire session — dead permanent screen real estate.

### H7 — `src/cli/index.js:435-481` — `/compact` handler spawns unawaited async IIFE

The slash-command handler returns immediately while the async IIFE runs
in the background. There is no top-level `.catch` on the floating
promise. If `engine.compact()` rejects after the handler returns, the
rejection is unhandled.

### H8 — `src/cli/index.js:540-564` — `/resume` same pattern + ref race

Same async-IIFE-without-await issue as H7, plus the handler mutates
`engineRef.current` without synchronization. Two `/resume` invocations in
quick succession can cross-assign the ref, leaving one engine orphaned
and another doubly-referenced.

### H9 — `src/config.js:27` — `loadEnvFile` does unprotected `readFileSync`

`existsSync` gates the read, but the read itself has no try/catch. If
`.env` exists but is unreadable (permission denied, is a directory,
encoding error, transient FS issue), the function throws instead of
returning `{}` — and config bootstrap dies before the CLI is up.

---

## Medium (13)

### M1 — `src/agent/engine.js:2092` + `2088-2093` — Worker-pool labels collide

```js
const workerLabel = `pool${[...inFlight.keys()].length}`;
```

Computed before the new task is inserted into `inFlight`. Across
iterations of the dispatch loop, multiple claims see the same `inFlight`
size and get the same label — duplicate `pool0` / `pool1` strings in
logs and event records.

### M2 — `src/agent/engine.js:1037-1066` — Stream cleanup unreliable on error path

`for await (const chunk of stream)` is correct, but if a `yield` inside
the loop throws, the loop exits with the stream half-consumed. The
finally in `llm-client.js:220` calls `.cancel()` — native Node Readables
don't always honor that. TCP connection can leak.

### M3 — `src/agent/engine.js:1210` — Tool throw swallows context

When `toolRegistry.execute()` throws (rather than returning a
ToolResult), the outer `try` at 1323 catches it but the tool name, input
args, and turn number are not in the error record. Generic error in
eventLog → diagnostic dead end.

### M4 — `src/agent/engine.js:1383` — Pipeline exception auto-advances phase

```js
try { criteriaMet = !!fromPipeline?.exitCriteriaMet?.(); }
catch { criteriaMet = true; }
```

Catching → `true` is the *worst* default for a phase-gate predicate. A
buggy pipeline that throws during exit-criteria evaluation silently
advances. Should be `false` (don't advance on uncertainty) — and the
exception should be logged, not swallowed.

### M5 — `src/agent/engine.js:1076` — Streaming chunk not null-checked

`chunk.choices?.[0]?.delta` protects the nested path but not `chunk`
itself. A null/undefined chunk from a malformed SSE frame throws
`Cannot read property 'choices' of null` — crashes the streaming
generator.

### M6 — `src/agent/engine.js:696-750` — `compact()` not wrapped in try/catch by task loop

`_runTaskLoopSerial` awaits `compact()` without a guard. If summarization
LLM errors (which happens on every degraded provider) the task loop
crashes without marking the current task failed or yielding an error
event.

### M7 — `src/agent/llm-client.js:129` — Silent `JSON.parse` swallow on tool args

```js
try { input = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore */ }
```

When converting Anthropic tool_calls to OpenAI format, malformed JSON in
arguments silently degrades to `{}`. Tool then runs with empty args,
produces wrong output, agent has no signal that anything was lost.

### M8 — `src/agent/pipelines/distillation.js:43-48` — Phantom-passing workflow state across rescans

`_scanWorkflows` snapshots `engineWfTested`/`engineWfPassing` at line
47-48, rescans, then re-merges at 80-85. If a workflow file is deleted
or broken between sessions, the old "passing" entry survives the merge.
Exit gate sees a passing workflow that no longer exists.

### M9 — `src/agent/pipelines/initializer.js:81` — Silent `autoCommit?.()` chaining

`this._workspace.autoCommit?.("AGENT.md", "seed")` — if `autoCommit` is
not implemented on the workspace impl (subagent, alt workspace), the
call is a no-op and no error is surfaced. AGENT.md persists locally; the
agent thinks initialization committed; downstream phases assume a clean
seed commit that doesn't exist.

### M10–M12 — `importState` length-compare keeps stale state

Same pattern in three pipelines:

- `src/agent/pipelines/extraction.js:189-197`
- `src/agent/pipelines/skill-testing.js:144`
- `src/agent/pipelines/skill-authoring.js:298-300`

```js
if (Array.isArray(data.X) && data.X.length > this.X.length) {
  this.X = data.X;
}
```

The comparison is `>` — the persisted array only replaces the in-memory
array if it is *longer*. If entities are deleted between sessions, the
fresh scan returns a shorter list but is overridden by the longer
persisted list. Ghost rules / skills / authored-skills remain in the
exit-gate denominator forever.

### M13 — Worker-pool labeling non-determinism (companion to M1)

`engine.js:2088-2093` — even single-iteration calls to `dispatch()`
produce labels relative to current inFlight size, not to spawn order
across the session. Post-mortem reconstruction of which worker handled
which task is unreliable.

---

## Low (6)

### L1 — `src/agent/context-window.js:59-60` — `summaryBudget` can go negative

```js
const summaryBudget = budget - recentTokens - 500;
```

No clamp. If recent messages consume ~95% of budget, `summaryBudget` is
negative; the mechanical summary builder truncates to empty. Not a
crash, but the reserve is silently disabled.

### L2 — `src/agent/task-manager.js:51-62` — `updateTask` silent on missing id

`if (!task) return;` — caller cannot tell whether the update applied.
Subsequent `getTasks()` returns the old state and the caller proceeds on
a false premise.

### L3 — `src/agent/engine.js:2237` — `"skipped"` status accepted, never set

`_allCurrentPhaseTasksComplete` accepts `t.status === "skipped"` but
`TaskManager` exposes only `markDone()` / `markFailed()`. Either dead
branch or a missing `markSkipped()` API.

### L4 — `src/agent/task-manager.js:163-164` — Task IDs not validated

`id: \`${ruleId}-${phase}\`` — no validation that `ruleId` is filename-
safe. A rule id containing `/`, backticks, or shell metacharacters
becomes a task id that is later interpolated into paths and possibly
shell args.

### L5 — `src/cli/components.js:359` — `historyRef` grows unbounded

InputPrompt history is appended on every submission with no cap. Long
sessions accumulate every input forever. Not catastrophic, but a true
leak.

### L6 — `src/cli/index.js:799` — Signal handlers race with Ink unmount

After `instance.waitUntilExit()` returns, Ink is torn down. If SIGINT/
SIGTERM fire after that line (e.g. background task keeps process alive),
the handlers call `engine.saveState()` / `engine.stop()` against a
torn-down TUI / partially-quiesced engine. Inconsistent shutdown state.

---

## Methodology notes

- All three reviews were read-only — no edits, no fixes, no test runs.
- Severity assignments are the agents' own; the v0.6.1 maintainer should
  re-rank against the hard-tracking thesis. Several items currently
  marked Medium (M4, M10–M12) are arguably Critical *for v0.6.1
  specifically* because they are exit-gate failures.
- File line numbers are accurate as of `main` at `028431c`. They will
  drift as v0.6.1 patches land — re-locate by grep before fixing.

*Audit run 2026-04-28 via three parallel `Explore` subagents
(non-overlapping scopes). 21 modified files on `main` were in scope; the
audit covered the whole tree, not just the diff.*
