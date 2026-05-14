# QA Layer Specifications

Detailed specifications for the five-layer QA architecture. Each layer builds on the one below it.

## Layer Details

### L1: Text Integrity

- **Description**: Verify that source files exist, are readable, and that text content is preserved correctly after any processing (parsing, OCR, conversion).
- **Input**: Raw document files and their processed text output.
- **Output**: Pass/fail per file with error details.
- **Example checks**: File exists and is non-empty. Encoding is UTF-8 (or declared encoding). No null bytes in text output. Character count is within expected range for document type.
- **Common failures**: File path changed after processing. OCR produced empty output. Encoding mismatch causes garbled characters.
- **Escalation**: If L1 fails, do not proceed to higher layers. Log the failure and flag for reprocessing.

### L2: Syntax

- **Description**: Verify that output files conform to their declared format and schema.
- **Input**: Output files (JSON, CSV, etc.) from workflows.
- **Output**: Pass/fail per file with parse errors or schema violations.
- **Example checks**: JSON is valid (parses without error). Required top-level keys exist. Array fields are arrays, not strings. Date fields match ISO 8601 format.
- **Common failures**: Trailing comma in JSON. Missing closing bracket. CSV with inconsistent column count. Unexpected null where value is required.
- **Escalation**: Syntax failures indicate a bug in the output generation code. Fix the code, not the data.

### L3: Data Completeness

- **Description**: Verify that required data fields are populated with values in their valid domain.
- **Input**: Parsed output records.
- **Output**: Per-field validation results with reasons for any failures.
- **Example checks**: Invoice date is a valid date (not "N/A" or empty). Amount is a positive number. Entity name is non-empty and does not contain only whitespace. Enum fields contain allowed values.
- **Common failures**: Extraction returned "unable to determine" as a value. Amount includes currency symbol (string instead of number). Date extracted as partial (month and day but no year).
- **Escalation**: Completeness failures feed back to extraction prompt improvement. If a field is consistently incomplete, the extraction logic needs work.

### L4: Business Logic

- **Description**: Verify cross-field consistency and compliance with business rules.
- **Input**: Complete, validated records from L3.
- **Output**: Per-rule validation results with reasoning.
- **Example checks**: Contract end date is after start date. Invoice date falls within contract validity period. Total amount equals sum of line items. Signatory name matches authorized personnel list.
- **Common failures**: Date comparison fails due to timezone differences. Rounding errors in amount calculations. Cross-reference lookup fails because entity names differ slightly (e.g., "ABC Corp" vs "ABC Corporation").
- **Escalation**: Business logic failures may indicate rule misunderstanding. Consult the developer user if the rule intent is ambiguous.

### L5: Cross-Phase

- **Description**: Verify consistency across different phases of the verification pipeline.
- **Input**: Outputs from multiple pipeline stages (extraction, verification, reporting).
- **Output**: Cross-phase consistency report.
- **Example checks**: Entities in final results match those in extraction output (nothing added or dropped). Rule IDs in results exist in the rule catalog. Workflow output for a skill matches the skill's own ground truth output. Confidence scores in results match those computed by the confidence system.
- **Common failures**: A rule was added to the catalog but the workflow was not updated to include it. Extraction found 5 entities but results only report 4. Workflow output diverges from skill ground truth on edge cases.
- **Escalation**: Cross-phase failures often indicate integration issues. Check the pipeline connections, not individual components.

## Script Naming Convention

| Prefix | Layer | Purpose | Examples |
|--------|-------|---------|----------|
| `lint_` | L1-L2 | Fast, syntactic checks | `lint_json.py`, `lint_encoding.py`, `lint_schema.py` |
| `validate_` | L3-L4 | Domain and logic validation | `validate_fields.py`, `validate_dates.py`, `validate_amounts.py` |
| `cross_validate_` | L5 | Cross-phase consistency | `cross_validate_extraction.py`, `cross_validate_rules.py` |

Scripts should:
- Accept a file or directory path as input.
- Output structured JSON results (pass/fail per check, with reasons).
- Return exit code 0 if all checks pass, non-zero otherwise.
- Be idempotent — running twice produces the same result.

## QC vs Reflection

| Dimension | QC (this skill) | Reflection (evolution-loop) |
|-----------|-----------------|---------------------------|
| **Who runs it** | Coding agent or automated scripts | Coding agent |
| **What triggers it** | Every batch, on schedule | QC failures, accuracy drops |
| **Input** | Workflow outputs | QC reports, failure logs, iteration history |
| **Output** | Pass/fail verdicts, accuracy metrics | Root cause diagnosis, fix proposals |
| **Cost** | Low (mostly scripts, some LLM at L4-L5) | Higher (deep analysis, prompt rewriting) |
| **When to use** | Always — every production batch | Only when QC reveals problems |
| **Goal** | Detect problems | Fix problems |

QC without Reflection detects issues but cannot fix them. Reflection without QC has no data to work from. They are complementary, not alternatives.

## Integration Points

### With `data-sensibility`

The `data-sensibility` skill provides input validation that feeds L1-L3. If data-sensibility checks flag a document as anomalous before processing, QC can prioritize reviewing that document's outputs. Data-sensibility operates on inputs; QC operates on outputs. Together they bracket the pipeline.

### With `cross-document-verification`

Cross-document verification enables L5 cross-doc consistency checks. When multiple documents reference the same entity (e.g., same contract number across invoice and purchase order), L5 can verify that extracted values are consistent across documents. Without cross-document verification, L5 is limited to single-document cross-phase checks.

### With `confidence-system`

QC results calibrate the confidence system. When QC reveals that high-confidence results are sometimes wrong, the confidence thresholds need adjustment. Conversely, confidence scores drive QC sampling — low-confidence results get more review. This creates a feedback loop: QC improves confidence calibration, better calibration improves QC efficiency.
