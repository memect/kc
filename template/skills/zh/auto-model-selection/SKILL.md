---
name: auto-model-selection
tier: meta
description: >
  使用 Context7 CLI 获取最新 LLM 模型信息。当需要了解可用模型、模型能力、价格、
  上下文窗口大小、或哪个模型适合某项任务时使用——包括分层分配、Worker LLM 工作流设计、
  模型对比、服务商 API 调用方式等。Context7 提供训练数据中可能没有的最新信息。
  需要安装 context7 CLI (npm i -g context7)。可选插件。
---

# 通过 Context7 自动选择模型

## Context7 是什么

Context7 (`c7`) 是一个轻量 CLI 工具，可获取最新的库和 API 文档。安装：`npm i -g context7`。两个命令：
- `c7 library <查询>` — 按名称搜索库/服务商
- `c7 docs <libraryId> <查询>` — 获取具体文档和代码示例

## 使用时机

- 用户的 `model-tiers.json` 过期（KC 长时间未更新）
- 用户切换到新服务商，需要模型发现
- 用户明确要求更新模型选择
- 配置向导的 `/models` 端点失败，且内置模型列表过期

## 工作流程

1. 用户选择服务商并提供 API 密钥
2. 用 `c7 library <服务商名>` 找到对应的 library ID
3. 用 `c7 docs <id> "available models"` 获取当前模型列表
4. 从文档中识别：模型名称、能力（推理、编码、视觉）、上下文窗口大小、价格
5. 按能力和成本分配到分层：
   - LLM tier1：最强（复杂判断、抽取）
   - LLM tier2-3：中等（常规抽取、简单判断）
   - LLM tier4：最便宜（大量简单任务）
   - VLM tier1-3：视觉模型（文档解析/OCR）
6. 更新 `model-tiers.json` 或工作区 `.env`

## 分层原则

- 满足准确率阈值的最便宜模型
- 正则是 tier0 — 比任何 LLM 都小
- 不需要填满所有分层 — 服务商没有合适模型时留空即可
- 在 AGENT.md 中记录哪些模型适合哪些任务

## 前置条件

```bash
npm i -g context7
```

验证：`c7 library openai` 应返回结果。
