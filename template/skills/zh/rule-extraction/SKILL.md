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

A well-extracted rule catalog has **10-20 rules per typical regulation PDF**
(2025 banking/insurance disclosure regs, 30-80 pages). Over-extraction into
60-100 rules per regulation signals you're treating every clause as its own
rule — which downstream consumers (skill-authoring, workflow-run) can't
distinguish meaningful checks from boilerplate.

If your first pass produces more than ~25 rules for a single regulation:
- **Merge rules that share evidence and fail together** (e.g., "must disclose
  X" and "must disclose Y" where both come from the same required-fields
  table → one rule: "must disclose the required-fields list including X, Y").
- **Drop procedural language** that isn't checkable against a report
  (definitions, scope statements, references to other regs that just
  transitively apply).
- **Keep only checkable obligations, prohibitions, and thresholds** — the
  things where you can read a sample report and say pass or fail.

### Sample "good" rule

```json
{
  "id": "R014",
  "source_ref": "信披办法 §15.2",
  "description": "季报应在季度结束后 15 个工作日内披露。",
  "applicable_sections": ["公募产品"],
  "severity": "high",
  "machine_checkable": true,
  "falsifiability_statement": "披露日期晚于季度结束后第 15 个工作日，则不合规",
  "test_case_stub": "读取季报的披露日期 + 对应季度末日期，计算工作日差值"
}
```

Note: one pass/fail outcome, a single `source_ref` to a specific clause,
clear applicability scope. Skill-authoring can write `check_r014.py` from
this alone.

### Cross-regulation dedup (when working across multiple PDFs)

If the developer user provides N regulations, rules from later regs often
duplicate cross-cutting requirements already captured by earlier ones
(e.g., 资管新规 2018 generic disclosure rule vs. 信披办法 2025's specific
version). Before emitting a rule from reg-N:

1. **Check the existing catalog.** Use `rule_catalog` (operation: list) to
   see what's already there. Skip if a rule with equivalent scope + intent
   exists.
2. **Prefer the newer / more specific source_ref** when rules overlap.
3. **If you merged rules**, record the consolidated sources in `source_ref`:
   e.g., `"信披办法 §15.2 + 资管新规 §24"`.

### Delegation to sub-agents

If you dispatch extraction to sub-agents (one per regulation), the sub-agent
inherits ONLY its `task_description` — it cannot see your conversation or
existing catalog. Therefore, when composing the brief:

- **Specify the target count band** explicitly: "Extract 10-20 atomic
  rules from this regulation."
- **Include a sample rule** in the brief body (paste the JSON above
  verbatim) so the sub-agent's calibration matches yours.
- **Name every regulation the sub-agent should process.** If AGENT.md
  lists 10 core regulations, the brief must list all 10 by name, not
  "the core regs" as a pronoun — LLMs composing long structured briefs
  frequently drop items (observed in session 6304673afaa0 where reg 02
  was silently omitted).
- **State the dedup contract**: "Rules already in the parent's catalog
  (R001–Rnnn) should NOT be re-extracted. If a requirement is already
  covered, skip it." Then pass the current catalog's ID ranges.
- **Prefer `rule_catalog` create operations over sandbox_exec writes to
  catalog.json.** rule_catalog uses workspace file locking (B9);
  sandbox_exec bypasses it and races with other writers.

## 如何读取规则文件 (默认整本读取)

法规文件是审核的权威依据。你为每条规则记录的 `source_ref` 都要能在
原文中复核。对于绝大多数规则文件 (单个文件 < 50 KB / < ~100 页),
**用 `workspace_file` (operation=read) 一次性整本读取**:

```js
workspace_file({ operation: "read", scope: "project", path: "Rules/01_某某办法.md" })
```

`workspace_file.read` 单次上限 50,000 字符, 足以覆盖几乎所有单个法规
文件。这是默认行为: **在抽取规则之前, 把每一份法规文件都整本读一遍。**

### 工具选择 — `workspace_file` 还是 `sandbox_exec`

| 工具 | 单次上限 | 适用 |
|---|---:|---|
| `workspace_file` (read) | 50,000 字符 | **整本读取法规/规则文件** |
| `sandbox_exec` (cat/head) | 10,000 字符 | 短命令, 不适合整文件读取 |

`sandbox_exec` 是为执行 shell 命令设计的, 10K 上限对绝大多数法规太小。
`cat rules/01_*.md` 只会返回前 ~10 KB, 后面被截断为 `\n[truncated]`。
反复用 `head -N` / `tail -M` 滑动窗口会丢失行号位置信息, 也浪费交互
回合。**遇到截断, 别和上限较劲——换工具。**

