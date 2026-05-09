---
name: work-decomposition
description: Decide how to decompose the rule set into TaskBoard tasks during rule_extraction → skill_authoring transition. Covers ordering methodologies (difficulty-first / Shannon–Huffman, breadth-first, depth-first, binary partition), grouping rules (when to bundle multiple rules into one task vs. keep separate), three-axis difficulty estimation, and how to write PATTERNS.md project memory that stays useful across the run. Use when entering rule_extraction, when entering skill_authoring, or whenever the TaskBoard feels wrong and you want to re-decompose.
---

# Work Decomposition

KC's main agent is the conductor. The conductor decides what work to do next — and that decision is upstream of every other choice that follows. Wrong decomposition makes the rest of the run expensive: if rules are processed in the wrong order, the agent re-designs the same shape three times. If unrelated rules are bundled into one skill, the resulting check.py becomes the unified-runner anti-pattern from E2E #4. If related rules are split across separate skills, the agent re-derives the shared chunker logic 17 times.

This skill is the conductor's playbook for that decision. It ships under `meta-meta/` because work decomposition is a system-level discipline, not a per-rule technique. The complementary `task-decomposition` skill (also under `meta-meta/`) covers the *internal* structure of one rule's check — locate, extract, normalize, judge, comment. This skill covers how the rule **set** should be split into TaskBoard items.

## When to use this skill

- **Entering rule_extraction.** Read the regulation, decompose into rules, then decide how those rules will be ordered and grouped before declaring the phase done. Coverage audit + chunk refs are downstream of these decisions.
- **Entering skill_authoring.** TaskBoard is empty (engine no longer auto-populates per-rule tasks). Read the rule list from `describeState`, decide grouping + order, then call `TaskCreate` for each unit of work.
- **Mid-run re-decomposition.** If the TaskBoard feels wrong (rules accumulating in the wrong order, an obviously-bundled pair across two tasks), stop adding work and re-decompose. The cost of pausing 5 minutes to re-plan is recovered within 2 rules of better-shaped work.

## Locked principles

1. **Hard tracking, soft executing.** The engine derives milestones from disk facts (`rule_skills/<id>/SKILL.md`, `check_*.py`, `workflows/<id>/...`) regardless of how you grouped your tasks. Coverage is engine-verified; grouping is your call. You cannot bypass the floor by clever task naming, but the floor doesn't dictate task shape.
2. **The hardest rule contains the most information.** Hard rules force the chunker, classifier, verdict shape, and worker LLM tier you'll need. Easy rules can compile down to a subset of that machinery cheaply. Encode the hard cases first; let the easy cases inherit.
3. **PATTERNS.md is the load-bearing memory.** Without an accumulating reference, every rule starts from a blank slate and you re-design the same shape repeatedly. With it, work compounds.

---

## Ordering methodologies

Pick one explicitly and write it into your first PATTERNS.md entry. "I'm going Shannon–Huffman because R028's multi-party verdict shape will dictate the chunker for everyone else" is a valid decision; "I started at the top of catalog.json and kept going" is not — it's just absence of decision.

### Shannon–Huffman (difficulty-first) — recommended default

Process the **hardest** rule first. Use the chunker, verdict shape, and worker tier that hard rule demands as the design floor. Process subsequent rules in descending difficulty, each one a degenerate case of the machinery already built.

**When to pick:** the rule set has uneven complexity and you suspect a few hard rules will dictate the shape (almost always true for compliance / regulatory work). E2E #5 GLM accidentally followed this path and produced 0.6% ERROR on real LLM-driven workflows; DS started bottom-up and shipped 78% NOT_APPLICABLE.

**Why "Huffman" not "Shannon" for the analogy:** Huffman builds optimal prefix codes by processing low-frequency symbols first. KC's analogue is the high-cost-per-rule, low-frequency rules — the R028s that dominate the design space even though there are few of them. Touch them first. The easy rules inherit the framework cheaply.

**The ordering compiler-design parallel:** don't optimize the common case until you've handled the worst case correctly. The common case being fast doesn't matter if the worst case requires a redesign.

### Breadth-first (round-robin)

Process every rule to a shallow depth (skill skeleton + first regex pass), then go back and deepen each one. Useful when:

- The full set's quality matters more than per-rule depth (e.g., you need a coverage report fast)
- You don't yet know which rules are hard
- You're piloting a new methodology and want to validate the pipeline shape across many rules cheaply

