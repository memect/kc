---
name: e2e-audit
description: Audit a completed KC E2E test session — both the process (phase transitions, force-bypass count, tool usage, worker LLM behavior, memory profile) and the deliverables (rule catalog, coverage audit, skills, workflows, QC results, release artifacts). Triggers when the user asks to inspect/audit/review a finished bench session, compare two sessions, evaluate whether a version's expected wins landed, or grade output quality. Use proactively after any phrase like "DS finished", "GLM session done", "audit the run", "check what we got from this session", or when the user pastes a session summary and asks for thorough review. Do not skip this skill when the request is for a "quick look" — quick looks routinely miss the version-drift bugs and prompt-induced-vs-autonomous distinctions that this skill catches.
---

# KC E2E Audit

A skill for Claude (the auditor, not KC the agent under test) to evaluate a
completed KC E2E test session end-to-end. This is not yet a self-audit skill
for KC itself — see `references/future-self-audit.md` for that direction once
this version stabilizes.

## When this skill fires

Triggered scenarios:

- "DeepSeek/GLM session finished, please audit"
- "Compare this run to the v0.7.0 one"
- "Did v0.X.Y's [Group N] fix actually land?"
- User pastes a session's final summary or a phase narrative and asks for
  a thorough review of process + results
- Post-mortem on a session that drifted, hung, or surfaced a bug

The right output is a substance-audit markdown doc placed under
`archive/e2e_test_<DATE>_v<VERSION>_<conductor>_session_audit.md`, paralleling
prior runs' audit docs. The doc is the deliverable. Conversation summary
afterward should be ≤8 lines pointing at the headline findings.

## Why audits matter (and why a skim isn't enough)

Three failure modes recur across runs and are invisible to skimming:

1. **Stale narrative artifacts.** AGENT.md, manifest version strings, and
   summary docs reflect *some* point in the run, not the final state. A skim
   of "what the agent reported at the end" misses that AGENT.md says
   "all regex" while the actual manifest says "44 regex + 5 hybrid", and
   that the manifest itself reports `kc_beta_version: "0.5.2"` (hardcoded).

2. **Prompt-induced vs autonomous outcomes.** When the user nudges the agent
   mid-run, the resulting fix gets attributed to the agent unless you check
   the timestamps. Wrong attribution corrupts the version's scorecard.

3. **Forced advances with cosmetic compliance.** Engine accepts force=true
   and logs `forced=true`. The agent's natural tendency may be to force
   through a gate while *also* writing the artifact the gate wanted, just
   later. If you only check the deliverable's existence, you record a win
   that isn't really one. Always cross-reference the
   `phase_advance_refused` / `phase_misfit_hint` events against deliverable
   timestamps.

## Methodology

Work in this order. Each step has its own section below.

1. Locate workspace + grab session shape
2. Process trace from events.jsonl
3. Per-phase deliverable check (bootstrap → finalization)
4. Cross-cutting checks
5. Scorecard against version's expected wins
6. Synthesize the audit doc

Run as much in parallel as the data dependencies allow — most reads are
independent. Spawn an `Explore` subagent for any sub-tree that you'd otherwise
read more than 3 files from, to keep the main context lean.

## Step 1 — Locate workspace and session shape

KC writes per-session workspaces under `~/.kc_agent/<bench-label>/<id>/`.
The bench-label encodes conductor + version (e.g., `bench-deepseek-v071`),
and the `<id>` is a per-run hash directory.

```bash
ls -la ~/.kc_agent/bench-{conductor}-v{version}/
# then descend into the hash dir
ls -la ~/.kc_agent/bench-deepseek-v071/<hash>/
```

The hash directory is the workspace root for that session. From here:

- `session-state.json` — final phase, message count, compact count, tokens.
  Check `currentPhase`. If not `finalization`, the run didn't reach the end
  — flag this immediately.
- `logs/events.jsonl` — the canonical process trace. Always present.
- `AGENT.md` — agent's project narrative. Snapshot for staleness check.
- `rules/`, `rule_skills/`, `workflows/`, `output/`, `snapshots/` — the
  per-phase deliverable trees.
- `.env` — the worker tier configuration the session ran under.
- `.git` — workspace is a git repo; `git log --oneline` is a phase-narrative
  goldmine.

## Step 2 — Process trace from events.jsonl

The events log uses `type` (not `event`). Distinct types worth counting:
`phase_transition`, `phase_advance_refused`, `phase_misfit_hint`,
`memory_pressure`, `compact`, `tool_start`, `tool_result`, `assistant_message`,
`llm_start`, `user_message`, `turn_complete`, `skill_invoked`.

