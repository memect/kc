# Lightweight Output Format Specification

This document defines the compact text markup format for verification results, its grammar, JSON conversion rules, and edge case handling.

## Grammar

```
[RESULT] field_name <- value (constraint) | conf:score | src:location | note:text
```

| Component | Required | Format | Description | Example |
|-----------|----------|--------|-------------|---------|
| `[RESULT]` | Yes | One of: PASS, FAIL, MISSING, ERROR, UNCERTAIN | The judgment outcome. | `[FAIL]` |
| `field_name` | Yes | snake_case identifier | The rule or field being checked. | `capital_adequacy` |
| `<- value` | No (omit for MISSING) | Free text, no pipes | The extracted value from the document. | `<- 12.5%` |
| `(constraint)` | No (omit if no constraint) | Parenthesized expression | The expected value or condition. | `(>= 8.0%)` |
| `conf:score` | Yes | Decimal 0.00-1.00 | Confidence score of the judgment. | `conf:0.95` |
| `src:location` | No | Page-section reference or trace ID prefix | Source location in the document. | `src:p3-s2` |
| `note:text` | No | Free text to end of line | Human-readable comment. | `note:Signing overdue by 45 days` |

Components after `field_name` are separated by ` | ` (space-pipe-space). The `<- value` and `(constraint)` components appear before the first pipe, space-separated.

## Field Definitions

### Result Values

| Value | Meaning | When to Use |
|-------|---------|-------------|
| `PASS` | Entity complies with the rule. | Deterministic or semantic check confirms compliance. |
| `FAIL` | Entity does not comply. | Clear non-compliance detected. Note is strongly recommended. |
| `MISSING` | Entity not found in document. | Extraction could not locate the required field. |
| `ERROR` | Processing failure. | Parsing error, API timeout, unexpected format. |
| `UNCERTAIN` | Ambiguous judgment. | Borderline values, conflicting evidence, low confidence. |

### Confidence Score

A decimal between 0.00 and 1.00 representing the system's confidence in the result. For deterministic Python checks, confidence is typically 0.95-1.00. For LLM semantic judgments, confidence reflects the model's self-assessed certainty. Scores below the configured threshold in `.env` trigger human review.

### Source Location

The `src:` component uses a compact reference format: `p{page}-s{section}`. Example: `src:p3-s2` means page 3, section 2. For trace ID integration, use the trace ID prefix: `src:R001-DOC042-P3-S2` (see Integration with Trace IDs below).

## JSON Conversion

### Markup to JSON

```
Input:  [FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:p1-s4 | note:Signing overdue by 45 days

Output:
{
  "field": "sign_date_gap",
  "result": "fail",
  "extracted_value": "75d",
  "expected": "<= 30d",
  "confidence": 0.90,
  "source": "p1-s4",
  "comment": "Signing overdue by 45 days"
}
```

Pseudocode:
1. Parse `[RESULT]` -> lowercase -> `result` field.
2. Parse next token -> `field` field.
3. If `<-` follows, parse until `(` or `|` -> `extracted_value`.
4. If `(...)` follows, parse contents -> `expected`.
5. Split remaining by ` | `. For each segment:
   - `conf:X` -> `confidence` (parse as float).
   - `src:X` -> `source`.
   - `note:X` -> `comment`.

### JSON to Markup

Pseudocode:
1. `[` + uppercase(`result`) + `] ` + `field`.
2. If `extracted_value` exists: ` <- ` + `extracted_value`.
3. If `expected` exists: ` (` + `expected` + `)`.
4. ` | conf:` + format(`confidence`, 2 decimal places).
5. If `source` exists: ` | src:` + `source`.
6. If `comment` exists: ` | note:` + `comment`.

## Diff Example

Comparing two verification runs is where markup shines.

**Markup diff** (clean, scannable):
```
  [PASS] capital_adequacy <- 12.5% (>= 8.0%) | conf:0.95 | src:p3-s2
- [PASS] sign_date_gap <- 28d (<= 30d) | conf:0.92 | src:p1-s4
+ [FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:p1-s4 | note:Signing overdue by 45 days
  [MISSING] collateral_value | conf:0.60 | note:Collateral valuation not found
```

**JSON diff** (noisy, hard to scan):
```json
  {
    "field": "sign_date_gap",
-   "result": "pass",
+   "result": "fail",
-   "extracted_value": "28d",
+   "extracted_value": "75d",
    "expected": "<= 30d",
-   "confidence": 0.92,
+   "confidence": 0.90,
    "source": "p1-s4",
-   "comment": ""
+   "comment": "Signing overdue by 45 days"
  }
```

The markup diff communicates the same information in one changed line vs. five changed lines.

## Edge Cases

### Multi-Value Fields
When a field has multiple extracted values (e.g., the same metric appears in two places with different values), separate values with semicolons:
```
[UNCERTAIN] total_assets <- 1,234,567;1,234,590 | conf:0.50 | src:p3-s1;p7-s2 | note:Conflicting values found
```

### Long Notes
In markup, truncate notes longer than 80 characters with `...`. The full text is preserved in JSON. Example:
```
[FAIL] risk_disclosure <- (see detail) | conf:0.85 | note:Missing discussion of liquidity risk, market risk, and operational ri...
```

### Special Characters
If a value or note contains the pipe character `|`, escape it with a backslash: `\|`. During JSON conversion, unescape back to `|`.

### Fields with No Constraint
Omit the parenthetical entirely:
```
[MISSING] collateral_value | conf:0.60 | note:Collateral valuation not found in document
```

### Fields with No Extracted Value
Omit the `<-` component (common for MISSING and ERROR results):
```
[ERROR] capital_adequacy | conf:0.00 | note:PDF parsing failed on page 3
```

## Integration with Trace IDs

The `src:` component can encode trace ID prefixes, linking each result line to the full trace ID defined by `version-control`. Use the trace ID format directly:

```
[PASS] capital_adequacy <- 12.5% (>= 8.0%) | conf:0.95 | src:R001-DOC042-P3-S2
[FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:R003-DOC042-P1-S4 | note:Signing overdue by 45 days
```

When converting to JSON, the `src:` value maps to the `trace_id` field in the full result object. The character range (`C{start}:{end}`) can be appended when full precision is needed: `src:R001-DOC042-P3-S2-C120:180`.
