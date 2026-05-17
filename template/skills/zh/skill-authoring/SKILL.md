---
name: skill-authoring
tier: meta
description: Write each verification rule into a Claude Code skill folder following the official skill format. Use when converting extracted rules into skill folders, when iterating on existing rule skills after testing, or when the developer user wants to capture domain knowledge as a skill. Each skill folder must be self-contained with business logic in SKILL.md, code in scripts/, regulation context in references/, and sample data in assets/. Also use the bundled skill-creator for the full eval/iterate workflow.
---

# 技能编写（Skill Authoring）

每条核查规则变成一个 skill 目录。这个 skill 必须自包含：任何人（或任何 agent）只读这一个目录就该有能力对这条规则做合规核查。

## Skill 目录结构

严格遵循官方 Claude Code skill 格式。完整规范见 `references/skill-format-spec.md`。

```
rule-skills/
  rule-001-capital-adequacy/
    SKILL.md            # 核查逻辑与方法论
    scripts/
      check.py          # 确定性核查（正则、算术）
    references/
      regulation.md     # 原始源文本，照抄
      interpretation.md # 对边缘情形的解读笔记
    assets/
      samples.json      # 已标注的样本抽取与期望结果
      corner_cases.json # 已知边缘案例与处理方式
```

不是每条规则都需要全部文件。简单阈值核查可能只要 SKILL.md + 一个脚本；复杂语义规则可能需要详尽的 references 和大量样本。从最小开始，测试期间按需加。

**文件名大小写很重要。** 必须使用大写 `SKILL.md`（与 `template/skills/` 中的 meta-skill 约定一致）。Linux 文件系统区分大小写；引擎的路径匹配、审计脚本、下游工具都假定为大写。不要写成 `skill.md`、`Skill.md` 或其他大小写变体。

## 颗粒度：默认 1 条规则 = 1 个技能目录

默认**每条规则一个独立技能目录**。仅当同时满足以下两个条件时，才能把多条规则合并到同一个文件：

1. 共享同一证据（同一章节 / 同一表格 / 同一字段）——找到一条就找到了全部。
2. 一同成败——一条失败，其他几乎必然失败（例如必填字段表中的同辈规则，表本身缺失则全部失败）。

合并时，用显式范围命名文件，让下游消费者（workflow-run、dashboards、finalization）可以从文件名解析规则覆盖范围：
- ✅ `check_r013_r017.py`（R013、R014、R015、R016、R017——同一披露表格，一同失败）
- ❌ `check_r001_r050_r078.py`（不同章节，即使主题相关，也应分开）

### 反模式：统一运行器（unified runner）

如果你发现自己在写一个 `unified_qc.py`（或 `batch_runner.py`、`master_check.py`）把全部规则塞进一个 Python 文件里，**停下来**。这说明你的单条规则技能写错了，不是架构错了。请修复单条技能。

一种值得警惕的失败模式：智能体写一个 `unified_qc.py` 类型的统一执行器来绕过它不信任的独立技能。结果是错误级联——一条规则的失败会把所有其他规则的判定一起带崩，很容易在数千次生产核查上做出 15%+ 的错误率。统一执行器在局部看起来很高效，全局上是个错误。它还会卡住阶段模型：磁盘上根本没有独立的 `check.py` 文件落地，引擎就没法把这部分工作计入里程碑。

如果某些独立技能跑不通，正确的应对是定位并修复出问题的那几条，而不是合并所有技能。整个流水线（extraction → skill_testing → distillation → production_qc）的前提就是「一条规则 = 一个可独立验证的产物」。

### 反模式：SKILL.md 是桩 或 check.py 是桩

每个 rule_skill 目录都必须 **同时** 拥有有内容的 `SKILL.md` **和** 有内容的 `check.py`（或 check.py 通过 import 调用一个真正做事的 workflow）。任何一边是桩都破坏了契约。

