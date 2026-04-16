# KC Agent 技术报告

> 2026-04-11 | 团队内部分享准备材料
>
> 关联项目：kc_cli, kc_reborn, Anything2Ontology, pdf2skills-doc-base

---

## 1. KC Agent 概述与工作流程

### 1.1 定位

KC Agent 是一个**自动构建文档验证系统的 Agent**。它接收法规文档和样本文件作为输入，自主完成规则理解、验证逻辑编写、测试迭代、能力蒸馏的完整流程，最终交付一套可以用低成本模型在生产环境运行的文档验证系统。

核心命题：用 SOTA LLM 作为 ground truth、裁判和教师，将其在特定验证场景中的能力逐步蒸馏到代码和小模型 prompt 中。最终交付物（workflows）构建成本高，但运行成本极低。

### 1.2 六阶段 Pipeline

KC 的工作被结构化为六个阶段，分为两种运行模式：

**BUILD 模式（阶段 1-4）**：KC 使用 SOTA 模型自主完成所有知识性工作，建立准确性基线。

| 阶段 | 输入 | 处理 | 输出 |
|------|------|------|------|
| **BOOTSTRAP** | 用户上传的法规文档（`Rules/`）和样本文档（`Samples/`） | 解析文档、理解业务场景、建立工作区结构 | 结构化工作区、场景定义 |
| **EXTRACTION** | 法规全文 | 将法规拆解为原子级验证规则，每条规则包含检查对象、判断标准、适用范围 | 规则目录（Rule Catalog） |
| **SKILL_AUTHORING** | 规则目录 + 样本文档 | 为每条规则编写完整的 Claude Code Skill 文件夹（遵循 Anthropic skill-creator 格式），包含 `SKILL.md`（业务逻辑）、`scripts/`（正则/代码片段）、`references/`（原始法规上下文）、`assets/`（数据样本和边界案例） | 可执行的 Skill 集合 |
| **SKILL_TESTING** | Skill 集合 + 样本文档 | **Evolution Loop**：执行验证 → 评估结果 → 分析错误 → 修改 Skill → 重新执行，循环直到准确率达到阈值（默认 0.9） | 经过验证的 Skill 集合（准确性基线） |

**DISTILL 模式（阶段 5-6）**：将 SOTA 模型的能力蒸馏到便宜模型可运行的 workflow 中。

| 阶段 | 输入 | 处理 | 输出 |
|------|------|------|------|
| **DISTILLATION** | 验证通过的 Skill 集合 | 将 Skill 转化为 Python 代码 + worker LLM prompt 的 workflow 组合；对比 workflow 结果与 Skill 结果（基线），通过 tier downgrade 机制逐层尝试更小的模型 | 可生产部署的 Workflow 集合 |
| **PRODUCTION_QC** | Workflow 集合 + 生产文档（`Input/`） | 批量运行 workflow，基于置信度的分层抽样质控（高置信度抽检 10%、中置信度 50%、低置信度 100%），KC 持续监控并反馈改进；新发现的边界案例回流到 CornerCaseRegistry，系统性问题可触发 Skill 回退重测 | 验证结果（`Output/`）+ 质控报告 |

### 1.2.1 Evolution Loop 与反思机制

**Plan → Execute → Reflect → Evolve** 是贯穿 KC 全流程的设计理念，不仅存在于某个单一阶段。

**Evolution Loop 的结构化四步过程**（`EvolutionCycleTool`）：

1. **Diagnose**：对失败文档逐一归因，分类到 `parsing`（解析错误）、`extraction`（实体提取错误）、`judgment`（合规判断错误）、`scope`（规则适用范围错误）四个环节
2. **Classify**：按失败率自动分流——失败率 ≥ systemic_threshold（默认 10%）判定为**系统性问题**，需要重写对应组件；低于阈值判定为**边界案例**，路由到 CornerCaseRegistry，不修补主流程
3. **Fix**：系统性问题修改 Skill/workflow 本身；边界案例记录 detection pattern 和 resolution，在执行时高阈值匹配
4. **Log**：生成结构化迭代日志 `logs/evolution/{rule_id}_iter_NNN.json`，包含准确率变化、失败分布、分类结果、修复描述

**跨迭代的 pattern 检测**：系统会回溯历史迭代日志，检测同一 `root_cause` 是否反复出现（`_checkRepeatedPatterns()`）。如果检测到重复模式，返回 `repeated_patterns` 警告，提示 KC 升级解决策略而非继续同类修补。

**CornerCaseRegistry**（`corner_cases.json`）：边界案例作为一等数据结构独立管理，每个案例包含 `id`、`ruleId`、`detectionPattern`、`resolution`、`affectedDocuments`、`discoveryDate`、`status`（active/resolved/obsolete）。执行阶段通过 `match(documentName, ruleId)` 对文档做 pattern 匹配，命中时应用特殊处理。这避免了主 workflow 因过多 patch 变得不可维护。

**在各阶段的体现**：
- **SKILL_TESTING**：最密集的 evolution loop 运行阶段。`SkillTestingPipeline` 跟踪每个 skill 的测试准确率，有最大迭代次数限制（默认 20 轮，`MAX_ITERATIONS`），达到上限后要求 KC 与 developer user 讨论剩余问题。所有 skill 达到 accuracy threshold 后自动触发阶段转换。
- **DISTILLATION**：workflow 输出与 Skill 结果（基线）对比验证。`TierDowngradeTool` 在 tier 间逐级搜索，在 accuracy tolerance（默认 5%）范围内找到最便宜的可用模型层级。如果降级后准确率低于 `WORKFLOW_ACCURACY` 阈值，保持当前 tier。
- **PRODUCTION_QC**：基于置信度的分层抽样质控。新发现的边界案例回流到 CornerCaseRegistry，系统性质量回退可触发上游阶段重新迭代。

