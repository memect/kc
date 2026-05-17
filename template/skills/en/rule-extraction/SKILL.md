---
name: rule-extraction
tier: meta
description: Extract and organize business verification rules from regulation documents into discrete, testable units. Use when processing documents in Rules/ to identify individual verification rules, when decomposing a regulation into atomic checks, or when the developer user adds new regulation files. Covers reading regulation text, identifying rule boundaries, determining granularity, handling cross-references, and producing a rule catalog. Also use when rules are provided in structured formats like xlsx or csv.
---

# Rule Extraction

Rules are the atoms of verification. Each rule you extract will become its own skill folder, its own workflow, and its own production pipeline.

## How This Differs from Data Extraction

Rule extraction is a **one-off task** at the start of a project. You read regulation documents and decompose them into discrete, testable rules. This is fuzzy, agile work — rules are read by you (a SOTA agent), so the schema can be messy and evolve freely.

Data/entity extraction (`entity-extraction`) is the **repeating task** that runs on every document being verified. It must fit a unified, stable schema because it feeds into automated workflows.

Don't conflate the two. Rule extraction happens once; data extraction happens on every document.

## Source-first sequencing

Extract rules from the source text FIRST. Only after you have a complete first-pass catalog from sources alone should you open sample documents. The temptation is to peek at samples early to "see what kinds of rules matter" — this biases you toward rules the samples happen to exercise and silently drops rules the samples don't cover.

A domain professional reads the source material, builds an understanding, then validates on samples — not the reverse. KC's differentiator over general-purpose agents is systematic accuracy across long context; that advantage compounds when you ground in the SOURCE not the EXAMPLES.

## Rule Structure: Location → Extraction → Judgment

Every verification rule decomposes into three parts:

1. **Location**: Where in the document to look (which chapter, section, table, or full document).
2. **Extraction**: What data to pull from that location (a number, a date, a clause, a description).
3. **Judgment**: How to determine pass/fail (threshold comparison, semantic assessment, cross-field check).

When extracting a rule, explicitly note all three parts. This determines the downstream pipeline structure:
- Full-document rules need no location step.
- Single-section rules need one location step.
- Cross-section rules (comparing values across chapters) need multiple location steps.

Classify each rule's scope accordingly — it affects how the verification workflow is structured.

## Philosophy

A well-extracted rule is:
- **Atomic**: it checks one thing. "The borrower's debt-to-income ratio must not exceed 50%" is one rule. "The loan agreement must comply with Regulation X" is not — it is a container for many rules.
- **Testable**: given a document, you can definitively say whether the rule passes or fails (or is not applicable).
- **Self-contained**: the rule's meaning does not require reading ten other rules to understand. Cross-references should be resolved into the rule's description.
- **Scoped**: you know WHERE in the document to look. "Chapter 3, Section 2" or "the risk disclosure section" or "the signature page."

But perfection is the enemy of progress. Extract rules at the granularity that feels right for the regulation and the business scenario. You will iterate. The developer user will tell you if rules are too coarse or too fine.

## Rule Schema Design Principles

Individual rules should be atomic and testable (above). The rule catalog as a whole must also satisfy system-level properties:

### Coverage Target
Extracted rules should cover at least 95% of the regulation's checkable requirements. After initial extraction, perform a coverage audit: read the source regulation end-to-end and mark which paragraphs are covered by at least one rule. Uncovered paragraphs are either non-checkable (definitions, context) or gaps to close.

### Atomicity Test
One rule = one pass/fail outcome. If a rule can produce two independent pass/fail results, it should be two rules. Ask: "Can this rule partially pass?" If yes, decompose further.

### Ambiguity Minimization
No two rules should produce contradictory results on the same document. After extraction, review rule pairs that touch overlapping scope. If Rule A says pass and Rule B says fail for the same entity, their scope boundaries are unclear — fix them.

### Downstream Anticipation
Rules will be distilled into workflows (see `skill-to-workflow`). Design with distillation in mind: clear input/output boundaries, explicit judgment criteria, minimal reliance on implicit domain knowledge. If a rule requires reading between the lines, make the interpretation explicit. Use `task-decomposition` to identify natural boundaries between rules.