The first thing you want is the phase timeline:

```python
import json
for line in open(EVENTS_PATH):
    e = json.loads(line)
    if e["type"] == "phase_transition":
        d = e["data"]
        ts = e["ts"][:19]
        print(f"[{ts}] {d['from']:>20} -> {d['to']:<20} forced={d['forced']} reason={(d.get('reason') or '')[:80]}")
```

Then compute:

- **Force-bypass count** = transitions with `forced=true` ÷ total transitions.
  Compare against the previous run's ratio. The headline metric of
  "did the version actually reduce force-bypass?".
- **`phase_advance_refused` count + reasons** — these are the cases where
  the engine *did* refuse. Inspect their `engineCounts` field: empty
  engineCounts on a refusal suggests the source phase doesn't compute one
  (worth flagging as a Group 2c gap).
- **`phase_misfit_hint` count + content** — these are advisories, not
  refusals. Read the hint text and check whether the agent acted on it
  before/after/never. Cross-reference against deliverable timestamps.

For tools:

```python
from collections import Counter
tools = Counter()
for line in open(EVENTS_PATH):
    e = json.loads(line)
    if e["type"] == "tool_start":
        tools[e["data"].get("name","?")] += 1
# top 10 reveals what kind of work the agent did
```

Heavy `rule_catalog` use indicates rule organization work; `sandbox_exec`
heavy indicates real testing; `worker_llm_call` heavy indicates LLM-judgment
distillation.

For worker LLM calls specifically:

```python
empty = filled = 0
for line in open(EVENTS_PATH):
    e = json.loads(line)
    if e["type"] == "tool_result" and e["data"].get("name") == "worker_llm_call":
        out = e["data"].get("output","")
        try:
            parsed = json.loads(out) if isinstance(out, str) else out
            resp = parsed.get("response","") if isinstance(parsed, dict) else ""
            (filled, empty)[not resp] += 1
        except: pass
```

Empty responses on tier3/tier4 with Qwen3.5 models almost always mean the
thinking-model `reasoning_content` vs `content` issue — see
`archive/e2e_test_20260501_v071_observations.md` Observation 1. Don't write
this off as a failed call until you've checked the model id and tier.

For memory:

```python
for line in open(EVENTS_PATH):
    e = json.loads(line)
    if e["type"] == "memory_pressure":
        print(e["data"])
```

Heap > 1 GB is a regression flag (v0.7.0 E2/E1m budget-aware compact should
keep this well under). Compact count of 0 over multi-hour runs is fine if
context is large (DeepSeek 400K) but suspicious on shorter contexts.

## Step 3 — Per-phase deliverable check

Process tells you what happened. Deliverables tell you what survived.

### Bootstrap

- `AGENT.md` exists and was updated (check git log: `[bootstrap] update AGENT.md`)
- `.env` has TIER1-TIER4 populated
- `samples/` and `rules/` are linked or copied from the project test corpus

The deliverable for bootstrap is mostly the agent's situated understanding;
SKILL.md text is the audit anchor.

### Rule extraction

- `rules/catalog.json` — count rules; verify each has `source_ref`,
  `description`, `category`, `verification_type`, `priority`,
  `source_chunk_ids`. Empty `source_chunk_ids` arrays = chunk_refs not
  populated (Group 2a target).
- `rules/coverage_audit.md` — should be article-by-article with explicit
  reasoning for why uncovered articles were excluded. If it's just a
  one-paragraph stub, note as soft fail of Group 2b.
- `PATTERNS.md` (anywhere) — Group 3b reinforcement target. If absent,
  note the miss; check `logs/phase_*.md` to see if narrative was
  captured elsewhere instead.

### Skill authoring

- `rule_skills/<id>/` for 1:1-per-rule, OR thematically-grouped skill folders
  (`prohibited_content/`, `custodian_checks/` etc.). Either is defensible
  per the work-decomposition skill's guidance.
- For each skill folder: `SKILL.md` should have purpose, source-rule table,
  per-rule methodology with PASS/FAIL criteria, regex patterns where
  applicable, corner cases. Read at least one in full and skim the rest.
- `check.py` presence — Group 3a anti-pattern check:
  - Stub pattern `{"pass": null, "method": "stub"}` → ✗ caught the v0.7.0
    DS anti-pattern; v0.7.1 teaching aimed to prevent this
  - No check.py at all (skill is documentation-only) → check.py likely
    lives in `workflows/`. This is the "skill ↔ workflow inversion" —
    Group 3a teaching landed for stubs but not for the canonical/distilled
    relationship. Document it as partial.
  - Real check.py with regex / verification logic → win.

