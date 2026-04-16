# Contradiction Taxonomy

Field-level reference for cross-document contradiction detection. Use this taxonomy to configure comparison rules per field type.

## Identity Fields

| Field | Match Type | Tolerance | Severity | Notes |
|-------|-----------|-----------|----------|-------|
| Full name | Fuzzy | Abbreviation, spacing, honorifics | Critical | "Zhang Wei" vs "Zhang W." is fuzzy match; "Zhang Wei" vs "Li Ming" is hard fail |
| ID number | Exact | None (zero tolerance) | Critical | Single-digit difference = different person or transcription error — both critical |
| Date of birth | Exact | None | Critical | Cross-check against ID number encoding where applicable |
| Address | Fuzzy | Abbreviation, floor/unit formatting | Medium | "Rm 1201, Bldg A" vs "Room 1201, Building A" is acceptable |
| Phone number | Exact | Country code prefix | Medium | +86 prefix presence/absence is tolerated |
| Company name | Fuzzy | Ltd/Co/Inc suffix, punctuation | High | Must match on core name; suffix variation tolerated |

## Financial Fields

| Field | Comparison Method | Tolerance | Severity | Notes |
|-------|------------------|-----------|----------|-------|
| Stated income | Cross-document | 10% relative | High | Application vs income certificate vs credit report |
| Bank avg deposits | Income plausibility | 50% of stated income (floor) | High | If avg deposits < 50% of claimed income, flag |
| Loan amount | Exact across docs | 0.1% relative | Critical | Must be identical in application and contract |
| Property value | Appraisal consistency | 5% relative | High | Application estimate vs formal appraisal |
| Existing debt | Cross-source | 20% relative | Medium | Self-reported vs credit report |
| Net assets | Calculated consistency | Sum of components vs stated total | High | Assets - liabilities must equal stated net |
| Contract total vs line items | Sum check | 0.01 absolute | Critical | Main contract total must equal appendix line item sum |

## Temporal Fields

| Field | Consistency Check | Tolerance | Severity | Notes |
|-------|------------------|-----------|----------|-------|
| Employment start date | Cross-document match | 90 days | Medium | Application vs income cert vs credit report |
| Contract signing date | Sequence plausibility | Must be after application date | High | Cannot sign before applying |
| Document issuance date | Freshness and sequence | Per business rule (typically 30-90 days) | Medium | Income cert issued 6 months ago may be stale |
| Loan maturity date | Contract consistency | Exact match across docs | High | Application vs contract vs amortization schedule |
| Appraisal date | Sequence plausibility | Must precede loan approval | Medium | Appraisal after disbursement is a red flag |

## Logical Consistency Checks

These are not single-field comparisons but cross-field logical validations:

- **LTV ratio consistency**: Property value x LTV % should equal or exceed loan amount. Check across appraisal, application, and contract.
- **DTI ratio reasonableness**: Monthly debt payments (from credit report) + proposed payment / monthly income (from income cert) should not exceed the stated DTI or regulatory limit.
- **Timeline plausibility**: Employment start < income cert issuance < application date < contract signing < disbursement. Any violation of this sequence is a finding.
- **Appendix completeness**: Every appendix referenced in the main contract must be present in the case file. Every appendix present must be referenced in the main contract.
- **Guarantor cross-check**: If a guarantor is listed, their identity fields must also pass cross-document verification against any guarantor-specific documents.
- **Amount decomposition**: If the contract specifies principal + interest + fees, these must sum to the total obligation stated elsewhere.

## Comparison Matrix Template

Output schema for the case-level comparison matrix:

```json
{
  "case_id": "CASE-2024-0042",
  "documents": [
    {"doc_id": "DOC-001", "type": "loan_application", "source": "applicant"},
    {"doc_id": "DOC-002", "type": "income_certificate", "source": "employer"}
  ],
  "matrix": [
    {"field": "applicant_name", "category": "identity",
     "values": {"DOC-001": "Zhang Wei", "DOC-002": "Zhang Wei"},
     "status": "consistent", "severity": null}
  ],
  "contradictions": [
    {"field": "monthly_income", "documents": ["DOC-001", "DOC-002"],
     "values": [85000, 82000], "type": "hard_contradiction",
     "severity": "medium", "detail": "3.5% discrepancy in stated income"}
  ],
  "fraud_signals": [],
  "summary": {"total_fields_compared": 8, "consistent": 6, "soft_mismatch": 1, "hard_mismatch": 1, "absent": 0}
}
```