### Catalog Versioning
When rules change (additions, modifications, deprecations), version the entire rule catalog as a unit. Individual rule versions track specific rules; the catalog version tracks the coherent set. Record the catalog version in `versions.json` alongside individual rule versions.

## Granularity Calibration (read before extracting)

Rule catalogs come from diverse source materials — formal regulations, internal handbooks, case law, legal opinions, expert rule tables, regulator Q&A. There is no universal "right number of rules per page". Calibrate by logic, not by count:

- **Atomicity is the real test.** A rule that can produce two independent pass/fail outcomes is two rules. A rule whose verdict requires verifying three different paragraphs of the source is probably three rules.
- **Boilerplate is not a rule.** Definitions, scope statements, transitive references to other regulations, and procedural language that can't be checked against the target document do not become rules.
- **Keep only checkable obligations, prohibitions, and thresholds** — things where you can read a target document and say pass / fail / not-applicable.

If your first pass feels too coarse (one rule per chapter, ignoring multiple distinct obligations within) — go finer. If it feels too fine (every clause in a definitions section is its own rule) — merge or drop. Then:

- **Merge rules that share evidence and fail together** (e.g., "must disclose X" and "must disclose Y" where both come from the same required-fields table → one rule: "must disclose the required-fields list including X, Y").
- **Drop procedural language** that isn't checkable against a target document.
- **Convert each surviving rule into a falsifiability statement** — if you can't state precisely what would make it fail, you don't have a rule yet.

### Sample "good" rule

```json
{
  "id": "R014",
  "source_ref": "Disclosure Reg §15.2",
  "description": "Quarterly reports must be disclosed within 15 business days after quarter-end.",
  "applicable_sections": ["public funds"],
  "severity": "high",
  "machine_checkable": true,
  "falsifiability_statement": "If disclosure date is later than 15th business day after quarter-end, the rule fails.",
  "test_case_stub": "Read the quarterly report's disclosure date + the quarter-end date, compute business-day difference."
}
```

Note: one pass/fail outcome, a single `source_ref` to a specific clause, clear applicability scope. Skill-authoring can write `check_r014.py` from this alone.

### Cross-source dedup (when working across multiple documents)

If the developer user provides N source documents, rules from later sources often duplicate cross-cutting requirements already captured by earlier ones (e.g., a generic disclosure rule from an older regulation vs. a newer specific version of the same obligation). Before emitting a rule from source N:

1. **Check the existing catalog.** Use `rule_catalog` (operation: list) to see what's already there. Skip if a rule with equivalent scope + intent exists.
2. **Prefer the newer / more specific source_ref** when rules overlap.
3. **If you merged rules**, record the consolidated sources in `source_ref`: e.g., `"New Reg §15.2 + Old Reg §24"`.

### Delegation to sub-agents

If you dispatch extraction to sub-agents (one per source document), the sub-agent inherits ONLY its `task_description` — it cannot see your conversation or existing catalog. Therefore, when composing the brief:

- **Anchor calibration with a concrete sample rule.** Paste the JSON above verbatim into the brief body so the sub-agent's atomicity calibration matches yours.
- **Name every source document the sub-agent should process.** If AGENT.md lists 10 core source documents, the brief must list all 10 by name, not "the core regs" as a pronoun — LLMs composing long structured briefs frequently drop items silently.
- **State the dedup contract**: "Rules already in the parent's catalog (R001–Rnnn) should NOT be re-extracted. If a requirement is already covered, skip it." Then pass the current catalog's ID ranges.
- **Prefer `rule_catalog` create operations over sandbox_exec writes to catalog.json.** rule_catalog uses workspace file locking; sandbox_exec bypasses it and races with other writers.

## How to read source files (default: read whole)

Source documents are the catalog's authoritative basis. Every `source_ref` in your extracted rules must be verifiable against the source text. For typical source documents (a single file under ~50 KB / under ~100 pages), **read each source file whole using `workspace_file` (operation=read) in a single call**:

```js
workspace_file({ operation: "read", scope: "project", path: "Rules/01_some_source.md" })
```

`workspace_file.read` is capped at 50,000 chars per call, which covers virtually every individual source document. This is the default. **Read every source file whole before you start extracting rules from any of them.**

### Tool choice — `workspace_file` vs `sandbox_exec`

| Tool | Per-call cap | Use for |
|---|---:|---|
| `workspace_file` (read) | 50,000 chars | **full reads of source / rule documents** |
| `sandbox_exec` (cat/head/etc) | 10,000 chars | shell commands, **not** full file reads |

`sandbox_exec` is designed for shell commands; its 10K cap is too small for most regulations. `cat rules/01_*.md` returns only the first ~10 KB followed by `\n[truncated]`. Re-issuing with `head -N` / `tail -M` to scroll the window loses positional precision and burns turns. **When you see truncation, don't fight the cap — switch tools.**

### Asymmetry — sources read whole, samples sampled

Source documents are limited (typically 1-10 files), authoritative, and read once. Read every source file whole.

Sample documents may number 30 to 1000+, are heterogeneous, and get read many times during testing. **Don't try to read every sample whole.** Use rule-applicability filters or sampled subsets to focus attention.

### Escape valve — when a single source exceeds ~200K chars

Rare in practice — most regulation, handbook, or rule-table documents fit comfortably under 50 KB. But if you do encounter a single source document so large that reading it whole would crowd the context window — heuristic: the file exceeds ~200,000 chars or ~25% of your context budget — use your own judgment:

- Read by chapter (e.g., `第X章` / `Chapter X`) using `document_parse` or paginated `workspace_file` reads
- Or build an in-workspace index file pointing to chapter offsets and read on-demand per rule being extracted

The 50 KB cap is high enough that this almost never triggers. **The default is read whole; deviate only when the file genuinely doesn't fit.**

## Extraction Strategies

### Strategy 1: Structured Input (Developer User Provides Rules)

When the developer user provides rules in xlsx, csv, or a structured document where each row/entry is a distinct rule with clear scope:
- Follow their structure exactly. Do not re-decompose.
- Map each row to a rule, preserving the developer user's identifiers.
- Ask clarifying questions only if entries are ambiguous.

### Strategy 2: Hierarchical Extraction from Source Text

For raw source documents (PDF, DOCX, legal text, handbooks, case collections):

1. **Survey the document structure.** Read the table of contents or scan headers. Understand the hierarchy: parts, chapters, sections, articles, clauses.

   Before extracting any rule, traverse the table of contents and section headers end-to-end. Sketch the rule-bearing hierarchy: which chapters impose obligations, which are definitions / context. A common failure mode: a long source with many articles yields disproportionately few rules — almost always meaning you stopped surveying after the high-density chapters. Decide your rule-bearing chapter span explicitly, then justify deviations relative to that span rather than to a single global count target.

2. **Identify rule-bearing sections.** Not every section contains a verification rule. Some are definitions, some are procedural, some are context. Focus on sections that impose obligations, prohibitions, thresholds, or requirements.
3. **Peel the onion.** Start at the highest structural level and work downward:
   - Level 1: What major areas does the regulation cover? (e.g., capital adequacy, risk disclosure, governance)
   - Level 2: Within each area, what are the specific chapters or sections?
   - Level 3: Within each section, what are the individual requirements?
   - Stop peeling when you reach atomic rules.
4. **Handle cross-references.** Regulations love to say "as defined in Section X" or "subject to the conditions in Article Y." Resolve these by including the referenced content in the rule's description, not just the reference.
5. **Handle compound rules.** "The report must include (a) risk factors, (b) financial projections, and (c) management discussion" — this is three rules, not one. Decompose unless the developer user specifically wants them grouped.

For long documents, use the onion-peeler approach — see the `document-chunking` skill for the full strategy and the wedge-driving fallback for sections without clear headers. Do not try to read the entire document in one pass.

### Strategy 3: Expert Notes

