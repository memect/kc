# Anthropic Managed Agents 分析 & KC 项目启示

> 基于 2026-04-08 Anthropic 发布的 Managed Agents 公测版，结合 kc-beta 项目架构的分析。

---

## 一、Managed Agents 是什么，能做什么

### 定义

Managed Agents 是 Anthropic 提供的**一套可组合的云端 Agent API**，用于在生产环境中构建、部署和运行 AI Agent。它把构建生产级 Agent 所需的基础设施（沙箱执行、状态管理、凭证处理、权限控制、链路追踪）全部托管，开发者只需定义 Agent 的行为逻辑。

### 三个核心抽象

Managed Agents 借鉴操作系统的设计思想，将 Agent 虚拟化为三个组件：

| 组件 | 类比 | 职责 |
|------|------|------|
| **Session** | 文件系统 / 事务日志 | Append-only 事件日志，持久化所有活动记录 |
| **Harness** | 进程调度器 | 无状态编排循环：调用 Claude → 路由工具调用 → 重复 |
| **Sandbox** | 容器 / 虚拟机 | 代码执行和文件操作的隔离环境 |

### 关键设计决策："Brain 与 Hands 解耦"

早期版本将所有组件耦合在单个容器中。容器崩溃 = 会话丢失 + 无法调试（安全与可观测性冲突）。

解耦后的架构：
- **Harness 变为无状态**：不再住在容器里，按需创建
- **Sandbox 变为可替换**：崩溃后 Harness 捕获失败，用 `provision({resources})` 启动新容器
- **恢复机制**：新 Harness 调用 `wake(sessionId)` → `getSession(id)` 获取事件日志 → 从最后一个事件恢复
- **工具调用统一接口**：`execute(name, input) → string`，Harness 不关心 Sandbox 是容器、手机还是任何其他执行环境

### 核心能力

1. **长时运行会话**：Session 作为外部上下文存储，突破 context window 限制
2. **上下文工程分离**：Session 负责持久化存储，Harness 负责上下文裁剪和优化（prompt cache 等），两者解耦
3. **安全凭证管理**：凭证永远不进入 Sandbox——Git token 在初始化时注入 remote，OAuth token 存 vault 由代理层转发
4. **多 Brain 多 Hands**：无状态 Harness 可水平扩展，一个 Brain 可连接多个执行环境
5. **自我评估**（研究预览）：Agent 根据定义的成功标准迭代改进
6. **多 Agent 协调**（研究预览）：多个 Agent 之间的任务委派和协作

### 性能收益

- p50 TTFT（首 token 时间）降低约 60%
- p95 TTFT 降低超过 90%
- 原因：推理立即开始，容器仅在工具调用时按需创建

---

## 二、Managed Agents 与 KC 项目的结合可能

### 2.1 当前 KC 架构速览

KC-beta 是一个纯 Node.js 的文档验证 Agent CLI，核心架构：

```
AgentEngine (harness loop)
  ├── LLMClient (OpenAI-compatible API)
  ├── ContextAssembler (system prompt 组装)
  ├── ConversationHistory (消息持久化)
  ├── Workspace (per-session 隔离目录)
  ├── ToolRegistry → 14+ tools (sandbox_exec, document_parse, worker_llm_call...)
  ├── Pipelines (BUILD: bootstrap→extraction→authoring→testing)
  │               (DISTILL: distillation→production_qc)
  ├── SkillLoader (meta-meta/meta/skill-creator 索引)
  ├── VersionManager + CornerCaseRegistry + ConfidenceScorer
  └── AgentTool (子 agent 递归生成)
```

两种模式：
- **BUILD 模式**：KC 自己做知识性工作（解析法规、提取规则、编写 skill、测试），建立准确性基线
- **DISTILL 模式**：将 skill 转化为便宜模型可运行的 workflow，对比基线验证质量

### 2.2 架构对应关系

| Managed Agents 概念 | KC 当前实现 | 差异 |
|---------------------|-------------|------|
| Session (事件日志) | `ConversationHistory` (messages.json) | KC 存完整消息，MA 是 append-only 事件流 |
| Harness (编排循环) | `AgentEngine.runTurn()` | KC 是有状态的类实例，MA 是无状态的 |
| Sandbox (执行环境) | `SandboxExecTool` + `Workspace` | KC 是本地进程，MA 是云端容器 |
| 工具接口 | `BaseTool.execute(input) → ToolResult` | 高度相似：`execute(name, input) → string` |
| 上下文管理 | `ContextAssembler.build()` | KC 每次重建完整 prompt，MA 可选择性切片 |
| 凭证管理 | `.env` + `config.json` 直传 | KC 凭证直接在进程中，MA 通过代理层隔离 |

