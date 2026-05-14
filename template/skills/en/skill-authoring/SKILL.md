---
name: skill-authoring
tier: meta
description: Write each verification rule into a Claude Code skill folder following the official skill format. Use when converting extracted rules into skill folders, when iterating on existing rule skills after testing, or when the developer user wants to capture domain knowledge as a skill. Each skill folder must be self-contained with business logic in SKILL.md, code in scripts/, regulation context in references/, and sample data in assets/. Also use the bundled skill-creator for the full eval/iterate workflow.
---

# Skill Authoring

Each verification rule becomes a skill folder. The skill must be self-contained: anyone (or any agent) reading just this folder should have everything needed to verify compliance with that one rule.

## Skill Folder Structure

Follow the official Claude Code skill format strictly. See `references/skill-format-spec.md` for the complete specification.

```
rule-skills/
  rule-001-capital-adequacy/
    SKILL.md            # The verification logic and methodology
    scripts/
      check.py          # Deterministic checks (regex, calculations)
    references/
      regulation.md     # Original regulation text, verbatim
      interpretation.md # Expert notes on how to interpret edge cases
    assets/
      samples.json      # Annotated sample extractions with expected results
      corner_cases.json # Known edge cases with their resolutions
```

Not every rule needs all of these. A simple threshold check might only need SKILL.md and a script. A complex semantic rule might need detailed references and many samples. Start minimal, add as needed during testing.

**Filename case matters.** Use uppercase `SKILL.md` (matching the meta-skill convention you see in `template/skills/`). On Linux filesystems this is case-sensitive; engine path-matching, audit scripts, and downstream tooling all assume uppercase. Do not write `skill.md`, `Skill.md`, or any other case variant.

## Granularity: 1 rule = 1 skill directory (default)

Default to **one rule per skill directory**. Group rules into the same file ONLY when they meet BOTH:

1. They share the same evidence (same section / same table / same field) — so locating one locates all.
2. They fail together — when one fails, the others almost always fail too (e.g., siblings in a required-fields list where the table itself is missing).

When grouping, name the file with the explicit range so downstream consumers (workflow-run, dashboards, finalization) can parse rule coverage by filename:
- ✅ `check_r013_r017.py` (R013, R014, R015, R016, R017 — same disclosure table, fail together)
- ❌ `check_r001_r050_r078.py` (different chapters, even if topically related — keep separate)

### Anti-pattern: the unified runner

If you find yourself writing a single `unified_qc.py` (or `batch_runner.py`, or `master_check.py`) that handles all 110 rules in one Python file, **stop**. That means your per-rule skills are wrong, not that the architecture is wrong. Fix the skills.

E2E #4 demonstrated the cost: an agent wrote `unified_qc.py` to bypass 110 individual skills it didn't trust. Result was 1,150 errors out of 6,930 production checks (16.6%) and a phase counter stuck in `production_qc` while real work happened in skill_authoring. The unified runner felt productive locally and was a global mistake.

If individual skills aren't running cleanly, the right response is to identify which ones break and fix them, not consolidate. The whole pipeline (extraction → skill_testing → distillation → production_qc) assumes one rule = one verifiable artifact.

### Anti-pattern: stub SKILL.md OR stub check.py

Each rule_skill folder MUST have BOTH a substantive `SKILL.md` AND a substantive `check.py` (or `check.py` that imports + calls a workflow that does the real work). One side being a stub breaks the contract.

**Variant 1 (v0.7.5 贷款 audit § 9.1)**: stub `SKILL.md` (templated 19 lines with `检查逻辑: N/A`) paired with real `check.py` (44-131 LOC of regex methodology). SKILL.md is supposed to be the human-readable methodology document. A reader scanning the rule folder for "what does this verify and why" gets nothing. The agent put all the methodology into `check.py` comments, which works for the engine but loses the deliverable framing.

**Variant 2 (v0.7.5 资管 audit § 3.4)**: substantive `SKILL.md` (real methodology, PASS/FAIL criteria, regulation cross-refs) paired with stub `check.py` (29-line scaffold returning `{"verdict": "NOT_APPLICABLE", "evidence": "Check requires worker LLM execution"}`). The real check logic lives in `workflows/<rule_id>/workflow.py` — but `check.py` doesn't import or call it. A user running `python rule_skills/R01-01/check.py document.txt` gets `NOT_APPLICABLE` on every input, which is misleading.

**Variant 3 (legacy v0.7.0)**: stub `check.py` returning `{"pass": null, "method": "stub"}` paired with otherwise-real SKILL.md. Methodology described but never executable.

**The contract**:
- ✓ DO: SKILL.md describes WHAT to check + WHY + WHEN to flag it. Substantive — typically 50-300 lines, not 19.
- ✓ DO: check.py implements the check. EITHER substantive direct logic OR `from workflows.<rule_id>.workflow_v1 import verify` + delegate. Returns concrete verdicts.
- ✗ DON'T: stub SKILL.md with methodology in check.py comments (variant 1).
- ✗ DON'T: substantive SKILL.md with check.py that returns NOT_APPLICABLE without delegating to a workflow (variant 2).
- ✗ DON'T: stub check.py returning null verdict (variant 3, legacy).

