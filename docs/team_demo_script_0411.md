# KC Agent 团队分享讲稿

> 2026-04-11 白板讨论 + Demo
> 讲者：产品负责人
> 听众：pdf2skills / Anything2Ontology / pdf2app 团队成员（熟悉 Claude Code、Skills、App 模板）

---

## 开场（~2 分钟）

大家好，今天想跟大家分享一下我最近做的 KC Agent 项目。

先说背景——我们团队过去几年一直在做文档验证系统：银行贷款合同、证券合规文件、监管报告。我们经历了完整的业务分析、数据标注、LLM workflow 开发测试、上线维护的全流程。这个过程很痛苦，每个新场景基本都要重来一遍。

KC 项目的核心问题就是：**能不能让一个 Agent 来替代我们自己做这些事？**

不是替代最终用户，而是替代我们——系统架构师、业务分析师、prompt 工程师。让 Agent 自己读法规、提取规则、写验证逻辑、测试、迭代、最终交付一套能用便宜模型跑的生产系统。

---

## 第一部分：KC Agent 是什么，能做什么（~8 分钟）

### 一句话定义

KC Agent 是一个**"生产 Agent 系统的 Agent"**。它读取法规文档和样本文件，自动构建出一套文档验证系统，并持续迭代改进。

### 六阶段工作流程

（白板画流程图）

```
BOOTSTRAP → EXTRACTION → SKILL_AUTHORING → SKILL_TESTING → DISTILLATION → PRODUCTION_QC
```

**阶段 1: BOOTSTRAP（引导启动）**

KC 启动后做的第一件事：建立工作区结构，跟用户确认验证场景是什么。用户需要把法规文档放到 `Rules/` 目录，样本文档放到 `Samples/` 目录。KC 会解析这些文档，理解业务场景。

这个阶段 KC 用的是 SOTA 模型（GLM-5、Claude Opus 这个级别），因为它需要真正理解法规的语义。

**阶段 2: EXTRACTION（规则抽取）**

KC 把法规文档拆解成原子级的验证规则。比如 GDPR 第三章，可能拆出几十条具体的合规检查点。每条规则有明确的检查对象、判断标准、适用范围。

这个工作以前是我们业务分析师做的事。现在 KC 自己做。

**阶段 3: SKILL_AUTHORING（技能编写）**

对每条规则，KC 写一个完整的 Skill 文件夹——按照 Anthropic 官方的 skill-creator 格式。包括：
- `SKILL.md`：业务逻辑描述
- `scripts/`：正则和代码片段
- `references/`：原始法规上下文
- `assets/`：数据样本和边界案例

**这里有一个很重要的认知：Skill 不只是中间产物，KC + Skills 本身就是一个生产模式。** 对于一些高难度、高价值、低频次的验证场景，用 SOTA 模型 + Skills 比 workflow 更划算，同时能在效果上兜底。

**阶段 4: SKILL_TESTING（技能测试）+ Evolution Loop**

KC 用自己写的 Skills 在样本文档上跑验证，评估结果，发现问题就改。这是一个 **evolution loop（进化循环）**——跑测试、分析错误、修改 Skill、再跑测试，直到准确率达标（默认 90%）。

进化循环的每一轮是一个结构化的四步过程：**diagnose → classify → fix → log**。
- **Diagnose**：对失败的文档逐一诊断，归因到 parsing / extraction / judgment / scope 四个环节之一
- **Classify**：按失败率自动分类——失败率 ≥ 10% 判定为系统性问题（systemic），需要重写对应组件；< 10% 判定为边界案例（corner case），路由到 CornerCaseRegistry 单独管理，**不修补主流程**
- **Fix**：系统性问题 → 改 Skill 本身；边界案例 → 记录 pattern 和 resolution 到注册表，在执行时高阈值匹配
- **Log**：每轮迭代生成结构化日志（`logs/evolution/{rule_id}_iter_001.json`），包含准确率变化、失败分布、修复内容

