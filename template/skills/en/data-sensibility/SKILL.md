---
name: data-sensibility
tier: meta
description: Build intuition about document data before writing extraction logic. Use before designing any extraction schema or regex pattern, when onboarding a new document type, or when extraction accuracy is unexpectedly low and you suspect a data assumption is wrong. Covers systematic observation of raw documents, spot-checking extracted results, distribution analysis, and recognizing suspicious patterns. If you are about to write code that touches document data and you have not read at least five documents end-to-end, stop and use this skill first.
---

# Data Sensibility

The most expensive errors in document verification come from assumptions about data that do not hold. You assume dates are in YYYY-MM-DD because the first three documents used it — then document four uses DD/MM/YYYY and every extraction is silently wrong. Data sensibility is the discipline of looking before coding.

## Front-Load Observation

Read 3-5 complete documents end-to-end before writing any extraction logic. Not skim — read. Open the raw parsed text, start at page one, and go to the end.

While reading, note what surprises you:
- A field you expected in a table is buried in a paragraph.
- Amounts appear in both Chinese uppercase and digits, sometimes on the same page.
- The document has two signature pages, not one.
- Section headings use inconsistent numbering schemes.
- A "standard" field like interest rate is expressed three different ways across five documents.

Read with a text editor, not a PDF viewer. You need to see what the extraction code will see — parsed text with all its artifacts, not the pretty rendered version. If your pipeline starts with OCR, read the OCR output.

Do this for each new document type. Do it again when document sources change. 30 minutes of reading saves 3 hours of debugging extraction logic that was built on wrong assumptions.

## Systematic Observation Checklist

After reading, answer these questions explicitly — write the answers down, not just think them:

**What is consistent across all documents?** Header structure, field positions, terminology, date formats. These are your anchors. Design extraction around them.

**What varies?** Table layouts, section ordering, field presence, formatting conventions. These are your risk points. Every variant needs a test case.

**What is surprising?** Anything you did not expect. A field that is sometimes missing. A value expressed in different units across documents. A section that appears in some templates but not others.

**Document subtypes?** Are there different templates, issuers, or time periods represented? A "loan contract" from Bank A may look nothing like one from Bank B. Identify subtypes early — they often need separate extraction paths.

**Section lengths?** Measure them. A section that averages 200 tokens is fine for any model. A section that occasionally runs to 8,000 tokens will blow your context window budget. Plan accordingly.

**Encoding issues?** Full-width vs half-width characters (１２.５% vs 12.5%). Unicode normalization problems. OCR artifacts. These cause silent extraction failures because the text looks correct to human eyes but does not match regex patterns.

## Spot-Check Protocol

After any extraction run, pick 10 random fields and verify manually against the source document. Not the easy ones — select across the confidence spectrum: 3 high-confidence, 4 medium, 3 low.

For each field, check:
- **Value correct?** Does the extracted value match what the document says?
- **Source location correct?** Did the extraction find the value in the right place, or did it grab a similar value from somewhere else?
- **Normalization correct?** If the raw text says "伍仟万元" and your output says 50000000, is that right?
- **Type correct?** Did a percentage end up as a decimal? Did a date parse into the wrong century?

If more than 1 out of 10 is wrong, stop. Do not continue processing the batch. Investigate the failures, identify the pattern, fix the extraction, and re-run. A 10% spot-check error rate implies a much higher overall error rate — you have not seen the errors that look correct but are not.

## Distribution Visualization

After extraction, visualize key field distributions. You do not need fancy tools — basic Python is enough.

**Field lengths.** If a "contract number" field is usually 12-16 characters but some are 3 or 200, those outliers are almost certainly wrong extractions.

**Value frequencies.** Run `Counter(values).most_common(20)` on categorical fields. Suspicious concentrations (one value appearing 90% of the time when you expect diversity) suggest extraction is grabbing a header or default value instead of the actual data.

**Missing rates.** If a field that should be present in every document is missing in 30% of results, your extraction is failing silently. Missing data is the easiest signal to detect and the most commonly ignored.