A future engine milestone check (v0.8 P2-F) may refuse phase advance if too many check.py files are stub-shaped. Better to author them substantively now.

## Writing SKILL.md

### Frontmatter

```yaml
---
name: rule-001-capital-adequacy
description: Verify that the capital adequacy ratio reported in the document meets the regulatory minimum of 8%. Use when checking capital adequacy compliance in bank financial reports. Check the capital adequacy section or table for the reported ratio and compare against the threshold.
---
```

- **name**: Must match the directory name exactly. Use lowercase, hyphens, no spaces. Prefix with the rule ID from your catalog.
- **description**: Write it as if explaining to another coding agent when they should use this skill. Be specific about what the rule checks, where to look in the document, and what constitutes pass/fail. Be pushy — include trigger keywords.

### Body Content

The body should cover:

1. **What this rule checks** — one paragraph explaining the rule in plain language. Include the regulatory source and intent.

2. **Where to look** — which section, chapter, table, or part of the document contains the relevant information. Be specific. "The capital adequacy ratio is typically found in Chapter 2, Section 'Key Regulatory Metrics' or in the summary table on page 1."

3. **What to extract** — the specific entities needed. "Extract the reported capital adequacy ratio as a percentage." Define the expected format and any normalization needed.

4. **How to judge** — the logic for pass/fail. "The ratio must be >= 8.0%. If the ratio is missing, flag as MISSING rather than FAIL." For semantic judgments, describe the criteria in natural language.

5. **Edge cases** — known tricky situations. "Some reports express the ratio as a decimal (0.12) rather than a percentage (12%). Normalize before comparing."

6. **Comment format** — what to say when the rule fails. Keep it concise and actionable. "Capital adequacy ratio is X%, which is below the regulatory minimum of 8%."

### Length and Style

- Keep SKILL.md under 500 lines. Most rules should be 100-200 lines.
- Explain the WHY behind the rule, not just the mechanics. Understanding intent helps handle edge cases.
- Write in imperative form: "Extract the ratio" not "The ratio should be extracted."
- If detailed regulation text is long, put it in `references/regulation.md` and reference it from SKILL.md.

## Pipeline Node Design

When a skill's workflow has multiple steps, decompose into nodes where each node does one thing well. Each node's difficulty should be well within the model's capability — don't cram location + extraction + judgment into a single LLM call.

Pre-processing (text cleaning, format normalization) and post-processing (output parsing, value normalization) are separate nodes, not embedded in the LLM prompt. This keeps prompts clean and makes each step independently testable.

## Writing Scripts

Scripts in `scripts/` handle deterministic operations:

- **Regex patterns** for entity extraction (dates, amounts, ratios, identifiers).
- **Calculation logic** for threshold checks, ratio computations, cross-field validation.
- **Format normalization** (Chinese numerals → digits, date format standardization, unit conversion).

Scripts should be self-contained Python files that can be imported or executed. Include clear input/output documentation in the script's docstring.

Do not put LLM prompts in scripts. LLM interactions belong in the SKILL.md body or in the workflow (later phase).

## Writing References

`references/` holds content that the coding agent reads on demand:

- **regulation.md**: The original regulation text, verbatim. Include the source, date, and version. This is the ground truth that the rule is derived from.
- **interpretation.md**: Expert notes from the developer user or from the coding agent's own analysis. "When the regulation says 'adequate disclosure', in practice this means the section must be at least 2 paragraphs and cover risks A, B, and C."

Keep references factual and sourced. They are evidence, not instructions.

## Writing Assets

`assets/` holds data that supports testing and edge case handling:

- **samples.json**: Annotated examples. Each entry: the input (extracted text or entity), the expected result (pass/fail/missing), and the expected comment. Build this incrementally as you test.
- **corner_cases.json**: Edge cases that the standard logic does not handle. Each entry: description, detection pattern, resolution, and confidence threshold. See the `corner-case-management` skill for the methodology.

## Iteration

Skills evolve through testing. After each test iteration:
1. Update SKILL.md if the logic needs adjustment.
2. Add failing cases to `assets/samples.json`.
3. Add newly discovered edge cases to `assets/corner_cases.json`.
4. Update `references/interpretation.md` with new insights.
5. Log what changed and why.

Use the bundled `skill-creator` skill if you want to run the full eval/iterate workflow with quantitative benchmarks.

## Bilingual Skills

Write skills in the language matching the LANGUAGE setting in `.env`. If rules and documents are in Chinese, write the SKILL.md body in Chinese using proper financial/regulatory terminology. The frontmatter (name, description) stays in English for system compatibility.
