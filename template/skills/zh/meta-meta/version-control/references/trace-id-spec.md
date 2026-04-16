# Trace ID Specification

Trace IDs embed source evidence pointers directly inside verification results. This document defines the format, generation rules, and integration points.

## Format

```
{rule_id}-{document_id}-P{page}-S{section}-C{char_start}:{char_end}
```

| Segment | Description | Example |
|---------|-------------|---------|
| `rule_id` | The rule that produced this result. Matches the ID in `rule-catalog.json`. | `R001` |
| `document_id` | A short identifier for the source document. Derived from filename or batch assignment. | `DOC042` |
| `P{page}` | The 1-indexed page number where the source evidence appears. | `P3` |
| `S{section}` | The section number within the page, following the document's own numbering. | `S2` |
| `C{char_start}:{char_end}` | Character offset range within the extracted text block that constitutes the evidence. | `C120:180` |

Full example: `R001-DOC042-P3-S2-C120:180`

When a rule draws evidence from multiple locations, generate one trace ID per location and store them as an array in the result.

## Generation

Trace ID generation is **deterministic**: the same rule applied to the same document at the same location always produces the same trace ID. This is achieved by deriving every segment from stable inputs:

- `rule_id` comes from the rule catalog.
- `document_id` comes from the document's filename or a developer-user-assigned identifier.
- Page, section, and character range come from the extraction step.

Trace IDs are generated at verification time, immediately after entity extraction identifies the source location. They are never modified after creation. Re-verifying the same document produces new result records with new timestamps but identical trace IDs (because the source location has not changed). If the document is modified, the new version gets a new `document_id`, producing different trace IDs.

## Collision Avoidance

The combination of rule ID + document ID + page + section + character range makes collisions astronomically unlikely in practice. Two different pieces of evidence would need to match on all five segments simultaneously.

If document IDs are not guaranteed unique across batches (e.g., multiple batches contain files named `report.pdf`), prefix the document ID with the batch identifier: `B003-DOC042`. This extends the trace ID format to `R001-B003-DOC042-P3-S2-C120:180`.

Do not use random UUIDs. Deterministic trace IDs allow deduplication and comparison across verification runs.

## Storage Overhead

A single trace ID string is approximately 30-50 bytes. The full trace ID object (including `source_location`, `rule_version`, `workflow_version`, and `model_tier`) is approximately 100-200 bytes in JSON.

For a typical batch of 1000 verification results, trace IDs add roughly 100-200 KB of storage. This is negligible relative to the result data itself and the source documents.

## Surviving Export/Re-Import

Trace IDs are embedded in the result JSON structure, not stored in external metadata, sidecar files, or database columns that might be lost during export.

Any system that consumes the verification result JSON automatically receives the trace IDs. Specific scenarios:

- **CSV export**: The `trace_id` field becomes a column. A developer user reviewing results in a spreadsheet can copy a trace ID and paste it back to locate the source evidence.
- **Aggregation**: When results from multiple batches are merged, trace IDs remain attached to their individual results. No re-linking is needed.
- **Downstream APIs**: Systems consuming verification results via API receive trace IDs as part of the payload. They can store, index, or display them without any awareness of the trace ID format.
- **Archival**: Archived results retain full traceability years later, even if the original verification system has evolved.

## Integration with Cross-Document Verification

When `cross-document-verification` detects a contradiction between two documents, reference trace IDs from both sides:

```json
{
  "contradiction": {
    "field": "total_assets",
    "document_a": {
      "trace_id": "R005-DOC042-P7-S1-C200:260",
      "value": "1,234,567"
    },
    "document_b": {
      "trace_id": "R005-DOC043-P3-S2-C80:140",
      "value": "1,234,590"
    },
    "discrepancy": "23"
  }
}
```

This creates a linked evidence chain: auditors can follow both trace IDs to the exact locations in both documents, verify the extracted values, and determine which document (if either) is correct. Without trace IDs, cross-document contradictions require manual search through both documents to find the relevant passages.
