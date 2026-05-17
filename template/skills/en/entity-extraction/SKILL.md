---
name: entity-extraction
tier: meta
description: Extract specific entities, values, and text segments from documents as required by verification rules. Use after tree processing has located the relevant section, when a rule needs a specific number, date, name, amount, clause, or any domain-specific entity extracted. Covers extraction method selection (regex vs LLM), schema design, postprocessing, and confidence annotation. Also use when designing the extraction step of a workflow for worker LLMs.
---

# Entity Extraction

An entity is the thing you need to check. A number, a date, a name, a clause, a percentage, a statement. The rule says what to check; extraction is how you get the value to check it against.

## Extraction Type Taxonomy

Different extraction scenarios call for different approaches:

### Single Entity from Single Section
The simplest case. One rule needs one value from one place.
- Example: "Extract the capital adequacy ratio from the Key Metrics table."
- Approach: Locate the section, apply regex or LLM extraction.

### Multiple Entities from Single Section
One rule needs several related values from the same place.
- Example: "Extract the borrower's name, loan amount, interest rate, and maturity date from the loan agreement summary."
- Approach: Design a single extraction call that returns all values. More efficient than multiple calls.

### Single Entity from Multiple Sections
One value is scattered across multiple places, or needs cross-referencing.
- Example: "Extract the total collateral value, which may be listed in the collateral section or in Appendix A."
- Approach: Collect content from all relevant sections, then extract. Note which source the value came from.

### Entity from Full Document
The value could be anywhere, or the rule applies to the document as a whole.
- Example: "Check whether the document contains a valid signature page."
- Approach: For the coding agent, scan the full document. For worker LLM workflows, design a two-pass approach: first pass identifies the location, second pass extracts the value.

## Method Selection

Extraction method selection is a cost-accuracy search. The goal is finding the cheapest method that meets the accuracy threshold. Regex is the smallest, cheapest "model" — zero cost, instant, deterministic. Worker LLM is more capable but costs tokens and time. Any search strategy is valid: try the cheapest first and escalate, try the most capable first and downgrade, bisect, or jump directly to a known-good method based on past experience in AGENT.md.

### Available Methods

**Regex / Python** — Cost: zero. Speed: instant. Deterministic. Works well for: dates, monetary amounts, percentages, identifiers, fixed phrases, any value with a predictable format.

**Worker LLM** — Cost: API tokens. Speed: seconds. Semantic understanding. Works well for: contextual interpretation, conditional values, semantic matching, ambiguous structures, suggestive or misleading language detection, table interpretation, anything requiring understanding rather than pattern matching.

Many real verification tasks require semantic understanding — "is this description misleading?", "does this clause adequately disclose risk?", "is this guarantor's business description consistent with their stated industry?" — regex cannot handle these. Use worker LLM without hesitation for such tasks.

### The Search

If a method's results fall below the accuracy threshold, try a different method or a more capable model. If regex works and meets accuracy — keep it, it's free. If regex produces results below threshold, escalate to worker LLM. If a cheap worker LLM isn't accurate enough, try a more capable tier. Record what works for each extraction type in AGENT.md for future reference.

## Project Glossary

The project glossary (built and maintained by `rule-extraction`, stored at `rules/glossary.json`) is a useful resource when designing extraction. It records canonical names and known aliases for entities that appear across rules. Reading it before extracting helps keep entity names schema-aligned and avoids parallel labels for the same thing.

Whether the glossary becomes more than a naming convention — for instance, driving cheap pattern matching for entities with stable surface forms — is a per-project judgment. Apply the same cost-accuracy logic as elsewhere: whatever method meets the accuracy threshold for the task at hand.

## Schema Design

Define the expected output for each extraction. Keep it simple and JIT:

```json
{
  "entity_name": "capital_adequacy_ratio",
  "value": 12.5,
  "unit": "%",
  "raw_text": "资本充足率为12.5%",
  "source_location": "Chapter 2, Table 1, Row 3",
  "confidence": 0.95,
  "extraction_method": "regex"
}
```

The schema should capture:
- **value**: The extracted value, normalized.
- **unit**: If applicable (%, 元, days, etc.).
- **raw_text**: The original text fragment where the value was found. This is evidence for the judgment step.
- **source_location**: Where in the document the value was found.
- **confidence**: How sure you are (see `confidence-system`).
- **extraction_method**: What extracted it (regex, LLM-TIER2, etc.).

Do not over-engineer the schema. Add fields as needed during testing.

## Postprocessing

Raw extracted values often need normalization:

- **Chinese numerals → digits**: 一百二十万 → 1200000
- **Date standardization**: 2024年3月15日 → 2024-03-15
- **Unit conversion**: 万元 → multiply by 10000 if comparing to a threshold in 元.
- **Whitespace and noise removal**: Strip extra spaces, line breaks, formatting artifacts.
- **Percentage normalization**: 0.125 → 12.5% or vice versa, depending on what the rule expects.

Build postprocessing as Python functions in the rule skill's `scripts/` directory. They are deterministic and reusable.

## Confidence Annotation

Every extraction should carry a confidence estimate:

- **Regex match, validated format**: 0.90-0.95
- **LLM extraction, high certainty**: 0.80-0.85
- **LLM extraction, some ambiguity**: 0.60-0.75
- **Fallback or inferred value**: 0.40-0.60
- **No value found**: 0.0 (flag as MISSING)

These are starting points. Calibrate based on actual accuracy (see `confidence-system`).

## Prompt Design: Ask For What You Want

Design prompts for what you want, not against what you don't want. "Don't include explanations" in a prompt is less reliable than stripping non-JSON text from the output in postprocessing. If you need to tell the LLM not to do something, use output filtering instead of prompt negation.

## Fitting Worker LLM Context

When designing extraction for worker LLM workflows:

1. Calculate the prompt size: system prompt + instructions + examples + output format = N tokens.
2. Available context for document content = model's context window - N.
3. If the section exceeds available context, narrow further via tree processing.
4. Always leave room for the model's response.
5. Test with the actual model to verify the context fits — token counts from the coding agent may differ from the worker LLM's tokenizer.

## Extraction has corner cases too

Extraction is **as important as judgment** for final accuracy. A common observation across projects: more than half of the final errors trace back to extraction problems, not judgment — the extractor returned the wrong value, the wrong unit, or pulled from the wrong section, and the judge faithfully concluded the wrong verdict from the wrong input.

Treat extraction with the same iteration discipline as judgment:

- **Reflection / iteration**: after running an extractor on the sample set, look at the cases where it failed. Is the failure a missing pattern (add to the prompt or regex)? A format quirk (unit conversion, locale)? A document-class issue (extractor right for class A but wrong for class B)?
- **Corner-case registration**: when an extraction failure can't be fixed without disproportionate cost to the standard extractor, log it as a corner case in `corner-case-management` — same registry shape as a judgment corner case, just resolution typed as `code` / `prompt` / `parser`-class transformation.
- **Validate the extractor independently of the judge**: an end-to-end test that fails only on the judgment side may hide a bad extractor whose outputs happen to verdict correctly *most* of the time. Use QC review to spot-check extracted values, not just final verdicts.

When you're tempted to fix accuracy by tuning the judge's prompt, first check whether the extractor is giving the judge the right input. The cheaper, more durable fix is almost always in the extractor.