关键设计点：**KC + Skills 本身就是一个独立的生产模式**，不必强制所有场景都走到 DISTILL 阶段。对于高价值低频次的验证场景，SOTA 模型 + Skills 可能比蒸馏后的 workflow 更经济——蒸馏本身有一次性成本，还有后续维护和法规变更时的更新成本。

### 1.3 工作区结构

```
project/
  .env              # 项目级配置（覆盖全局）
  Rules/            # 法规文档
  Samples/          # 样本文档（训练集）
  Input/            # 生产批次
  Output/           # 验证结果
  skills/           # Meta-methodology skills (en/zh)
```

### 1.4 两个版本

KC Agent 存在两个实现：

- **kc_reborn**（Python 后端 + Node.js 前端）：通过 npm + pypi 安装，Meta skills 作为 Claude Code Skills 加载。18 个 meta skills（10 个 meta-meta + 8 个 meta），涵盖 bootstrap、规则抽取、任务分解、规则图谱、skill 编写、workflow 蒸馏、进化循环、质控、版本控制、dashboard 等。
- **kc_cli**（纯 Node.js）：更轻量，meta skills 内置为代码逻辑（Pipeline 系统），通过 npm 单独安装。本报告以 kc_cli 为主。

---

## 2. 产品设计哲学

### 2.1 系统角色模型

系统中存在五个角色层次（详见 `docs/initial_spec_draft.md`）：

```
Super-developer（我们：系统架构师 + 产品经理）
    │  交付 meta skills
    ▼
Developer User（开发者用户，如银行信贷部技术负责人）
    │  加载 skills 到 coding agent
    ▼
Coding Agent（Claude Code / 其他 coding agent）
    │  自动构建
    ▼
Verification App（验证应用，运行在 worker LLMs 上）
    │  服务
    ▼
End User（最终用户，如信贷部分析师）
```

类比：我们是**指挥家**（定义方法论），developer user + coding agent 是**作曲家**（创作具体作品），verification app + worker LLMs 是**演奏家**（执行演出）。

在 kc_cli 中，这个角色模型被简化——Super-developer 的方法论被编码为 Pipeline 阶段和 Tool 实现，Developer User 通过 CLI 与 KC Agent 交互，KC Agent 同时扮演 Coding Agent 的角色。

### 2.2 核心设计原则

**Minimum Viable Model**：使用能够胜任任务的最小（通常也是最便宜和最快）模型。文档解析优先使用 pymupdf 等规则解析器，仅在必要时升级到 VLM；正则能匹配的不用 LLM。但这是一个运行时决策，不是预先设定——只在需要时降级，不做过早优化。

**JIT Structure（即时结构）**：数据 schema 和格式按需生成，不预先定义。结构的存在性和一致性重要，具体格式不重要。这意味着 KC 在 EXTRACTION 阶段自行决定规则的拆解粒度，在 SKILL_AUTHORING 阶段自行决定 Skill 的内部组织方式。

**OTF Evolution（运行时进化）**：系统通过 Plan → Execute → Reflect → Evolve 的循环不断进化。Evolution Loop 不仅应用于 Skill Testing 阶段，它是贯穿整个系统的设计理念——KC 在每个阶段都可能根据执行结果调整自己的策略。

### 2.3 两层 Meta Skills

- **Meta Meta Skills（系统架构层）**：如何设计自举和进化系统、如何从 SOTA 模型降级到小模型、如何确定参数配置、如何与 developer user 沟通。对应产品经理和系统架构师的能力。在 kc_cli 中，这一层编码为 Pipeline 阶段定义和阶段转换逻辑。
- **Meta Skills（业务方法论层）**：如何执行文档验证的各个环节——文档解析（多级降级设计）、树处理（"洋葱剥皮"分层提取）、实体抽取（全文→章节→实体的渐进式窗口适配）、合规判断（代码/正则/LLM 混合）、边界案例管理（高阈值 RAG 管线）。对应业务分析师和 prompt 工程师的能力。

### 2.4 关于 prescription vs freedom 的经验

在 meta skills 的编写中，存在两种风格的对比：

- **详细规定式**：每个步骤给出具体做法和完整示例
- **方法论式**：只传递原则和理念，具体执行由 Agent 自主决定

实践表明方法论式效果更好。SOTA 模型（Opus 4.6 级别）有足够能力自行制定执行计划。过度详细的指令导致模型过拟合到示例上，对具体场景的适应性下降。

推论：角色扮演式 prompt（如"你是一个架构师"）对 SOTA 模型无效甚至有害。直接陈述任务和约束即可。

---

## 3. kc_cli 系统架构

### 3.1 技术栈

- **运行时**：Node.js 20+，纯 ESM 模块
- **终端 UI**：Ink 6 + React 19（声明式终端界面），组件包括 StreamingText（流式文本渲染）、ToolBlock（工具调用块）、CookingSpinner（上下文感知活动指示器）、StatusBar（session/phase/context 状态栏）
- **LLM 通信**：原生 `fetch` + 手动 SSE 解析，无第三方 SDK 依赖
- **依赖**：ink, ink-text-input, ink-spinner, react, pdfjs-dist（共 5 个生产依赖）
- **分发**：npm 包 `kc-beta`，全局安装

### 3.2 整体架构

