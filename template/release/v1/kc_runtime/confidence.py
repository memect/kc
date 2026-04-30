"""
Confidence calibration helpers for the release runtime.

Workflows return raw verdicts with a self-reported confidence score.
This module re-weights that score against the historical accuracy
captured during KC's distillation phase, so users see calibrated
confidence rather than the agent's prior. Falls back to identity
when no calibration data is available.
"""

from __future__ import annotations


def calibrate(verdict: dict, historical: dict) -> dict:
    """
    Adjust verdict["confidence"] using historical accuracy for the rule.

    Schema for `historical`:
        {
          "historical_accuracy": {
            "<rule_id>": {"accuracy": float in [0, 1], "n_samples": int},
            ...
          }
        }

    If the rule has no calibration data, the verdict is returned
    unchanged. If the rule's accuracy is < 0.5 (worse than coin flip),
    confidence is dampened by the calibration ratio. If accuracy is
    high but n_samples is small, calibration trusts the raw score
    more (avoid over-correcting on weak prior).
    """
    rule_id = verdict.get("rule_id")
    if not rule_id:
        return verdict

    hist = historical.get("historical_accuracy", {}).get(rule_id)
    if not hist:
        return verdict

    accuracy = float(hist.get("accuracy", 1.0))
    n_samples = int(hist.get("n_samples", 0))

    raw = float(verdict.get("confidence", 0.5))

    # Bayesian-ish blend: weight raw confidence vs accuracy by n_samples.
    # Small n → trust the raw score; large n → trust the prior more.
    weight = min(0.5, n_samples / 100.0)
    calibrated = raw * (1 - weight) + raw * accuracy * weight

    out = dict(verdict)
    out["confidence"] = round(calibrated, 4)
    out["confidence_raw"] = raw
    out["confidence_calibrated"] = True
    return out


def confidence_band(score: float) -> str:
    """Map numeric score to a verbal band: high / medium / low."""
    if score >= 0.8:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"
