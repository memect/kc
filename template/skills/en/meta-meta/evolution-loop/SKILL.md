---
name: evolution-loop
description: Drive continuous improvement of skills and workflows through the diagnose-classify-fix-retest cycle. Use after any testing round reveals failures, when production quality control flags issues, or when accuracy drops below thresholds. Covers failure analysis, distinguishing systemic issues from corner cases, deciding whether to rewrite or patch, and knowing when to stop iterating. The evolution loop is the heartbeat of the system. Also use when transitioning between lifecycle phases (skill testing, workflow testing, production monitoring).
---

# Evolution Loop

The evolution loop is what makes this system self-improving rather than static. Every failure is information. The question is always: what kind of failure is this, and what is the most efficient fix?

## The Loop

```
Test → Observe → Reflect → Diagnose → Classify → Fix → Re-test → Log
  ↑                                                              |
  └──────────────────────────────────────────────────────────────┘
```

Run this loop until one of:
- Accuracy meets the threshold in `.env` (SKILL_ACCURACY or WORKFLOW_ACCURACY, depending on the phase).
- MAX_ITERATIONS is reached (escalate to developer user).
- You determine that the remaining failures are irreducible given the current approach (escalate to developer user).
- Convergence criteria are met (see Convergence Tracking below).

## Step 1: Test

Run the skill or workflow on the relevant document set:
- During skill development: run on Samples/.
- During workflow testing: run on Samples/, compare to skill-based ground truth.
- During production: run on Input/ batches.

Record every result: pass/fail/missing/error, the extracted values, the confidence scores, and any comments.

## Step 2: Observe

Review the results holistically:
- What is the overall accuracy?
- Which rules are failing most?
- Are there patterns in the failures? Same section type? Same document format? Same kind of entity?
- Are there documents that fail multiple rules?

Do not just count. Understand.

### User-Reported Errors

When developer users or end users report errors on verification results, treat these corrections as ground truth. User-reported corrections override the coding agent's own quality judgments. In the evolution loop, prioritize diagnosing user-reported errors before agent-detected ones — they represent confirmed failures, not suspected ones.

Collect user error reports from the feedback mechanisms built into the dashboard (see `dashboard-reporting`). Each report should be converted into a test case and added to the regression set.

## Step 3: Reflect

Before diagnosing new failures, review what has already been tried. This prevents cycling through the same failed fixes.

Read the structured iteration logs from `logs/evolution/{rule_id}/`. Focus on:
- Which failure categories were identified in previous iterations.
- What fixes were attempted and their outcomes — did accuracy go up, down, or stay flat?
- Whether any fix was reverted due to regression.

**Anti-pattern detection**: If the current failures match a pattern that was already diagnosed and "fixed" in a prior iteration, the prior fix was insufficient. Escalate the approach — for example, from a prompt tweak to a logic rewrite, or from a logic rewrite to an architecture change. Do not try the same category of fix twice.

**Output**: Produce a brief iteration history summary to feed into the Diagnose step. This gives the diagnosis context about what NOT to try again. On the first iteration (no history), skip this step.

### Three Dimensions of Reflection

When reviewing failures, analyze them along three cross-cutting dimensions:

1. **Per-rule across documents**: Is a specific rule (e.g., R003) failing on a particular subset of documents? This reveals rule-specific weaknesses — perhaps the extraction prompt does not handle a particular document format.

2. **Per-document across rules**: Is a specific document type causing failures across multiple rules? This reveals document-level issues — perhaps a particular template has parsing problems that affect all downstream extraction.

3. **Global patterns**: Are there systemic correlations? For example:
   - Failures clustering on documents processed by a specific model tier.
   - Failures clustering on documents that went through a specific parser level.
   - Failures that only appear when document length exceeds a threshold.

Cross-referencing these dimensions often reveals root causes invisible from a single perspective. For example, "R003 fails on type-X documents" is a per-rule finding, but if type-X documents also cause R007 and R012 to fail, the real issue is the document type, not any individual rule.

## Step 4: Diagnose

For each failure, determine the root cause:
- **Parsing failure**: the document was not parsed correctly. The text was garbled, tables were mangled, or content was missing.
- **Extraction failure**: the entity was not found, or the wrong value was extracted. The section was located correctly but the entity extraction failed.
- **Judgment failure**: the entity was extracted correctly but the pass/fail determination was wrong. The logic is flawed or the edge case is not handled.
- **Scope failure**: the rule was applied to a section where it does not apply, or not applied to a section where it should.

## Step 5: Classify

This is the critical decision:

### Systemic Issue (affects >10% of documents)
The failure has a common cause that affects many documents. Examples:
- The document parser consistently fails on a certain table format.
- The extraction prompt misunderstands a common phrasing.
- The threshold logic has a bug.

