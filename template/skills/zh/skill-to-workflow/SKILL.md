---
name: skill-to-workflow
tier: meta
description: 将一条已通过测试的验证 skill 蒸馏为带 worker LLM 提示词的 Python workflow。当某条规则 skill 已经过测试、达到 `.env` 中定义的 SKILL_ACCURACY 阈值时使用。覆盖如下决定：哪些部分用代码实现、哪些部分用 LLM 调用；针对小上下文窗口的提示词工程；模型层级选择与渐进式降级；以及如何用编码 agent 自己的 skill 结果作为 ground truth 来测试 workflow。也用于对已有 workflow 做成本或速度上的优化。
---

# Skill 到 Workflow（Skill to Workflow）

skill 是 ground truth。workflow 是更便宜、更快的近似。你的工作是让这个近似在尽可能便宜的同时，逼近原版的精度。

## 工程目标

优化整条链路：**最短 workflow**（节点数最少）→ **每个节点用最小模型**（在满足精度的前提下用最便宜的层级）→ **每个模型用最短提示词**（最少 token）。这才是工程目标——不是提示词模板的华丽程度，也不是某种框架的合规性。

## 何时开始

满足以下条件时，一条 skill 才算准备好被蒸馏为 workflow：

- 它已经在 Samples/ 下所有文档上跑过测试。
- 它的准确率达到或超过 `.env` 中的 SKILL_ACCURACY 阈值。
- 边缘案例都记录在 skill 的 `assets/corner_cases.json` 里。
- 你对这条规则的理解，已经足以一字一句地说清楚自己是怎么验证它的。

任意一条不成立，就回去继续迭代 skill，先别开始蒸馏。

## 蒸馏决策

对基于 skill 的验证流程里每一步，问自己：

### 这一步能用正则或 Python 完成吗？（成本：零）
- 已知格式的日期抽取 → 正则
- 阈值数值比较 → Python 算术
- 中文数字转换 → Python 查表
- 格式校验（身份证号、代码） → 正则
- 从结构化 markdown 抽表格单元 → 字符串处理

如果能，就写成代码。这类操作免费、快速、确定性强。

### 这一步需要语言理解吗？（成本：一次 worker LLM 调用）
- 在文档里找出相关段落 → LLM
- 抽取一个用自然语言描述的实体 → LLM
- 判定语义充分性（"披露是否充分"） → LLM
- 解析有歧义的引用 → LLM

如果是，就设计一个 worker LLM 提示词。在保证精度的前提下，用最小的模型层级。

### 混合方案（最常见）
大多数规则是混合体：正则抽数字，Python 比阈值，LLM 处理少数特殊情形。把 workflow 设计成流水线——便宜的步骤先跑，昂贵的步骤只在需要时才跑。

### 正则不足以应付时——决策标准

在宣布蒸馏完成之前，先审计每条规则的 `verification_type` / `metric` / `evidence_type`（或目录里对应的字段）。如果某条规则所需的验证属于以下类型之一：

- **语义** 判断
- **上下文** 解读
- **反事实** 推理
- **跨字段算术**

仅靠正则几乎肯定不够。可接受的形式有三种：

1. **纯正则，附带显式限制说明** —— 写正则核查，并在注释里说明脆弱性（例如："只匹配语法模式；无法检测语义保证"）
2. **正则 + LLM 混合** —— 正则基线处理明显的情形，`worker_llm_call`（tier1-2）处理有歧义的情形。混合 workflow 要显式声明哪些 rule_id 会被上升到 LLM。
3. **纯 LLM，通过 `worker_llm_call`** —— 对完全语义化、没有有意义正则基线的规则。

对 `verification_type` 是 `judgment` / `semantic` 的规则，不要只交付一段纯正则、又不附"显式限制"的说明。未来的你或同事会以为正则就够用——这种 bug 能埋藏好几个月。

### Worker LLM 的成本-意识层级选择

