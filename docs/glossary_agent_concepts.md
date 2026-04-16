# Agent 系统核心概念速查

> 面向熟悉 prompt engineering 和 Claude Code Skills 但刚接触 agent 系统架构的工程师。
>
> 概念来源标注为 [Anthropic]、[OpenAI] 或 [KC] 以区分官方定义和项目内部用法。

---

## 基础概念

### Agent

**一句话**：能自主决定下一步做什么的 LLM 系统。

与我们熟悉的 workflow（预定义步骤、代码控制执行路径）的根本区别在于：agent 的执行路径是**模型在运行时自己决定的**。Workflow 是你写好了剧本让演员演，agent 是你告诉演员目标，让他自己决定怎么到达。

> [Anthropic] "Systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks."

> [OpenAI] An agent combines "a set of instructions in natural language (system prompt), along with the tools necessary to complete them."

注意：行业里 "agent" 这个词被严重滥用。很多自称 agent 的产品其实只是 workflow。判断标准很简单——**执行路径是代码写死的还是模型决定的**。

### Tool Use / Function Calling

**一句话**：让 LLM 调用外部函数的标准化协议。

我们在 Claude Code 里用 Skills 已经间接接触过这个概念。Tool use 是更底层的机制：你给 LLM 一组函数的 JSON schema（名称、参数、描述），LLM 在回复中输出结构化的函数调用请求，你的代码执行函数并把结果返回给 LLM。

```
你定义: { name: "web_search", parameters: { query: string } }
LLM 输出: tool_call { name: "web_search", arguments: { query: "GDPR article 15" } }
你执行: 调用搜索 API，返回结果
LLM 继续: 基于结果生成回复
```

这跟 MCP（Model Context Protocol）的关系：MCP 是 tool use 的一个标准化传输协议。Tool use 是"LLM 可以调函数"，MCP 是"用什么格式和协议来注册和调用这些函数"。

### Agentic Loop

**一句话**：agent 的核心执行循环——调用 LLM → 执行工具 → 把结果喂回 LLM → 重复。

这是所有 agent 系统最基础的模式。无论系统多复杂，拆到底都是这个循环：

```
while true:
    response = LLM(messages + tools)
    if response 包含 tool_calls:
        for each tool_call:
            result = execute(tool_call)
            messages.append(result)
    else:
        break  // LLM 决定停止，一轮结束
```

循环的终止条件是 LLM 自己决定不再调用任何工具——它认为任务完成了，或者需要向用户报告。

这个循环在不同框架里有不同名字：Anthropic 叫 harness loop，OpenAI 的 Swarm 框架叫 `run_full_turn`，LangChain 叫 agent executor，我们在快察早期叫"干细胞"（stem cell）。本质都是同一个东西。

---

## 架构概念

### Harness

**一句话**：围绕 agentic loop 的完整编排框架——不只是循环本身，还包括上下文管理、错误处理、状态持久化等一切"让循环能可靠运行"的基础设施。

Harness 这个词来自测试领域的 "test harness"（测试工具台/测试支架）——一套支撑和驱动被测对象运行的框架。在 agent 领域，harness 是支撑和驱动 LLM 运行的框架。

> [Anthropic] "The loop that calls Claude and routes Claude's tool calls to the relevant infrastructure."

如果 agentic loop 是发动机，harness 就是整辆车——包括油箱（上下文）、变速箱（工具路由）、仪表盘（状态监控）、安全气囊（错误恢复）。

[KC] kc_cli 的 `AgentEngine` 就是一个 harness 实现。它的 `runTurn()` 是 agentic loop，周围的 ContextWindow、EventLog、SessionState、ToolRegistry 等组件构成了完整的 harness。

### Session

**一句话**：agent 一次工作过程的完整持久化记录。

> [Anthropic] "An append-only log of everything that happened."

关键设计原则：Session 是**只追加、不修改**（append-only）的。所有事件——用户消息、LLM 调用、工具执行、错误——都按时间顺序追加。这给了你审计、回放、恢复的能力。

Session 和"喂给 LLM 的上下文"是两个不同的东西。Session 是完整记录（可能几十万 token），上下文是从 Session 中裁剪出来的子集（受模型 context window 限制）。这个分离是 Anthropic Managed Agents 最重要的设计决策之一。

[KC] kc_cli 中 `EventLog`（JSONL 文件）是 session 的实现，`ContextWindow` 负责从完整历史中裁剪出喂给 LLM 的子集。