**Action**: Fix the root cause. Rewrite the relevant part of the skill or workflow. This is a code/prompt change.

### Corner Case (affects <10% of documents)
The failure is specific to a few unusual documents. Examples:
- One document uses a non-standard date format.
- One document has the relevant information in a footnote instead of the main text.
- One document is a special report type with different structure.

**Action**: Do NOT patch the main workflow. Record the pattern and resolution in `corner_cases.json`. See `corner-case-management` skill.

### The 10% Threshold

This is a heuristic, not a law. Use judgment:
- If 8% of documents fail the same way but the fix is simple, treat it as systemic.
- If 12% of documents fail but each for a different reason, treat them as individual corner cases.
- When in doubt, discuss with the developer user.

## Step 6: Fix

For systemic issues:
1. Identify the specific component that needs to change (parser config, extraction prompt, judgment logic, regex pattern).
2. Make the change.
3. Version the change (see `version-control` skill).

For corner cases:
1. Document the pattern in `corner_cases.json`.
2. Add a detection mechanism (regex, keyword, structural pattern).
3. Define the resolution (alternative extraction method, special judgment logic).
4. Set a confidence threshold for matching.

## Step 7: Re-test

After fixing:
1. Re-run on the full document set, not just the failing documents. Fixes can introduce regressions.
2. Compare to previous iteration results.
3. If accuracy improved, continue. If accuracy regressed, roll back (see `version-control`).

## Step 8: Log

For every iteration, record the following in a structured format that the Reflect step can consume:

```json
{
  "iteration": 3,
  "trigger": "regression_detected",
  "observation_summary": "3 documents failing on date extraction",
  "reflection": "Iteration 2 attempted regex fix for same pattern, accuracy unchanged",
  "failures": [
    {"case_id": "doc_007", "diagnosis": "extraction", "root_cause": "non-standard date format", "fix": "added regex pattern", "outcome": "resolved"}
  ],
  "mutations": [
    {"component": "scripts/check.py", "change_type": "patch", "description": "Added YYYY/MM/DD pattern"}
  ],
  "outcome": {"accuracy_before": 0.82, "accuracy_after": 0.91, "regressions": 0}
}
```

This schema is a recommended starting point — adapt the fields to your specific needs. The important thing is that logs are machine-parseable (JSON) so the Reflect step can programmatically scan history.

Also maintain a plain text summary alongside the JSON for developer user readability. Store both in `logs/evolution/{rule_id}/`.

## Convergence Tracking

Track three metrics per iteration to know when to stop:

- **Correction volume**: How many test cases changed result compared to last iteration (as a percentage of total).
- **New pattern count**: How many previously unseen failure patterns were identified this iteration.
- **Regression count**: How many test cases that passed last iteration now fail.

### Stopping Criteria

Stop the loop when ALL three conditions hold for one iteration:

1. Correction volume < 5% of total test cases.
2. New pattern count = 0.
3. Regression count = 0.

If correction volume *increases* between consecutive iterations, this is a regression signal. Pause the loop and diagnose before continuing — the last fix may be destabilizing the system.

### Expected Convergence

Convergence is not linear. Expect rapid improvement in early iterations followed by diminishing returns:

| Document count | Typical iterations to converge |
|---------------|-------------------------------|
| < 50 | 3–5 |
| 50–200 | 4–7 |
| 200–1000 | 5–10 |
| 1000+ | 7–15 |

These are empirical estimates. Actual convergence depends on rule complexity, document variability, and model capability. If convergence takes significantly more iterations than expected, revisit your approach rather than grinding through more rounds.

See `references/convergence-guide.md` for diagnostic procedures and real-world convergence data.

## The Three Phases of Life

### Phase 1: Evolution (Active Improvement)
The system is being built. Every testing round reveals issues. The loop runs frequently. This is where you spend most of your effort.

### Phase 2: Monitoring (Quality Control)
The system is deployed. Workflows are running on production data. The loop runs on sampled results (see `quality-control` skill). You intervene only when quality drops.

### Phase 3: Stability (Near-Zero Oversight)
The system is mature. Quality has been stable for a sustained period. The loop runs rarely, on small random samples. You intervene only when business rules change.

Transition between phases is gradual, not sudden. And it can reverse — a regulatory change can push you from Phase 3 back to Phase 1.

## Escalation

Escalate to the developer user when:
- MAX_ITERATIONS is reached without meeting the accuracy threshold.
- You cannot determine the root cause of a failure.
- The fix requires domain knowledge you do not have.
- Multiple rules interact in ways you cannot resolve.

When escalating, provide: the rule, the failing documents, the diagnosis, what you tried, and why it did not work.