**变体 1**：桩 `SKILL.md`（一份约 20 行的模板脚手架，里面写着 `检查逻辑: N/A` 或类似内容）配上真实的 `check.py`（把正则方法论塞在代码注释里）。SKILL.md 本该是人类可读的方法论文档。读者扫一眼规则目录想了解"这条核查什么、为什么核查"，结果什么都看不到。方法论被推进了 `check.py` 的注释里——引擎能跑，但产物的语义就丢了。

**变体 2**：有内容的 `SKILL.md`（真实方法论、PASS/FAIL 判定标准、源文交叉引用）配上桩 `check.py`（一份薄脚手架，永远返回 `{"verdict": "NOT_APPLICABLE", "evidence": "Check requires worker LLM execution"}`）。真正的核查逻辑在 `workflows/<rule_id>/workflow.py` 里 —— 但 `check.py` 既没 import 也没调用。用户执行 `python rule_skills/R01-01/check.py document.txt` 任意输入都得到 `NOT_APPLICABLE`，结果是误导性的。

**变体 3（历史遗留）**：桩 `check.py` 返回 `{"pass": null, "method": "stub"}`，SKILL.md 写得还行。方法论描述出来了，但没有可执行实现。

**变体 4（"单体 verify_engine 桩"）**：每条规则的 SKILL.md 都是一份 20-35 行的薄脚手架（"详见 verify_engine.py"），每条规则的 check.py 都是一段薄 shim，import 并调用一个根目录下的单体 `rule_skills/verify_engine.py`（或类似文件）—— 后者把全部 15-20 条规则的核查逻辑塞在一个 ~750 行的大文件里。每条规则的 check.py 都长这样：`from rule_skills.verify_engine import check_R01_01; return check_R01_01(doc)`。这能通过"check.py 不是字面意义上的桩"这道表面检查，但它颠倒了规范的"每规则一个粒度单元"的设计：每条规则的文件不含规则特定的推理，单体文件持有一切，"读这条 skill 就能理解这条规则"的工作流对所有人（开发者用户、未来审计者、下游 agent）都失效了。契约里之所以把 skill 定义为 KC 每条规则的粒度单元，是有原因的。把所有核查逻辑集中到一个大文件里看上去高效，实质上失去了"按规则审计"这个本意。如果你发现自己在写一个 `verify_engine.py`，里面有 15 个以上的 check 函数，而每条规则只有桩 SKILL.md / 桩 check.py，停下 —— 把方法论留在每条规则的 SKILL.md 里（要有内容），check 逻辑要么内联到每条规则的 check.py，要么走规范的"per-rule check.py + workflow_v1.py"模式。

**契约**：
- ✓ DO：SKILL.md 描述「核查什么」「为什么核查」「什么时候触发」。要有内容 —— 通常 50-300 行，不是一份 20 行的模板。
- ✓ DO：check.py 实现核查。**要么** 直接写有实质的逻辑，**要么** `from workflows.<rule_id>.workflow_v1 import verify` 然后委托给它。返回具体的判定。
- ✗ DON'T：SKILL.md 是桩、方法论塞在 check.py 注释里（变体 1）。
- ✗ DON'T：SKILL.md 有内容，但 check.py 返回 NOT_APPLICABLE 且不委托给 workflow（变体 2）。
- ✗ DON'T：check.py 返回 null verdict（变体 3，历史遗留）。

引擎可能在 check.py 桩比例过高时拒绝阶段推进。现在就写得有内容更省事。

## 编写 SKILL.md

### Frontmatter

```yaml
---
name: rule-001-capital-adequacy
description: Verify that the capital adequacy ratio reported in the document meets the regulatory minimum of 8%. Use when checking capital adequacy compliance in bank financial reports. Check the capital adequacy section or table for the reported ratio and compare against the threshold.
---
```

- **name**：必须与目录名完全一致。小写、用连字符，不要空格。前缀用目录里的 rule ID。
- **description**：当作在向另一个 coding agent 解释"什么时候该用这个 skill"来写。说清楚这条规则核查什么、要去文档的哪里看、什么算 pass/fail。写得"主动"一点 —— 把触发关键词都带上。