```
┌───────────────────────────────────────────────────────────┐
│  Terminal UI Layer (Ink/React 19)                          │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ │
│  │StreamingText │ │ToolBlock │ │CookingSpin│ │StatusBar │ │
│  │(流式渲染)    │ │(工具块)  │ │ner(活动)  │ │(CTX/状态)│ │
│  └─────────────┘ └──────────┘ └───────────┘ └──────────┘ │
├───────────────────────────────────────────────────────────┤
│  CLI Layer                                                │
│  kc-beta onboard │ kc-beta config │ kc-beta init │ main  │
├───────────────────────────────────────────────────────────┤
│  AgentEngine (Harness Loop)                               │
│  ┌─────────┐ ┌────────────────┐ ┌───────────────────────┐│
│  │LLMClient│ │ContextAssembler│ │ConversationHistory    ││
│  │(多协议) │ │(system prompt) │ │(messages.json)        ││
│  └─────────┘ └────────────────┘ └───────────────────────┘│
│  ┌──────────────┐ ┌────────┐ ┌─────────────┐            │
│  │ContextWindow │ │EventLog│ │SessionState │            │
│  │(自动裁剪)    │ │(JSONL) │ │(持久化恢复) │            │
│  └──────────────┘ └────────┘ └─────────────┘            │
├───────────────────────────────────────────────────────────┤
│  ToolRegistry (Phase-Gated)                               │
│  BUILD tools (9):                                         │
│    sandbox_exec, workspace_file, document_parse,          │
│    document_search, rule_catalog, evolution_cycle,         │
│    dashboard_render, agent_tool, web_search               │
│  DISTILL tools (4, additional):                           │
│    worker_llm_call, workflow_run, tier_downgrade, qc_sample│
├───────────────────────────────────────────────────────────┤
│  Pipeline System (6 phases, each with exportState/import) │
│  Bootstrap → Extraction → SkillAuthoring →                │
│  SkillTesting → Distillation → ProductionQC               │
├───────────────────────────────────────────────────────────┤
│  Provider Registry (10 providers)                         │
│  SiliconFlow │ Aliyun │ VolcanoCloud │ Anthropic │ OpenAI │
│  Zhipu │ MiniMax │ OpenRouter │ Bedrock(stub) │ Custom    │
│  MODEL_RANKING (0-100) + classifyModels + curatedModels   │
├───────────────────────────────────────────────────────────┤
│  Infrastructure                                           │
│  Retry (exp. backoff) │ Workspace (per-session isolation) │
│  Config (.env + ~/.kc_agent/config.json, 2-tier)          │
│  TokenCounter │ VersionManager │ CornerCaseRegistry       │
│  ConfidenceScorer │ SkillLoader                           │
└───────────────────────────────────────────────────────────┘
```

### 3.3 Harness Loop 详细流程

`AgentEngine.runTurn(userMessage)` 是核心循环，实现了标准的 agentic loop 模式：

```
userMessage
    │
    ▼
history.addUser(userMessage)
eventLog.append("user_message")
    │
    ▼
构建 system prompt:
  ├─ SkillLoader.formatForContext()    // meta skills 索引注入
  ├─ pipeline.describeState()          // 当前阶段状态描述
  └─ workspaceState                    // 工作目录信息
    │
    ▼
┌─► contextWindow.window(messages, phaseSummaries)   // 85% 阈值自动裁剪
│       │
│       ▼
│   LLM streamChat() ─── 流式接收 ───┐
│       │                             │
│       ├─ delta.content ──► yield AgentEvent("text_delta")
│       └─ delta.tool_calls ──► 累积到 toolCallsAcc (Map<index, {id, name, args}>)
│       │
│       ▼
│   流式结束，组装 assistant message → history.addRaw()
│       │
│       ▼
│   toolCallsAcc.size === 0? ──yes──► eventLog.append("turn_complete")
│       │                             saveState()
│       no                            yield AgentEvent("turn_complete")
│       │                             return
│       ▼
│   for each tool_call:
│       ├─ eventLog.append("tool_start")
│       ├─ toolRegistry.execute(name, input) → ToolResult
│       ├─ eventLog.append("tool_result")
│       ├─ history.addRaw({role: "tool", ...})
│       └─ pipeline.onToolResult() ──► 检查阶段转换
│           │
│           └─ if phase_ready:
│               ├─ 记录 phaseSummary
│               ├─ eventLog.append("phase_transition")
│               ├─ currentPhase = nextPhase
│               ├─ _registerToolsForPhase(nextPhase)  // 重新注册工具
│               └─ saveState()
│       │
└───────┘  (继续下一轮 LLM 调用)
```

### 3.4 多协议 LLM Client

`LLMClient` 支持两种 API 协议，通过 `apiFormat` 参数切换：

**协议适配层**：

| 方法 | OpenAI 格式 | Anthropic 格式 |
|------|------------|----------------|
| `_buildHeaders()` | `Authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` |
| `_getEndpoint()` | `{baseUrl}/chat/completions` | `{baseUrl}/v1/messages` |
| `_buildStreamBody()` | 标准 OpenAI 格式 | system 提取为顶级字段；`tool` role 消息转为 `user` role + `tool_result` content block；assistant `tool_calls` 转为 `tool_use` content block；tools schema 从 OpenAI 格式转 Anthropic 格式 |

**Anthropic SSE 归一化**：

Anthropic 的 SSE 流使用 `event:` + `data:` 的双行格式，事件类型包括 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。`_parseAnthropicSSE()` 维护跨 chunk 的状态（当前 content block 索引、tool call 累积），将每个事件归一化为 OpenAI chunk 格式 `{ choices: [{ delta: { content?, tool_calls? } }] }`：