### Skill testing

- `output/*.json` for per-skill or per-batch test results. v0.7.1's Group 1a
  derivation reads anything with a `rule_id` field, `results` dict, or
  array-of-rule-objects. Inventory which artifacts the agent actually wrote
  and whether they matched the engine's expected paths.
- Cross-reference with the seeded violation cases in the test corpus
  (currently `archive/test_data_3_lite/samples/trust/三季度_含违规/` has
  3 known-violation files + 1 control). Did the agent's checks correctly
  flag the violations? False negative = check is too narrow. False positive
  on the control = check is too broad. Aim for honest reporting; don't fish
  for wins.

### Distillation

- `workflows/` tree — count R\*.json route files vs skill-grouped folders.
- Inspect at least one `workflows/<x>/check.py` for real implementation:
  imports, regex patterns, structured output dicts. Compare LOC vs SKILL.md
  line count (a 100-line SKILL.md and 5-line check.py is a stub-by-omission).
- Per-rule R\*.json routing files should specify `workflow`, `entry`,
  `function`, `tier`, `method`. Verify at least one matches a real file
  on disk.
- Hybrid signaling: search for `worker_llm_call` references in workflow code
  or a `judgment_llm/` folder. Pure-regex-only workflows are fine if all
  rules are deterministic, but for `verification_type: "judgment"` rules
  this is suspect — see DS v0.7.1 Appendix A in
  `archive/e2e_test_20260501_v071_ds_session_audit.md`.

### Production QC

- `output/qc_batch_results.json` is the canonical batch artifact. Schema
  varies but typically: top-level keys = doc paths, values = per-skill
  pass/failed/total/na/failures dicts plus per-doc metadata
  (`_custodian`, `_custodian_ok`, `_type`).
- Aggregate pass rate across all 6 skills × N docs. Compare against
  manifest's claimed accuracy.
- A skill with `total=0` across all docs but the same skill exists in
  the workflows tree is a router miss (e.g., custodian skill in DS v0.7.1).
  Real bug.
- Per-product-type breakdown — if QC ran on only 2 of 5 product types,
  note the scope limitation in the audit.

### Finalization / release

- `snapshots/release-<slug>/` directory created
- `git tag` shows `snap/release-<slug>` ✓
- `output/releases/<slug>/` populated. Read `manifest.json` carefully:
  - `label`, `slug`, `snapshot_tag`, `snapshot_commit`, `created_at`
  - `notes` — the agent-written release announcement. This should read
    like a real release note. If it's "v1.0 — release" with no detail,
    flag as thin.
  - `rules` — count vs catalog rule count. Subset is fine if explained.
  - `kc_beta_version` — known stale at "0.5.2" hardcoded in
    `engine.js:424`. Flag every time until the bug is fixed.
  - `fixtures` — sample doc names; these should appear in
    `<release>/fixtures/`.
  - `models` — tier1-tier4 model list mirrored from the workspace .env.
- `run.py` syntax check:
  ```python
  import ast; ast.parse(open(RUN_PY).read())
  ```
- `confidence_calibration.json` — often ships empty even when QC produced
  data. Flag.
- Two release dirs (e.g., `releases/v1/` next to `releases/v1-0/`) is a
  common scaffold-then-customize pattern. Note as cleanliness, not blocker.

## Step 4 — Cross-cutting checks

These cut across phases and are easy to miss when going phase-by-phase:

1. **AGENT.md staleness.** Compare the AGENT.md "Key Decisions" / "System
   Architecture" sections against the actual final manifest + workflow tree.
   Drift is normal-ish, but worth recording. Bonus: check `git log AGENT.md`
   to see when it was last touched relative to phase transitions.

2. **Hardcoded version strings.** Check whether release manifest's
   `kc_beta_version` matches the live `package.json` version. Pre-v0.7.2
   this was hardcoded `"0.5.2"` in `engine.js:424`; v0.7.2 lifted it to
   `src/util/kc-version.js`. Regression check: if a fresh release
   manifest still says `"0.5.2"`, the lift broke. See
   `references/snippets.md` "v0.7.2+ regression-check" for the one-shot.

   General principle: after each KC release that ships a bug fix,
   audit the corresponding artifact on the next E2E run. v0.7.2's
   five fixes (path traversal, version stamping, calibration auto-aggregate,
   template scaffold cleanup, bootstrap engineCounts) each have a 1-line
   verification check in the snippets file. Run them every audit until
   each is verified holding for 3+ consecutive runs, then promote to
   "expected behavior" rather than "regression-check".