**Numeric ranges.** Plot or bucket numeric fields. Loan amounts should be positive and within a plausible range for the business. Interest rates should be between 0% and 30%, not 0.03 (forgot to multiply) or 3000 (grabbed the wrong column). Even a quick histogram of numeric field values will reveal bimodal distributions (two document subtypes?), impossible values (negative loan amounts?), or truncation artifacts.

## Smelly Patterns

Some extracted values look correct individually but form suspicious patterns in aggregate:

- **Suspiciously round amounts.** Every loan is exactly 1,000,000.00 or 5,000,000.00. Possible in reality (banks do round), but worth verifying — you might be extracting a template placeholder.
- **Date clusters.** All contracts signed on the 1st of the month. All documents dated the same day. May indicate you are extracting a print date instead of a signature date.
- **Identical unique fields.** Multiple documents sharing the same contract number or borrower ID. Either a data quality issue upstream or an extraction error.
- **Values at regulatory thresholds.** Capital adequacy at exactly 8.00%. Loan-to-value at exactly 70.00%. These may be real (institutions manage to thresholds), or they may be artifacts of extracting the threshold definition instead of the actual value.
- **Perfect consistency.** Every single document passes every single rule. Real data has exceptions. If your system reports 100% compliance, your system is probably wrong.

These patterns may be real. They may be artifacts. The point is to notice them and investigate.

## Intermediate Output Materialization

Save every processing stage to disk:
1. Raw parsed text (from document parsing).
2. Tree-chunked sections (from tree processing).
3. Extracted entities (from entity extraction).
4. Judgment results (from compliance judgment).

Write intermediate results as JSON files in a `debug/` directory, named by document ID and stage:

```
debug/
  DOC001_01_raw_text.json
  DOC001_02_tree_sections.json
  DOC001_03_extracted_entities.json
  DOC001_04_judgments.json
```

Disk is cheap. Debugging without intermediates is guesswork.

When something goes wrong — and it will — you can inspect each stage independently. Was the section split wrong? Was the extraction correct but the judgment wrong? Was the raw text garbled by OCR? Without intermediates, you are reduced to staring at the final output and guessing.

Keep intermediates for at least the current iteration. Delete old iterations only when disk space becomes a real constraint.

## Looking at the corpus when it doesn't fit in your head

A foundational constraint to plan around: you have a finite context window. Reading dozens of sample documents in a row will push earlier observations out of your working memory before you finish, leaving you with the impression of having seen the corpus but not the ability to actually generalize from it.

Treat the corpus the way a statistician would treat a population: sample, summarize, and don't try to keep the population in your head. A few approaches that work in practice:

- **Use the file system as memory.** Write a `notes/data_observations.md` (or per-rule `notes/<rule_id>_observations.md`) as you scan. Note field name variants, format quirks, missing-section patterns, surprising values. Re-read the notes file next session instead of re-scanning the docs.
- **Per-rule notepads / memory.md.** For each rule, keep a short `memory.md` that captures "what I've seen across the sample set for this rule" — which documents trigger it, what values appear, what edge cases exist. Update incrementally rather than re-deriving it each time you look at the rule.
- **Dispatch subagents to explore samples.** When the corpus is large, send a subagent (via the `agent_tool`) to scan a directory and return summary statistics or a short markdown report. The subagent's full reads stay in its own context; you receive only the digest. This is the right tool when you'd otherwise spend context budget reading dozens of files for a single observation.
- **Statistical / meta views over individual reads.** Instead of reading 20 income certificates, run a regex over all of them and count format variants. Instead of opening every annual report, list filenames and group by issuer / year. Build the meta view first, then dive into representatives.

The principle: aim for **enough samples to characterize the distribution**, not enough samples to memorize the corpus. The former fits in your head and in your notes. The latter doesn't.

## Integration

Feed your observations into downstream skills:
- `entity-extraction`: Your observations about data formats, field variants, and encoding issues directly inform schema design and regex patterns.
- `skill-authoring`: Edge cases and known variants you discover here become test cases and special handling in rule skills.
- `confidence-system`: Your spot-check results and distribution analysis calibrate initial confidence expectations.
- `evolution-loop`: Revisit data sensibility whenever the evolution loop reveals unexpected failures — the data may have changed, or your initial observations may have been incomplete.

Data sensibility is not a one-time activity. Every new batch, every new document source, every format change is an occasion to look before coding.
