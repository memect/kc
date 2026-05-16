---
name: cross-document-verification
tier: meta
description: Build cross-document verification rule-skills and workflows — i.e., rules where the verdict depends on facts that appear in MORE than one document. Use when authoring or distilling a rule that requires comparing entities/values across documents in a case (main contract + appendices, loan application + income certificate + bank statement, etc.). Covers what the rule definition must specify (source-doc → entity → target-doc → entity → consistency level), how the resulting check.py/workflow walks the case, contradiction types to handle, and severity classification. Distinct from `compliance-judgment` (within-doc rules); KC is the builder, not the executor.
---

# Cross-Document Verification — Building Rules That Span Documents

KC's job in this phase is **building** verification rules that span
multiple documents — not executing cross-doc checks at runtime. The
output is a rule-skill / workflow that, once shipped, can be applied
by KC or downstream systems to any case.

If a rule's verdict depends on facts in more than one document, that
fact has to be encoded in the rule itself. You can't build a
within-doc check.py and hope the cross-doc check happens by magic at
production time.

## What the rule definition must specify

For a cross-doc rule, the catalog entry needs more than just
"description + falsifiability_statement". It needs an **explicit
cross-doc trajectory**:

1. **Starting document class**: which document do we start from? How
   do we classify a document as belonging to this class? (e.g., "loan
   application form", "main contract", "annual disclosure report")
2. **Anchor entity in the starting doc**: what do we extract first?
   (e.g., applicant ID, borrower name, contract reference number,
   reported total amount)
3. **Target document class(es)**: which document(s) must we
   cross-check against? How do we identify them within the same
   case? (shared anchor key, naming pattern, explicit reference in
   the starting doc)
4. **Target entity in each target doc**: what do we extract from each
   target doc to compare? It may or may not have the same field
   name — "monthly income" on the application vs. "average deposit"
   on the bank statement.
5. **Consistency level for PASS**: when do we say the documents agree?
   Exact equality? Equality within tolerance? Plausibility check
   (within 1.5× of the other value)? Reciprocal-reference present?
6. **What FAIL looks like**: hard mismatch, soft contradiction, or
   missing reciprocal reference — and what severity each carries.

Without these five anchors, the rule is just a wish. With them, the
resulting check.py can walk the case deterministically.

## How this differs from `compliance-judgment`

`compliance-judgment` covers within-doc rules: read one document,
apply the rule, return a verdict. The judgment can be regex,
deterministic Python, or LLM-augmented — but the input is one
document.

This skill covers rules where the **input is a case** (a set of
related documents). The check.py for such a rule:

- Receives a case-level structure (list of documents + metadata), not
  a single doc.
- Performs entity extraction across the relevant documents.
- Builds the comparison matrix needed for that specific rule (not a
  generic everything-vs-everything matrix — only the fields this rule
  cares about).
- Applies the consistency check defined in the rule.
- Returns the verdict plus the matrix-cells that drove it (evidence).

KC is the **builder** of this check.py / workflow, not the executor.
The teaching below is about what to design, not what to do at runtime.

## Case patterns to design for

Two patterns cover most cross-doc rules:

1. **Main contract + appendices/supplements.** Same issuer, formally
   cross-referenced. The main contract states the total, the
   appendices break it down. Issues to expect: totals that don't
   match line-item sums, referenced appendices missing or outdated,
   version mismatches between main body and supplements.

2. **Multi-source bundle.** Loan application + income certificate +
   bank statement + credit report + property appraisal. Different
   issuers, different formats, same borrower/case. Issues to expect:
   identity drift across docs (name spellings, employer name
   variants), value contradictions (income claimed vs. observed),
   suspicious consistency (multiple docs with identical
   formatting/phrasing → possible fabrication).

When authoring a rule, name the pattern it targets. The check.py
shape differs between the two — the contract+appendices pattern
expects formal references and reciprocal links; the multi-source
pattern expects normalization (entity reconciliation across
formats).

## Contradiction taxonomy (what the rule may need to detect)

A cross-doc rule may flag one or more of these:

### Hard contradictions
Exact mismatches in fields that must be identical across docs.
- Identity field mismatch (name, ID, DoB).
- Amount mismatch beyond tolerance (totals, line items, reported
  incomes).
- Date mismatch on fields that should be identical (effective date,
  signing date).

Hard contradictions are binary. Either the values match (within
defined tolerance) or they don't.

### Soft contradictions
Values not directly inconsistent but **implausible** when considered
together.
- Monthly income claimed at one level; bank statement averages
  significantly below it.
- Property appraisal close to the loan amount (high LTV — technically
  possible, but a signal).
- Employment dates with multi-month gaps across documents.

Soft contradictions need thresholds and judgment. They are findings,
not verdicts — the rule should specify whether they trigger FAIL,
WARNING, or just evidence-collection for downstream review.

### Cross-reference failures
Structural integrity problems within formally linked documents.
- Main contract references "Appendix B — Payment Schedule" but
  Appendix B is missing or has a different title.
- Appendix references a clause that doesn't exist in the main
  contract.
- Missing reciprocal reference: appendix references main contract,
  but main contract doesn't list appendix.
- Version mismatch: main contract dated one date, appendix dated a
  much later date with different terms.

See `references/contradiction-taxonomy.md` for the field-level
taxonomy with tolerances and severity templates the rule designer
can borrow.

## Severity classification (rule-level decision)

Not all contradictions carry the same weight. The rule must specify
how its findings map to severity:

| Severity | Typical example |
|----------|-----------------|
| Critical | Identity field mismatch (different ID across docs) |
| High | Significant financial amount discrepancy |
| Medium | Date or employment-detail mismatch |
| Low | Formatting / abbreviation difference ("ABC Corp" vs "ABC Corporation") |

The actual thresholds are domain-specific. The developer user sets
them per field; the rule's design should leave room for the
configured values rather than hardcode percentages.

## Fraud-signal patterns the rule may surface

Some patterns are visible only at the case level:

- **Consistent small discrepancies across docs**: e.g., every doc
  inflated by ~5%, every date shifted by exactly one month.
  Consistency-in-error suggests coordinated fabrication rather than
  honest mistakes.
- **Suspicious doc consistency**: multiple docs from supposedly
  different issuers using identical formatting / phrasing / typos.
- **Values at regulatory thresholds**: LTV exactly at the limit, DTI
  exactly at the limit. One coincidence is harmless; a pattern across
  the case is a signal.
- **Temporal impossibilities**: income certificate issued before
  employment start; bank statement covering a period before account
  opening; appraisal dated after loan disbursement.

If the rule's job includes any of these, encode them. These are
**signals for escalation**, not conclusions — the rule should output
"flagged" with evidence, and let the developer user or downstream
review process determine the final verdict.

## Designing the case-walk in check.py

For a cross-doc rule, a typical check.py:

1. Receives the case (list of doc paths/handles + classification
   metadata).
2. Selects the **starting document** of the class declared in the
   rule.
3. Extracts the **anchor entity** (using entity-extraction).
4. Locates the **target document(s)** in the case by the anchor or by
   formal reference.
5. Extracts the **target entity** from each target doc.
6. Applies the **consistency check** per the rule's PASS criteria.
7. Returns:
   - verdict (PASS / FAIL / WARNING / NOT_APPLICABLE)
   - evidence (the cells of the comparison matrix that drove the
     verdict, with source-doc + page references)
   - confidence (per `confidence-system`)

The comparison matrix is rule-specific — only the fields this rule
needs. Building a generic "all entities × all docs" matrix is
expensive and pollutes the evidence trail.

## Integration

**Inputs to the rule's check.py at runtime:**
- Case structure (set of related documents + identifiers).
- Entity extraction available per-doc (skill: `entity-extraction`).
- Compliance judgment may have already produced per-doc verdicts
  (skill: `compliance-judgment`) that this rule can use as part of
  its inputs.

**Outputs:**
- A case-level verdict plus the comparison-matrix slice that justifies
  it.

**Feeds into:**
- `confidence-system`: cross-doc contradictions are a strong signal,
  often lowering confidence in affected fields.
- `evolution-loop`: recurring contradiction patterns the rule didn't
  anticipate trigger workflow refinement.
- `dashboard-reporting`: case-level view alongside per-doc results.

## Ground-truth principle

When the developer user or end user reports a cross-doc inconsistency
that this rule missed, that report is prior to agent judgment. Log
it, treat it as a corner case (`corner-case-management`) or as a
trigger for rule refinement, and adjust detection thresholds
accordingly. The rule's job is to catch what humans catch — and then
go further.