如果确实要上 LLM：
- **tier1**（能力最强，~¥0.001-0.002/doc）：跨字段推理、歧义解析、能受益于 chain-of-thought 的规则
- **tier2-3**：批量抽取 + 简单语义检查
- **tier4**（最便宜）：正则无法覆盖、量又很大的关键词识别。注意：SiliconFlow 上的 tier4 模型是 Qwen3.5 thinking 模式——如果 `reasoning_content` 把 max_tokens 用光，`content` 可能返回空字符串。在依赖之前先用真实提示词测试。如果出现空响应，要么把 max_tokens 提到 ≥8192，要么缩短提示词，要么回退到 tier1-2。

一种值得警惕的失败模式：agent 默认全正则蒸馏，只有当用户显式要求"V2，带 worker LLM"时才加上 LLM 上升路径。如果你的规则目录里有任何一条规则的验证本质上就是语义性的，你应当主动伸手去用 `worker_llm_call`——不要等别人要你才用。

## Workflow 结构

一个 workflow 是 `workflows/` 下的一个 Python 文件（或几个相关的小文件）：

```
workflows/
  rule_001_capital_adequacy/
    workflow_v1.py        # The main workflow script
    prompts/
      extract.txt         # Worker LLM prompt for extraction
      judge.txt           # Worker LLM prompt for judgment (if needed)
    config.json           # Model assignments, thresholds
```

workflow 文件应当有清晰的入口：

```python
def verify(document_text: str, config: dict) -> dict:
    """
    Returns:
        {
            "rule_id": "R001",
            "result": "pass" | "fail" | "missing" | "error",
            "extracted_value": ...,
            "confidence": 0.0-1.0,
            "comment": "..." (only when fail),
            "model_used": "...",
            "llm_calls": int,
            "llm_tokens": int
        }
    """
```

这是参考，不是死契约。按具体规则的需要调整结构。重要的是每个 workflow 都能产出可以与 skill ground truth 做对比的结果。

## Worker LLM 的提示词工程

worker LLM 的上下文窗口较小（典型 16K-32K token）。设计提示词时要满足：

1. **自包含。** 模型需要的一切都写进提示词。不要假设模型还记得之前几次调用的上下文。
2. **指定输出格式。** "返回一个 JSON 对象，字段包括：value、confidence、reasoning。" 结构化输出能减少解析错误。
3. **只送进窄化后的上下文。** 不要把整篇文档喂给它。用树状处理流水线（整篇文档 → 相关章 → 相关节）把上下文窄化之后再调 worker LLM。
4. **提示词用文档同语言。** 中文文档配中文提示词，英文文档配英文提示词。不要在同一份提示词里混用两种语言。
5. **示例要克制。** 一两个例子有用，十个例子既浪费上下文窗口、又容易过拟合。

## 模型层级选择

对每一步，先用最高层级（TIER1）。测精度。再尝试更低的层级：

1. 用 TIER1 在所有 Samples/ 上跑 workflow，记录每一步的精度。
2. 对每一步，换 TIER2 试一次。如果精度仍高于 WORKFLOW_ACCURACY，就保留 TIER2。
3. 继续逐步降级，直到精度跌破阈值。
4. 把每一步的最优层级写进 `config.json`。

同一个 workflow 内不同步骤可以用不同层级。抽取也许需要 TIER2，而判断也许用 TIER3 就够。

### 正式降级协议

上面这种基础做法可用，但更严格的协议能避免过早锁定层级：

**方向**：从上往下（TIER1 → TIER4），先确立精度上限。你得先知道最优精度能到哪里，才能开始用它换成本。

**最小测试样本**：在做层级决定之前，每个候选层级至少跑足够数量的文档（例如 `min(10, total_samples)`）。小样本不可靠——3 篇文档的测试可能完全误导你。

**精度差触发条件**：如果某个较低层级的精度明显低于较高层级（例如差超过 5 个百分点），该步就保留较高层级。差距在容差内，就用更便宜的层级。

**逐步独立**：每个 workflow 步骤单独评估。把每一步的最优层级写到 `config.json` 里。不要假设整条 workflow 都得用同一个层级。

**再评估触发条件**：如果生产质控发现某一步的精度在退化（例如出现了新格式的文档），就对那一步重跑层级评估。