- `content_block_start` (type: tool_use) → 初始化 tool_call，设置 id 和 name
- `content_block_delta` (type: text_delta) → `delta.content`
- `content_block_delta` (type: input_json_delta) → `delta.tool_calls[n].function.arguments += partial_json`
- `message_delta` → `finish_reason` 映射

这一设计使得 `engine.js` 对 API 协议完全无感——所有下游逻辑只处理 OpenAI 格式的 chunk。

### 3.5 Provider Registry

`src/providers.js` 维护 10 个供应商预设，与 `kc_reborn/platform/backend/app/providers.py` 对齐。每个供应商定义：

```js
{
  id, name, baseUrl,
  authType: "bearer" | "x-api-key",
  apiFormat: "openai" | "anthropic",
  modelsEndpoint,           // GET /models 路径，null 表示不支持
  supportsCodingPlanKey,    // 是否支持编程套餐 key（不同 base URL）
  codingPlanUrl,            // 编程套餐专用 URL
  defaultModel,             // conductor 默认模型
  defaultTiers,             // worker 默认四层分配
  curatedModels,            // 无 /models 接口时的人工维护模型列表
  labels: { en, zh }        // 界面显示标签
}
```

**模型排名系统**：`MODEL_RANKING` 字典为已知模型 ID 模式分配 0-100 能力分。`classifyModels(models)` 根据分数自动分配层级：>=85 → tier1, >=70 → tier2, >=55 → tier3, 其余 → tier4。`getCuratedModels(providerId)` 为没有 `/models` 接口的供应商提供预设模型列表。

**供应商特例处理**：
- **Aliyun Bailian**：支持 API Key（`dashscope.aliyuncs.com/compatible-mode/v1`）和 Coding Plan Key（`coding.dashscope.aliyuncs.com/v1`）两种模式，`supportsCodingPlanKey: true`。默认 conductor=glm-5，tier1=qwen3.6-plus（有视觉/OCR 能力），tier2-4 留空。
- **VolcanoCloud**：使用实际的 coding plan model IDs（`doubao-seed-2-0-pro-260215` 等），不是通用名。
- **Anthropic**：`authType: "x-api-key"`，`apiFormat: "anthropic"`，使用原生 Messages API 而非 OpenAI 兼容层。
- **Bedrock**：标记为 stub，`aws-sigv4` 认证抛出 not-yet-supported 错误。

### 3.6 上下文工程

上下文管理被分解为三个独立组件，遵循关注点分离原则：

**TokenCounter**（`src/agent/token-counter.js`）：
基于字符的 token 估算启发式算法，无外部依赖。CJK 字符检测使用 Unicode 范围正则 `[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]`。Latin 文本约 4 字符/token，CJK 文本约 1.5 token/字符。消息级估算额外计入 4 token/message 的角色和格式开销。

**ContextWindow**（`src/agent/context-window.js`）：
自动上下文裁剪，在每次 LLM 调用前应用。触发阈值为 `contextLimit * 0.85`（考虑 `reserveForResponse` 后的可用预算）。裁剪策略：
1. 保留最近 30 条消息完整
2. 将更早的消息进行机械压缩：按 user-turn 分组，每组提取 user 消息摘要（前 80 字符）、tool 调用名称列表、assistant 回复摘要（前 60 字符）
3. 将 pipeline 阶段转换摘要（`_phaseSummaries`）作为高信号内容注入压缩摘要顶部
4. 压缩结果受 token 预算控制，超出时截断并标记 `[earlier history truncated]`

**Compact**（`AgentEngine.compact()`）：
用户通过 `/compact` 命令手动触发。保留最近 20 条消息，对更早消息通过 conductor LLM 生成语义摘要（focus on: decisions made, files created/modified, current state, key findings, unresolved questions）。如果 LLM 摘要失败，降级为机械提取（与 ContextWindow 类似）。压缩后替换历史，并记录 `compact` 事件到 event log。

### 3.7 事件日志与会话持久化

**EventLog**（`src/agent/event-log.js`）：
Append-only JSONL 日志，存储路径 `workspace/{sessionId}/logs/events.jsonl`。每条记录：`{"seq": N, "ts": "ISO", "type": "...", "data": {...}}`。事件类型包括：`user_message`、`llm_start`、`assistant_message`、`tool_start`、`tool_result`、`phase_transition`、`context_windowed`、`compact`、`session_resume`、`turn_complete`、`error`。

支持按序号范围和事件类型的选择性读取：`read({ fromSeq, toSeq, types })`。维护运行时 token 估算用于 context 统计。

**SessionState**（`src/agent/session-state.js`）：
持久化 `session-state.json`，存储版本号、sessionId、当前阶段、阶段摘要列表、最后事件序号、pipeline milestones。`save(engine)` 通过调用每个 pipeline 的 `exportState()` 提取 milestones。保存时机：阶段转换、每轮结束、compact、优雅退出。

**会话恢复**（`AgentEngine.resume()`）：
静态工厂方法，接收 `{ client, config, sessionId }`，从 session-state.json 恢复 currentPhase 和 phaseSummaries，重新注册对应阶段的工具集，调用每个 pipeline 的 `importState(data)` 恢复 milestones。用户通过 `/resume <name>` 触发。

### 3.8 重试机制

`withRetry(fn)`（`src/agent/retry.js`）包装所有 LLM API 调用（`streamChat` 和 `chat` 均已集成）：

- 最多 10 次重试，指数退避（初始 1s，最大 60s，2x 乘数，0.2 jitter 系数）
- 可重试状态码：408, 429, 500, 502, 503, 504, 520, 522, 524
- 不可重试状态码：400, 401, 403, 404, 422（立即抛出）
- 网络错误（ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED, socket hang up, AbortError）视为可重试
- 尊重 429 响应的 `Retry-After` header，delay 上限为 MAX_DELAY_MS