### Sandbox

**一句话**：agent 执行代码和文件操作的隔离环境。

> [Anthropic] "An execution environment where Claude can run code and edit files."

核心思想是 **Brain（思考）和 Hands（执行）解耦**。LLM 做推理决策（brain），sandbox 执行具体操作（hands）。Brain 不需要知道 Hands 是本地进程、Docker 容器还是云端虚拟机——它只通过统一接口 `execute(name, input) → result` 交互。

这样做的好处：sandbox 崩溃不影响 brain，可以重启一个新的 sandbox 继续工作。

[KC] kc_cli 的 `SandboxExecTool` 是一个简单的本地 sandbox（`child_process.spawn`），没有做容器级隔离。对于本地 CLI 工具来说够用了。

### Context Engineering

**一句话**：决定"在有限的 context window 里放什么内容"的工程实践。

这是 prompt engineering 的进化。Prompt engineering 关注的是"怎么写好一条指令"，context engineering 关注的是"在每次 LLM 调用时，怎么组装最优的完整输入"。当 agent 连续工作几小时、积累了大量对话历史和工具结果时，context engineering 变得至关重要。

核心问题：模型的 context window 是有限的（比如 200k tokens），但 session 记录可能远超这个限制。你需要决定保留什么、压缩什么、丢弃什么。

常见策略：
- **Windowing**：只保留最近 N 条消息，更早的压缩为摘要
- **Compaction**：用 LLM 生成旧对话的语义摘要，替换原文
- **Phase summaries**：在阶段转换时生成总结，作为高密度上下文注入
- **Selective loading**：资源索引放在 context 里，完整内容按需加载（Claude Code 的 Skills 就是这么做的）

[KC] kc_cli 的三层上下文管理：`TokenCounter`（估算当前用量）→ `ContextWindow`（85% 阈值自动裁剪）→ `compact()`（用户手动触发的 LLM 摘要）。

### Context Window

**一句话**：模型单次调用能处理的最大 token 数。

不要和 context engineering 混淆。Context window 是模型的硬件限制（比如 Claude 的 200k tokens），context engineering 是在这个限制内做最优决策的工程方法。

实际可用的 context window 比标称值小，因为需要预留空间给模型的输出（response）。比如 200k 的 context window，如果 max_tokens 设为 65536，实际可用于输入的大约是 135k。

---

## 多 Agent 模式

### Orchestrator-Workers

**一句话**：一个中心 agent 动态分解任务，分配给多个 worker 执行，最后综合结果。

> [Anthropic] 适用于"任务不可预测，需要动态规划"的场景。

这是最常见的多 agent 模式。Orchestrator 是指挥，workers 是演奏家。Orchestrator 看到全局，决定把任务拆成什么子任务、分给谁。Workers 只管执行自己的子任务。

[KC] KC 的 conductor model（GLM-5/Opus 级别）是 orchestrator，worker LLMs（Qwen-3.6/DeepSeek-v3 级别）是 workers。Orchestrator 在 BUILD 阶段自己做知识性工作，在 DISTILL 阶段把执行任务分配给 workers。

### Evaluator-Optimizer

**一句话**：一个 agent 生成结果，另一个（或自己）评估质量，循环改进直到达标。

> [Anthropic] 适用于"有明确质量标准，可迭代改进"的场景。

这就是我们的 evolution loop 的理论基础。生成 → 评估 → 反馈 → 改进 → 再生成。两个角色可以是同一个模型（自我评估），也可以是不同模型（交叉验证）。

[KC] KC 的 SKILL_TESTING 阶段就是 evaluator-optimizer：KC 既是 skill 的作者，也是 skill 的测试者和改进者。`EvolutionCycleTool` 编码了评估逻辑（diagnose → classify → fix → log）。

### Handoff

**一句话**：一个 agent 把控制权和上下文转交给另一个 agent。

> [OpenAI] "An agent handing off an active conversation to another agent." 接收方拥有"complete knowledge of your prior conversation."

与 orchestrator-workers 的区别：orchestrator-workers 是一个中心节点持续控制全局；handoff 是控制权本身在 agent 之间传递，没有固定的中心节点。

[KC] kc_cli 目前不使用 handoff 模式。`AgentTool` 可以派生子 agent，但主 agent 始终保持控制权（更接近 orchestrator-workers）。

### Guardrails