如果同一个 root_cause 在多轮迭代中反复出现，系统会检测并发出 repeated_pattern 警告，提示升级解决策略。整个循环有最大迭代次数限制（默认 20 轮，可配置），达到上限后要求 KC 与 developer user 讨论剩余问题。

这个循环是 KC 最核心的价值之一。它把我们以前手动做的"发现问题→分析原因→改 prompt→重测"的循环自动化了。

**阶段 5: DISTILLATION（蒸馏）**

当 Skills 稳定后，KC 把它们转化成 workflow——用 Python 代码和 prompt 的组合，能在便宜的小模型上跑（Qwen-3.6、DeepSeek-v3 这个级别）。

核心设计原则：**用能够胜任任务的最小模型**。SOTA 模型是老师和裁判，小模型是执行者。SOTA 模型的能力被蒸馏到代码和 prompt 里。

蒸馏阶段本身也包含迭代验证：KC 将 Skill 阶段的结果作为准确性基线（baseline），workflow 的输出必须对齐这个基线。`tier_downgrade` 工具会逐级尝试更小的模型（tier1 → tier2 → tier3 → tier4），在准确率容忍范围内（默认 5%）找到最便宜的可用 tier。如果降级后准确率低于阈值，保持在当前 tier。

**阶段 6: PRODUCTION_QC（生产质控）**

Workflow 在 `Input/` 目录的生产文档上批量运行。KC 设计了一套基于置信度的抽样检查机制：
- 高置信度结果：抽检 10%
- 中置信度结果：抽检 50%
- 低置信度结果：全量检查

生产阶段发现的问题会反馈回系统——新的边界案例进入 CornerCaseRegistry，系统性问题可能触发 Skill 回退重测。理想情况下，随着系统成熟，KC 可以逐步降低监控频率直到趋近于零——除非法规本身发生变化。

### 贯穿全流程的反思机制

Evolution Loop 不仅存在于 SKILL_TESTING 阶段。**Plan → Execute → Reflect → Evolve** 是 KC 的全局设计理念：

- EXTRACTION 阶段：KC 在抽取规则后会回头检查覆盖度和粒度是否合适
- SKILL_TESTING 阶段：结构化的 diagnose → classify → fix → log 循环
- DISTILLATION 阶段：workflow vs skill 基线对比 + tier downgrade 搜索
- PRODUCTION_QC 阶段：置信度抽样 + 问题反馈到上游阶段

支撑这个机制的关键组件是 **CornerCaseRegistry**（`corner_cases.json`）：边界案例不是被忽略或硬编码到主流程中，而是作为一等数据结构独立管理。每个案例有 detection pattern、resolution、affected documents、status（active/resolved/obsolete）。在执行阶段，CornerCaseRegistry 对文档做 pattern 匹配，命中时应用对应的特殊处理。这避免了主 workflow 因为过多 patch 变得不可维护。

### 两种运行模式

- **BUILD 模式**：阶段 1-4，KC 自己做所有知识性工作，建立准确性基线
- **DISTILL 模式**：阶段 5-6，将能力蒸馏到便宜模型，对比基线验证质量

### Demo 演示

（此处启动 `kc-beta`，演示以下内容）
- 启动界面、状态栏（显示 session、phase、context 使用率）
- `/status` 命令看当前状态
- 展示一个已完成的 workspace 结构
- 展示生成的 Skill 文件夹样例
- 展示 Output 中的验证结果

---

## 第二部分：产品定位和设计哲学（~5 分钟）

### 从初始设想说起

（打开 `docs/initial_spec_draft.md` 白板上画角色关系图）

我最初写这个 spec 的时候，定义了系统中的五个角色：

```
Super-developer（我们）
    ↓ 提供 meta skills
Developer User（开发者用户，比如银行信贷部技术负责人）
    ↓ 加载 skills 到
Coding Agent（Claude Code）
    ↓ 构建
Verification App（验证应用，跑在 worker LLMs 上）
    ↓ 服务
End User（最终用户，比如信贷部分析师）
```

