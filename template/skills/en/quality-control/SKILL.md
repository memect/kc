---
name: quality-control
tier: meta-meta
description: Design and execute quality control for production verification workflows. Use when workflows are deployed on Input/ documents and results need to be monitored, when designing the QC sampling strategy for a rule, or when evaluating whether monitoring can be reduced. Covers LLM-as-Judge evaluation, adaptive sampling strategies, confidence-based triage, and the transition from active monitoring to stable oversight. Also use when production quality drops and you need to diagnose whether to trigger the evolution loop.
---

# Quality Control

Quality control is the Observer role. You are watching the worker LLMs perform and deciding whether they are doing it well enough. The goal is not to review every result — that would defeat the purpose of automation. The goal is to review just enough to maintain confidence that the system is working.

## Five-Layer QA Architecture

Quality control is not one activity — it is five layers that build on each other. Lower layers must pass before higher layers run.

| Layer | Name | What It Checks | Method |
|-------|------|---------------|--------|
| L1 | Text Integrity | Files exist, encoding correct, source text preserved after processing | Scripts (`lint_*`) |
| L2 | Syntax | Output format valid (JSON/CSV), required fields present, types correct | Scripts (`lint_*`) |
| L3 | Data Completeness | Required fields populated, values in valid domain (dates are dates, amounts are positive) | Scripts (`validate_*`) |
| L4 | Business Logic | Cross-field consistency, threshold compliance, sequence reasonableness | Scripts + LLM |
| L5 | Cross-Phase | Entities in results match extraction output, rules match catalog, workflow output matches skill ground truth | Scripts (`cross_validate_*`) + LLM |

**Key principles:**
- **Fail fast**: If L1 fails (file missing), do not run L4 (business logic). Lower layers block higher layers.
- **Code first**: L1-L3 should be pure code — cheap and deterministic. LLM-as-Judge (below) operates at L4 and L5.
- **Naming convention**: `lint_*` for L1-L2, `validate_*` for L3-L4, `cross_validate_*` for L5.

**QC vs Reflection**: QC catches problems in outputs (this skill). Reflection diagnoses WHY problems occur and fixes them (see `evolution-loop`). QC feeds data to Reflection; Reflection feeds fixes back to the system.

See `references/qa-layers.md` for detailed layer specifications and example patterns.

## LLM-as-Judge

Use yourself (the coding agent) or a high-tier worker LLM to evaluate workflow outputs. The judge receives:
- The source document (or relevant section).
- The workflow's extracted value.
- The workflow's pass/fail determination.
- The workflow's comment (if any).

The judge produces a structured verdict:

- **correct**: The extraction and judgment are both right.
- **partial**: The extraction is roughly right but imprecise, or the judgment is right but the comment is misleading.
- **incorrect**: The extraction or judgment is wrong.
- **missing**: The workflow failed to produce a result when it should have.

Field-level verdicts should include: the field name, the verdict, the expected value (what the judge thinks is correct), and brief reasoning.

## Adaptive Sampling

Do not review everything forever. Start at high coverage and reduce as quality stabilizes:

### Initial Deployment
- Review 100% of results for the first batch. This is your baseline.
- Establish per-rule accuracy from this batch.

### Early Production
- Review all results that the workflow flagged as low confidence.
- Additionally, randomly sample a percentage of high-confidence results.
- The percentage depends on MONITOR_FREQUENCY in `.env`:
  - `high`: 50% random sample
  - `mid`: 20% random sample
  - `low`: 10% random sample

### Stable Production
- Review only low-confidence results.
- Random sample drops further (5-10%).
- Trigger full review if random samples reveal unexpected failures.

### The Decay Function
The sampling rate should decay based on observed accuracy, not just time. If accuracy stays above the threshold for N consecutive batches, reduce sampling. If accuracy drops, increase sampling immediately.

The exact decay curve is for you to design per rule, based on:
- How variable the documents are.
- How complex the rule is.
- How much the developer user trusts the workflow.

Discuss the sampling strategy with the developer user. They may have preferences.

## Confidence-Based Triage

Confidence scores (from the `confidence-system` skill) determine review priority:

- **High confidence (above auto-accept threshold)**: Spot-check only. These are results the workflow is sure about.
- **Medium confidence (between thresholds)**: Sample at the rate determined by MONITOR_FREQUENCY.
- **Low confidence (below full-review threshold)**: Review every one. These are results the workflow is uncertain about.