**一句话**：限制 agent 行为边界的机制——确保 agent 不做不该做的事。

Guardrails 可以在多个层面实现：
- **Prompt 层**：在 system prompt 中声明约束（最弱，模型可能忽略）
- **Tool 层**：不注册不该用的工具（较强，物理上不可调用）
- **代码层**：在工具执行前/后做校验（最强，硬编码约束）

[KC] kc_cli 的**阶段门控**（phase-gated tool registration）是 tool 层 guardrail 的典型实现——BUILD 阶段物理上不注册 `worker_llm_call`，所以 agent 无法调用它，无论 system prompt 怎么写。这比在 prompt 里说"这个阶段不要用 worker LLM"可靠得多。

---

## 基础设施概念

### SSE（Server-Sent Events）

**一句话**：服务端向客户端单向推送数据流的 HTTP 协议，LLM 流式输出的标准传输方式。

当你在 Claude Code 里看到文字一个字一个字蹦出来，底层就是 SSE。HTTP 连接保持打开，服务端持续发送 `data:` 行，客户端逐行解析。

格式很简单：
```
data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":" world"}}]}

data: [DONE]
```

需要注意的是 OpenAI 和 Anthropic 的 SSE 格式不一样。OpenAI 只有 `data:` 行，Anthropic 有 `event:` + `data:` 双行格式，事件类型更细（`content_block_start`、`content_block_delta`、`input_json_delta` 等）。

[KC] `LLMClient._parseAnthropicSSE()` 将 Anthropic 的 SSE 事件归一化为 OpenAI 格式，这样上层代码只需处理一种格式。

### Exponential Backoff（指数退避）

**一句话**：请求失败后，等待时间按指数增长再重试的策略。

第 1 次重试等 1 秒，第 2 次等 2 秒，第 3 次等 4 秒，第 4 次等 8 秒……加上随机 jitter（抖动）避免多个客户端同时重试导致 thundering herd。

这是调用 LLM API 的刚需。API 调用会因为各种原因临时失败（限流 429、服务器错误 5xx、网络波动），大多数情况下等一会儿再试就好了。但有些错误不该重试（认证失败 401、参数错误 400），否则只是浪费时间。

[KC] `withRetry(fn)` 实现了 10 次重试、1s-60s 指数退避、0.2 jitter、区分可重试/不可重试错误、尊重 `Retry-After` header。

### Append-only Log

**一句话**：只追加不修改的日志——数据库里叫 WAL（Write-Ahead Log），分布式系统里叫 event log。

优点：简单、可靠、可审计、天然支持恢复（从任意位置重放）。缺点：文件会一直增长。

在 agent 系统中，append-only log 是 session 持久化的最佳选择。每个事件（用户消息、LLM 调用、工具执行）追加一行 JSON，崩溃后从日志恢复状态。

[KC] `EventLog` 使用 JSONL 格式（每行一个 JSON 对象），存储在 `logs/events.jsonl`。

### Token Estimation

**一句话**：不调用 tokenizer 就大致算出一段文本有多少 token 的启发式方法。

精确的 token 计数需要调用模型专用的 tokenizer（比如 tiktoken），但这有依赖成本。启发式估算够用：英文大约 4 个字符 ≈ 1 个 token，中文大约 1 个字符 ≈ 1.5 个 token。误差在 10-20% 以内，用于上下文用量监控足够了。

[KC] `estimateTokens(text)` 使用 Unicode 范围正则检测 CJK 字符，分别计算。

---

## KC 项目特有概念

### Pipeline / Phase

**一句话**：将 agent 的长期目标结构化为多个阶段，每个阶段有明确的进入条件、退出条件和可用工具集。

这是 KC 在通用 harness 之上的领域层设计。通用 agent 只有一个 agentic loop，KC 的 agent 在这个 loop 之上叠加了 6 个阶段：

```
BOOTSTRAP → EXTRACTION → SKILL_AUTHORING → SKILL_TESTING → DISTILLATION → PRODUCTION_QC
```

每个阶段的 `describeState()` 向 LLM 注入当前阶段的目标和进度，`onToolResult()` 监听工具执行结果判断是否满足退出条件，`exitCriteriaMet()` 定义阶段完成的硬性条件。

Pipeline 解决的问题：**防止 agent 在局部决策中迷失长期目标**。没有 pipeline 的 agent 可能在第 10 分钟开始做第 5 步的事，因为它不知道自己还在第 2 步。