我们的定位是**指挥家**。Developer user 和 Coding agent 是**作曲家**。最终的 App 和 Worker LLMs 是**演奏家**。

### 三个核心设计原则

**1. Minimum Viable Model（最小可用模型）**

不是追求用最强的模型，而是用能做好这件事的最便宜的模型。文档解析能用 pymupdf 就不用 VLM，正则能搞定的不用 LLM。但是——只在需要的时候才降级，不要过早优化。

**2. JIT Structure（即时结构）**

数据 schema 和格式是 JIT 的——按需生成，保持敏捷。不预先定义死板的数据结构。存在性和一致性比具体格式重要。

**3. OTF Evolution（运行时进化）**

系统通过运行不断进化，最终的形态可能和起点完全不同。Plan → Execute → Reflect → Evolve。

### 一个很重要的经验

（着重强调）

**不要过度规定（over-prescribe）。** 我最初给 KC 写了很详细的规则和示例，结果发现 SOTA 模型会过拟合到这些示例上，对具体场景反而不好。Meta skills 应该传递方法论和理念，而不是手把手教每一步怎么做。给 Agent 足够的自由度和权限。

同样的道理，不要用"你是一个架构师"这种角色扮演 prompt——对 SOTA 模型没用，反而可能限制它的发挥。

### 两层 Meta Skills

- **Meta Meta Skills**：系统架构层——怎么设计一个自举（bootstrap）和进化的系统、怎么从 SOTA 模型降级到小模型、怎么设置参数、怎么跟用户沟通。这是我作为系统架构师和产品经理的 skills。
- **Meta Skills**：业务方法论层——怎么做文档验证、怎么具体构建 workflow。这是我作为业务分析师和 prompt 工程师的 skills。

---

## 第三部分：kc_cli 详细架构（~8 分钟）

### 技术栈

（白板画架构图）

```
┌─────────────────────────────────────────────────┐
│  Terminal UI (Ink/React 19)                      │
│  ├── StreamingText (流式输出)                     │
│  ├── ToolBlock (工具调用展示)                     │
│  ├── CookingSpinner (活动指示器)                  │
│  └── StatusBar (session/phase/context usage)     │
├─────────────────────────────────────────────────┤
│  CLI Layer (bin/kc-beta.js)                      │
│  ├── onboard (首次配置向导)                       │
│  ├── config (分类设置编辑器)                      │
│  ├── init (项目初始化)                            │
│  └── main (主 Agent 循环)                        │
├─────────────────────────────────────────────────┤
│  AgentEngine (Harness Loop)                      │
│  ├── LLMClient (多协议: OpenAI / Anthropic SSE) │
│  ├── ConversationHistory (消息持久化)             │
│  ├── ContextAssembler (system prompt 组装)       │
│  ├── ContextWindow (自动上下文裁剪)               │
│  ├── EventLog (append-only JSONL 事件日志)       │
│  ├── SessionState (会话状态持久化)                │
│  ├── SkillLoader (meta skills 索引注入)          │
│  └── TokenCounter (token 估算)                   │
├─────────────────────────────────────────────────┤
│  ToolRegistry (阶段门控)                          │
│  ├── BUILD 阶段工具:                              │
│  │   sandbox_exec, workspace_file,               │
│  │   document_parse, document_search,            │
│  │   rule_catalog, evolution_cycle,              │
│  │   dashboard_render, agent_tool, web_search    │
│  └── DISTILL 阶段工具:                           │
│      worker_llm_call, workflow_run,              │
│      tier_downgrade, qc_sample                   │
├─────────────────────────────────────────────────┤
│  Pipeline System (6 phases)                      │
│  ├── Bootstrap → Extraction → SkillAuthoring     │
│  ├── SkillTesting → Distillation → ProductionQC │
│  └── 每个 pipeline: exportState / importState    │
├─────────────────────────────────────────────────┤
│  Provider Registry (10 providers)                │
│  ├── SiliconFlow, Aliyun, VolcanoCloud          │
│  ├── Anthropic, OpenAI, Zhipu, MiniMax          │
│  ├── OpenRouter, Bedrock(stub), Custom           │
│  └── 模型排名 + 自动分层 + curated lists        │
├─────────────────────────────────────────────────┤
│  Infrastructure                                  │
│  ├── Retry (指数退避, 10次重试, jitter)          │
│  ├── Workspace (per-session 隔离目录)            │
│  └── Config (.env + ~/.kc_agent/config.json)     │
└─────────────────────────────────────────────────┘
```

