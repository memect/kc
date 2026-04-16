---
name: rule-graph
description: Build and maintain a graph of relationships between verification rules — shared entities, logical dependencies, and conflicts. Use when analyzing the impact of a regulation change, when optimizing extraction to avoid duplicate work, when checking rule catalog completeness, or when rolling up document-level results into a summary. Critical constraint — the graph is an overlay for analysis, NOT a prerequisite for execution. Every rule must remain independently runnable.
---

# Rule Graph

Rules do not exist in isolation. They share entities, depend on each other's results, and sometimes contradict each other. The rule graph makes these relationships explicit so you can reason about the rule catalog as a system rather than a flat list.

But a graph can become a trap. If rules cannot run without the graph, you have built a monolith. The graph is a lens for analysis — never a gate for execution.

## Independence First

**CRITICAL: Every rule MUST have a self-sufficient workflow.** This is not a suggestion. It is the single most important constraint in the entire rule graph design.

Enterprise systems integrate at the individual rule level. A bank's existing compliance platform calls Rule R001 to check capital adequacy, independently of any other rule. If R001 requires R003 to run first, the integration breaks. If R001 requires the graph to be loaded, the integration breaks.

The graph is an overlay. It exists for the coding agent's analysis and optimization. It does NOT create hard dependencies between rules. Any rule, extracted from the graph and dropped into a standalone system, must produce correct results with only its own inputs.

When you find a genuine dependency (Rule B only makes sense if Rule A has already been evaluated), encode it as metadata in the graph. The workflow for Rule B should handle the case where Rule A's result is unavailable — by computing it inline, requesting it as an optional input, or marking its own result as incomplete.

## What the Graph Captures

### Shared Entities

Rules that extract the same entity from the same document region. R001 (capital adequacy) and R004 (tier-1 capital ratio) both need the capital figures from the balance sheet. The graph records this so an optimizer can extract once and share.

But shared extraction is an optimization, not a requirement. Each rule's workflow must include its own extraction logic as the default path. The shared extraction is a fast path that the system can use when rules run together.

### Logical Dependencies

Rule B applies only if Rule A passes. "If the borrower is classified as high-risk (R012), then enhanced due diligence documents are required (R013)." The graph captures this so that:
- When presenting results, R013 can be shown in context of R012.
- When R012's logic changes, you know R013 may be affected.

The workflow for R013 must still function if R012's result is not available — it should either compute the high-risk classification itself or flag that it cannot determine applicability.

### Conflicts

Two rules that can produce contradictory guidance. Regulation A requires disclosure of all related-party transactions; Regulation B's privacy provisions restrict disclosure of certain transaction details. The graph marks this conflict so the coding agent can escalate to the developer user rather than silently choosing one rule over the other.

### Shared Corner Cases

Edge cases that affect multiple rules. A document with an unusual structure (merged cells in a table, non-standard date format) may cause extraction failures across several rules. The graph links these rules to the shared corner case so a fix in one propagates awareness to others.

## Three Uses

### 1. Impact Analysis

A regulation changes. Which rules are affected? Traverse the graph from the changed rule:
- Direct edges: rules that share entities or have dependencies.
- Second-degree edges: rules that depend on affected rules.
- Conflict edges: rules whose conflict resolution may need revisiting.

Without the graph, impact analysis requires reading every rule to check for overlap. With the graph, it is a traversal.

### 2. Optimization

When processing a batch of documents against many rules, the graph identifies:
- **Shared extraction**: extract entity X once, use it in rules R001, R004, R007.
- **Execution ordering**: if R012 runs before R013, R013 can use R012's result as a shortcut (but must not require it).
- **Parallel groups**: rules with no edges between them can run in parallel.

The optimization is opportunistic. It makes batch processing faster. It must never make individual rules dependent on the batch context. A rule pulled out of the batch and run alone must still work.

### 3. Completeness Checking

Map regulation paragraphs to rules. The graph helps identify:
- **Uncovered sections**: regulation paragraphs that no rule addresses.
- **Over-covered sections**: paragraphs addressed by multiple overlapping rules (potential redundancy).
- **Coverage target**: aim for 95% of substantive regulation paragraphs mapped to at least one rule.

### 4. Document-Level Rollup

When presenting results for a document checked against many rules, use the graph to:
- **Group related results**: show capital adequacy rules together, show disclosure rules together.
- **Order by dependency**: show R012 (risk classification) before R013 (enhanced due diligence).
- **Highlight conflicts**: when two rules produce contradictory results, surface the conflict rather than burying it in a flat list.
- **Aggregate severity**: if five related rules all fail, that cluster may be more significant than five unrelated failures.

## Representation

The graph is stored as a JSON adjacency list in the rule catalog directory.

```json
{
  "nodes": {
    "R001": {"name": "Capital adequacy ratio", "category": "capital"},
    "R004": {"name": "Tier-1 capital ratio", "category": "capital"},
    "R012": {"name": "Borrower risk classification", "category": "risk"},
    "R013": {"name": "Enhanced due diligence", "category": "due_diligence"}
  },
  "edges": [
    {"from": "R001", "to": "R004", "type": "shares_entity", "entity": "capital_figures"},
    {"from": "R012", "to": "R013", "type": "depends_on", "condition": "R012 result is high-risk"},
    {"from": "R008", "to": "R015", "type": "conflicts_with", "detail": "Disclosure vs privacy"}
  ]
}
```

**Edge types:**
- `shares_entity`: Both rules extract the same entity. Optimization opportunity.
- `depends_on`: Target rule's applicability depends on source rule's result. Metadata only — not a hard execution dependency.
- `conflicts_with`: Rules may produce contradictory guidance. Requires escalation logic.
- `shares_corner_case`: Both rules are affected by the same edge case pattern.

The graph is updated whenever the rule catalog changes — new rules added, rules modified, rules retired. It is visualizable through `dashboard-reporting` as a node-link diagram.

## Integration

**Input:** Rule catalog from `rule-extraction`. The graph is built after rules are extracted and updated as rules evolve.

**Enriches:**
- `skill-authoring`: When writing a new rule skill, check the graph for related rules. Reference shared entities and dependencies in the skill's SKILL.md.
- `quality-control`: When a rule's accuracy drops, check the graph for downstream rules that may also be affected.

**Feeds:**
- `dashboard-reporting`: Graph visualization, impact analysis results, coverage metrics.
