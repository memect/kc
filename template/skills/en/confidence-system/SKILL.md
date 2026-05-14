---
name: confidence-system
tier: meta
description: Design and calibrate confidence scoring for extraction and verification results. Use when building any workflow that needs to quantify trust in its output, when setting up quality control sampling thresholds, or when calibrating existing confidence scores against actual accuracy. Confidence is the bridge between workflows and quality control — high confidence means less review, low confidence means more review. Also use when the quality control skill reports that confidence scores do not correlate with actual correctness.
---

# Confidence System

Confidence is not about the model's certainty — it is about your system's track record. A confidence score should predict: "If I see this score, how likely is the result to be correct?" If your 0.9 confidence results are correct 90% of the time, your confidence system is calibrated.

## Why Confidence Matters

Without confidence, you have two choices:
1. Review everything (expensive, defeats the purpose of automation).
2. Review nothing (risky, errors slip through).

With confidence, you can review intelligently: spend your review budget where errors are most likely.

## Composite Scoring

Confidence for a single extraction or judgment result should combine multiple signals. No single signal is reliable enough on its own.

### Signal: Extraction Method Prior
How inherently reliable is the extraction method?
- Regex match with validated format: 0.90-0.95
- LLM extraction with structured output: 0.75-0.85
- LLM extraction with free-form output: 0.60-0.75
- Fallback or inferred value: 0.40-0.50

This is a prior — it reflects the method's general reliability, not this specific result.

### Signal: Source Text Presence
Was the extracted value clearly present in the source text?
- Exact string found in source: high signal
- Approximate match found: medium signal
- No matching text in source (model inferred or generated): low signal

This catches hallucination. If the model claims "capital adequacy ratio is 12.5%" but "12.5" does not appear anywhere in the source section, that is a red flag.

### Signal: Historical Accuracy
How often has this rule, on this document type, with this extraction method, been correct in the past?
- First iteration (no history): use the method prior only.
- After QC reviews: compute actual accuracy and blend it in.

This is the most valuable signal over time. It reflects real performance, not assumptions.

### Signal: Corner Case Proximity
Does this document match any known corner case pattern?
- Exact match: lower confidence (the standard workflow may not apply).
- Near miss: slightly lower confidence.
- No match: neutral (no adjustment).

### Combining Signals

Start with a simple weighted average:

```
confidence = w1 * method_prior + w2 * source_presence + w3 * historical_accuracy + w4 * corner_case_adjustment
```

Initial weights (adjust through calibration):
- w1 (method): 0.25
- w2 (source): 0.25
- w3 (history): 0.35 (most important once available)
- w4 (corner case): 0.15

When historical accuracy is not yet available (early iterations), redistribute its weight to the other signals.

## Threshold Bands

Define bands that map confidence to review action:

| Band | Confidence Range | Action |
|------|-----------------|--------|
| High | Above auto-accept threshold | Spot-check only (5-10% random sample) |
| Medium | Between thresholds | Sample at MONITOR_FREQUENCY rate |
| Low | Below full-review threshold | Review every result |

Starting thresholds: auto-accept = 0.85, full-review = 0.60. These are defaults — calibrate per rule.

## Calibration

Calibration is the process of checking: "Do my confidence scores actually predict accuracy?"

### How to Calibrate

After each QC review cycle:
1. Group reviewed results by confidence band (e.g., 0.0-0.2, 0.2-0.4, ..., 0.8-1.0).
2. For each band, compute the actual accuracy (% of results that QC confirmed as correct).
3. Compare actual accuracy to the confidence band's midpoint.
4. If they match (0.8-0.9 band has ~85% actual accuracy), the system is calibrated.
5. If they diverge (0.8-0.9 band has only 60% actual accuracy), the confidence is overestimated — adjust weights.

### When to Recalibrate

- After the first QC review cycle (establishing initial calibration).
- After a workflow version change (new code may have different reliability characteristics).
- After confidence thresholds are adjusted.
- When the QC skill reports that confidence does not predict correctness.

## Integration Points

- **Entity extraction** assigns initial confidence based on method prior and source presence.
- **Compliance judgment** may adjust confidence based on the complexity of the judgment.
- **Quality control** uses confidence bands to determine review sampling.
- **Evolution loop** uses confidence trends to detect degradation.
- **Dashboard** displays confidence distribution for developer user visibility.

## Keep It Simple Initially

Do not over-engineer the confidence system upfront. Start with the method prior alone:
- Regex: 0.90
- LLM: 0.75
- Fallback: 0.50

Run QC on the first few batches. See whether these scores predict actual accuracy. If they do, you are done for now. If they do not, add signals incrementally.

The confidence system should earn its complexity, not start with it.