### 3.9 阶段门控的工具注册

ToolRegistry 在阶段转换时重建。`_createAllTools()` 创建所有工具实例（不重复创建），`_registerToolsForPhase(phase)` 决定哪些工具对 LLM 可见：

- **BUILD 阶段**（BOOTSTRAP → SKILL_TESTING）：注册 9 个 core tools
- **DISTILL 阶段**（DISTILLATION, PRODUCTION_QC）：注册 core + 4 个 distill tools

```js
const DISTILL_PHASES = new Set([Phase.DISTILLATION, Phase.PRODUCTION_QC]);
```

这是一个关键的架构决策。在 AB 测试中观察到 KC 会在 EXTRACTION 阶段违规调用 `worker_llm_call`，试图将规则抽取交给小模型。通过阶段门控在工具层面物理阻止了这种行为，比在 system prompt 中反复强调约束更可靠。

### 3.10 工具清单

**BUILD 阶段工具（9 个）：**

| 工具 | 职责 |
|------|------|
| `sandbox_exec` | 在隔离环境中执行 shell 命令（`child_process.spawn`），有超时控制 |
| `workspace_file` | 文件读写操作，集成 VersionManager 进行版本追踪 |
| `document_parse` | 文档解析，支持多级降级（文本直读 → pdfjs-dist → LLM OCR），OCR 使用 tier1 模型 |
| `document_search` | 工作区内文档搜索 |
| `rule_catalog` | 规则目录 CRUD，维护结构化的规则元数据 |
| `evolution_cycle` | 执行一轮结构化进化循环（diagnose→classify→fix→log），按失败率自动分流系统性问题和边界案例，检测跨迭代重复 pattern，集成 CornerCaseRegistry |
| `dashboard_render` | 生成 HTML dashboard 供 developer user 查看 |
| `agent_tool` | 派生子 Agent（递归创建新 AgentEngine 实例），用于并行子任务 |
| `web_search` | Tavily API 集成，附带领域文档优先级 guardrail |

**DISTILL 阶段附加工具（4 个）：**

| 工具 | 职责 |
|------|------|
| `worker_llm_call` | 调用 worker LLM（tier1-4），支持多认证方式 |
| `workflow_run` | 执行 workflow 并与 Skill 基线对比，集成 ConfidenceScorer |
| `tier_downgrade` | 逐级尝试更小模型（tier1→2→3→4），对比 baseline 准确率，在容忍范围内（默认 5%）选择最便宜的可用 tier |
| `qc_sample` | 基于置信度的分层抽样质控 |

### 3.11 配置体系

两层配置，项目级覆盖全局级：

- **全局配置**：`~/.kc_agent/config.json`，通过 `kc-beta onboard` 初始化，`kc-beta config` 编辑
- **项目配置**：`{project}/.env`，覆盖全局设置

`src/config.js` 的 `loadSettings()` 合并两层配置，向后兼容旧键名（`SILICONFLOW_API_KEY` → `LLM_API_KEY`）。关键字段：provider, api_key, base_url, conductor_model, tiers (tier1-4), accuracy_threshold, systemic_threshold, spot_check_rate, tier_tolerance, tavily_api_key。

---

## 4. Agent Harness 概念

### 4.1 定义

Anthropic 在 "Building Effective Agents"（https://www.anthropic.com/engineering/building-effective-agents）中的定义：Agent 是"LLM 动态指导自身流程和工具使用的系统，自主控制如何完成任务"（systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks）。与 workflow（预定义代码路径控制 LLM 的调用方式和顺序）不同，Agent 的执行路径由模型自身在运行时决定。

**Harness** 是 Agent 的编排循环本身——调用 LLM → 解析响应 → 路由工具调用 → 将结果返回 LLM → 重复，直到模型决定停止。

### 4.2 Anthropic Managed Agents 的三个核心抽象

Anthropic Managed Agents（2026 年 4 月公测，https://www.anthropic.com/engineering/managed-agents）借鉴操作系统的虚拟化思想，将 Agent 分解为三个可独立替换的组件：

| 组件 | OS 类比 | 职责 | 关键接口 |
|------|---------|------|----------|
| **Session** | 文件系统 / 事务日志 | "An append-only log of everything that happened." 持久化所有活动记录，是恢复和上下文检索的基础。 | `emitEvent(id, event)`, `getEvents()` (支持位置切片) |
| **Harness** | 进程调度器 | "The loop that calls Claude and routes Claude's tool calls to the relevant infrastructure." 无状态编排循环。 | `wake(sessionId)` → `getSession(id)` → 恢复 |
| **Sandbox** | 容器 / 虚拟机 | "An execution environment where Claude can run code and edit files." 可替换的执行环境。 | `execute(name, input) → string` |

### 4.3 Brain vs Hands 解耦

Managed Agents 的关键架构演进：早期版本将 Harness 嵌入容器中，容器崩溃导致会话丢失且无法调试（安全与可观测性冲突）。

解耦后的设计：
- **Harness 变为无状态**：不再驻留在容器中，崩溃后通过 `wake(sessionId)` + `getSession(id)` 获取事件日志恢复
- **Sandbox 变为可替换**："cattle not pets"——崩溃后 Harness 用 `provision({resources})` 启动新容器
- **工具调用统一接口**：`execute(name, input) → string`，Harness 不关心执行环境是容器、手机还是其他
- **上下文工程与 Session 分离**：Session 只管持久化（`emitEvent`/`getEvents`），上下文裁剪、压缩、prompt cache 优化全在 Harness 层，通过变换层连接