3. **User intervention timeline.** Pull every `user_message` event from
   events.jsonl with timestamps. For each user prompt, check what changed
   in the workspace within the next 10 minutes (`git log --since`,
   tool calls, file modifications). Outcomes attributed to "the agent"
   that actually came from a user prompt should be reframed in the
   audit as prompt-induced. See DS v0.7.1 Appendix A as a worked example.

4. **Skill teaching landings.** For each Group X teaching change in the
   version, write one sentence: did the deliverable show evidence the
   teaching was internalized? Distinguish:
   - "Teaching prevented the anti-pattern" (e.g., no `{"pass": null, "method": "stub"}` in check.py)
   - "Teaching surfaced as advisory but the agent worked around it"
     (e.g., chunk_refs nudge fired, agent forced through, then populated
     chunk_refs anyway)
   - "Teaching didn't land" (e.g., PATTERNS.md never written)

5. **Engine signal effectiveness.** For each `phase_misfit_hint` and
   `phase_advance_refused`, check whether the agent acted on it. Count
   "advisories ignored", "advisories satisfied", "advisories satisfied
   late (after force)". If most advisories are ignored, the version's
   nudge-not-refuse approach isn't working as intended; consider
   reporting back to the engine team.

## Step 5 — Scorecard against version's expected wins

Each KC release has a "watch for" list in its release plan (see
`archive/e2e_test_<prior>_observations.md` and the release commit
messages — `git log v0.7.0..v0.7.1 --oneline`). Build a scorecard table:

```markdown
| Expectation | Result | Status |
|---|---|---|
| <Group X target> | <observed behavior> | ✅ Win | ⚠️ Partial | ❌ Miss | N/A |
```

Use ✅/⚠️/❌ for clarity even though emojis are otherwise discouraged —
this is a skill-internal status indicator, not user-facing prose. Keep
the rest of the audit doc plain.

Anti-pattern: don't grade your own work. If you wrote the version's
release plan, your scorecard will be biased toward "✅". Independence
matters. When in doubt, downgrade to ⚠️ Partial.

## Step 6 — Synthesize the audit doc

Output goes to `archive/e2e_test_<YYYYMMDD>_v<NNN>_<conductor>_session_audit.md`.

Structure:

```markdown
# E2E #<N> — <Conductor> v<NNN> Session Audit (Substance)

**Workspace**: `~/.kc_agent/bench-<conductor>-v<NNN>/<hash>/`
**Conductor**: <model id> (provider, ctx)
**Workers**: <pool>
**Tag**: v<NNN> (commit <hash>)
**Run window**: <start UTC> → <end UTC> (≈<duration>)
**Final phase reached**: <phase>

This is the substance audit: structure + content quality of the
deliverables, paired with the process trace.

---

## Summary verdict

<3-5 sentences. What worked. What didn't. The headline finding —
e.g., "Group 1a fix earned the one natural advance in the run".>

---

## 1 — Process trace
   Phase transitions table; engine signals (refused/misfit/memory/compact);
   tool top-10; worker LLM table; heap profile.

## 2 — Bootstrap & rule_extraction
   catalog.json structure & counts; coverage_audit quality;
   PATTERNS.md presence.

## 3 — Skill authoring
   Folder layout (1:1 vs grouped); SKILL.md content; check.py status
   (real / stub / absent); sample skill in detail.

## 4 — Skill testing
   Test artifacts; ground-truth check vs seeded violations;
   evolution narrative if present.

## 5 — Distillation
   Workflows tree; sample workflow code; routing manifests;
   hybrid vs pure-regex; AGENT.md drift.

## 6 — Production QC
   Aggregate pass/fail; per-product-type; per-skill column completeness;
   any router misses.

## 7 — Finalization & release
   Snapshot + git tag; release dir contents; manifest details
   (notes, rules count, fixtures, models, version field);
   run.py syntax check; calibration data.

## 8 — Scorecard against v<NNN> expectations
   Table per Step 5.

## 9 — Findings to act on
   ### Bugs (real, easy)
   ### Drift to think about (no immediate fix)
   ### Wins to keep

---

## Appendix A — <prompt-induced vs autonomous, if applicable>
   Timeline of any user intervention that materially changed the run's
   outcome. Worked example: DS v0.7.1's hybrid arch came from a 14:58
   user prompt, not autonomous emergence.
```

Length target: 400-700 lines. Less than 300 = thin. More than 800 = should
have used subagents to summarize sections.

