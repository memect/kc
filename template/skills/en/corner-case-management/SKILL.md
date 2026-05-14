---
name: corner-case-management
tier: meta
description: Identify, catalog, and handle corner cases that do not fit the mainstream verification workflow. Use when the evolution loop classifies a failure as a corner case (affecting less than ~10% of documents), when adding a new edge case to the registry, or when deciding whether a corner case should be promoted to a systemic fix. Also use when designing the corner case detection mechanism for a workflow.
---

# Corner Case Management

A good workflow handles 90% of cases cleanly. Corner cases are the other 10%. They are individually rare but collectively significant. The key insight: do NOT patch the main workflow to handle them. That leads to spaghetti logic, fragile code, and regressions.

Instead, maintain a separate registry. Check incoming documents against the registry before the standard workflow. Handle matches with specific resolutions.

## Philosophy

Corner cases are a fact of life in document verification. Financial documents are produced by thousands of different organizations, each with their own formatting quirks, templates, and interpretations of regulations. No workflow will handle every variant.

The question is not "how do I eliminate corner cases?" but "how do I manage them efficiently?"

The answer is: separate them from the main logic. Keep the workflow clean. Keep the corner cases cataloged, detectable, and resolvable.

## The Corner Case Registry

A structured file (`corner_cases.json`) in the rule skill's `assets/` directory:

```json
[
  {
    "id": "CC001",
    "rule_id": "R001",
    "description": "Some reports express capital adequacy as a decimal (0.125) instead of percentage (12.5%)",
    "affected_documents": ["report_bank_xyz_2024.pdf"],
    "detection_pattern": {
      "type": "regex",
      "pattern": "资本充足率[：:]*\\s*0\\.\\d+",
      "confidence_threshold": 0.8
    },
    "resolution": {
      "type": "code",
      "action": "Multiply extracted value by 100 before threshold comparison",
      "code_snippet": "if value < 1.0: value *= 100"
    },
    "discovered_at": "2026-04-01",
    "iteration": 3,
    "status": "active"
  }
]
```

Each entry captures:
- **What** the corner case is (description).
- **How to detect** it (detection pattern with type: regex, keyword, structural, or model-based).
- **How to resolve** it (resolution with type: code, regex, prompt, or manual).
- **When** it was discovered and in which iteration.
- **Status**: active, promoted (moved to main workflow), or deprecated.

## Detection During Execution

Before running the standard workflow on a document:

1. Load the corner case registry for the relevant rule.
2. Check the document against each active corner case's detection pattern.
3. If a match exceeds the confidence threshold, apply the specific resolution instead of (or in addition to) the standard workflow.
4. Log that a corner case was triggered.

This is similar to a RAG pipeline with progressive disclosure:
- The registry is the knowledge base.
- Detection patterns are the retrieval queries.
- High confidence thresholds prevent false matches.
- Only relevant corner cases are loaded into context.

## When to Add a Corner Case

Add a corner case when:
- The evolution loop classifies a failure as non-systemic (affects <10% of documents).
- The failure has a recognizable, describable pattern.
- The resolution is clear and self-contained.

Do NOT add a corner case when:
- The failure affects many documents (that is a systemic issue — fix the workflow).
- The failure has no discernible pattern (that may be a data quality issue — escalate to developer user).
- The resolution would require changing the core judgment logic (that belongs in the main workflow).

## When to Promote a Corner Case

A corner case should be promoted to the main workflow (i.e., the resolution becomes part of the standard logic) when:
- It starts appearing in >10% of documents. It is no longer a corner case — it is a pattern.
- Multiple similar corner cases suggest a common underlying issue.
- The developer user explicitly says "this is how it always works."

When promoting, remove the corner case from the registry and update the workflow. Version both changes.

## Human Visibility

The corner case registry must be readable and manageable by the developer user:
- Format it clearly (JSON or a markdown table).
- Include enough context that a domain expert can understand each case without reading the code.
- Report new corner cases in the dashboard.
- Allow the developer user to add corner cases from their own expertise.

Developer users often know about edge cases that the coding agent has not yet encountered. They should be able to add entries like:
- "Bank XYZ always uses a different template for their Q4 reports."
- "Mutual fund documents from before 2020 follow the old regulation format."

These are valuable inputs that prevent future failures.

## Corner Case Cost

Every corner case has a runtime cost: the detection check runs on every document. Keep the registry lean:
- Remove deprecated corner cases.
- Merge similar corner cases into a single entry with a broader pattern.
- Keep detection patterns efficient (prefer regex over LLM-based detection).
- Monitor the registry size. If it grows beyond ~50 entries for a single rule, that suggests the workflow itself needs improvement.
