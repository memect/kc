---
name: compliance-judgment
description: Determine whether extracted entities comply with verification rules. Use after entity extraction to make the pass/fail judgment for each rule on each document. Covers translating natural language rules into executable logic, choosing between Python calculation and LLM semantic judgment, and producing actionable comments on failures. Also use when designing the judgment step of a workflow or when a rule's judgment logic needs debugging.
---

# Compliance Judgment

Judgment is the moment of truth. You have the extracted entity. You have the rule. Do they comply? The answer must be clear, correct, and — when the answer is no — accompanied by a concise, actionable comment.

## The Judgment Spectrum

Rules range from trivially deterministic to deeply semantic. Pick the right tool for each rule.

**Deterministic** — threshold checks, format validation, date arithmetic, cross-field consistency. Pure Python: free, instant, deterministic.

**Semantic** — adequacy, completeness, consistency, compliance with templates, detecting misleading or suggestive language, assessing whether a description is fair and balanced. These require language understanding — use worker LLM.

Many real compliance rules require semantic judgment. "The risk disclosure must adequately describe the key risks" cannot be checked with regex or Python. "The contract description must not be misleading or suggestive" requires deep language understanding. Use worker LLM for these without hesitation.

Some rules combine both: extract a number (deterministic), compare to threshold (deterministic), then assess the explanation if borderline (semantic). The mix depends on the rule.

The right method is whatever achieves accuracy at lowest cost. Simple threshold checks don't need LLM. Semantic assessments don't benefit from Python. Most projects will have a mix — let the nature of each rule determine the method.

## Output Format

For each rule × document combination:

```json
{
  "rule_id": "R001",
  "document": "report_2024_q1.pdf",
  "result": "pass | fail | missing | error | uncertain",
  "extracted_value": "12.5%",
  "expected": ">= 8.0%",
  "comment": "",
  "confidence": 0.95
}
```

**Result values:**
- **pass**: Entity complies with the rule.
- **fail**: Entity does not comply. Comment is required.
- **missing**: The entity could not be found in the document. This is different from fail — the information is absent, not non-compliant.
- **error**: Something went wrong during extraction or judgment (parsing failure, API error). Needs investigation.
- **uncertain**: The judgment is ambiguous. May need human review.

**Design exit criteria first:** Before writing judgment logic for a rule, define the exit conditions: what constitutes pass, what constitutes fail, what triggers escalation to human, how to handle empty/missing values, what value ranges are valid. Explicit exit criteria prevent ambiguous or inconsistent judgment.

**Prompt design:** Design prompts for what you want, not against what you don't want. "Don't include reasoning" is less reliable than extracting the verdict from structured output in postprocessing. Use output filtering instead of prompt negation.

**Comments:**
- Required only when result is `fail`. Skip for `pass` unless the developer user specifically requests pass comments.
- Be concise and factual: "Capital adequacy ratio is 7.2%, below the regulatory minimum of 8.0%."
- Do not editorialize: not "This is a serious violation that could result in penalties." Just state the facts.
- Include the extracted value and the expected value/condition for context.

### Lightweight Annotation Markup

For human review, token-efficient logging, and clean diff comparisons, results can also be expressed in compact text markup:

```
[PASS] capital_adequacy <- 12.5% (>= 8.0%) | conf:0.95 | src:p3-s2
[FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:p1-s4 | note:Signing overdue by 45 days
[MISSING] collateral_value | conf:0.60 | note:Collateral valuation not found in document
```

This format is losslessly convertible to and from the JSON format above. Use it when presenting results to the developer user for quick review, logging to evolution iteration summaries where token economy matters, or computing diffs between verification runs. See `references/output-format.md` for the full specification and conversion rules.

## Judgment Ordering

Some rules depend on the results of other rules:
- Rule B might only apply if Rule A passes. "If the borrower is a new customer (Rule A), then additional documentation is required (Rule B)."
- Rule C might use a value computed by Rule A. "The risk-weighted capital ratio (Rule A) determines the required reserve level (Rule C)."

Map these dependencies in the rule catalog. Execute rules in dependency order. Pass upstream results as context to downstream rules.

## Handling Edge Cases

- **Null extraction**: The entity was not found. Default to `missing`, not `fail`. A missing value is an extraction problem, not a compliance problem.
- **Multiple values**: The document contains the entity in multiple places with different values. Flag as `uncertain`. Report all found values.
- **Conditional rules**: "If the loan exceeds 1M, then collateral is required." Check the condition before applying the rule. If the condition is not met, the rule does not apply — result is `pass` (or `not_applicable` if you add that category).
- **Negative results**: Some rules check for absence. "The document must NOT contain guarantees to related parties." Searching for absence is harder than searching for presence. Be thorough in the search, then be confident in the negative.