### 2.3 可能的结合方向

#### 方向 A：KC 的 DISTILL 模式用 Managed Agents 替代 Worker LLM

当前 KC 在 DISTILL 模式中通过 `WorkerLLMCallTool` 直接调用便宜模型。如果 Anthropic 成为 KC 的一个可选 LLM 后端，可以：

- 用 Managed Agent Session 来运行长时间的批量验证任务
- 利用 MA 的沙箱执行来运行验证脚本，而不是本地 `child_process.spawn`
- 利用 MA 的持久化和恢复能力，让大规模 QC 作业在断开后可恢复

#### 方向 B：KC 自身作为 Managed Agent 部署

KC 目前是本地 CLI。如果要支持云端部署（SaaS 化）：

- Session API 提供了现成的持久化层，替代 KC 的文件系统 workspace
- Harness 的无状态模式天然适合 serverless 部署
- 多 Agent 协调可以让 KC 的 BUILD 和 DISTILL 各自作为独立 Agent 运行

#### 方向 C：Managed Agents API 作为 KC 的一个 Tool

在 KC 的 ToolRegistry 中新增一个 `ManagedAgentTool`：
- KC 主 Agent（conductor）委派子任务给 Managed Agent
- 适用场景：需要真正沙箱隔离的代码执行、需要长时运行的文档处理
- 类似现有 `AgentTool` 但执行在云端

---

## 三、Managed Agents 的设计和工程思路对 KC 的启发

### 3.1 将 Session 从 "消息历史" 升级为 "事件日志"

**MA 做法**：Session 是 append-only 事件流，不只是 chat messages，而是所有活动（工具调用、结果、阶段转换、错误）的完整记录。Harness 通过 `getEvents()` 选择性读取，支持：
- 位置切片（从某个点开始读）
- 回退到某个时刻之前
- 在喂给 Claude 之前做变换（上下文工程）

**KC 现状**：`ConversationHistory` 存两份数据（API messages + display log），但都是完整线性列表，没有选择性读取能力。

**启发**：
- KC 的 `AgentEvent` 已经有事件类型（`text_delta`, `tool_start`, `tool_result`, `pipeline_event`），但只用于 CLI 渲染，没有持久化
- 可以把 `AgentEvent` 流持久化为真正的 event log，让 `ConversationHistory` 变成 event log 的一个视图
- 这样 pipeline 阶段转换、tool 执行历史、错误恢复都有了可审计的基础
- 长会话时可以按需加载事件片段，而不是把全部 messages 塞进 context

### 3.2 Harness 无状态化

**MA 做法**：Harness 是无状态的，所有状态在 Session 中。崩溃后新 Harness 通过 `wake(sessionId)` + `getSession(id)` 恢复。

**KC 现状**：`AgentEngine` 是有状态类，持有 `history`, `workspace`, `toolRegistry`, `currentPhase`, `pipelines` 等。进程退出 = 状态丢失（虽然 history 持久化了，但 phase、pipeline state 等没有）。

**启发**：
- KC 已经有会话恢复的雏形（`ConversationHistory._load()` 从 workspace 加载历史消息）
- 可以进一步将 `currentPhase`、pipeline milestone、tool registry 状态也持久化到 workspace
- 这样 `kc-beta resume <sessionId>` 可以精确恢复到上次中断的位置，而不仅仅是重放对话历史
- 对于长时间运行的 BUILD 流程（可能跨多天），这一点尤其重要

### 3.3 "Brain 与 Hands 解耦" 的思维模型

**MA 做法**：Harness 调用 Sandbox 就像调用任何工具一样：`execute(name, input) → string`。Harness 不知道也不关心执行环境是什么。

**KC 现状**：`SandboxExecTool` 直接 `spawn("sh", ...)` 在本地执行。`WorkerLLMCallTool` 直接 HTTP 调用 API。Tool 和执行环境是紧耦合的。

**启发**：
- KC 的 `BaseTool` 接口已经足够抽象（`execute(input) → ToolResult`），这是一个好的基础
- 但具体 Tool 实现内部耦合了执行方式。如果要支持本地/云端/远程多种执行环境，可以在 Tool 和执行环境之间加一层抽象
- 不一定现在就做——但在设计新 Tool 时保持这种"接口不变，后端可替换"的意识

### 3.4 凭证隔离

