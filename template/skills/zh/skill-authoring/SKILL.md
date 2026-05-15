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

**文件名大小写很重要。** 必须使用大写 `SKILL.md`（与 `template/skills/` 中的 meta-skill 约定一致）。Linux 文件系统区分大小写；引擎的路径匹配、审计脚本、下游工具都假定为大写。不要写成 `skill.md`、`Skill.md` 或其他大小写变体。

## 颗粒度：默认 1 条规则 = 1 个技能目录

默认**每条规则一个独立技能目录**。仅当同时满足以下两个条件时，才能把多条规则合并到同一个文件：

1. 共享同一证据（同一章节 / 同一表格 / 同一字段）——找到一条就找到了全部。
2. 一同成败——一条失败，其他几乎必然失败（例如必填字段表中的同辈规则，表本身缺失则全部失败）。

合并时，用显式范围命名文件，让下游消费者（workflow-run、dashboards、finalization）可以从文件名解析规则覆盖范围：
- ✅ `check_r013_r017.py`（R013、R014、R015、R016、R017——同一披露表格，一同失败）
- ❌ `check_r001_r050_r078.py`（不同章节，即使主题相关，也应分开）

### 反模式：统一运行器（unified runner）

如果你发现自己在写一个 `unified_qc.py`（或 `batch_runner.py`、`master_check.py`）把全部 110 条规则塞进一个 Python 文件里，**停下来**。这说明你的单条规则技能写错了，不是架构错了。请修复单条技能。

E2E #4 给出了代价：智能体写了一个 `unified_qc.py` 绕过它不信任的 110 个独立技能。结果是 6,930 条生产检查里出了 1,150 个错误（16.6%），相位计数器卡在 `production_qc`，而真实工作还在 skill_authoring 里进行。统一运行器在局部看起来很高效，全局上是个错误。

如果某些独立技能跑不通，正确的应对是定位并修复出问题的那几条，而不是合并所有技能。整个流水线（extraction → skill_testing → distillation → production_qc）的前提就是「一条规则 = 一个可独立验证的产物」。

### 反模式：SKILL.md 是桩 或 check.py 是桩

每个 rule_skill 目录都必须 **同时** 拥有有内容的 `SKILL.md` **和** 有内容的 `check.py`（或 check.py 通过 import 调用一个真正做事的 workflow）。任何一边是桩都破坏了契约。

**变体 1（v0.7.5 贷款 审计 § 9.1）**：桩 `SKILL.md`（19 行模板，`检查逻辑: N/A`）配上真实的 `check.py`（44-131 行正则方法论）。SKILL.md 本该是人类可读的方法论文档。读者扫一眼规则目录想了解"这条核查什么、为什么核查"，结果什么都看不到。智能体把方法论塞进了 `check.py` 的注释里，引擎能跑，但产物的语义就丢了。

**变体 2（v0.7.5 资管 审计 § 3.4）**：有内容的 `SKILL.md`（真实方法论、PASS/FAIL 判定标准、法规交叉引用）配上桩 `check.py`（29 行脚手架，永远返回 `{"verdict": "NOT_APPLICABLE", "evidence": "Check requires worker LLM execution"}`）。真正的核查逻辑在 `workflows/<rule_id>/workflow.py` 里 —— 但 `check.py` 既没 import 也没调用。用户执行 `python rule_skills/R01-01/check.py document.txt` 任意输入都得到 `NOT_APPLICABLE`，结果是误导性的。

**变体 3（历史遗留 v0.7.0）**：桩 `check.py` 返回 `{"pass": null, "method": "stub"}`，SKILL.md 写得还行。方法论描述出来了，但没有可执行实现。

**契约**：
- ✓ DO：SKILL.md 描述「核查什么」「为什么核查」「什么时候触发」。要有内容 —— 通常 50-300 行，不是 19 行模板。
- ✓ DO：check.py 实现核查。**要么** 直接写有实质的逻辑，**要么** `from workflows.<rule_id>.workflow_v1 import verify` 然后委托给它。返回具体的判定。
- ✗ DON'T：SKILL.md 是桩、方法论塞在 check.py 注释里（变体 1）。
- ✗ DON'T：SKILL.md 有内容，但 check.py 返回 NOT_APPLICABLE 且不委托给 workflow（变体 2）。
- ✗ DON'T：check.py 返回 null verdict（变体 3，历史遗留）。

未来的引擎里程碑检查（v0.8 P2-F）可能在 check.py 桩比例过高时拒绝阶段推进。现在就写得有内容更省事。

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

### 关键字匹配前先剥除审核者注解

样本文档常带有审核者写的注解尾注（`预期命中点: ...`、`标注: ...`、`Expected: ...`），用来标注测试时的真实判定。如果你的 check.py 是用关键字/正则去匹配文档正文，这些注解会漏进匹配 —— 在违规样本上反而 false-positive PASS（规则在注解里"找到了"披露关键字，而不是在真实文档内容里）。

规范的清理工具在 `workflows/common/utils.py`，引擎初始化时会自动写入工作区：

```python
from workflows.common.utils import strip_annotations

def check(document_text):
    text = strip_annotations(document_text)
    # 真正的核查逻辑用 `text`，不要用原始的 document_text
```

已识别的前缀（中英文）：预期命中点、预期结果、预期判定、预期验证、标注、审核标注、Expected、expected、EXPECTED、Annotation、annotation。如果你的项目用了别的标签，传 `extra_prefixes=("...", "...")`。

E2E #11 贷款 v0.8 审计：14 条规则里有 4 条独立运行 check.py 时在违规样本上 false-positive PASS，因为匹配到的是 `预期命中点: ...年化利率` 尾注而不是文档正文。v0.8.1 把这个工具作为模板文件随包发布，import 一行就能避开这个坑。

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