### 正文内容

正文应当覆盖：

1. **这条规则核查什么** —— 用一段平白的话解释规则。带上源文出处和意图。
2. **去哪里看** —— 哪一节、哪一章、哪张表、文档哪一部分。写具体。"资本充足率通常在第 2 章「关键监管指标」一节，或在第 1 页的汇总表中。"
3. **要抽什么** —— 具体的实体。"抽出报告中的资本充足率，以百分比表示。"明确期望的格式与必要的归一化。
4. **怎么判** —— pass/fail 逻辑。"比率须 ≥ 8.0%。如果比率缺失，标记为 MISSING 而不是 FAIL。"语义判断时，用自然语言描述判定标准。
5. **边缘情形** —— 已知的棘手情况。"有些报告把比率写成小数（0.12）而非百分比（12%），比较前先归一化。"
6. **comment 格式** —— 规则失败时该说什么。简洁、可操作。"资本充足率为 X%，低于监管下限 8%。"

### 篇幅与风格

- SKILL.md 控制在 500 行以内。大多数规则在 100-200 行。
- 解释规则**为什么**这样定，而不是只描述机械流程。理解意图有助于处理边缘情形。
- 用祈使句："Extract the ratio"，不要写"The ratio should be extracted"。
- 如果详细源文较长，放进 `references/regulation.md`，在 SKILL.md 里引用。

## Pipeline 节点设计

当一条 skill 的 workflow 有多个步骤时，拆成多个节点，每个节点把一件事做好。每个节点的难度都要在模型能力范围内 —— 不要把 location + extraction + judgment 全塞到一次 LLM 调用里。

预处理（文本清洗、格式归一化）和后处理（输出解析、数值归一化）是独立节点，不要嵌进 LLM 提示词。这能保持提示词干净，且每一步可独立测试。

## 编写 Scripts

`scripts/` 下的脚本负责确定性操作：

- **正则模式**用于实体抽取（日期、金额、比率、标识符）。
- **算术逻辑**用于阈值核查、比率计算、跨字段校验。
- **格式归一化**（中文数字 → 阿拉伯数字、日期格式标准化、单位转换）。

脚本应该是自包含的 Python 文件，既可被 import 也可被执行。在 docstring 中说明输入/输出。

不要把 LLM 提示词写在脚本里。LLM 交互属于 SKILL.md 正文或属于 workflow（后续阶段）。

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

一种值得警惕的失败模式：相当一部分规则在独立运行 check.py 时会在违规样本上 false-positive PASS，原因是正则匹配到的是 `预期命中点: ...` 尾注，而不是文档正文。KC 把这个工具作为模板文件随包发布，import 一行就能避开这个坑。

## 编写 References

`references/` 放 coding agent 按需读取的内容：

- **regulation.md**：原始源文本，照抄。带上出处、日期、版本。这是规则所依据的 ground truth。
- **interpretation.md**：开发者用户的专家笔记，或 coding agent 自己分析得来的笔记。"当源文说'充分披露'时，实践中意味着该章节至少有 2 段、覆盖风险 A、B、C。"

References 要事实化、要有来源。它们是证据，不是指令。

## 编写 Assets

`assets/` 放支撑测试与边缘案例处理的数据：

- **samples.json**：标注过的样例。每条记录：输入（抽取出来的文本或实体）、期望结果（pass/fail/missing）、期望 comment。在测试过程中逐步累积。
- **corner_cases.json**：标准逻辑不处理的边缘案例。每条记录：描述、检测模式、处理方式、置信度阈值。方法学见 `corner-case-management` skill。

## 编写方法论（来自 skill-creator 核心）

这一节把 Anthropic 上游 `skill-creator` 里通用的编写模式整合进来。起草任何 KC 规则技能时，在上文的 KC 专属布局之上叠加应用这些模式。

### 先捕捉意图，再起草

在写任何技能之前，先把四个问题想清楚：