### 法规与样本的不对称 — 法规整本读, 样本按需抽样

法规通常只有 1–10 份, 权威性强, 只需读一次。每一份法规都整本读取,
作为后续所有规则抽取与引用的基础。

样本文档可能 30 份甚至 1000+ 份, 异质性强, 在测试阶段会被多次读取。
**不要试图把每个样本都整本读一遍**——用规则适用性过滤、抽样子集来
聚焦注意力。

### 例外 — 单个法规超过 200K 字符时

实践中极少见。test_data_4 中最大的法规 42 KB; 银行业 资管新规 +
信披办法 等典型法规也都在 50 KB 以内。但如果你确实遇到一份超大法规,
读取整本会挤压上下文窗口 (启发式: 单文件超过 ~200,000 字符 或超过你
上下文预算的 ~25%), 此时由你判断:

- 按章 (`第X章`) 分段读, 用 `document_parse` 或分页的 `workspace_file`
- 或建立工作区内的索引文件, 标注每章的偏移位置, 抽取规则时按需读取

50 KB 的上限已经足够高, 上述例外情形几乎不会触发。**默认就是整本读;
只有当文件确实太大时才偏离这一默认。**

## Extraction Strategies

### Strategy 1: Structured Input (Developer User Provides Rules)

When the developer user provides rules in xlsx, csv, or a structured document where each row/entry is a distinct rule with clear scope:
- Follow their structure exactly. Do not re-decompose.
- Map each row to a rule, preserving the developer user's identifiers.
- Ask clarifying questions only if entries are ambiguous.

### Strategy 2: Hierarchical Extraction from Regulation Text

For raw regulation documents (PDF, DOCX, legal text):

1. **Survey the document structure.** Read the table of contents or scan headers. Understand the hierarchy: parts, chapters, sections, articles, clauses.
2. **Identify rule-bearing sections.** Not every section contains a verification rule. Some are definitions, some are procedural, some are context. Focus on sections that impose obligations, prohibitions, thresholds, or requirements.
3. **Peel the onion.** Start at the highest structural level and work downward:
   - Level 1: What major areas does the regulation cover? (e.g., capital adequacy, risk disclosure, governance)
   - Level 2: Within each area, what are the specific chapters or sections?
   - Level 3: Within each section, what are the individual requirements?
   - Stop peeling when you reach atomic rules.
4. **Handle cross-references.** Regulations love to say "as defined in Section X" or "subject to the conditions in Article Y." Resolve these by including the referenced content in the rule's description, not just the reference.
5. **Handle compound rules.** "The report must include (a) risk factors, (b) financial projections, and (c) management discussion" — this is three rules, not one. Decompose unless the developer user specifically wants them grouped.

For long documents (100+ pages), use the onion-peeler approach described in `references/chunking-strategies.md`. Do not try to read the entire document in one pass.

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

After extracting your rule catalog and before authoring skills, do this 5-minute check: project each rule's applicability filter against the sample corpus.

For every rule:
1. Walk `samples/`, classify each by product type / report type / document format
2. For each rule, count how many samples it would apply to (per the rule's `applicability` field, scope filter, or whatever shape your catalog uses)
3. Flag rules that apply to **0 samples** — they're either genuinely test-corpus-irrelevant (acceptable) or over-constrained (bug)

E2E #7 GLM produced a 97-rule catalog where 36 rules (37%) had `PASS=0 FAIL=0 NOT_APPLICABLE=90` across all 90 documents — they never fired. Some were legit (rules for cash-management products with no cash-management samples in corpus), but 36 inactive of 97 was high enough to suggest scope-too-narrow drift.

If many rules are 0-sample, either:
- **Reframe their applicability** — broaden product types, look for evidence in headers/footers not just body, relax the scope filter
- **Document them as "future scope"** and remove from this iteration's catalog (still capture them in a `rules/future_scope.md` so they're not forgotten)
- **Update the test corpus** to include matching samples (work with the developer user)

Catching this in `rule_extraction` is much cheaper than authoring 36 skills that then test as inactive in `skill_testing`. The cheap projection here is worth the time it saves later.

## When Rules Change

Regulations evolve. When the developer user adds new or updated regulation documents:
1. Identify which existing rules are affected.
2. Extract new rules or update existing ones.
3. Mark affected workflows for re-testing.
4. Use `version-control` to track the change.