**MA 做法**：凭证永远不进入 Sandbox。Git token 在初始化时注入 remote URL，OAuth token 存 vault 通过代理层转发。Agent（Claude）永远看不到真实 token。

**KC 现状**：API key 通过 `config.js` → `loadSettings()` 直接注入到 Tool 实例中，Tool 在 system prompt 可见的上下文中使用这些 key。`SandboxExecTool` 执行的命令可以访问环境变量。

**启发**：
- 当前 KC 是本地 CLI，凭证暴露风险可控
- 但如果 KC 走向 SaaS 或多用户，需要考虑凭证隔离
- 短期可做：确保 `SandboxExecTool` 不将 API key 传入子进程环境变量
- 长期可做：Worker LLM 的 API key 通过代理层转发，而不是直接传给 WorkerLLMCallTool

### 3.5 上下文工程与 Session 分离

**MA 做法**：Session 只管持久化（`emitEvent`/`getEvents`），上下文工程（裁剪、压缩、cache 优化）全部在 Harness 层做。两者通过变换层（transformation layer）连接。这样 Session 格式稳定，而上下文策略可以随模型迭代变化。

**KC 现状**：`ContextAssembler` 拼接 system prompt，`ConversationHistory` 提供完整消息列表。当消息列表过长时没有裁剪策略。

**启发**：
- KC 可以在 `AgentEngine.runTurn()` 中加入上下文窗口管理：
  - 当消息总 token 接近模型限制时，对早期消息做摘要压缩
  - 保留最近的 tool_call/tool_result 对完整，压缩更早的
  - Pipeline 阶段转换时可以做一次"阶段总结"，清理前一阶段的细节消息
- 这与 MA 的"Session 是完整记录，Harness 做选择性读取"理念一致
- `ContextAssembler` 可以从"拼接器"升级为"上下文编排器"，根据当前 phase 和 token 预算决定放什么进 context

### 3.6 Pipeline 阶段作为一等公民

**MA 做法**：没有内置 pipeline 概念，但 Session 的事件日志 + Harness 的无状态恢复天然支持多阶段长时任务。

**KC 优势**：KC 的 Pipeline 系统（`Phase.BOOTSTRAP → EXTRACTION → SKILL_AUTHORING → SKILL_TESTING → DISTILLATION → PRODUCTION_QC`）是一个比 MA 更结构化的编排层。这是 KC 的领域特色，MA 是通用基础设施。

**启发**：
- KC 的 pipeline 可以借鉴 MA 的恢复模式：每个 pipeline milestone 持久化到 workspace，以支持跨会话恢复
- Pipeline 阶段转换事件应该写入 event log（不只是 yield `AgentEvent`），这样恢复时可以精确定位阶段

### 3.7 "Opinionated about interfaces, agnostic about implementations"

**MA 的哲学**：对 Session/Harness/Sandbox 的接口有明确主张，但对接口背后跑什么不做限制。

**对 KC 的启发**：
- KC 的 `BaseTool` 接口、`AgentEvent` 类型、`Phase` 枚举已经是好的接口定义
- 保持这些接口稳定，让实现可以自由演进
- 例如：`LLMClient` 可以保持接口不变，但后端从 SiliconFlow 切换到 Anthropic API 或本地模型
- `SandboxExecTool` 可以保持接口不变，但后端从本地 spawn 切换到远程容器

---

## 四、优先级建议

按投入产出比排序，KC 可以从 MA 中汲取的改进：

| 优先级 | 改进项 | 复杂度 | 收益 |
|--------|--------|--------|------|
| P0 | AgentEvent 持久化为 event log | 低 | 审计、调试、恢复的基础 |
| P0 | Pipeline 状态持久化 + 会话恢复 | 中 | 支持跨天的长流程 |
| P1 | 上下文窗口管理（长会话裁剪） | 中 | 防止 token 爆炸 |
| P1 | SandboxExec 凭证隔离 | 低 | 安全加固 |
| P2 | Event log 选择性读取 | 中 | 长会话性能优化 |
| P2 | 执行环境抽象层 | 高 | 为未来云端部署做准备 |
| P3 | 接入 Managed Agents API 作为 Tool | 高 | 云端沙箱能力 |

---

## 五、一句话总结

> Managed Agents 的核心洞察是**把 Agent 当作操作系统进程来管理**——Session 是持久存储，Harness 是无状态调度器，Sandbox 是可替换的执行环境。KC 已经有了类似的骨架（AgentEngine/Workspace/ToolRegistry），最值得借鉴的是：**把 AgentEvent 升级为持久化事件日志，让 Pipeline 状态可恢复，让上下文管理独立于消息存储**。