### Phase-Gated Tool Registration

**一句话**：不同阶段注册不同的工具集，从 API 层面限制 agent 的行为。

BUILD 阶段（阶段 1-4）只注册 9 个 core tools，agent 看不到 `worker_llm_call`；DISTILL 阶段（阶段 5-6）额外注册 4 个 distill tools。阶段转换时重建 ToolRegistry。

这是一种 **tool-level guardrail**——比 prompt 约束可靠，因为未注册的工具对 LLM 完全不可见。LLM 不可能调用一个它不知道存在的工具。

### Evolution Loop

**一句话**：KC 的结构化迭代改进机制——测试 → 诊断 → 分类 → 修复 → 记录。

与通用的 evaluator-optimizer 模式的区别在于，KC 的 evolution loop 将失败分为两类处理：
- **Systemic**（系统性，失败率 ≥ 10%）：问题在主流程，需要修改 skill/workflow 本身
- **Corner case**（边界案例，失败率 < 10%）：问题是特殊情况，路由到 CornerCaseRegistry 单独管理，**不修补主流程**

这个分类机制防止主流程被过多的特殊处理 patch 搞得不可维护。

### Workflow Distillation

**一句话**：将 SOTA 模型的能力固化为代码 + prompt 的组合，使其可以在便宜模型上重复运行。

这是快察产品哲学里"指挥→谱曲→演奏"模型的工程实现：
1. **指挥**（Conductor / SOTA model）：理解法规、设计验证策略
2. **谱曲**（Skill / prompt+code）：将策略编码为可执行的 skill
3. **演奏**（Worker LLM / cheap model）：按照 skill 蒸馏出的 workflow 执行

蒸馏后的 workflow 运行成本可能是原始 SOTA 调用的 1/10 到 1/100，但准确率需要与 SOTA 基线对齐。

### Tier System

**一句话**：按模型能力从高到低分 4 层（tier1-4），蒸馏时逐级尝试，找到能胜任任务的最便宜模型。

```
Tier1: 最强（GLM-5, Kimi-K2.5）      — 蒸馏的第一目标
Tier2: 次强（DeepSeek-V3, MiniMax-M2.5）— 如果 tier1 够了，试试更便宜的
Tier3: 中等（Qwen3.5-122B）           — 更便宜
Tier4: 轻量（Qwen3.5-35B）           — 最便宜
```

如果供应商没有合适的低层级模型，低 tier 留空是正确做法。一个强的 tier1 可以覆盖所有任务。

### Provider Registry

**一句话**：集中管理多个 LLM 供应商元数据（URL、认证方式、API 格式、默认模型）的注册表。

解决的问题：不同供应商的 API 差异很大——SiliconFlow 用 Bearer token + OpenAI 格式，Anthropic 用 x-api-key + 自有 Messages API，阿里云区分 API Key 和 Coding Plan Key（不同 URL）。Provider Registry 把这些差异抽象掉，上层代码通过 `providerId` 获取配置。

### Curated Model List / Model Auto-Discovery

**一句话**：让 agent 系统在配置阶段自动获知供应商有哪些可用模型，并按能力分层。

两种获取方式：
- **API 探测**：调用供应商的 `GET /models` 接口，获取可用模型列表，用 `classifyModels()` 按能力评分自动分 tier
- **Curated list**：对于不提供 `/models` 接口的供应商（如阿里云百炼 Coding Plan、火山云），人工维护一份模型列表

[KC] onboard 流程中先尝试 curated list，再 fallback 到 API 探测（5s 超时）。`MODEL_RANKING` 字典为已知模型打 0-100 分，`classifyModels()` 按分数阈值分配 tier（>=85 → tier1, >=70 → tier2, >=55 → tier3, 其余 → tier4）。

### Coding Plan Key

**一句话**：部分中国云服务商提供的包年包月 LLM 订阅模式，使用与按量付费不同的 API 地址。

与普通 API Key 的区别：同一个供应商，按量付费和 Coding Plan 的 base URL 不同。比如阿里云百炼：
- 按量付费：`dashscope.aliyuncs.com/compatible-mode/v1`
- Coding Plan：`coding.dashscope.aliyuncs.com/v1`

用错了 URL 会导致 401 认证错误。Provider Registry 中用 `supportsCodingPlanKey: true` 和 `codingPlanUrl` 字段来处理这个差异。

### SOTA Model