**Trap:** you may declare rule_extraction done with shallow skills that never deepen. Worse than depth-first because the gate appears satisfied from coverage alone.

### Depth-first (one rule at a time, fully done)

Process rule 1 to completion (SKILL.md + check.py + tests passing) before touching rule 2. Useful when:

- Rules are largely independent (rare in compliance work)
- The conductor model has small context and re-loading shape between rules is cheap
- You're proving the end-to-end pipeline before scaling

**Trap:** the first rule's shape gets locked in; refactoring after rule 5 means rewriting 1-4. Combine with PATTERNS.md to mitigate.

### Binary partition

Split the rule set into two halves on a meaningful axis (public/private products, document type, regulation chapter), then recurse. Useful when:

- The split axis is structural (e.g., banking rules vs trust rules) — you can build separate tools per partition
- Some partitions can be skipped entirely (D6 applicability filter says "not applicable for this corpus")

**Trap:** premature partitioning when the axis isn't real. The agent commits to two tools that turn out to need a shared base. Validate the split with 2-3 rules per side before committing.

### "Easiest first" — what NOT to default to

Tempting because it builds confidence and ships something visible quickly. Do not default to it for regulatory rule sets — the easy rules teach you nothing transferable about the hard ones, and the framework crystallizes around the wrong shape. Use it only when you're piloting tooling on a brand-new project and need to prove the pipeline can produce ANY output before sizing the real work.

---

## Grouping rules

The default is **one rule per task → one rule per skill directory**. This keeps coverage measurable and the TaskBoard clear. Group only when grouping reduces total work without coupling unrelated concerns.

### When to bundle

Bundle multiple rules into a single task (and a single check_r###_r###.py file) when ALL of:

- The rules share the same source chunk(s) — looking at the same paragraph of the same regulation
- They share the same input format (e.g., a required-fields table)
- The judgment logic for one rule is a substring or close variant of the next
- A single failure typically implies multiple failures (you can't pass R013 if R015 fails)

Example: R013 / R015 / R017 all check that a specific table on page 3 of the report contains certain mandatory fields. Same chunk, same parse, same verdict shape. Bundle as `check_r013_r015_r017.py` and create a single task: `TaskCreate({id: "R013-R015-R017-skill_authoring", title: "R013/R015/R017 — required-fields table", phase: "skill_authoring"})`. The engine's filesystem-derived milestones recognize the grouped check.py and credit all three rule_ids.

### When to keep separate

Keep separate when ANY of:

- Rules cite different regulation chapters — even if conceptually related (e.g., R013 disclosure-content and R028 custodian-responsibility — both about reports, but different chapters / different evidence chains)
- Rules need different worker LLM tiers (R005 needs a flagship for nuanced judgment, R001 is regex)
- Rules apply to different document types (one applies only to public-fund reports, another only to private-fund reports)
- One rule's failure mode is a specific failure mode of another (don't bundle parent + child rules — the child's check redundantly re-runs the parent's)

The v0.6.2 D2 anti-pattern wording captures the failure case clearly:
> If you find yourself writing a unified_qc.py-style monolith that bypasses individual skills, your per-rule skills are wrong. Fix them, don't replace them.

That came from E2E #4 where one conductor wrote a 2,400-line `unified_qc.py` that ran all rules at once. It produced 1,150 ERROR verdicts (16.6%) because every rule's failure cascaded into every other rule's verdict. Per-rule skills are KC's unit of granularity for a reason.

### Anti-pattern: stub check.py + real workflow.py

Do NOT make `rule_skills/<id>/check.py` a stub that defers to
`workflows/<id>/workflow.py`. KC's intent: SKILL.md + check.py is the
**canonical** verification. workflow.py is the **distilled, cheaper**
form (regex baseline + LLM fallback). The relationship is
skill → workflow, not workflow → skill.

❌ DON'T:
```python
# rule_skills/R001/check.py — STUB, real logic elsewhere
def check(text):
    rule_ids = re.findall(r"R\d{3}", load_skill())
    return {rid: {"pass": None, "method": "stub",
                  "note": "to be implemented later"} for rid in rule_ids}
# real verification logic only in workflows/R001/workflow_v1.py
```

✅ DO:
```python
# rule_skills/R001/check.py — canonical verification
def check(text):
    matches = re.findall(r"...", text)  # actual rule logic
    return {"rule_id": "R001", "passed": bool(matches),
            "evidence": matches[:3], "method": "regex"}

# workflows/R001/workflow_v1.py — distilled, cheaper form
def run(text, llm_fn=None):
    result = check(text)             # baseline from skill
    if not result["passed"] and llm_fn:
        result = llm_verify(text, llm_fn)  # escalate on fail
    return result
```

Why it matters: distillation phase consumers (release tool, run.py
harness) load workflow.py. If check.py is a stub, the skill's
methodology (SKILL.md) becomes documentation-only and the
verification logic is scattered across N workflow files. Future
iterations of the skill (changes to regulation interpretation, edge
cases discovered in production) need a single canonical place to
update — the skill — not N workflows that have drifted independently.

E2E #6 v070 surfaced this pattern (DS bundled-skill check.py files
all returned `{"pass": null, "method": "stub"}` deferring to
workflows/). v0.7.1 added this anti-pattern explicitly.