**模型-任务推荐表**：维护一份"任务类型 → 推荐层级"的项目级映射，基于你自己的测试经验。时间长了，这些表可以跨项目汇总，形成通用的层级建议。

这里所有数字（10 篇文档、5 个百分点等）都只是推荐起点。编码 agent 和开发者用户应当根据具体的体量、精度要求、成本约束做校准——甚至彻底替换为别的评估方法。重要的是模式：**在每个层级测试 → 对比精度 → 在容差内时锁定 → 退化时再评估**。

这与 `document-parsing` 里 parser 上升的层级转移框架是同一套：由一个质量/精度评分驱动"保留 / 上升 / 跳过"的决定。

### 在 tier 槽位内挑具体模型 —— 速查

上面的 tier 框架回答"这一步该用哪个 tier？"。在某个 tier 槽位内
仍然要回答"具体用哪个模型？"。下面几条启发式短期内有效（具体型
号请从 `auto-model-selection` 刷新，模型代次的更替以月为单位、
不是以年为单位）：

- **Tier 1 / Tier 2 主力 worker**：当代的旗舰 MoE LLM（总量
  200-400B、激活 ~20B 专家）是合理的起点基准。Qwen 家族当前的
  旗舰、DeepSeek 当代的高级模型都是这个形状；任一都行。
- **Tier 3 / Tier 4 小模型**：30B 以下优先选 Qwen 家族 ——
  便宜可靠的选择最多。小尺寸下避开名字里带 `coder` / `code`
  的变体（在通用 worker 任务上不可靠）。能选无 thinking 模式
  的就选无 thinking —— 这些任务不需要反思。
- **provider 分流**：把 conductor 和 worker 走不同的服务商，
  可以隔离单一服务商对同一模型的限流暴露（例如 worker 走
  DeepSeek、conductor 留在 SiliconFlow）。
- **VLM / OCR**：字符 / 手写 / 印章 → 专用 OCR 模型（Paddle-OCR、
  GLM-OCR、DeepSeek-OCR 或其后继）。复杂图表 / 表格 → 更大的
  通用 VLM。

具体事实（确切模型名、上下文窗口、定价）用 `auto-model-selection`
+ Context7 查。上面的启发式过得快，但**形状**（旗舰 MoE 当主力、
30B 以下无 thinking 当便宜底、OCR 专用做字符）稳定得多。

## 用 Ground Truth 做测试

编码 agent 基于 skill 的结果就是 ground truth。对 Samples/ 下每篇文档：

1. 跑一遍 workflow。
2. 把 workflow 的结果与 skill 的结果对比。
3. 记录差异：哪一步失败，期望值 vs 实际值。
4. 计算精度：`(匹配的结果数) / (总文档数)`。
5. 如果精度 < WORKFLOW_ACCURACY，定位并修复。用 `evolution-loop` 方法学。

## 版本管理

每次迭代是一个新版本文件：`workflow_v1.py`、`workflow_v2.py`，依此类推。在 `config.json` 里追踪当前激活的版本。完整方法学见 `version-control` skill。

## Workflow 发布

workflow 达到精度阈值后，就可以通过 `release` 工具打包给最终用户。每次发布是 `output/releases/<slug>/` 下的一个自包含目录，里面有钉住的 workflow、一个 Python 运行器、一个置信度评分器、一个 HTML 仪表盘生成器，以及一个 `serve.sh` 启动脚本。整个包不依赖 kc-beta——任何装了 Python 并有 worker LLM API key 的人都能跑 `python run.py <doc>` 并得到验证结果。

打包什么内容由你决定：是 catalog 里所有规则，还是用 `include` 参数挑出来的子集；要不要捆绑 1-3 份代表性样本放到 `fixtures/`，好让接收方在没有自己数据的情况下也能空跑一遍。

`release` 工具会先给工作区打 git 快照（tag 是 `snap/release-<slug>`），即使 `output/releases/` 之后被清理，整个包也能从 git 再生。何时发布由你决定——没有自动化，也没有强制的节奏。常见触发点：workflow 达到 SKILL/WORKFLOW_ACCURACY 阈值；某位利益相关者需要交接；生产 cron 应该跑钉住的版本而不是最新版。和开发者用户讨论后决定。

