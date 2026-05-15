"""KC workflow helpers (v0.8.1 P10-B).

Common utilities for distilled workflows. Provider-agnostic, no
external dependencies. Reusable across rule check.py / workflow.py
files so that per-rule scripts stay focused on rule-specific logic.

Currently:
  strip_annotations(text)     — drop reviewer-annotation footers
                                from sample documents so per-rule
                                check.py regex doesn't false-positive
                                on the annotation itself

  detect_report_type(text)    — light-touch report-type classifier
                                (年报 / 季报 / 月报 / 周报 / 其他)
                                used by rules that gate on report type

  make_result(rule_id, verdict, evidence, confidence, **kwargs)
                              — standardized result dict factory
"""
import re


# Annotation prefixes that mark reviewer-added footers in sample docs.
# These should be stripped before keyword/regex matching so per-rule
# check.py doesn't match the annotation as if it were document content.
#
# Added based on E2E #11 贷款 v0.8 audit § 9: 4/14 spot-checks
# false-positive PASS because samples contain `预期命中点: ...年化利率`
# footers that the rule's keyword regex matches.
_ANNOTATION_PREFIXES = (
    "预期命中点",
    "预期结果",
    "预期判定",
    "预期验证",
    "标注",
    "审核标注",
    "Expected",
    "expected",
    "EXPECTED",
    "Annotation",
    "annotation",
)


def strip_annotations(text, extra_prefixes=None):
    """Remove reviewer-annotation footers from document text.

    A line is dropped if it starts with one of the recognized
    annotation prefixes followed by `:` or `：` (Chinese full-width
    colon). All subsequent lines until a blank line or end of text
    are also dropped (annotations are typically multi-line trailing
    blocks).

    Pass `extra_prefixes` (iterable of strings) to add project-specific
    annotation labels.

    Returns the cleaned text. Input is never mutated.
    """
    if not text:
        return text
    prefixes = tuple(_ANNOTATION_PREFIXES)
    if extra_prefixes:
        prefixes = prefixes + tuple(extra_prefixes)
    # Build a pattern matching `<prefix>` + colon (half or full-width)
    pattern = "|".join(re.escape(p) for p in prefixes)
    anno_start = re.compile(rf"^\s*(?:{pattern})\s*[::]")

    out_lines = []
    in_anno_block = False
    for line in text.split("\n"):
        if anno_start.match(line):
            in_anno_block = True
            continue
        if in_anno_block:
            # End block on a blank line OR a line that doesn't look
            # like annotation continuation (no leading whitespace).
            if not line.strip() or not line.startswith((" ", "\t", "-", "*", "·")):
                in_anno_block = False
                if line.strip():
                    out_lines.append(line)
            # Otherwise still inside the annotation block — drop.
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


_REPORT_TYPE_PATTERNS = [
    ("年报", re.compile(r"年报|年度报告|annual report", re.IGNORECASE)),
    ("半年报", re.compile(r"半年报|半年度报告|interim report", re.IGNORECASE)),
    ("季报", re.compile(r"季报|季度报告|quarterly report", re.IGNORECASE)),
    ("月报", re.compile(r"月报|月度报告|monthly report", re.IGNORECASE)),
    ("周报", re.compile(r"周报|周度报告|weekly report", re.IGNORECASE)),
]


def detect_report_type(text):
    """Light-touch report-type classifier.

    Returns one of: "年报", "半年报", "季报", "月报", "周报", "其他".
    Scans only the first 2000 chars (report-type identifiers usually
    appear in the title or cover page). Used by rules that gate on
    report type (e.g. R02-06/R02-08 are NOT_APPLICABLE for 季报).
    """
    if not text:
        return "其他"
    head = text[:2000]
    for kind, pattern in _REPORT_TYPE_PATTERNS:
        if pattern.search(head):
            return kind
    return "其他"


def make_result(rule_id, verdict, evidence, confidence=0.7, **kwargs):
    """Build a standardized check result dict.

    Required: rule_id, verdict ("PASS" / "FAIL" / "WARNING" / "NOT_APPLICABLE"),
    evidence (string explaining the verdict).

    Optional: confidence (0.0-1.0), plus any extra fields the rule
    needs (model_used, llm_calls, llm_tokens, comment, etc.).
    """
    result = {
        "rule_id": rule_id,
        "verdict": verdict,
        "evidence": evidence,
        "confidence": confidence,
    }
    result.update(kwargs)
    return result


__all__ = ["strip_annotations", "detect_report_type", "make_result"]
