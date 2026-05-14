# Sampling Strategies for Quality Control

## Adaptive Sampling

The core idea: review more when you are uncertain, less when you are confident. Confidence grows with evidence — consecutive batches of high accuracy.

### Continuous Decay Model

Rather than cliff-edge transitions between phases, use a smooth exponential decay driven by observed accuracy:

```
sampling_rate = max(floor_rate, exp(-λ × consecutive_successes))
```

Where:
- `consecutive_successes`: number of consecutive batches where accuracy meets or exceeds the threshold. **Resets to 0** whenever a batch's accuracy drops below the threshold. This is the self-correcting mechanism — quality drops immediately increase monitoring.
- `λ` (decay speed): controlled by MONITOR_FREQUENCY in `.env`.
- `floor_rate`: the minimum sampling rate, never goes below this.

### MONITOR_FREQUENCY Mapping

| Setting | λ | floor_rate | Character |
|---------|---|------------|-----------|
| `high` | 0.1 | 0.10 | Slow decay, cautious — for high-stakes verification where errors are costly |
| `mid` | 0.2 | 0.05 | Balanced decay — standard for most scenarios |
| `low` | 0.3 | 0.05 | Fast decay — for well-understood domains with simple rules |

As a rough mental model of the curve shape (for `mid`):
- After 1 success: ~82% sampling
- After 3 successes: ~55%
- After 5 successes: ~37%
- After 10 successes: ~14%
- After 15 successes: ~5% (floor)

These numbers, the formula, and even the exponential shape are recommended defaults. The coding agent and developer user should discuss and calibrate based on the specific business scenario. If a different decay function (linear, sigmoid, or hand-tuned) works better, use it. The framework — accuracy-driven decay with reset on quality drop — matters more than the specific formula.

## Priority Sampling

Not all results are equally worth reviewing. Priority sampling ensures that the most informative results are always in the review set:

### Always Review
- Results where the workflow reported low confidence (below the full-review threshold from `confidence-system`).
- Results where the workflow produced an error or missing result.
- Results from document types not seen during skill/workflow testing.

### Usually Review
- Results where the workflow's confidence is in the medium band.
- Results from rules that historically have lower accuracy.
- Results from the first occurrence of a new document format or variant.

### Spot-Check
- Results with high confidence from rules that historically have high accuracy.
- These are selected randomly from the high-confidence pool.
- The purpose is regression detection, not active improvement.

## Stratified Sampling

When documents vary significantly in complexity or type, stratify the sample:

1. **Group documents** by type, complexity, or any relevant characteristic.
2. **Sample proportionally** from each group, ensuring that minority groups are represented.
3. **Over-sample** from groups that historically have lower accuracy.

This prevents the random sample from being dominated by easy documents while missing systematic failures in hard documents.

## Confidence Calibration Check

Periodically (every N batches), run a calibration check:

1. Take a random sample of high-confidence results.
2. Review them (LLM-as-Judge or human).
3. Compare: are 90%+ of "high confidence" results actually correct?
4. If not, the confidence system needs recalibration (see `confidence-system` skill).
5. If yes, you can safely reduce the sampling rate for high-confidence results.

This is a meta-check on the quality of the quality control system itself.