E2E #7 v071 showed the teaching prevented the stub anti-pattern in
both conductors (no `{"pass": null}` patterns in either run), but
**DS still inverted the canonical-vs-distilled relationship**: DS's
6 thematic skill folders had SKILL.md only (no check.py), with the
real verification code living in `workflows/<skill>/check.py`. The
absence of stubs is good; the inversion is not — editing a rule then
requires touching both SKILL.md (the doc) and the workflow check.py
(the code). Single source of truth is lost.

GLM v071 by contrast landed the canonical pattern: 97/97 skills had
both SKILL.md AND a real `check.py` (median 143 LOC of regex +
applicability logic), and `workflows/<id>/workflow_v1.py` was a
50-line thin wrapper that imported and called it:

```python
# workflows/D01-01/workflow_v1.py — thin wrapper, 52 LOC
import importlib.util, json
from pathlib import Path

def run(doc_text: str, meta: dict = None) -> dict:
    check_path = Path(__file__).parent.parent.parent / "rule_skills" / "D01-01" / "check.py"
    spec = importlib.util.spec_from_file_location("check", check_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    result = mod.check(doc_text, meta)
    result["_workflow"] = "D01-01_v1"
    return result
```

This is the v0.7.2+ canonical pattern: workflow is a shim that
points at the skill's check.py. To iterate on a rule's verification,
edit `rule_skills/<id>/check.py`. The workflow doesn't change. v0.7.2
clarifies the teaching: avoid stubs AND keep the canonical
relationship (skill is canonical, workflow is distilled wrapper).

### Naming convention for grouped checks

When you do bundle, name the file with the explicit range:

- `check_r013_r015_r017.py` — three specific rules
- `check_r002_r007.py` — contiguous range (R002 through R007)
- `check_r013-r017.py` — alternative spelling, also accepted

The engine's filesystem-derived milestones parse these names and credit each constituent rule_id. The grouping is documentation as much as code organization — downstream consumers (workflow-run, dashboards, release tool) read the filename to know coverage.

---

## Difficulty estimation — three-axis triage

Before you commit to an order, score each extracted rule on three axes. One quick worker LLM call per rule (tier3 is sufficient — not a deep judgment) writes a `rules/difficulty.json` that the conductor then reads when deciding TaskBoard order.

### Axis 1 — Chain-of-thought depth

How many sequential judgments does the rule require? Count operations the agent has to chain together:

- 1: `text contains "industry-unified channel"` (regex)
- 2: classify product type, then check channel (two-step)
- 3+: classify product type, locate disclosure section, parse table, compare against another section's table (multi-step)

Score: 1 / 2 / 3+ on this axis.

### Axis 2 — Module count

How many distinct sub-checks does the rule encompass? A "module" is a logically separable predicate.

- 1: single predicate ("must mention channel A")
- 2-3: a small required-fields list ("must mention A, B, C, D")
- 4+: a large checklist or conditional branch ("if public fund, then channels X+Y; if private, then channel Z; in all cases also include the manager identity")

Score: 1 / 2-3 / 4+ on this axis.

### Axis 3 — Cross-rule interaction

Does the rule reference another rule, depend on its output, or have to resolve consistency with it?