### 核心循环（Harness Loop）

AgentEngine 的 `runTurn()` 方法就是一个标准的 Agent harness loop：

```
用户输入 → 加入历史 → 组装 system prompt（skills + pipeline 状态）
    ↓
    ┌──────────────────────────────────────┐
    │  调用 LLM（流式）                     │
    │  ├── 收集文本输出                     │
    │  └── 收集 tool_calls                 │
    │         ↓                            │
    │  执行每个 tool_call                   │
    │  ├── 结果加入历史                     │
    │  └── 如果有 pipeline 事件 → 处理阶段转换 │
    │         ↓                            │
    │  还有 tool_calls？→ 继续循环          │
    └──────────────────────────────────────┘
    ↓ 没有更多 tool_calls
返回（一轮结束）
```

### 几个关键设计决策

**1. 多协议 LLM Client**

LLMClient 支持 OpenAI 兼容协议和 Anthropic 原生 Messages API。Anthropic 的 SSE 流格式跟 OpenAI 完全不同（`content_block_delta`、`input_json_delta` 等），我在 `_parseAnthropicSSE()` 里做了完整的归一化，统一转成 OpenAI chunk 格式。这样 engine.js 完全不需要改——**接口不变，后端可替换**。

**2. 阶段门控的工具注册**

不是所有工具一开始就全部可用。BUILD 阶段只注册知识性工具（文档解析、规则目录、进化循环等），DISTILL 阶段才注册 worker LLM 相关工具。这防止 KC 在不该用小模型的时候去调用小模型。

**3. 事件日志（Event Log）**

所有活动——用户消息、LLM 调用、工具执行、阶段转换、错误——都以 append-only JSONL 格式持久化到 `logs/events.jsonl`。这是会话恢复和审计的基础。这个设计直接来自 Anthropic Managed Agents 的 Session 概念。

**4. 上下文管理三件套**

- **TokenCounter**：字符级 token 估算（Latin ~4 chars/token, CJK ~1.5 tokens/char）
- **ContextWindow**：当消息接近 85% context limit 时自动压缩旧消息，保留最近 30 条完整
- **/compact 命令**：用 LLM 总结旧对话，保留最近 20 条，用户可手动触发

**5. 会话持久化与恢复**

`session-state.json` 保存当前阶段、pipeline milestones、phase summaries。用户可以用 `/resume <name>` 恢复之前的会话，精确回到中断位置。每个 Pipeline 子类都实现了 `exportState()` / `importState()`。

---

## 第四部分：Agent Harness 简介（~5 分钟）

### 什么是 Agent Harness

先说概念。Anthropic 在他们的工程博客里定义了构建生产级 Agent 的核心架构模式。

最基础的理解：Agent = LLM + 循环 + 工具。Anthropic 官方的说法是，Agent 是"LLM 动态指导自身流程和工具使用的系统，自主控制如何完成任务"。区别于 workflow（预定义的代码路径），Agent 的执行路径是模型自己决定的。

**Harness 就是这个循环本身**——调用 Claude → 路由工具调用 → 重复。它是编排器。

### Anthropic Managed Agents 的三个核心抽象

Anthropic 在 2026 年 4 月发布的 Managed Agents 里，借鉴了操作系统的设计思想，定义了三个组件：