The thresholds themselves should be calibrated per rule. Start with reasonable defaults (e.g., 0.9 / 0.6) and adjust based on whether the thresholds actually distinguish correct from incorrect results.

## Triggering Evolution

Quality control can trigger the evolution loop. Criteria:

- Average accuracy across reviewed results drops below WORKFLOW_ACCURACY.
- A single rule's accuracy drops significantly (e.g., 15+ percentage points below its historical average).
- A new pattern of failures emerges that was not seen during skill/workflow testing.

When triggering evolution, provide the quality control data as input to the diagnosis step.

## Batch Processing

For production Input/ documents:

1. Process the batch through workflows. Results go to Output/.
2. Assign confidence scores to each result.
3. Select the review sample based on confidence triage + random sampling.
4. Review the selected results (LLM-as-Judge or manual review by the developer user).
5. Compute batch accuracy from reviewed results.
6. Log batch QC report.
7. Move processed input docs to `input/archived/` via `archive_file` so the next session sees only fresh arrivals.
8. If accuracy is acceptable, finalize the batch. If not, trigger evolution loop.

Production input often arrives on a schedule (see `bootstrap-workspace` → "Scheduled Ingestion"). Files in `input/` are auto-prefixed with `<job-id>_<UTC-timestamp>_` by the ingestion wrapper, so each batch carries provenance in its filenames. When a batch fails QC, the prefixes let you trace which scheduled run produced the bad data.

## Two Dashboard Surfaces

There are two distinct dashboards in this system:

- **Developer dashboard** — `dashboard_render` tool, generated inside the workspace from `output/results/`, `logs/evolution/`, and `output/qc/`. For your audit and the developer user's day-to-day monitoring during BUILD and DISTILL.
- **End-user dashboard** — the `render_dashboard.py` script bundled inside a release (built via the `release` tool). For non-developer recipients of a packaged release. It renders results from a single `run.py` invocation; no workspace dependency.

When a release is built, point end users at the bundled dashboard, not the workspace one. Workspace dashboard stays your developer surface.

## Re-release after substantive changes

A release bundle is a snapshot of `workflows/` and `rule_skills/` at the moment the `release` tool ran. If you modify any `workflows/<rule>/workflow_v*.py`, `rule_skills/<id>/SKILL.md`, or `check.py` AFTER the release was built, the shipped artifact no longer reflects your actual work. Engine's milestone derivation will surface `releaseIsStale: true` with the divergent file list.

When this fires:
- **Substantive change** (new hybrid path, fixed verdict logic, added rule): re-run the `release` tool to produce a fresh bundle.
- **Cosmetic edit only** (typo, comment, formatting): write `.accept_stale_release` into the release directory to acknowledge — `touch output/releases/<slug>/.accept_stale_release`.
- **DON'T** declare finalization done while a stale release ships. Downstream consumers (other agents, deployed verification systems) read the bundled `parser_v*.py` / `workflows/`, not the workspace.

## Developer User Involvement

The developer user should see QC results through the dashboard (see `dashboard-reporting`). Key metrics to surface:
- Per-rule accuracy over time.
- Confidence distribution (are most results high-confidence?).
- Sampling rate (is monitoring decreasing as expected?).
- Flagged issues requiring human attention.

The developer user may also want to review specific results themselves, especially for high-stakes rules. Accommodate this by marking results for human review in the output.

## User Feedback Collection

Build error reporting and comment mechanisms into every verification app you create. These are not optional features — they are essential data sources.

### Two Audiences

- **Developer users**: Technical error reporting — field-level correction, rule re-evaluation requests, false positive/negative flags with context. They see the full result detail.
- **End users**: Simplified feedback — flag a result as wrong, add a comment, indicate severity. They see a clean interface without technical internals.

### Feedback as Ground Truth

When a user reports an error on a verification result, that correction is ground truth. It overrides the coding agent's judgment and the worker LLM's output. Feed user corrections into the `evolution-loop` immediately as confirmed failures — they are higher priority than agent-detected issues.

### Feedback Data Flow

Collect feedback via the dashboard (see `dashboard-reporting`) → Store as structured records (result_id, reporter_role, feedback_type, corrected_value, comment, timestamp) → Feed into `evolution-loop` as regression test cases → Track correction trends in QC metrics.

See `references/sampling-strategies.md` for detailed sampling patterns.
