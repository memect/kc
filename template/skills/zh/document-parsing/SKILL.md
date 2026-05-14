---
name: document-parsing
tier: meta
description: Parse source documents into machine-readable text with maximum fidelity. Use when processing any document in Samples/ or Input/ for the first time, when parsed text quality is poor, or when tables and charts need special handling. Covers multi-level parser selection from simple text extraction to OCR and vision models. Also use when a verification rule fails due to parsing issues (garbled text, missing tables, mangled layouts) and the parser needs to be upgraded for that document type.
---

# Document Parsing

Parsing is the foundation. If the text is wrong, everything downstream is wrong. But parsing is also a cost center — do not use expensive vision models when simple text extraction works.

## The Minimum Viable Parser Principle

Start with the simplest parser. Escalate only when necessary. This is not about saving money — it is about producing the most reliable output. Simple parsers have fewer failure modes.

### Level 1: Direct Text Extraction
- Tool: pdfjs-dist or similar PDF text extraction.
- When: Well-formed digital PDFs with embedded text. This covers most modern business documents.
- Output: Raw text with basic structure preserved (paragraphs, basic formatting).
- Limitations: Tables may come out as messy text. Charts and images are invisible. Scanned PDFs produce nothing.

### Level 2: Provider VLM (Vision Language Model)
- Tool: VLM models from configured provider (VLM_TIER3 for cheap OCR, VLM_TIER1 for complex interpretation).
- When: Level 1 produces garbled/incomplete text, scanned PDFs, image-based PDFs.
- Output: Recognized text from page images, or structured interpretation (table as markdown, chart data as JSON).
- Calling a provider VLM is more convenient and reliable than deploying local OCR. Use the cheapest VLM tier first; escalate to a more capable tier for complex tables/charts.

### Level 3: MineRU API or Local Tools (Optional)
- Tool: MineRU API, pdfplumber, or locally deployed OCR — if configured.
- When: Provider VLM is unavailable or too expensive for batch processing.
- These are optional fallbacks. Most users will use Level 1 + Level 2.

## Quality Detection

How to know when to escalate:

- **Low character count**: The document has pages but extracted text is very short. Likely a scanned PDF.
- **Garbled text**: Unusual character sequences, encoding errors, or meaningless text patterns.
- **Missing expected sections**: The table of contents mentions Chapter 5 but no Chapter 5 text was extracted.
- **Table artifacts**: Columns of numbers without alignment, cell content mixed with headers, or table borders appearing as characters.
- **Missing numbers in financial tables**: If a financial document's key metrics are not in the extracted text, the tables were probably not parsed.

Write a quick quality check after parsing and before proceeding. If quality is insufficient, escalate to the next parser level.

### Parse Quality Score

Compute a quality score (0.0 to 1.0) from weighted heuristics to make escalation decisions systematic rather than ad-hoc. A recommended starting framework:

- **Character density** (weight ~0.3): actual character count / expected characters for the document's page count. A 10-page PDF that yields only 200 characters likely failed.
- **Garble ratio** (weight ~0.2): fraction of characters that are common CJK/Latin vs control characters, unusual sequences, or encoding artifacts.
- **Section completeness** (weight ~0.3): if the document has a table of contents, what fraction of TOC entries have matching content in the extracted text?
- **Table integrity** (weight ~0.2): for financial documents, are key numeric values that should appear in tables actually present in the extracted text?

**Escalation thresholds** (recommended defaults — adjust freely):
- Score >= 0.7: accept this parser level, proceed to downstream processing.
- Score 0.4-0.7: escalate to the next parser level, re-parse, re-score.
- Score < 0.4: skip directly to Level 3 (OCR) or Level 4 (vision) depending on document characteristics.

**Lock-in**: once a parser level produces an acceptable score for a document type, record that level. Do not re-evaluate unless a downstream verification failure is traced back to a parsing issue.

These weights, thresholds, and the scoring approach itself are starting points. The coding agent should design whatever quality assessment works for the specific document types at hand — a simple pass/fail heuristic may be sufficient for some scenarios; a more nuanced scoring function may be needed for others. The important pattern is: **measure quality → compare to threshold → decide whether to escalate**.

This follows the same tier-transition pattern as model tier selection in `skill-to-workflow`: a quality/accuracy score drives the decision to stay, escalate, or skip tiers.

## Table Handling

Tables are critical in financial documents (balance sheets, ratio tables, compliance metrics). They deserve special attention:

1. **Detection**: Identify table regions. Look for grid patterns, consistent column spacing, or explicit table markers.
2. **Extraction**: Extract cell-by-cell content. Preserve the row-column relationship.
3. **Reconstruction**: Convert to a structured format (markdown table, JSON array of rows, or CSV).
4. **Validation**: Spot-check that key values in the reconstructed table match what is visible in the document.

When the standard parser fails on tables, try the vision model approach: send the table image (cropped from the PDF page) to a vision model and ask it to produce a markdown table.

## Chart Handling

Charts (bar charts, line charts, pie charts) occasionally contain data needed for verification:

- Extract the chart image from the document.
- Send to a vision model with a prompt: "Extract the data points, labels, and values from this chart. Return as a JSON array."
- Validate the extracted data against any nearby text or table that might contain the same numbers.

This is expensive. Only do it when a verification rule specifically requires data from a chart and that data is not available in text elsewhere in the document.

## Output Format

Parsed documents should be saved as clean markdown:

- Preserve the document's heading hierarchy (# Chapter, ## Section, ### Subsection).
- Preserve lists, numbered or bulleted.
- Convert tables to markdown table format.
- Note page boundaries if relevant (some rules reference specific pages).
- Strip noise: headers, footers, page numbers, watermarks (unless a rule specifically checks for them).

Save parsed output alongside the original document for reuse across rules.

## Caching

Parsing is expensive (especially Level 3-4). Cache parsed output:
- Store the parsed markdown alongside the original file.
- Track which parser level produced it.
- Re-parse only when: the original file changes, a rule requires higher-quality parsing than what is cached, or a verification failure is traced back to a parsing issue.