| 组件 | 类比 | 职责 |
|------|------|------|
| **Session** | 文件系统/事务日志 | Append-only 事件日志，持久化所有活动记录 |
| **Harness** | 进程调度器 | 无状态编排循环：调用 Claude → 路由工具调用 → 重复 |
| **Sandbox** | 容器/虚拟机 | 代码执行和文件操作的隔离环境 |

关键设计："Brain 与 Hands 解耦"。早期版本把所有组件耦合在一个容器里，容器崩溃就全部丢失。解耦后，Harness 是无状态的（崩溃后可以重新创建），Sandbox 是可替换的（崩溃后启动新容器），Session 是持久的（通过 `getEvents()` 恢复状态）。

用他们原话说：**"接口有主见，实现不设限"（Opinionated about interfaces, agnostic about implementations）**。

### 跟 KC 的对应关系

（白板上画对照表）

| Managed Agents | KC CLI |
|----------------|--------|
| Session (事件日志) | `EventLog` (append-only JSONL) + `SessionState` |
| Harness (编排循环) | `AgentEngine.runTurn()` |
| Sandbox (执行环境) | `SandboxExecTool` + `Workspace` |
| 工具接口 `execute(name, input) → string` | `BaseTool.execute(input) → ToolResult` |
| 上下文工程 | `ContextWindow` + `ContextAssembler` |

KC 比 Managed Agents 多的部分是 **Pipeline System**——6 个阶段的结构化编排。Managed Agents 是通用基础设施，KC 的 Pipeline 是领域特色。

### Anthropic 的 Agent 构建建议

Anthropic 在 "Building Effective Agents" 博客中提出了五种由简到繁的模式：

1. **Prompt Chaining**：任务分解为顺序步骤
2. **Routing**：输入分类，分发到专门处理器
3. **Parallelization**：独立子任务并行执行
4. **Orchestrator-Workers**：中心 LLM 动态分解任务
5. **Evaluator-Optimizer**：一个 LLM 生成，另一个评估反馈

核心原则："只在能明显改善结果的时候才增加复杂度。" KC 的设计本质上是 **Orchestrator-Workers + Evaluator-Optimizer** 的组合——KC 主 Agent 是 orchestrator，worker LLMs 是 workers，evolution loop 是 evaluator-optimizer。

---

## 第五部分：开发过程中的问题与解决（~8 分钟）

### 问题 1（最高优先级）：长时间运行不稳定

**现象**：KC 运行 30-40 分钟后开始不稳定——响应变慢、键盘输入有 0.1 秒延迟、甚至直接断连。

**根因分析**：
- LLM API 调用没有重试机制，一次网络波动就彻底中断
- 对话历史无限增长，context 超限后行为不可预测
- 进程退出后所有状态丢失，无法恢复

**解决方案（Context Engineering 整套）**：
- **Retry 机制**：指数退避重试（1s 到 60s，最多 10 次），区分可重试错误（429、5xx、网络错误）和不可重试错误（401、403）。尊重 `Retry-After` header
- **Token 估算 + 状态栏显示**：实时显示 `CTX: 45.2k/200k (23%)`，颜色编码（绿 < 60%，黄 < 80%，红 >= 80%）
- **自动上下文裁剪**：接近 85% 限制时自动压缩旧消息
- **/compact 命令**：用 LLM 总结旧对话，释放 context 空间
- **会话持久化 + /resume**：保存完整状态到文件，支持跨会话恢复

这一块的设计大量参考了 Anthropic Managed Agents 的 Session 概念和 Claude Code 的源码实现。

### 问题 2：单一 LLM 提供商的局限

**现象**：最初只支持 SiliconFlow。但团队有人用阿里云百炼，有人用火山云，API 格式和认证方式都不一样。阿里云还有"编程专用"的 Coding Plan Key，用不同的 base URL。