性能收益：p50 TTFT 降低约 60%，p95 降低超过 90%——因为推理立即开始，容器仅在工具调用时按需创建。

核心哲学：**"Opinionated about interfaces, agnostic about implementations"**——对 Session/Harness/Sandbox 的接口有明确主张，但对接口背后的实现不做限制。

### 4.4 Anthropic 的 Agent 模式分类

"Building Effective Agents" 提出五种由简到繁的模式：

| 模式 | 特征 | 适用场景 |
|------|------|----------|
| **Prompt Chaining** | 固定步骤序列，步间有程序化校验门 | 可分解为可预测步骤的任务 |
| **Routing** | 输入分类，分发到专门处理器 | 输入类型多样但处理逻辑固定 |
| **Parallelization** | 独立子任务并行 / 多次尝试投票 | 子任务间无依赖 |
| **Orchestrator-Workers** | 中心 LLM 动态分解任务，综合子结果 | 任务不可预测，需要动态规划 |
| **Evaluator-Optimizer** | 生成-评估-反馈迭代循环 | 有明确质量标准，可迭代改进 |

核心原则："you should consider adding complexity only when it demonstrably improves outcomes"。

### 4.5 KC 与 Harness 概念的映射

| Managed Agents 概念 | KC CLI 实现 | 差异分析 |
|---------------------|------------|----------|
| Session (append-only event log) | `EventLog` (JSONL) + `SessionState` (JSON) | KC 将事件日志和状态元数据分开存储；MA 统一在 Session 中 |
| Harness (无状态编排循环) | `AgentEngine.runTurn()` | KC 的 AgentEngine 是有状态类实例（持有 history, workspace, toolRegistry 等），通过 SessionState 实现"伪无状态"恢复 |
| Sandbox (可替换执行环境) | `SandboxExecTool` + `Workspace` | KC 是本地 `child_process.spawn`，紧耦合于 OS 进程；MA 是云端容器，可替换 |
| 工具统一接口 `execute(name, input) → string` | `BaseTool.execute(input) → ToolResult` | 高度相似，KC 的 ToolResult 多一个 `isError` 字段 |
| 上下文工程与 Session 分离 | `ContextWindow` + `ContextAssembler` 独立于 `EventLog` | 设计一致：存储层和裁剪层解耦 |
| 凭证隔离 | `.env` / `config.json` 直传到 Tool 实例 | KC 作为本地 CLI 风险可控，但 SaaS 化时需要凭证代理层 |

KC 相对于通用 Managed Agents 的领域增量：**Pipeline System**（6 阶段结构化编排 + 阶段门控工具注册 + pipeline 状态持久化/恢复）。这是文档验证领域知识的编码，MA 本身不提供。

KC 的 Agent 模式本质上是 **Orchestrator-Workers**（KC conductor 动态分解任务，worker LLMs 执行子任务）+ **Evaluator-Optimizer**（evolution loop 中 KC 评估 Skill/workflow 输出，反馈改进）的组合。

---

## 5. 开发过程中的关键问题与决策

### 5.1 长时间运行不稳定（P0）

**现象**：v0.1.2 版本在 30-40 分钟后出现响应延迟增大（键盘输入延迟约 100ms）、LLM API 断连后不可恢复、进程退出后完全丢失进度。在 GDPR 第三章 + 20 份用户协议的 AB 测试中，两个版本（kc_reborn 和 kc_cli）均在约 1 小时后失败。

**根因**：
1. LLM API 调用无重试，单次网络波动即终止会话
2. `ConversationHistory` 无限线性增长，无上下文窗口管理
3. `AgentEngine` 有状态但无持久化，进程退出 = 状态丢失
4. 两个版本共用 API key 时加剧 API 不稳定

**决策与实现**：
- 引入 `withRetry()` 包装所有 fetch 调用，区分可重试/不可重试错误
- 实现三层上下文管理：TokenCounter（估算）→ ContextWindow（自动裁剪，85% 阈值）→ Compact（LLM 摘要 + 机械降级）
- 将 `AgentEvent` 流持久化为 `EventLog`（append-only JSONL），使 `ConversationHistory` 成为事件日志的一个视图
- 实现 `SessionState` + Pipeline `exportState()`/`importState()` 支持跨会话精确恢复

参考来源：Anthropic Managed Agents 的 Session 设计（"append-only log of everything that happened"）和 Claude Code 源码的重试/上下文管理实现。

### 5.2 Agent 违反设计约束（P0）

**现象**：KC 在 EXTRACTION 阶段调用 `worker_llm_call`，将本应由 SOTA 模型完成的规则抽取工作委托给小模型。这违反了"BUILD 阶段 KC 自己做所有知识性工作"的核心设计。

**根因**：所有工具在所有阶段都可见。LLM 基于工具描述自主选择，无法通过 system prompt 可靠约束。

**决策**：阶段门控（phase-gated tool registration）。将工具分为 `core`（9 个，所有阶段可用）和 `distill`（4 个，仅 DISTILL/PRODUCTION_QC 阶段可用）。阶段转换时调用 `_registerToolsForPhase()` 重建 ToolRegistry。在 Tool API 层面物理屏蔽比 prompt 约束更可靠。

### 5.3 单一供应商局限（P1）

**现象**：v0.1.2 仅支持 SiliconFlow（硬编码 API key 名、base URL、Bearer 认证）。团队成员使用阿里云百炼、火山云等不同供应商，认证方式（Bearer vs x-api-key）和 API 格式（OpenAI-compatible vs Anthropic Messages API）各异。阿里云还区分 API Key 和 Coding Plan Key（不同 base URL）。

