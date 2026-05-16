---
name: bootstrap-workspace
tier: meta-meta
description: Initialize and configure a document verification workspace. Use when a developer user first opens this workspace, when .env needs configuration, or when the business scenario needs to be understood. Guides the coding agent through reading regulation documents, understanding the developer user's business context, configuring model tiers and thresholds, and establishing the working relationship. Covers initial conversation with developer user to scope the verification task, set expectations, and agree on checkpoints.
---

# 工作空间初始化与业务场景配置

## 你的角色定位

你现在承担的不是单一岗位的职责。在传统的单据核查项目中，通常需要业务分析师（BA）梳理法规条文、提炼核查逻辑，需要提示词工程师将业务逻辑转化为模型可执行的指令，需要QA工程师设计测试用例、回归验证。你一个人要把这三个角色的事都做了。

因此，初始化阶段不要急于写代码。先像BA一样搞清楚业务，像提示词工程师一样评估技术可行性，像QA一样思考怎么验证。

## 首次进入工作空间的动作序列

### 第一步：阅读法规文件

扫描 `Rules/` 目录下的所有文件。这些是业务法规、监管文件、内部制度等原始材料。阅读时关注以下要素：

- 法规的适用范围（哪类单据、哪些业务场景）
- 核查要求的粒度（字段级别、逻辑级别、交叉验证级别）
- 是否存在条件分支（如：金额超过某阈值时需要额外核查）
- 法规之间是否存在交叉引用或冲突
- 时效性（是否有生效日期、过渡期条款）

### 第二步：扫描样本文件

检查 `Samples/` 目录。这些是开发者用户提供的单据样本，用于理解实际业务场景。注意：

- 单据类型和格式（PDF、图片、结构化数据）
- 字段分布和命名规律
- 样本覆盖的业务场景是否充分
- 是否包含正例（合规）和反例（违规）

### 第三步：检查环境配置

读取 `.env` 文件。如果不存在，后续需要引导开发者用户创建。如果已存在，检查各参数是否合理。

## 与开发者用户的初始对话

在动手之前，必须与开发者用户确认以下事项：

### 核查范围界定

- 本次核查覆盖哪些法规？是全量还是部分条款？
- 针对哪些类型的单据？（发票、合同、报关单、银行回单等）
- 核查目标是合规审查、风险排查，还是数据提取？

### 规则粒度协商

- 开发者用户期望的规则拆分粒度是什么？
- 举例：「发票金额核查」是一条规则，还是要拆成「发票金额与合同金额一致性」「发票金额与付款金额一致性」两条规则？
- 粒度越细，准确率越高，但开发和维护成本也越高

### 期望值与检查点

- 开发者用户对准确率的期望是多少？（建议初始目标 85%+，逐步优化到 95%+）
- 哪些规则是高优先级的？（先做核心规则，再扩展边缘规则）
- 约定检查点：每完成 N 条规则的技能编写后，暂停汇报进展

## .env 参数配置指南

以下是工作空间的核心配置参数：

### 模型层级配置

```
TIER1_MODEL=         # 最强模型，用于复杂判断（如 claude-sonnet-4-20250514）
TIER2_MODEL=         # 中等模型，用于结构化提取
TIER3_MODEL=         # 轻量模型，用于格式校验和简单分类
TIER4_MODEL=         # 最廉价模型，用于文本预处理
```

模型选择原则：从最便宜的开始尝试，只有当准确率不达标时才升级到更高层级。

### 准确率阈值

```
SKILL_ACCURACY=0.90        # 技能（Skill）达到此准确率后方可蒸馏为工作流
WORKFLOW_ACCURACY=0.85     # 工作流（Workflow）的最低可接受准确率
```

`SKILL_ACCURACY` 必须高于 `WORKFLOW_ACCURACY`，因为蒸馏过程必然有损耗。

### 监控与迭代参数

```
MONITOR_FREQUENCY=mid      # 质量监控频率：high（全量）/ mid（抽样50%）/ low（抽样10%）
MAX_ITERATIONS=10          # 单条规则的最大迭代轮次，防止无限循环
```

### API 配置

```
API_BASE_URL=              # LLM API 的基础地址（如 SiliconFlow）
API_KEY=                   # API 密钥
```

## 工作空间目录结构搭建

初始化时需要创建以下目录（如尚不存在）：

```
logs/                   # 所有测试、迭代、质控的日志
  evolution/            # 演化循环日志
  qc/                   # 质量监控日志
workflows/              # 蒸馏后的生产工作流
  prompts/              # 工作流使用的提示词模板
rule-skills/            # 每条规则对应的技能文件夹
versions.json           # 版本清单（工作空间根目录）
```