Sometimes rules come from the developer user's domain expertise rather than formal regulations:
- "We always check that the guarantor's signature matches the name on page 1."
- "If the collateral value is below 120% of the loan amount, flag it."

Capture these with the same rigor as formal regulation rules. They are equally important in the verification app.

## Rule Catalog

Maintain a lightweight catalog of all extracted rules. This is your index, not the rules themselves (those live in skill folders). The catalog should track:

- Rule ID (simple sequential: R001, R002, ...)
- Rule title (one line)
- Source (which regulation document, which section)
- Status (extracted / skill-written / skill-tested / workflow-written / workflow-tested / production)
- Dependencies (rules that must be checked before this one)

Format: a simple markdown table or JSON file. Do not over-engineer this. The catalog exists to give you and the developer user an overview of progress.

## Project Glossary

Alongside the rule catalog, build a project glossary — a living vocabulary of the entities, terms, and patterns the verification system encounters. The glossary is what keeps entity names consistent across rules: without it, the same balance-sheet item might be named "注册资本", "registered capital", and "paid-in capital" by three different rule skills, breaking shared-entity matching and producing inconsistent extraction outputs.

The glossary is not frozen at the end of extraction. It is a living document. Update it when you discover new aliases in samples, when a worker LLM extraction reveals a variant phrasing, when corner cases surface unfamiliar terminology. Both the coding agent and any operator can edit it.

### When to seed it

During rule extraction. As you decompose each rule, note the entities the rule references — capital ratios, signature pages, related-party transactions, dates, parties, monetary values. Seed the glossary with the canonical name and any aliases already visible in the source documents.

### Storage and shape

Save as `rules/glossary.json` next to `catalog.json`. Each entry is small:

```json
{
  "canonical": "registered_capital",
  "aliases": ["注册资本", "registered capital", "实收资本"],
  "definition": "The capital amount registered with regulators",
  "entity_type": "monetary_value",
  "seen_in": ["rules/regulation_A.pdf:p12", "samples/annual_report_2024.pdf:p3"],
  "status": "extracted"
}
```

Status field tracks maturity: `extracted` (from rules), `validated` (confirmed in samples), `production` (used by deployed workflows). Add or drop fields as the project demands — same JIT philosophy as the rule schema.

### How it integrates

- `rule-graph` consumes the glossary so `shares_entity` edges reference canonical labels rather than free-text strings.
- `entity-extraction` references the glossary for canonical names and known aliases when designing extraction logic.
- Skills authored under `skill-authoring` should use canonical names in their schemas.

How the glossary is used downstream is a per-project judgment. A mature glossary may enable cheap pattern-based matching for some entities; for others it just keeps naming consistent. Let the cost-accuracy logic in `entity-extraction` decide per case.

## Handling Ambiguity

Regulations are often ambiguous. When you encounter ambiguity:
1. Extract the rule as you understand it.
2. Note the ambiguity explicitly in the rule description.
3. Ask the developer user for clarification.
4. Update the rule after receiving clarification.

Do not skip ambiguous rules. They are often the most important ones.

## Sanity-check applicability against the sample corpus

> This is a validation pass, not a discovery pass. Do not let 0-sample rules tempt you to delete them at this stage — first ask whether the source requires them; if yes, keep them as "future scope" rather than drop.

After extracting your rule catalog and before authoring skills, do this 5-minute check: project each rule's applicability filter against the sample corpus.