1. **这个技能要让 Claude（或 check.py）做什么？** —— 一个具体的能力，不是一类能力。
2. **它应该在什么时候触发？** —— 什么样的用户话术 / 文档语境应该匹配它的 description。
3. **期望的输出格式是什么？** —— verdict + comment + evidence 的形态；非检查类技能则给出交付物的形态。
4. **要不要准备测试样本？** —— 如果这条规则有客观的通过/失败判定（KC 几乎所有规则都是），那就要。`assets/samples.json` 应该在遇到边界情况时增量地写。

如果对话里已经有了实际例子（用户指着一段文字说"这不合规"），先从对话历史里抽取答案——不要让用户把已经说过的话再说一遍。

### Frontmatter 与渐进式信息披露

技能按三个层级加载，每层各有合适的容量：

1. **元数据（name + description）** —— 始终在代理上下文里。约 100 词。这是**最主要的触发机制**——要写得具体、稍微"催促"一点（Claude 倾向于触发不足）。在里面包含触发关键词、规则编号、来源法规、以及它期望在文档哪里找到证据。
2. **SKILL.md 正文** —— 技能被触发时加载。典型规则的目标长度是 100–300 行，硬上限 500 行。要解释规则背后的"为什么"，不要只讲机械操作。
3. **打包资源**（scripts/、references/、assets/）—— 只有正文显式指向它们时才会被加载。大段的法规原文和样本语料应当放在这里，而不是塞在正文里。

如果 SKILL.md 接近 500 行，那就是该把细节下沉到 `references/` 的信号——在正文里留一个指向："详尽的边界情况枚举见 references/edge-cases.md。"

### 写作风格

- **祈使句优于被动语态。** "提取这一比率"好过"该比率应被提取"。
- **解释为什么，不只是是什么。** 今天的 LLM 有不错的心智理论——只要一句"这条法规是为了保护零售投资者"，下游代理就能把你没有枚举到的情形泛化处理。
- **警惕大写 MUST 和 NEVER。** 一旦你想伸手去写它们，通常意味着背后的道理没有讲清楚。换个说法、把道理讲出来。
- **位置要具体。** "在第二章「主要监管指标」一节或者首页的汇总表里找"比"在财务披露里某个地方找"要好得多。

### 先写测试样本，再写脚本

写完 SKILL.md 之后，在 `assets/samples.json` 里写 2–3 个贴近现实的样本输入和它们的预期判定，**再去**最终敲定 `check.py`。样本为脚本提供锚点：你写的每条正则、每个关键字，都是为了让某个具体样本得到它的预期判定。脱离样本凭空写脚本，几乎一定会过拟合，在第一份真实文档上就会失效。

### 迭代，不要追求一次到位

规则技能很少能在第一稿就写对。请预设至少要经过一轮测试暴露问题后的修订。不要为了应付每一个边界情况而堆砌防御性的 MUST——把方法论本身泛化一下更合算。如果三个样本各自都需要一个一次性的补丁，那是个信号：这条规则的陈述本身就太窄了。

如果你需要的方法论比这一节覆盖的更精细——例如带定量基准的正式评估循环、技能不同版本之间的盲式 A/B 对比、或者运行 description 优化器——请参考 `skill-creator`。

## 迭代

Skill 通过测试不断演化。每一轮测试之后：
1. 如果逻辑需要调整，更新 SKILL.md。
2. 把失败案例加进 `assets/samples.json`。
3. 把新发现的边缘案例加进 `assets/corner_cases.json`。
4. 把新的洞察加进 `references/interpretation.md`。
5. 记录改了什么、为什么改。

如果你想跑完整的 eval/iterate workflow 并拿到量化基准，使用随包的 `skill-creator` skill。

## 双语 Skill

按 `.env` 中 LANGUAGE 设置的语言来写 skill。如果规则和文档都是中文，SKILL.md 正文也用中文写，使用恰当的金融/监管术语。Frontmatter（name、description）保持英文以保证系统兼容性。