- 0: standalone (most rules)
- 1: cross-references one other rule (e.g., R007 references R013's table existence)
- 2+: tightly coupled with multiple rules, requires consistency reasoning across them

Score: 0 / 1 / 2+ on this axis.

### Total difficulty

Sum the three axes (1+1+0 = 2 minimum, 3+3+2 = 8 maximum). Sort descending. The 2-3 highest are your design-floor cases — work them first.

For a 70-rule corpus, expect difficulty distribution roughly:
- 10-15 hard (sum 5-8)
- 30-40 medium (sum 3-4)
- 20-30 easy (sum 2)

Don't over-engineer the triage. It's a planning aid, not a contract. If during work you discover a rule scored 2 was actually a 6, update PATTERNS.md and re-sort the remaining queue.

---

## PATTERNS.md — project memory discipline

KC's main agent does not have continuous memory across phases. Every time the agent re-reads `describeState`, it sees the same rule list and the same milestones. Without an external accumulating reference, every rule's design starts from scratch.

`rules/PATTERNS.md` is that reference. The agent owns it (writes via `workspace_file`, not via any tool wrapper). The engine surfaces it in every system prompt of skill_authoring + skill_testing. Capped at ~5 KB so token cost stays trivial.

### What to write — patterns that transfer

A good PATTERNS.md entry captures something that will SAVE work on the next rule. Three legitimate categories:

✅ **Transferable shape** — a verdict shape, chunker granularity, or interface decision that subsequent rules will reuse.

```
R028 (custodian responsibility) needed multi-party verdict shape:
  { primary_party: PASS|FAIL, secondary_parties: [...], reasons: [...] }
Adopting as default for any rule with multiple liable entities.
Confirmed reusable on R029, R031.
```

✅ **Project-level constraint** — a fact about the corpus or environment that affects multiple rules.

```
Sample corpus has bilingual table headings (EN+ZH).
Chunker MUST split on the ZH heading boundary, not the EN one —
verified on 5 sample docs. Without this, R013 / R015 / R017 all
under-extract.
```

✅ **Anti-pattern with rationale** — a thing you tried, why it failed, what to do instead.

```
Tried tier4 for JSON-output verdicts → empty responses 80% of the time.
tier3 (Qwen3.5) hallucinates field names. Settled on tier2 (DeepSeek-V3.2)
for any structured-output rule. Tier1 reserved for verdict reasoning under
ambiguous evidence (R005, R024).
```

### What NOT to write — log-dump anti-patterns

These add token cost without adding decision value. Future-you reading PATTERNS.md is trying to figure out what to do, not reconstruct what already happened.

❌ **Completion log** — already in tasks.json + filesystem.

```
R001 done. R002 done. R003 partial pass. R004 done.
```

❌ **Tool history echo** — already in events.jsonl.

```
Called workspace_file to write check_R013.py. Then called sandbox_exec.
Then ran the result through worker_llm_call.
```

❌ **Filesystem-authoritative facts** — the engine derives these from disk.

```
Workflows live under workflows/R001_workflow.py. There are 28 of them.
```

❌ **Conversation summary** — neither agent nor user reads PATTERNS.md as narrative.

```
After discussing with the user, we decided to focus on banking rules first.
The user mentioned that trust products are out of scope.
```

If a project-level decision came out of conversation, write it as a constraint:

```
Trust products excluded from this run (D6 applicability NO).
Skip R078, R092, R104 — their skills exist as stubs only.
```

### When to update vs append

- **Append** when you discover something new and transferable.
- **Update an existing entry** when work on a later rule reveals a better abstraction. Don't lock yourself into the first hard rule's shape — JIT compilers recompile when profile data invalidates the original assumption; PATTERNS.md should evolve the same way.
- **Delete an entry** when you discover it was wrong. Mark the deletion with a brief rationale at the bottom of the file:

```
[DELETED 2026-04-29] "Always use tier1 for FAIL verdicts"
Why: R005 + R007 work fine on tier2; tier1 reserved for genuinely
ambiguous evidence cases only (3 rules across the set).
```

### Sizing

Keep PATTERNS.md under ~5 KB total. If it exceeds, prune the least-actionable entries (the ones that haven't influenced any decision in the last 5 rules). Memory is for what you're using, not what you've seen.

---

## Putting it together — opening sequence

When entering skill_authoring with an empty TaskBoard:

1. **Read `describeState`.** Look at the rule list, the milestones (rules with chunk refs / coverage audited), and any existing PATTERNS.md.
2. **If PATTERNS.md is empty:** spend ~2 turns deciding ordering methodology + first 3-5 patterns. Write PATTERNS.md as your first artifact, before any skill code.
3. **If `rules/difficulty.json` exists:** sort rules by difficulty descending. Group where appropriate per the rules above. Call `TaskCreate` for each unit.
4. **If `rules/difficulty.json` doesn't exist:** decide whether to spend the worker LLM calls to triage (almost always yes for a corpus of >20 rules). Run the triage step (one tier3 call per rule, batched in groups of 10 if you want), write `rules/difficulty.json`, then proceed to step 3.
5. **Pick the first task.** Work it to completion (skill + check + at least one local test). Update PATTERNS.md with whatever you learned. Move to the next task.
6. **At task ~5 and task ~10:** stop and re-read PATTERNS.md. If patterns suggest a refactor of earlier work, do it now (cheap) rather than later (expensive).

### Calling TaskCreate / TaskUpdate / TaskComplete

The engine registers three task-board tools (v0.7.3+):

- `TaskCreate({id, title, phase, ruleId?})` — adds a task to `tasks.json`. `id` must be unique within the session; pick a stable shape like `<rule_id>-<phase>` for per-rule tasks or `<group-name>-<phase>` for grouped / non-rule tasks. `phase` is the phase the task belongs to (current phase or a future phase you're pre-populating). `ruleId` is optional — set it for per-rule tasks so the engine can credit the rule_id in milestone derivation.
- `TaskUpdate({id, status?, summary?})` — updates a task's status to `pending` / `in_progress` / `completed` / `failed`, optionally with a short summary.
- `TaskComplete({id, summary?})` — sugar for `TaskUpdate({id, status:"completed", summary})`. Use this for the common path after finishing a unit of work.

After you call `TaskCreate` for your decomposition and exit the current turn, the Ralph loop pulls the next pending task and runs it. Finish the work, call `TaskComplete`, and the loop advances. If a task can't be completed (irrecoverable error), call `TaskUpdate({id, status:"failed", summary:"reason"})` so the queue moves on rather than blocking on the failed task.

Examples:

```
TaskCreate({ id: "R001-skill_authoring", title: "Author skill for R001",
             phase: "skill_authoring", ruleId: "R001" })

TaskCreate({ id: "trust-bundle-skill_authoring",
             title: "R013/R015/R017 — required-fields table",
             phase: "skill_authoring" })

TaskComplete({ id: "R001-skill_authoring",
               summary: "regex check passes 89/90; R001 done" })
```

### Persisted methodology — PATTERNS.md OR phase logs OR AGENT.md decisions

The principle: capture framework-level decisions to disk before each phase advance. The conversation will compact, agents will restart, the next phase will lose grounding. Whichever format you pick, write to disk — don't rely on conversation context that disappears.

Three formats, each defensible. Pick one and stick with it:

- **`rules/PATTERNS.md`** — concise, framework-only, updated as the project progresses. Best for greenfield projects with clear hypothesis-up-front structure. Capped at ~5 KB; entries are transferable shapes / project constraints / anti-patterns with rationale (see "What to write" above).

- **`logs/phase_<name>_complete.md` per phase** — incremental, captures what each phase produced + decisions made + what the next phase inherits. Best for iterative discovery work where the framework crystallizes mid-run. E2E #7 GLM used this pattern across 6 phase docs and an `evolution_summary_v1.2.md`; the methodology was captured even though PATTERNS.md was never written.

- **`AGENT.md` decisions section + domain notes** — narrative-style, living document of "what we know" and "why". Best for projects with rich domain context to capture (regulations, edge cases, thresholds, sample format distributions). E2E #7 GLM's AGENT.md included regulation enforcement dates, product type taxonomies, threshold values, and sample format counts — this is fine; it's a different idiom for the same goal.

What you should NOT do: skip persistence and rely only on the live conversation context. By the time you have N skills authored without any persisted methodology, you've made N implicit decisions about verdict shape, chunker boundaries, and worker tier. Each rule re-derives from scratch. Refactoring requires touching N files instead of one.

❌ "I'll capture insights when I have time."

✅ "Before each phase advance, write what I learned to whichever persistence file matches this project's idiom — even if it's tentative."

E2E history:
- E2E #6 v070 DS wrote PATTERNS.md only after a rollback. Per-skill decisions before that point had to be re-touched. v0.7.1 added "PATTERNS.md FIRST" reinforcement.
- E2E #7 v071 neither DS nor GLM wrote PATTERNS.md, but GLM wrote 6 rich phase-completion logs and a comprehensive AGENT.md — the methodology WAS captured, just in different files. v0.7.2 blesses the broader principle: persist before you advance, format flexible.

The engine's filesystem-derived milestones (Group A v0.7.0) verify coverage on disk regardless of how you split the work. The TaskBoard is your scratchpad; the disk is the contract; the persistence file is your project's memory.