**一句话**：State of the Art，当前最强的模型。

在 KC 的语境中，SOTA 指的是用来驱动 KC agent 本身的高能力模型（如 GLM-5、Claude Opus），而不是 worker LLM。SOTA 模型做知识性工作（理解法规、设计验证策略），worker 模型做重复性执行工作。

KC 的核心命题就建立在 SOTA 和 worker 的能力差之上——用 SOTA 的能力建立基线，蒸馏到 worker 可以运行的形式。

### Ground Truth / Baseline

**一句话**：用于评估其他结果正确性的参考标准。

在 KC 中有两层 baseline：
- **SOTA baseline**：KC agent 自己做验证的结果，作为 "ground truth"
- **Skill baseline**：SKILL_TESTING 阶段通过 evolution loop 验证后的 Skill 结果，作为 DISTILLATION 阶段的 baseline

Workflow 的输出必须对齐 Skill baseline（准确率 >= `WORKFLOW_ACCURACY`，默认 0.9）。如果 workflow 结果与 baseline 偏差过大，说明蒸馏损失了质量。

### System Prompt / ContextAssembler

**一句话**：每次 LLM 调用时注入的背景指令，定义 agent 的身份、能力、当前状态和约束。

System prompt 是 LLM 调用中 `role: "system"` 的消息。它告诉模型"你是谁、能做什么、现在在做什么"。与用户消息（`role: "user"`）和模型回复（`role: "assistant"`）不同，system prompt 在每次调用都会重新注入。

[KC] `ContextAssembler.build()` 动态组装 system prompt，包含三部分：
1. **AGENT_IDENTITY**：KC 的身份描述和架构说明
2. **Pipeline state**：当前阶段的状态描述（来自 `pipeline.describeState()`）
3. **Skill index**：可用的 meta skills 索引（来自 `SkillLoader.formatForContext()`）

这里的"动态"很重要——system prompt 不是写死的文本，它会根据当前阶段、工作区状态、可用 skills 实时变化。

### SkillLoader（技能索引注入）

**一句话**：将 meta skills 的目录索引注入到 agent 上下文中，完整内容按需加载。

这是从 Claude Code 借鉴的模式。Claude Code 不会把所有 skills 的完整内容塞进 system prompt——那样会浪费大量 context 空间。它只放一个简短索引（名称 + 一句话描述），agent 需要某个 skill 的详细内容时通过文件读取工具按需加载。

[KC] `SkillLoader` 扫描 `template/skills/{lang}/` 目录，构建索引，通过 `formatForContext()` 注入 system prompt。Agent 需要具体方法论时，用 `workspace_file` 工具读取完整的 `SKILL.md`。

### Workspace Isolation

**一句话**：每个 session 有独立的工作目录，互不影响。

[KC] `Workspace` 类为每个 session 创建隔离目录（`~/.kc_agent/workspaces/{sessionId}/`），包含 `.env`、`rules/`、`samples/`、`input/`、`output/`、`logs/`、`rule_skills/`、`workflows/` 等子目录。所有文件操作都在这个目录内进行，不同 session 之间完全隔离。

### CornerCaseRegistry（边界案例注册表）

**一句话**：将低频特殊情况独立于主流程管理的数据结构，避免主 workflow 因过多 patch 变得不可维护。

设计灵感来自软件工程中的"特殊路径应该从主路径分离"原则。当 evolution loop 发现某个失败率低于 systemic_threshold（默认 10%）的问题时，不修改主 Skill/workflow，而是将其记录到 `corner_cases.json`。

每个案例包含：`id`、`ruleId`、`detectionPattern`（用于匹配文档）、`resolution`（处理方式）、`affectedDocuments`、`status`（active/resolved/obsolete）。

执行阶段通过 `match(documentName, ruleId)` 对文档做 pattern 匹配——类似一个高阈值的 RAG 管线，只有高度匹配时才触发特殊处理。

### ConfidenceScorer（置信度评分）

**一句话**：为 workflow 的每个输出结果计算置信度分数，驱动分层抽样质控。

高置信度的结果只需少量抽检，低置信度的结果需要全量检查。这让 KC 在 PRODUCTION_QC 阶段可以高效分配审核资源——不是对每个结果都做全量检查，而是根据置信度决定检查力度。

### VersionManager（版本追踪）

**一句话**：跟踪 Skills 和 Workflows 的变更历史。