**解决方案**：
- 建立 Provider Registry（`src/providers.js`），10 个预设供应商
- LLMClient 支持 OpenAI 和 Anthropic 两种 API 协议
- 完整的 Anthropic SSE 流归一化——这个比较复杂，Anthropic 的流式格式跟 OpenAI 完全不同，需要跟踪 `content_block_start/delta`、`input_json_delta`、`message_delta` 等事件类型，全部转成 OpenAI chunk 格式
- 模型自动发现：连接 API 后探测可用模型，按能力评分自动分配 tier
- 对于没有 `/models` 接口的供应商（阿里云、火山云），维护 curated model lists

### 问题 3：KC Agent 违反自身设计原则

**现象**：AB 测试中发现 KC 会在应该自己做的阶段（比如规则抽取）去调用 worker LLM，违反了"SOTA 模型做知识性工作"的核心设计。

**解决方案**：阶段门控的工具注册。BUILD 阶段不注册 `worker_llm_call` 等蒸馏工具，物理上阻止 KC 在错误的阶段使用错误的工具。这比在 prompt 里反复强调"不要用 worker LLM"有效得多。

### 问题 4：配置交互体验差

**现象**：团队成员在 onboard 流程中不知道哪些字段可以跳过，卡在那里不知道该按什么键。

**解决方案**：
- 分离 `onboard`（首次配置，顺序引导）和 `config`（后续修改，分类菜单）
- 所有可跳过的字段加上灰色提示 `(Press Enter to keep)` / `(Press Enter to use default)`
- 阈值等高级设置从 onboard 移到 config，降低首次使用门槛

### 问题 5：用户不知道 KC 在干什么

**现象**：KC 经常连续工作 10-15 分钟不输出任何内容。用户不确定它是在工作还是卡死了。

**解决方案**：Always-on spinner，根据当前活动显示不同状态——"Thinking..."（LLM 推理中）、"Running document_parse..."（工具执行中）、"Analyzing results..."（处理结果中）。只要 KC 在工作就显示。

---

## 第六部分：可以抽象的经验——如何构建"生产 Agent 系统的 Agent"（~10 分钟）

### 经验 1：Agent Harness 是通用基础设施

KC 的 AgentEngine 本质上就是一个 harness loop。这个模式可以复用到任何"Agent 自动构建 X"的场景。核心组件清单：

1. **LLM Client**（多协议、多供应商）
2. **Tool Registry**（阶段门控）
3. **Conversation History**（消息持久化）
4. **Event Log**（append-only 活动日志）
5. **Context Window**（自动裁剪）
6. **Session State**（跨会话恢复）
7. **Retry**（指数退避）

这 7 个组件构成了一个可复用的 harness 框架。不同场景只需要换 Pipeline 和 Tools。

### 经验 2：Pipeline 即领域知识

KC 的 6 个阶段（bootstrap → extraction → authoring → testing → distillation → QC）编码了"怎么构建一个文档验证系统"的领域知识。

如果我们要做一个"KC for X"——比如自动构建数据分析 pipeline、自动构建推荐系统——需要重新定义的是 Pipeline 的阶段和每个阶段的 Tools，而不是 harness 基础设施。

**思考题给大家：如果要让 Agent 自动构建一个 pdf2app 的 App 模板，Pipeline 应该分哪几个阶段？每个阶段需要什么 Tools？**

### 经验 3：Skills 是一等公民的交付物

这一点要特别强调。之前我们习惯把 Skills 当成中间步骤——写 Skill 只是为了最终蒸馏成 workflow。但实际上，**KC + Skills 本身就是一个生产模式**。

对于高价值低频次的场景，用 SOTA 模型 + 精心编写的 Skills 来跑，可能比花大量时间蒸馏成 workflow 更经济。蒸馏的成本不只是一次性的——还有维护成本、法规变更时的更新成本。

所以在设计类似系统时，要把"Agent + Skills"作为一个独立的交付选项，不要强制要求所有场景都走到 DISTILL 阶段。

### 经验 4：给 Agent 自由度比给详细指令更重要

