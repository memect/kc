---
name: cross-document-verification
tier: meta
description: Perform case-level analysis across multiple documents for the same transaction. Use when documents do not exist in isolation — main contracts have appendices, loan applications come bundled with income certificates, bank statements, credit reports, and property appraisals. Use to build comparison matrices, detect contradictions (hard mismatches and soft implausibilities), classify severity, and flag fraud signals. Also use when user or end-user reports a cross-document inconsistency — these reports are ground truth and take priority over agent judgment.
---

# Cross-Document Verification

Single-document verification asks: does this document comply with the rules? Cross-document verification asks a different question: do all the documents in this transaction tell a consistent story?

This is the difference between a document checker and a case analyst. A document checker reviews files one at a time. A case analyst lays them all on the table and looks for the threads that connect — or contradict — each other. When you activate cross-document verification, you are upgrading the system from checker to analyst.

## The Case Concept

A case is the set of documents that belong to one transaction, one borrower, or one deal. Documents within a case share entities: names, dates, amounts, identifiers. These shared entities are your anchors for comparison.

Two common case patterns:

1. **Main contract + appendices/supplements.** Same issuer, formally cross-referenced. The main contract states the total, the appendices break it down. The main contract references Appendix B; Appendix B must exist and match. The team has extensive experience with inconsistencies in this pattern — totals that do not match line item sums, referenced appendices that are missing or outdated, version mismatches between main body and supplements.

2. **Multi-source bundle.** Loan application + income certificate + bank statement + credit report + property appraisal. Different issuers, different formats, same borrower. The applicant's name, ID number, income, and employment must be consistent across all documents.

In both patterns, the shared entities are the anchors. Every anchor that appears in more than one document is a candidate for cross-verification.

## Building the Comparison Matrix

The comparison matrix is the core artifact. Rows are shared fields. Columns are source documents. Each cell contains the value found in that document for that field, or is marked absent.

Example matrix for a loan case:

| Field | Application | Income Cert | Bank Statement | Credit Report |
|-------|-------------|-------------|----------------|---------------|
| Applicant name | Zhang Wei | Zhang Wei | Zhang Wei | Zhang W. |
| ID number | 310...1234 | 310...1234 | — | 310...1234 |
| Monthly income | 85,000 | 82,000 | avg 43,000 | — |
| Employer | ABC Corp | ABC Corp Ltd | — | ABC Corporation |
| Employment start | 2019-03 | 2019-06 | — | 2019 |

Example matrix for a contract + appendices case:

| Field | Main Contract | Appendix A | Appendix B |
|-------|---------------|------------|------------|
| Total amount | 5,000,000 | — | 4,850,000 (sum of items) |
| Party B name | Shenzhen XX Co. | Shenzhen XX Co., Ltd | Shenzhen XX Co. |
| Effective date | 2024-01-15 | 2024-01-15 | 2024-02-01 |

Populate the matrix using output from `entity-extraction`. An empty cell means the field was not found in that document — this is absence, not necessarily an error. But absence in a field that should be present is itself a finding.

## Contradiction Types

### Hard Contradictions

Exact mismatches in fields that must be identical across documents:

- **Identity mismatch**: Name spelled differently, ID number differs by digits, date of birth inconsistent.
- **Amount mismatch**: Main contract states 5,000,000 but appendix line items sum to 4,850,000. Income certificate says 82,000/month but application says 85,000/month.
- **Date mismatch**: Contract effective date in the main body differs from the date in an appendix.

Hard contradictions are binary. Either the values match (within defined tolerance) or they do not.

### Soft Contradictions

Values that are not directly inconsistent but are implausible when considered together:

- Monthly income claimed as 100,000 but bank statement average deposits are 5,000.
- Property appraised at 3,000,000 but loan amount is 2,800,000 (93% LTV — technically possible but suspicious).
- Employment start date 2019-03 on the application but 2019-06 on the income certificate — a 3-month gap that could be rounding or could be fabrication.

Soft contradictions require thresholds and judgment. They are findings, not verdicts.

### Cross-Reference Failures

Structural integrity problems within formally linked documents:

- Main contract references "Appendix B — Payment Schedule" but Appendix B is titled "Technical Specifications" or is missing entirely.
- Appendix references a clause in the main contract that does not exist in the provided version.
- Missing reciprocal reference: Appendix C references the main contract, but the main contract does not list Appendix C.
- Version mismatch: main contract dated January, appendix dated March with different terms.

See `references/contradiction-taxonomy.md` for the full field-level taxonomy with tolerances and severity classifications.

## Severity Classification

Not all contradictions are equal. Classify by impact:

| Severity | Criteria | Example |
|----------|----------|---------|
| **Critical** | Identity field mismatch | ID number differs between documents |
| **High** | Financial amount discrepancy > 10% | Income 85K vs bank avg 43K |
| **Medium** | Date or employment detail mismatch | Employment start date 3 months apart |
| **Low** | Formatting or abbreviation difference | "ABC Corp" vs "ABC Corp Ltd" |

The developer user sets severity thresholds per field in the project configuration. The defaults above are starting points. Adjust based on the business context — in some scenarios, a 5% amount discrepancy is critical; in others, 15% is acceptable.

## Fraud Signal Patterns

Cross-document analysis reveals patterns that single-document review cannot detect. Flag these — do not accuse, flag:

- **Consistent small discrepancies across documents.** Income inflated by exactly 5% in every document. Dates shifted by exactly one month. This consistency in error suggests coordinated fabrication rather than honest mistakes.
- **Suspicious document consistency.** Multiple documents from supposedly different issuers use identical formatting, identical phrasing, or identical typos. Legitimate documents from different organizations look different.
- **Values at regulatory thresholds.** LTV ratio at exactly 69.9% when the limit is 70%. DTI at exactly 49.8% when the limit is 50%. One occurrence is coincidence. A pattern across the case is a signal.
- **Temporal impossibilities.** Income certificate issued before the employment start date. Bank statement covering a period before the account opening date. Appraisal dated after the loan disbursement.

These are signals for escalation, not conclusions. Present them with evidence and let the developer user or downstream review process make the determination.

## Workflow Sequence

The recommended sequence for cross-document verification within a case:

1. **Identify the case boundary.** Which documents belong together? Use shared identifiers (borrower name, loan number, contract reference) to group documents into cases.
2. **Extract anchors.** Run `entity-extraction` on each document independently. Collect the shared fields.
3. **Build the matrix.** Populate the comparison matrix. Flag empty cells.
4. **Detect contradictions.** Apply hard/soft/cross-reference checks per `references/contradiction-taxonomy.md`.
5. **Classify severity.** Assign severity per the configured thresholds.
6. **Scan for fraud signals.** Run pattern checks across the matrix.
7. **Produce the report.** Output the case-level consistency report with all findings.

## Integration

**Inputs:**
- Entity extraction results from `entity-extraction` (the raw field values per document).
- Compliance judgment results from `compliance-judgment` (per-document pass/fail already computed).

**Outputs:**
- Case-level consistency report: the comparison matrix, all contradictions found, severity classifications, and fraud signal flags.

**Feeds into:**
- `confidence-system`: Cross-document contradictions lower confidence in affected fields.
- `evolution-loop`: Recurring contradiction patterns trigger workflow refinement.
- `dashboard-reporting`: Case-level view alongside document-level results.

**Ground truth principle:** User and end-user contradiction reports feed back as ground truth. When a user or end-user reports a cross-document inconsistency that the system missed, that report is prior to agent judgment. Log it, learn from it, and adjust detection thresholds accordingly. The system's job is to catch what humans catch — and then go further.