**决策与实现**：
- 建立 Provider Registry 集中管理供应商元数据，与 kc_reborn Python 版对齐
- LLMClient 抽象出 `_buildHeaders()`、`_getEndpoint()`、`_buildStreamBody()` 三个协议适配点
- 完整实现 Anthropic SSE 归一化（`_parseAnthropicSSE()` + `_normalizeAnthropicEvent()`），跟踪 6 种事件类型的跨 chunk 状态
- 模型自动发现：onboard 时先查 curated models，再探测 `/models` 端点（5s 超时），用 `classifyModels()` 按能力评分（0-100）自动分配 tier
- Coding Plan Key 特殊处理：在 onboard 和 config 编辑器中展示密钥类型子选项，切换不同 base URL

### 5.4 配置交互混乱（P1）

**现象**：团队成员在 onboard 流程中无法区分哪些字段可跳过、哪些必填，导致卡住。Threshold 等高级设置在首次配置时造成认知负荷。

**决策**：
- 分离 `kc-beta onboard`（首次配置，顺序引导，聚焦于 provider + key + model 选择）和 `kc-beta config`（后续修改，分类菜单式编辑器，4 个类别：LLM 供应商、模型分层、质量阈值、语言）
- 所有提示统一使用 `(Press Enter to keep)` / `(Press Enter to use default)` 灰色提示
- 阈值从 onboard 移到 config，降低首次使用门槛
- config 编辑器中检测 Coding Plan Key 状态，防止编辑操作覆盖正确的 base URL（实际遇到的 bug：config 编辑器在用户选择"保持当前供应商"时仍将 base_url 重置为默认值，导致 Coding Plan Key 的 401 错误）

### 5.5 用户感知不足（P2）

**现象**：KC 连续工作 10-15 分钟无输出，用户无法判断是正常工作还是卡死。原有 spinner 仅在 LLM 流式响应等待期间显示。

**决策**：将 spinner 从"等待 LLM 首个 token"改为"KC 工作中全程显示"，附带上下文感知的状态文本：`"Thinking..."`（LLM 推理中）、`"Running {toolName}..."`（工具执行中）、`"Analyzing results..."`（工具结果返回后到下一次 LLM 调用之间）。

---

## 6. 可抽象的经验与方法论

### 6.1 Harness 基础设施的可复用性

KC 的 AgentEngine 可拆解为 7 个场景无关的基础设施组件：

| 组件 | 职责 | 核心接口/参数 |
|------|------|-------------|
| LLMClient | 多协议多供应商 LLM 通信 | `streamChat()`, `chat()`, `listModels()` |
| ToolRegistry | 工具注册、schema 导出、执行路由 | `register(tool)`, `execute(name, input)`, `schemasOpenai()` |
| ConversationHistory | 消息持久化 | `addUser()`, `addRaw()`, `messages` |
| EventLog | Append-only 活动审计日志 | `append(type, data)`, `read({fromSeq, toSeq, types})` |
| ContextWindow | 自动上下文裁剪 | `window(messages, phaseSummaries)` |
| SessionState | 跨会话状态恢复 | `save(engine)`, `load()` |
| Retry | 指数退避重试 | `withRetry(fn)` |

构建新的"KC for X"系统时，需要替换的是 **Pipeline 定义**（阶段划分和转换条件）和 **Tool 实现**（领域特定的工具集），harness 基础设施可直接复用。

### 6.2 Pipeline 即领域知识的编码

KC 的 6 个阶段编码了"如何构建文档验证系统"的完整方法论。这种编码方式的价值在于：

- Pipeline 阶段定义了 Agent 的**长期目标结构**，防止 Agent 在局部决策中迷失方向
- 阶段门控提供了**行为约束的物理机制**，比 prompt 约束更可靠
- 每个阶段的 `describeState()` 为 LLM 提供**结构化的上下文注入**
- `exportState()`/`importState()` 支持**跨会话恢复**

如果要构建其他类型的"Agent 自动构建 X"系统，需要重新设计的是 Pipeline 的阶段划分——这本质上是在回答"构建 X 的方法论是什么"。

### 6.3 Skills 作为一等公民的交付物

传统认知：Skills 是中间产物，最终目标是蒸馏成 workflow。

KC 的实践修正了这个认知：**KC + Skills 本身就是一个生产模式**。在以下条件下，直接使用 SOTA 模型 + Skills 比蒸馏更经济：
- 场景高价值但低频次
- 法规变更频繁（蒸馏维护成本高）
- 验证逻辑语义复杂度高（小模型难以可靠处理）

系统设计应将"Agent + Skills"作为独立交付选项，不强制所有场景走到 DISTILL 阶段。

### 6.4 Prescription vs Freedom 的平衡

对 SOTA 模型编写指令时，方法论传递优于步骤规定。具体表现：
- Meta skills 中给出过多示例 → 模型过拟合到示例上，对实际场景适应性下降
- 角色扮演 prompt（"你是 X"）→ 对 SOTA 模型无效
- 只传递原则和约束，让模型自行制定执行计划 → 效果最好

检验标准：每写一条指令或功能，检查是在传递方法论还是在代替 Agent 做决策。

### 6.5 Append-only Event Log 作为系统基础

从 Managed Agents 借鉴的核心设计模式。传统做法（维护 messages 数组）的问题：

- 无法区分"完整记录"和"喂给模型的上下文"
- 历史无限增长导致 context 爆炸
- 进程崩溃后只能从最后一次持久化点恢复

