---
name: corner-case-management
tier: meta
description: Identify, catalog, and handle corner cases that do not fit the mainstream verification workflow. Use AFTER several rounds of skill/workflow iteration have surfaced documents that genuinely don't fit and can't be accommodated by reasonable changes to the standard flow. Covers when something is a corner case vs. a systemic fix needed, how to register it, how to wire detection-and-resolve so the corner case stays out of the hot path until a similar document appears again, and when to promote a corner case to a regular rule.
---

# Corner Case Management

A good workflow handles the bulk of cases cleanly. Corner cases are
documents that don't fit — individually rare, collectively
non-negligible. The key insight: do NOT patch the main workflow to
handle them. That leads to spaghetti logic, fragile code, and
regressions.

Instead, maintain a separate registry. Check incoming documents
against the registry; handle matches with specific resolutions; keep
the main workflow lean.

## When to reach for this skill

Corner cases are identified **after** the testing iterations, not
during initial design. The typical pathway:

1. You've built a skill/workflow for a rule.
2. You've run it on the sample set. Most cases pass; some fail.
3. You iterate — change code, change prompts, run back-tests.
4. After several rounds, some cases stubbornly don't fit. Either:
   - The current workflow doesn't catch them and changing the workflow
     to catch them would cost too much (breaks unrelated cases, adds
     too much complexity, requires architectural rework).
   - The cases are swinging — one round of changes fits them, the next
     round breaks them, and oscillation continues.

That's when you use this skill. Not on the first iteration. Not when
you can plausibly fix it in the workflow. Only when fitting the case
into the standard flow costs more than the case is worth.

## Philosophy

Corner cases are a fact of life in document verification. Financial
documents come from thousands of different organizations, each with
their own formatting quirks, templates, and interpretations of
regulations. No workflow will handle every variant.

The question is not "how do I eliminate corner cases?" but "how do I
manage them efficiently without polluting the main path?"

The answer is: separate them. Keep the main workflow clean. Keep the
corner cases cataloged, detectable, and resolvable when they recur.

## The Corner Case Registry

A structured file (`corner_cases.json`) in the rule skill's `assets/`
directory:

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
    "discovered_at": "<date>",
    "iteration": 3,
    "status": "active"
  }
]
```

Each entry captures:
- **What** the corner case is (description).
- **How to detect** it (detection pattern with type: regex, keyword,
  structural, or model-based).
- **How to resolve** it (resolution with type: code, regex, prompt, or
  manual).
- **When** it was discovered and in which iteration.
- **Status**: active, promoted (moved to main workflow), or
  deprecated.

## How to handle corner cases — lazy retrieval with a high bar

Corner cases live in the registry, not in the main verification path.
They're **lazily loaded** with a **high retrieval threshold**, meaning:

- The main workflow runs first on every document.
- The registry is consulted only when a new incoming document
  resembles a previously-collected corner case strongly enough to
  trigger that entry.
- The "strongly enough" bar should be set high — false matches drag
  in a wrong resolution and pollute the main result. Better to miss a
  match (the main workflow handles it, possibly imperfectly) than to
  apply an irrelevant corner-case patch.

Two detection patterns work for this:

- **Cheap deterministic match**: regex or keyword fingerprint over
  document text. Fast, run on every document.
- **Embedding-based similarity**: compute embedding of the document's
  rule-relevant region, compare to embeddings of registered corner
  cases. Catches semantic resemblance the regex misses; costs more.

For early-stage rules with a small registry, deterministic detection
is enough. For mature rules with dozens of registered cases,
embedding-based similarity scales better.

When a match fires:
1. Log that the corner case was triggered (audit visibility).
2. Apply the registered resolution.
3. Skip / supplement / override the standard workflow as the
   resolution prescribes.

## When to add a corner case

Add a corner case when:
- Iterations of the standard workflow can't accommodate the document
  without disproportionate cost.
- The failure has a recognizable, describable pattern (a fingerprint
  to detect again).
- The resolution is clear and self-contained (not "rewrite the
  workflow").

Do NOT add a corner case when:
- The failure affects many documents — that's not a corner case,
  it's a pattern, and the main workflow should change.
- The failure has no discernible pattern — that may be a data
  quality issue; escalate to the developer user.
- The resolution would require changing the core judgment logic —
  that belongs in the main workflow.

## When to promote a corner case

A corner case should be promoted to the main workflow (i.e., the
resolution becomes part of the standard logic) when:
- It starts appearing across many documents. It's no longer a corner
  case — it's a pattern.
- Multiple similar corner cases suggest a common underlying issue.
- The developer user explicitly says "this is how it always works."

When promoting, remove the corner case from the registry and update
the workflow. Version both changes.

## Human visibility

The corner case registry must be readable and manageable by the
developer user:

- Format it clearly (JSON or a markdown table).
- Include enough context that a domain expert can understand each
  case without reading code.
- Report new corner cases in the dashboard.
- Allow the developer user to add corner cases from their own
  expertise.

Developer users often know about edge cases that the agent has not
yet encountered. They should be able to add entries like:
- "Bank XYZ always uses a different template for their Q4 reports."
- "Mutual fund documents from before 2020 follow the old regulation
  format."

These are valuable inputs that prevent future failures.

## Corner case cost

Every corner case has a runtime cost: the detection check runs on
every document. Keep the registry lean:

- Remove deprecated corner cases.
- Merge similar corner cases into a single entry with a broader
  pattern.
- Keep detection patterns efficient (prefer regex over LLM-based
  detection where possible).
- Monitor the registry size. When it grows large for a single rule,
  that's a signal the workflow itself needs improvement — many of
  those "corner" cases probably want promotion to mainline handling.
