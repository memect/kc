---
name: document-chunking
tier: meta
description: >
  Fast, cheap chunking for processing batches of sample and input documents.
  Use when you need to split documents into manageable pieces for initial observation,
  data sensibility checks, or feeding to extraction workflows. Not for production
  verification chunking — for that, use tree-processing to design a tailored chunking script.
---

# 文档分块处理

将文档切分为若干块，供下游环节使用。本技能提供的是快速、低成本的版本，面向样本和输入文档的批量处理，不适用于追求精度的核查工作流。

文档分块是 KC 工作流的常见前置步骤。原始文档往往超出单次调用的上下文窗口，或包含大量与当前任务无关的内容；恰当的分块既能控制 token 消耗，又能让后续的规则匹配、抽取、合规核查在更小、更聚焦的单元上进行。本技能给出三种成本最低、最易复用的分块策略，并说明各自的适用场景。

## 分块方法

**按页切分（Page-level splits）** — 最简单的方式。每页即为一个块。适用于大多数需要遍历文档内容的处理场景，例如初步观察样本、统计页数分布、或为每页生成摘要。这种方式不依赖文档内部结构，鲁棒性最高。

**定长分块（Fixed-size chunks）** — 按字符数或 token 数切分，相邻块之间保留重叠区域。适合构建检索索引或进行初步观察。常见参数：每块 2000–4000 字符，相邻块之间保留 200 字符重叠。重叠的作用是避免边界处的语义被切断，导致后续匹配漏检。

**按标题切分（Header-based splits）** — 识别章节标题，在标题边界处切分。这种方式能保留语义完整的章节单元，便于按条款、按章节进行规则核查。具体实现上，应根据目标文档的标题格式编写正则表达式，例如「第X条」「附录X」「X.X.X」等编号规则。

## 何时使用哪一种

按任务复杂度选择最简单可行的方法：

- 批量观察样本文档 → 按页切分
- 构建全文检索索引 → 定长分块加重叠
- 按章节抽取条款或要点 → 按标题切分
- 文档自带目录 → 直接解析目录得到结构

选择策略时要兼顾下游消费方的需求。若下游是 `worker_llm_call` 进行规则抽取，块的粒度应与单条规则的承载单元对齐；若下游是关键词检索，则块越小越精确，但召回率可能下降，需在两者之间取得平衡。

## 与 tree-processing 的关系

本技能仅用于探索阶段和批量处理阶段的快速、低成本分块。当你需要为合规核查工作流构建生产级分块——即分块机制必须精确、稳定、可复现并以脚本形式落地时，应改用 `tree-processing` 技能。后者会根据文档的具体结构设计专门的分块脚本，并把切分逻辑沉淀为可重复运行的工件，便于在 production_qc 阶段对结果进行回溯和审计。

两者的分工原则：本技能服务于「先看一眼数据」的快速判断，`tree-processing` 服务于「正式核查每一份文档」的工程化交付。在 KC 的 bootstrap 和 rule_extraction 阶段优先使用本技能；进入 skill_authoring 之后，若分块逻辑将被反复调用，应及时迁移到 `tree-processing`，并把对应的脚本和参数固化到技能目录下，避免每次运行得到不一致的切分结果，影响后续违规判定的可追溯性与置信度评估。