Event log 解耦了存储和上下文两个关注点：
- **Session 层**（EventLog）：完整、持久、append-only，是 source of truth
- **Harness 层**（ContextWindow）：按需裁剪、压缩、变换，适配当前模型的 context 限制

这使得审计追踪、会话恢复、调试回放都基于同一个可靠数据源。

### 6.6 接口稳定，实现可替换

Managed Agents 的哲学 "Opinionated about interfaces, agnostic about implementations" 在 KC 中的具体应用：

- `BaseTool.execute(input) → ToolResult`：工具接口统一，后端可以是本地 spawn、HTTP API、或未来的云端沙箱
- `LLMClient.streamChat()` / `.chat()`：调用接口统一，后端通过 `apiFormat` 切换 OpenAI / Anthropic 协议
- Pipeline `exportState()` / `importState()`：接口统一，每个阶段自定义持久化内容
- Provider Registry：供应商接口统一（`{ id, baseUrl, authType, apiFormat, ... }`），新增供应商只需添加配置条目

### 6.7 Worker Tier 策略

模型分层应基于实际可用性而非理论完整性。如果供应商缺少合适的低成本模型，低层级 tier 留空是正确选择——一个能力足够的 tier1 模型可以处理所有 worker 任务。实例：阿里云百炼 Coding Plan 配置 conductor=glm-5、tier1=qwen3.6-plus（具备视觉/OCR 能力）、tier2-4 留空。

---

## 附录

### A. 文件结构

```
kc_cli/
├── bin/kc-beta.js                    # CLI 入口，路由子命令，解析 --en/--zh
├── src/
│   ├── config.js                     # 两层配置加载
│   ├── providers.js                  # Provider Registry (10 providers)
│   ├── cli/
│   │   ├── index.js                  # 主 Agent 循环 + Ink UI
│   │   ├── onboard.js                # 首次配置向导
│   │   ├── config.js                 # 分类设置编辑器
│   │   └── components.js             # React 组件 (StreamingText, ToolBlock, etc.)
│   └── agent/
│       ├── engine.js                 # AgentEngine (Harness Loop)
│       ├── llm-client.js             # 多协议 LLM Client
│       ├── context.js                # ContextAssembler
│       ├── context-window.js         # 自动上下文裁剪
│       ├── history.js                # ConversationHistory
│       ├── event-log.js              # Append-only JSONL EventLog
│       ├── session-state.js          # 会话状态持久化
│       ├── token-counter.js          # Token 估算
│       ├── retry.js                  # 指数退避重试
│       ├── events.js                 # AgentEvent 类型定义
│       ├── workspace.js              # Per-session 工作区隔离
│       ├── skill-loader.js           # Meta skills 索引注入
│       ├── version-manager.js        # Skill/Workflow 版本追踪
│       ├── corner-case-registry.js   # 边界案例管理
│       ├── confidence-scorer.js      # 置信度评分
│       ├── tools/
│       │   ├── registry.js           # ToolRegistry
│       │   ├── base.js               # BaseTool 接口
│       │   ├── sandbox-exec.js       # shell 执行
│       │   ├── workspace-file.js     # 文件读写
│       │   ├── document-parse.js     # 文档解析
│       │   ├── document-search.js    # 文档搜索
│       │   ├── rule-catalog.js       # 规则目录
│       │   ├── evolution-cycle.js    # 进化循环
│       │   ├── dashboard-render.js   # HTML dashboard
│       │   ├── agent-tool.js         # 子 Agent 派生
│       │   ├── web-search.js         # Tavily 网页搜索
│       │   ├── worker-llm-call.js    # Worker LLM 调用
│       │   ├── workflow-run.js       # Workflow 执行 + 基线对比
│       │   ├── tier-downgrade.js     # 模型层级降级
│       │   └── qc-sample.js          # 分层抽样质控
│       └── pipelines/
│           ├── index.js              # Phase 枚举
│           ├── base.js               # BasePipeline (exportState/importState)
│           ├── initializer.js        # BOOTSTRAP
│           ├── extraction.js         # EXTRACTION
│           ├── skill-authoring.js    # SKILL_AUTHORING
│           ├── skill-testing.js      # SKILL_TESTING
│           ├── distillation.js       # DISTILLATION
│           └── production-qc.js      # PRODUCTION_QC
└── template/                         # 项目初始化模板 (skills en/zh)
```

### B. 参考资源

| 资源 | 位置/链接 |
|------|----------|
| KC CLI 源码 | `desktop/kc_cli` |
| KC Reborn 源码 | `desktop/kc_reborn` |
| Anything2Ontology | `desktop/Anything2Ontology` |
| pdf2skills 文档库 | `desktop/pdf2skills-doc-base` |
| KC 初始设计文档 | `kc_cli/docs/initial_spec_draft.md` |
| KC 更新设计文档 | `kc_cli/docs/global_update_design_v2.md` |
| KC Managed Agents 分析 | `kc_cli/docs/managed-agents-analysis.md` |
| KC 开发日志 | `kc_cli/DEV_LOG.md` |
| Anthropic - Building Effective Agents | https://www.anthropic.com/engineering/building-effective-agents |
| Anthropic - Managed Agents Engineering | https://www.anthropic.com/engineering/managed-agents |

### C. 版本历史

- **v0.1.2**（2026-04-08）：初始 beta，14 工具，6 阶段 pipeline，SiliconFlow 单供应商
- **v0.2.0**（2026-04-10）：6 大更新——多供应商、上下文工程、配置 UX、语言覆盖、Web 搜索、活动指示器
- **v0.2.1**（2026-04-10）：Provider Registry 与 kc_reborn 对齐，curated model lists，config 编辑器 bug 修复