当 evolution loop 修改了一个 Skill，或者 distillation 更新了一个 workflow，VersionManager 记录变更。这支持回溯和对比——"上一个版本的准确率是多少，这个版本改了什么"。

### Streaming vs Non-Streaming（流式 vs 非流式）

**一句话**：LLM 调用的两种模式——流式逐 token 返回 vs 等待完整结果一次性返回。

- **Streaming**（`streamChat()`）：LLM 生成一个 token 就通过 SSE 推送一个，用户看到文字逐渐出现。适用于 agent 主循环，用户体验好。
- **Non-streaming**（`chat()`）：等 LLM 生成完整回复后一次性返回 JSON。适用于后台任务（如 `/compact` 的摘要生成），不需要实时展示。

[KC] `LLMClient` 同时实现两种模式。`runTurn()` 用 streaming，`compact()` 用 non-streaming。

### ESM（ECMAScript Modules）

**一句话**：Node.js 的现代模块系统，使用 `import/export` 语法替代旧的 `require/module.exports`。

在 `package.json` 中 `"type": "module"` 声明整个项目使用 ESM。文件扩展名为 `.js`，导入时必须包含完整扩展名（`import { X } from "./foo.js"`）。这是 kc_cli 采用的模块格式。

### Ink / React Terminal UI

**一句话**：用 React 组件模型构建终端界面的框架。

Ink 让你用写 React 组件的方式写 CLI 界面——`useState`、`useEffect`、JSX 渲染，但输出不是 DOM 而是终端文本。好处是声明式 UI 管理（状态变了界面自动更新），不需要手动操作光标和 ANSI 转义码。

[KC] 终端界面由 4 个 React 组件构成：`StreamingText`（流式文本渲染）、`ToolBlock`（工具调用展示）、`CookingSpinner`（活动指示器）、`StatusBar`（底部状态栏）。

---

## 行业术语对照

| 英文 | 中文 | 在 KC 中的对应 |
|------|------|---------------|
| Agent | 智能体 / Agent | AgentEngine |
| Harness | 编排框架 / 工具台 | AgentEngine + 周围组件 |
| Agentic Loop | Agent 循环 | `runTurn()` |
| Session | 会话 | EventLog + SessionState |
| Sandbox | 沙箱 / 执行环境 | SandboxExecTool + Workspace |
| Tool Use | 工具调用 | ToolRegistry + BaseTool |
| Context Window | 上下文窗口 | 模型的 token 限制（如 200k） |
| Context Engineering | 上下文工程 | ContextWindow + ContextAssembler |
| Guardrail | 护栏 / 行为约束 | Phase-gated tool registration |
| Orchestrator | 编排器 / 指挥 | KC conductor model |
| Worker | 工作者 / 执行者 | Worker LLMs (tier1-4) |
| Handoff | 交接 | （KC 未使用） |
| Evaluator-Optimizer | 评估-优化循环 | Evolution Loop |
| Distillation | 蒸馏 | DISTILLATION 阶段 |
| SSE | 服务端推送事件 | LLMClient._parseSSE() |
| Exponential Backoff | 指数退避 | withRetry() |
| Append-only Log | 只追加日志 | EventLog (JSONL) |
| Pipeline | 管线 / 阶段系统 | 6-phase Pipeline System |
| SOTA | 当前最强 | Conductor model (GLM-5/Opus) |
| Ground Truth / Baseline | 基线 / 参考标准 | Skill 测试结果作为蒸馏基线 |
| System Prompt | 系统提示 | ContextAssembler.build() |
| Streaming | 流式输出 | LLMClient.streamChat() |
| Corner Case | 边界案例 | CornerCaseRegistry |
| Confidence Score | 置信度分数 | ConfidenceScorer |
| Curated Model List | 人工维护模型列表 | providers.js curatedModels |
| Coding Plan Key | 编程套餐密钥 | Provider supportsCodingPlanKey |
| ESM | ES 模块 | package.json "type": "module" |
| Ink | React 终端 UI 框架 | CLI 界面层 |

---

## 参考资料

- Anthropic - Building Effective Agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic - Managed Agents Engineering: https://www.anthropic.com/engineering/managed-agents
- OpenAI - Orchestrating Agents (Swarm): https://cookbook.openai.com/examples/orchestrating_agents
- KC 技术报告: `docs/team_demo_report_0411.md`
- KC Managed Agents 分析: `docs/managed-agents-analysis.md`