我们在 meta skills 中试过两种风格：
- 详细版：每一步具体怎么做，给出完整示例
- 精简版：只给方法论和原则，让 Agent 自己决定

结论是精简版效果更好。SOTA 模型（Opus 4.6 级别）有足够的能力自己制定执行计划。过度详细的指令反而导致模型过拟合到示例上，对实际场景的适应性变差。

**每写一个 feature 或 prompt，都要问自己：我是不是在 over-prescribe？我是在传递方法论还是在手把手教？**

### 经验 5：Append-only Event Log 是一切的基础

从 Anthropic Managed Agents 学到的最重要的一个设计模式。

传统做法是维护一个 `messages` 数组，越来越长，最终 context 爆炸。Event log 的思路是：**完整记录一切，但按需读取**。Session 是完整的持久化存储，Harness 层决定什么时候、把什么内容喂给模型。

这让会话恢复、审计、调试都有了坚实基础。KC 的 `events.jsonl` 记录了每一次 LLM 调用、工具执行、阶段转换，任何时候都可以精确回放。

### 经验 6：Worker Tier 不需要填满

如果供应商没有合适的便宜模型，**低层级 tier 留空是完全可以的**。一个能力够强的 tier1 模型可以处理所有任务。

比如阿里云百炼的 Coding Plan：conductor 用 GLM-5，tier1 worker 用 qwen3.6-plus（有视觉能力，可以做 OCR），tier2-4 全部留空。不要为了填满 tier 而选一个不够格的模型。

### 经验 7：接口有主见，实现不设限

这是 Anthropic Managed Agents 的设计哲学，KC 也受益匪浅。

- `BaseTool.execute(input) → ToolResult`——所有工具同一接口，后端可以是本地 spawn、HTTP API、甚至未来的云端沙箱
- `LLMClient` 保持同一接口，后端从 SiliconFlow 切换到 Anthropic 完全无感
- Pipeline 的 `exportState()` / `importState()`——同一接口，每个阶段自己决定存什么

设计新工具、新组件的时候，先定义好接口，实现可以自由演进。

---

## 总结与讨论（~5 分钟）

### 一句话总结

KC 证明了一件事：**用一个 SOTA Agent 来自动构建和优化一套基于小模型的生产系统，这个路径是可行的。** 核心不是某个具体技术，而是 harness + pipeline + evolution loop 的组合模式。

### 对团队的意义

我们以前的交付物是 App 模板。现在可以往上抽象一层——交付的是**"能自动生成和进化 App 的 Agent 系统"**。

KC 目前聚焦在文档验证场景。但它的 harness 基础设施、provider registry、context engineering、session management 都是场景无关的。如果我们要做其他类型的"生产 Agent 系统的 Agent"，可以复用这些组件。

### 开放讨论

1. 大家在自己的 App 模板工作中，有哪些环节是重复性最高、最想让 Agent 自动化的？
2. 如果要把 KC 的 harness 基础设施抽出来做成通用框架，你们觉得还缺什么？
3. 对于 Skills 作为独立交付物这个观点，大家怎么看？在你们的场景中，有没有"SOTA + Skills 就够了"的案例？

---

## 附录：参考资源

- KC CLI 源码：`desktop/kc_cli`
- KC Reborn（Python+Node 版）：`desktop/kc_reborn`
- Anything2Ontology：`desktop/Anything2Ontology`
- pdf2skills 文档库：`desktop/pdf2skills-doc-base`
- Anthropic Managed Agents 工程博客：https://www.anthropic.com/engineering/managed-agents
- Anthropic Building Effective Agents：https://www.anthropic.com/engineering/building-effective-agents
- KC 初始设计文档：`kc_cli/docs/initial_spec_draft.md`
- KC Managed Agents 分析：`kc_cli/docs/managed-agents-analysis.md`
- KC 更新设计文档：`kc_cli/docs/global_update_design_v2.md`
- KC 开发日志：`kc_cli/DEV_LOG.md`
