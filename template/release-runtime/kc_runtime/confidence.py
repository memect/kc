"""
Confidence scorer — Python port of src/agent/confidence-scorer.js.

Composite formula: confidence = method_prior * source_presence
                                * historical_accuracy * (1 - corner_proximity)

Identical to the JS scorer used inside KC, so release runs produce the same
confidence values KC produces in-workspace.

Note on rounding: JS Math.round() is half-up, Python's round() is half-to-even
(banker's rounding). We use a half-up implementation here to match JS exactly.
"""

import math


def _round3_halfup(x):
    """Round x to 3 decimals, half-up (matches JS Math.round)."""
    return math.floor(x * 1000 + 0.5) / 1000


DEFAULT_PRIORS = {
    "regex": 0.95,
    "python": 0.90,
    "llm": 0.75,
    "ocr": 0.65,
    "fallback": 0.50,
}


def score(rule_id, extracted_value, source_text="", method="llm",
          document="", priors=None, historical=None, corner_cases=None):
    """
    Compute composite confidence score (0.0 - 1.0).

    rule_id: rule identifier
    extracted_value: the value the workflow extracted (string)
    source_text: optional surrounding text from the document
    method: "regex" | "python" | "llm" | "ocr" | "fallback"
    document: document name / path (used for corner-case proximity)
    priors: dict overriding DEFAULT_PRIORS
    historical: dict of {rule_id: accuracy} from confidence_calibration.json
    corner_cases: list/dict from corner_cases.json registry
    """
    p = priors or DEFAULT_PRIORS
    method_prior = p.get(method, p.get("fallback", 0.50))

    source_presence = 1.0
    if source_text and extracted_value:
        source_presence = 1.0 if str(extracted_value) in source_text else 0.7

    hist = (historical or {}).get(rule_id, 0.8)

    corner_proximity = _corner_proximity(corner_cases, document, rule_id)

    confidence = method_prior * source_presence * hist * (1.0 - corner_proximity)
    confidence = max(0.0, min(1.0, confidence))
    return _round3_halfup(confidence)


def band(confidence):
    """Classify confidence into low/medium/high band — matches JS getBand()."""
    if confidence >= 0.8:
        return "high"
    if confidence >= 0.5:
        return "medium"
    return "low"


def _corner_proximity(corner_cases, document, rule_id):
    """Mirror CornerCaseRegistry.match: count entries matching this doc + rule.
    Each match adds 0.1 (capped at 0.3). Schema is intentionally loose — KC's
    JS registry stores entries with optional `document_pattern` and `rule_id`
    fields; we replicate the same matching semantics here.
    """
    if not corner_cases or not document:
        return 0.0
    entries = corner_cases if isinstance(corner_cases, list) else corner_cases.get("entries", [])
    if not entries:
        return 0.0

    matches = 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        if e.get("rule_id") and e.get("rule_id") != rule_id:
            continue
        pattern = e.get("document_pattern") or e.get("document") or ""
        if pattern and pattern not in document:
            continue
        matches += 1

    return min(0.3, 0.1 * matches)