## What to do when the run didn't finish

If `currentPhase` ≠ `finalization`, swap the audit doc structure to focus
on the drift point:

1. Last successful phase + its deliverables
2. Where the agent got stuck — read the last 50 events.jsonl entries +
   `phase_<phase>_*.md` files in `logs/`
3. Whether engine signals (refused, misfit, errors) preceded the drift
4. What the agent was trying to do when it stalled

Don't pad with phase audits for phases that were never entered. Do
include a forward-looking "if/when this run resumes" suggestion.

## Cross-session comparison

When auditing a parallel run pair (e.g., DS + GLM), each gets its own
`<conductor>_session_audit.md`. After both finish, write a combined
`session_audit.md` (no conductor suffix) that surfaces:

- Where the two converged on the same finding (likely a real signal)
- Where they diverged (model-specific tendency, e.g., DS regex-default,
  GLM thinking-model auto-engagement)
- Which version expectations were validated by both vs only one

Cross-comparison is where individual-conductor model traits become visible
relative to the harness's intent.

## Anti-patterns the auditor should avoid

1. **Skim-and-summarize.** The user can read `git log --oneline` themselves;
   the value of an audit is the synthesis across process + deliverables that
   only emerges from sitting with the data. If you find yourself writing a
   bullet list of phase docs without contradiction-checking, slow down.

2. **Generous grading.** You are not the agent's coach; you are the auditor.
   When in doubt between ✅ and ⚠️, choose ⚠️. The next version's plan
   depends on honest signal, not flattering signal.

3. **One-pass linear reading.** Always do one structural recon (tree + file
   counts) before reading any content. Otherwise you waste tokens reading
   things that aren't there.

4. **Forgetting to check timestamps.** Especially around user prompts and
   git commits. Outcomes are not autonomous unless the timeline says so.

5. **Letting the agent's own narrative frame the audit.** AGENT.md and
   evolution_summary docs are the agent's perspective. They go *into* the
   audit as data, not as the audit's organizing thesis.

## This skill is a living document

KC's engine, skill teaching, and tooling change between versions. The audit
methodology has to track those changes or it goes stale. After each audit,
ask: was anything in the run unfamiliar to this skill? Likely sources of
drift:

- **New event types** in `events.jsonl` — engine adds a new signal (e.g.,
  hypothetically `subagent_phase_misfit` or `worker_llm_thinking_strip`)
  and the type tally / process trace stops covering it. Update
  `references/event-schema.md` and the process-trace section.
- **New deliverable shapes** — agents start writing artifacts in new
  paths or new schemas (e.g., GLM v0.7.1's `output/results/skill_test/`
  one level deeper than Group 1a's traversal walks). Add to the
  per-phase deliverable check.
- **New v0.7.x Group teachings** — each release plan adds Group N items
  to the "watch for" list. Update Step 5 (scorecard) with the new
  expectations. The scorecard table format scales.
- **New cross-cutting bugs that recur** — when an audit finding shows up
  twice (e.g., `kc_beta_version: "0.5.2"` hardcoded, two release dirs
  coexist), promote it from "audit finding" to a fixed-pattern check in
  the cross-cutting section. Future audits should expect to find it
  pre-fixed; if they don't, the bug regressed.
- **New conductor model traits** — DS regex-default, GLM
  thinking-engagement-default, future model X with trait Y. The
  cross-session comparison section already captures this; just keep
  adding rows.
- **Methods we adopt in real audits** — if you find yourself repeatedly
  doing a check that isn't in the snippets file, that's a signal to
  extract it. After an audit, scan the conversation for "let me also
  check..." moments and add the durable ones to `references/snippets.md`.

The bar for adding to the skill: would the next auditor (future-me, or
the user-converted KC self-audit version) actually use this? If yes,
add it. If it's a one-off oddity from a single run, leave it in the
audit doc and don't pollute the methodology.

## See also

- `archive/e2e_test_<date>_v<version>_observations.md` — live observations
  during a run, pre-audit.
- `archive/e2e_test_<date>_v<version>_<conductor>_session_audit.md` —
  prior audits as templates and points of comparison.
- `archive/e2e_test_20260430_v070_observations.md` — the v0.7.0 audit that
  drove v0.7.1's plan; good worked example of audit → version-plan flow.
- `references/event-schema.md` — quick reference for events.jsonl types.
- `references/snippets.md` — reusable bash/python snippets used in audits.
- `references/future-self-audit.md` — direction for converting this skill
  into one KC can use to audit its own work in production_qc / finalization.