创建 `versions.json` 的初始内容：

```json
{
  "workspace_version": "1.0.0",
  "initialized_at": "<当前时间戳>",
  "skills": {},
  "workflows": {},
  "last_updated": "<当前时间戳>"
}
```

## 生产环境的定时摄取

项目进入生产后，新文档通常会按固定节奏到达 —— 监管机构每日发布、API 每小时拉取、上游系统批量上传。用 `schedule_fetch` 工具注册摄取任务，让 OS 调度器在 kc-beta 关闭时也能跑：

- 每个任务是一条 shell 命令（rsync、curl、自定义脚本），把文件落到 `$INPUT_DIR`。
- KC 在 `scripts/ingest/<job-id>.sh` 下生成一个 wrapper 脚本；用户通过 `crontab -e` 把这一行装进自己的 crontab。
- 新到达的文件会自动前缀成 `<job-id>_<UTC-时间戳>_`，文件名本身就告诉你来源和到达时间。
- 用 `/schedule` 或 `schedule_fetch list` 查看状态；`logs/ingest.log` 末尾几行展示最近的运行情况。

在初始化阶段就和开发者用户讨论这个节奏 —— 生产侧文档输入节奏直接决定 skill 和工作流的写法（批处理 vs 流式、幂等性要求等等）。

## 持续维护 AGENT.md 的项目记忆

工作区根目录的 `AGENT.md` 有几段「项目记忆」（`Project`、`Decisions`、`Domain Notes`、`User Preferences`）。它们在 bootstrap 阶段是占位注释 —— 你的任务是随着工作推进往里填东西，让跨阶段或跨会话的人能直接读出上下文。

应该写什么：
- **Project**：语料身份（法规名称 + 范围）、语言、主规则与辅助规则、样本文档集组成。
- **Decisions**：从代码看不出来的设计决定 —— 比如「非标 35% 限制是银行级合计而非单产品限制，所以单文档报告给 WARNING 而非 FAIL」「R02-06/R02-08 对季报判 NOT_APPLICABLE，依据是法规 §39」。
- **Domain Notes**：值得显式记下来的法规或业务领域细节 —— 比如「PT/RT/LZ 是三种不同产品类型，披露模板不同」、术语消歧。
- **User Preferences**：开发者用户希望你在本项目上的协作风格 —— 详略偏好、命名约定、什么时候问、什么时候直接做。

更新 `AGENT.md` 的自然时机：开发者用户给出实质性澄清之后、阶段结束之后、发现会影响后续阶段的设计约束之后。不要等用户发 `/remember` —— 这份记忆是你自己维护的。

未来会话恢复时会先读 `AGENT.md`。它越充实，开发者用户需要重复解释的内容就越少。

### 阶段切换的更新节奏

一种值得警惕的反复出现的失败模式：agent 在 bootstrap 时把 AGENT.md 写得很丰富，之后就再也不碰 —— 后续若干小时的阶段工作里一次 AGENT.md 提交都没有。这就把长期记忆这个用途废了。

要养成的节奏：**每次 phase transition 都往 `AGENT.md` 追加一行决策日志**。格式：

```
[<时间戳> | rule_extraction → skill_authoring]
抽出 N 条规则；coverage_audit 已完成；R03/R05/R07 标记为判断密集型。
```

每次阶段切换三行摩擦；积累下来就是给下一个审计员、下一次会话的三十行洞见。格式不必严格 —— 节奏比措辞更重要。

## 何时需要重新初始化

以下情况需要重新运行本技能：

- 法规文件发生重大更新（不是小修小补，而是新增法规或废止旧法规）
- 业务场景发生根本变化（如从发票核查转为合同核查）
- `.env` 中的模型配置发生变更（更换了 API 供应商或模型版本）
- 开发者用户明确要求重置工作空间
- 工作空间长时间未使用后重新启动（需要重新理解上下文）

重新初始化时，不要删除已有的 `rule-skills/` 和 `workflows/`，而是先评估哪些可以保留、哪些需要更新。

## 初始化完成的标志

当以下条件全部满足时，初始化完成：

1. `Rules/` 目录已阅读，规则范围已明确
2. `Samples/` 目录已扫描，业务场景已理解
3. `.env` 已配置完毕，参数合理
4. 与开发者用户就范围、粒度、期望值达成一致
5. 工作空间目录结构已创建
6. `versions.json` 已初始化
7. 可以开始进入规则提取阶段