## 成本追踪

追踪每次 workflow 运行的成本：
- 每篇文档的 LLM 调用次数。
- 每篇文档消耗的总 token 数。
- 每次调用使用的模型层级。

这份数据帮助开发者用户理解生产成本，也为后续优化提供依据。

## Worker LLM API

Worker LLM 通过 SiliconFlow API 访问。连接信息在 `.env` 里：
- `SILICONFLOW_API_KEY` —— 鉴权
- `SILICONFLOW_BASE_URL` —— API 端点
- `TIER1` 到 `TIER4` —— 各层级的模型名称

各模型当前的能力与上下文窗口大小，见 `references/worker-llm-catalog.md`。

## 两条访问路径：`worker_llm_call` 工具（优先）vs 直接 HTTP

KC 自带一个 `worker_llm_call` 工具。能用就用 —— 引擎能看到每次调用，能统计成本和 token、做限流、并把数据进入审计。它支持批量模式：

```
worker_llm_call({
  tier: "tier1",
  prompts: ["核查文档 A...", "核查文档 B...", "核查文档 C..."],
  system_prompt: "你是合规助手。返回 JSON {verdict, evidence, confidence}。",
  concurrency: 5    // 1-10，默认 5
})
```

返回 `{n_total, n_succeeded, n_failed, total_tokens_in, total_tokens_out, results: [...]}` 摘要。部分失败不会让整批失败。

### 规范的 `workflows/common/llm_client.py`（作为模板文件随包发布）

对于一个 **独立运行** 的 workflow（没有 KC 会话 —— 比如客户把 release 包部署后跑 `python run.py doc.pdf`），workflow 拿不到 `worker_llm_call`。规范的 HTTP 客户端 shim 作为模板文件随 kc-beta 一起发布；引擎初始化时会自动把它写入工作区的 `workflows/common/llm_client.py`。**不要自己重写**。直接用这个已经放好的文件：

```python
from workflows.common.llm_client import call

result = call(
    tier="tier2",
    prompt=user_prompt,
    system_prompt="你是合规助手。返回 JSON。",
    max_tokens=2048,
)
# result = {"response": "...", "model_used": "...", "tier": "tier2",
#          "tokens_in": N, "tokens_out": N}
```

shim 做的事：
- 从 `.env` 读 `LLM_API_KEY` + `LLM_BASE_URL` + `TIER1..4`（多 provider 友好 —— SiliconFlow、OpenAI、Anthropic、阿里、火山等都能用）
- 以 OpenAI 兼容的 chat completions 格式发请求到配置好的 base URL
- 每次调用往 `output/llm_ledger.jsonl` 写一行，KC 审计即使在你没走 worker_llm_call 时也能还原成本
- 如果 `LLM_BASE_URL` 缺失，会显式抛错（不会偷偷回退到某个写死的 vendor URL）

**不要自己从零写 llm_client.py**。一种值得警惕的失败模式：agent 反复自己造轮子 —— 拼出来的版本要么模型 ID 过期、要么写死某个 vendor URL、要么不写 ledger，且对引擎不可见。优先用规范化版本；如果因为某种原因没有，从 kc-beta 安装目录的 `template/workflows/common/llm_client.py` 复制过来（引擎也会在 init 时自动写入 —— 检查 events.jsonl 里的 `workflows_common_populated` 事件）。

## sandbox_exec 超时设置（已知耗时长的命令）

`sandbox_exec` 默认超时是 120 秒。对于你预期会跑得更久的命令 —— LLM 批处理、大型回归测试、文档解析 —— 显式传 `timeout_ms`（最大 600000ms = 10 分钟）。不要靠把任务切成不必要的小块来绕开默认值；那只会浪费回合数并模糊意图。

```
sandbox_exec({
  command: "python scripts/v2_full_test.py",
  timeout_ms: 480000   // 14 条规则 × 6 篇文档走 worker LLM，预留 8 分钟
})
```

如果已经顶到 10 分钟上限还在超时，把工作拆成多次调用，或者交给子代理（子代理的超时和父进程相互独立）。