For every rule:
1. Walk `samples/`, classify each by product type / report type / document format
2. For each rule, count how many samples it would apply to (per the rule's `applicability` field, scope filter, or whatever shape your catalog uses)
3. Flag rules that apply to **0 samples** — they're either genuinely test-corpus-irrelevant (acceptable) or over-constrained (bug)

A failure mode worth flagging: a catalog where a large fraction of rules (say 30-40%) return `PASS=0 FAIL=0 NOT_APPLICABLE=all` across the entire sample set. Some inactive rules are legitimate (the source requires checks for a product type the corpus doesn't happen to contain), but a high inactive ratio almost always signals scope-too-narrow drift — applicability filters that over-specify.

If many rules are 0-sample, either:
- **Reframe their applicability** — broaden product types, look for evidence in headers/footers not just body, relax the scope filter
- **Document them as "future scope"** and remove from this iteration's catalog (still capture them in a `rules/future_scope.md` so they're not forgotten)
- **Update the test corpus** to include matching samples (work with the developer user)

Catching this in `rule_extraction` is much cheaper than authoring N skills that then test as inactive in `skill_testing`. The cheap projection here is worth the time it saves later.

## Logic-type taxonomy (coverage diagnostic)

After first-pass extraction, classify each rule by judgment type:

- **Threshold** — numeric comparison ("annualized rate ≥ 15.4%")
- **Decision-Tree** — multi-branch ("if product type ∈ {A, B} then ...")
- **Heuristic** — semantic judgment ("does marketing copy imply principal guarantee")
- **Process** — procedural compliance ("published within the required deadline")

If your catalog is 90% Threshold rules, you have likely missed the semantic / process obligations that don't reduce to a number. Re-survey for those. The four types are roughly comparable in frequency across most rule corpora; a heavy skew is a signal to look again at the chapters or sections you skimmed.

## Preserve specifics (anti-summarize)

When writing a rule's `description` and `falsifiability_statement`, preserve every threshold, percentage, deadline, and named entity from the source. "Disclose within a reasonable period" is a vague rule and will fail downstream — the source almost certainly says "within 15 business days." If the source IS genuinely vague, flag the ambiguity explicitly (e.g., `notes: "source uses '及时'; no numeric deadline"`) rather than smoothing it. Downstream skill-authoring will need the specifics to write check.py logic.

## Soft sample-access discipline

You have unlimited tool access to samples — KC does not cap you. The discipline is procedural: source-extraction phase first, then validation phase. Inside source-extraction phase, samples are a last-resort reference for clarifying terminology, not a discovery surface. If you find yourself opening sample N° 3 to figure out what to extract next, you have inverted the methodology — close the sample, return to the source. Acceptable narrow exceptions:
- A jargon term in the source needs example resolution
- Sanity-check that a rule's `description` field reads coherently when applied to a real document

## Primary vs auxiliary sources — iteration order, NOT coverage breadth

When the developer user labels some source documents "primary" and others "auxiliary" (or "supplementary", or "secondary"), that distinction is about **iteration order**: do the primary regs deeply first, then come back to the auxiliary ones. It is **NOT** a license to skip the auxiliary regs entirely.

A recurring failure mode worth flagging: agent reads "primary 01-02 are the main basis, the rest is auxiliary" and produces 13 rules from regs 01-02 + 2 rules from regs 03-04 + zero rules from regs 05-10. The auxiliary regulations (often 60-90 articles each in compliance domains) almost always contain core obligations the primary regs reference or assume. Extracting nothing from them produces a thin catalog that misses real compliance requirements.

The right interpretation: primary regs get the first deep pass, the auxiliary regs get a structural-survey pass at minimum — identify their core obligations and extract those, even if not at the same density as primary. Skipping a 80-article regulation entirely should require an explicit reason in `coverage_audit.md` (e.g., "regulation 05 covers fund operations outside our case scope; explicitly out-of-scope per user discussion"). Silent skipping is the failure mode.

## Coverage trace (recommended deliverable)

After extraction, walk the source document paragraph-by-paragraph and tag each as either:

- `covered_by: [Rxxx, Ryyy]` — articles whose obligations became one or more rules
- `non_checkable: definition | context | cross_ref | scope` — articles excluded with explicit reason

Write this as `rules/coverage_trace.md` (or a section in `coverage_audit.md`). This is the source-side mirror of the existing sample-side applicability check, and catches the "long source → suspiciously few rules" failure mode directly. Engine derivation can read this trace to validate completeness later.

## When Rules Change

Regulations evolve. When the developer user adds new or updated regulation documents:
1. Identify which existing rules are affected.
2. Extract new rules or update existing ones.
3. Mark affected workflows for re-testing.
4. Use `version-control` to track the change.
