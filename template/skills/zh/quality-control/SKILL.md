---
name: quality-control
tier: meta-meta
description: Design and execute quality control for production verification workflows. Use when workflows are deployed on Input/ documents and results need to be monitored, when designing the QC sampling strategy for a rule, or when evaluating whether monitoring can be reduced. Covers LLM-as-Judge evaluation, adaptive sampling strategies, confidence-based triage, and the transition from active monitoring to stable oversight. Also use when production quality drops and you need to diagnose whether to trigger the evolution loop.
---

# 生产环境的质量监控与质控策略

## 质量监控的定位

工作流部署到生产环境后，不能放任不管。但也不可能对每一份单据的核查结果都做人工复查——那就失去了自动化的意义。

质量监控的角色是「观察员」：用最少的复查量，维持对系统准确率的信心。当信心下降时，立即拉响警报、触发演化循环。

## 五层质量保障架构

质量控制不是单一活动——它由五个层级构成，逐层递进。低层级必须通过后，高层级才会执行。

| 层级 | 名称 | 检查内容 | 方法 |
|------|------|---------|------|
| L1 | 文本完整性 | 文件存在、编码正确、处理后源文本保持完整 | 脚本（`lint_*`） |
| L2 | 语法 | 输出格式有效（JSON/CSV）、必填字段存在、类型正确 | 脚本（`lint_*`） |
| L3 | 数据完备性 | 必填字段已填充、值在有效范围内（日期是日期、金额为正数） | 脚本（`validate_*`） |
| L4 | 业务逻辑 | 跨字段一致性、阈值合规性、序列合理性 | 脚本 + LLM |
| L5 | 跨阶段 | 结果中的实体与提取输出匹配、规则与目录匹配、工作流输出与技能基准真值匹配 | 脚本（`cross_validate_*`）+ LLM |

**核心原则：**
- **快速失败**：如果 L1 失败（文件缺失），不要运行 L4（业务逻辑）。低层级阻塞高层级。
- **代码优先**：L1-L3 应为纯代码——低成本且确定性强。LLM 评审（见下文）在 L4 和 L5 层级运作。
- **命名规范**：`lint_*` 用于 L1-L2，`validate_*` 用于 L3-L4，`cross_validate_*` 用于 L5。

**质控 vs 反思**：质控发现输出中的问题（本技能）。反思诊断问题的根因并修复（参见 `evolution-loop`）。质控向反思提供数据；反思向系统反馈修复。

详见 `references/qa-layers.md` 的层级规格和示例模式。

## LLM 作为评审（LLM-as-Judge）

质控的核心机制是用编程智能体（你）或指定的高层级模型，对工作流的输出结果进行独立评审。

### 评审判定等级

每条核查结果的评审结论分为四个等级：

| 等级 | 含义 | 后续处理 |
|------|------|---------|
| **correct（正确）** | 工作流判定完全正确，字段提取准确，结论有据 | 无需处理 |
| **partial（部分正确）** | 核心结论正确，但细节有偏差（如字段提取不完整、批注不够精确） | 记录偏差，低优先级修复 |
| **incorrect（错误）** | 核查结论错误（漏报或误报） | 触发演化循环 |
| **missing（缺失）** | 工作流未能给出核查结论（异常退出、超时、格式错误） | 检查工作流健壮性 |

### 字段级评审

除了整体判定之外，对关键字段逐一评审：

```json
{
  "document_id": "DOC-2025-0042",
  "rule_id": "R001",
  "workflow_verdict": "pass",
  "judge_verdict": "correct",
  "field_review": {
    "invoice_date": {"extracted": "2025-03-15", "judge": "correct"},
    "contract_start": {"extracted": "2025-01-01", "judge": "correct"},
    "contract_end": {"extracted": "2025-12-31", "judge": "correct"}
  },
  "comment": "",
  "reviewed_at": "2025-04-01T16:00:00Z"
}
```

字段级评审能帮助发现「歪打正着」的情况——结论碰巧正确但提取过程有误，这种隐患在未来的案例中可能导致错误。

## 自适应抽样策略

不是每一份单据都需要复查。抽样比例根据工作流的历史表现动态调整。

### 抽样比例阶梯

```
初始部署期：100% 全量复查
  ↓ 连续 2 批次准确率 ≥ 阈值
稳定期初期：50% 抽样
  ↓ 连续 3 批次准确率 ≥ 阈值
稳定期中期：20% 抽样
  ↓ 连续 5 批次准确率 ≥ 阈值
长期稳态：5-10% 抽样
```

**回退机制**：任何一个批次出现准确率下降，抽样比例立即回退一级。连续两个批次下降，回退到 100%。

### .env 中的 MONITOR_FREQUENCY 映射

```
MONITOR_FREQUENCY=high  → 初始部署期，100% 全量复查
MONITOR_FREQUENCY=mid   → 稳定期，50% 抽样
MONITOR_FREQUENCY=low   → 长期稳态，10% 抽样
```

这个参数是初始值。系统运行后会根据实际表现自动调整。

### 抽样方法

抽样不是简单的随机抽取。采用分层抽样确保覆盖面：

1. **按置信度分层**：优先复查低置信度的案例
2. **按单据类型分层**：确保每种单据类型都有样本被复查
3. **按判定结果分层**：不通过的案例优先复查（误报成本高于漏报）
4. **随机保底**：即使高置信度案例也有一定概率被抽中

## 基于置信度的分诊

工作流输出的置信度（confidence）是分诊的重要依据：

### 高置信度（≥ 0.9）

工作流对自己的判定非常确定。

处理方式：抽检即可。在稳定期，只随机抽取 5-10% 进行复查。

### 中等置信度（0.7 - 0.9）

工作流有一定把握但不完全确定。

处理方式：加大抽样比例，至少 30-50%。关注置信度居中的案例是否存在系统性偏差。

### 低置信度（< 0.7）

工作流对自己的判定没有信心。

处理方式：全量复查。低置信度案例本身就是有价值的数据——它们往往是边界案例或新场景，可以丰富测试集。

## 触发演化循环的条件

质量监控发现以下情况时，需要触发演化循环：

### 准确率下降

```
IF 当前批次准确率 < WORKFLOW_ACCURACY:
    触发演化循环
    抽样比例回退到 100%
    通知开发者用户
```

### 新的失败模式

即使整体准确率达标，如果发现了之前未见过的失败类型，也需要启动演化循环进行调查。

### 置信度漂移

工作流的平均置信度持续下降，即使判定结果仍然正确。这可能预示即将出现准确率问题，需要提前介入。

### 分布漂移

输入单据的特征分布发生变化（新的单据格式、新的业务场景），即使当前准确率不受影响，也需要评估是否需要补充测试覆盖。

## 批量处理的质控流程

当 `Input/` 目录中有批量单据需要处理时，按以下流程执行：

### 处理流程

```
1. 扫描 Input/ 目录，统计待处理单据数量和类型
2. 按规则逐条执行工作流
3. 将结果写入 Output/ 目录
4. 根据当前抽样比例，选取样本进行质控评审
5. 汇总评审结果
6. 判断是否需要触发演化循环
7. 生成质控报告
8. 处理完的输入文档通过 `archive_file` 移到 `input/archived/`，下次 session 只看到新到达的批次
```

生产环境的输入通常按节奏到达（见 `bootstrap-workspace` 的"生产环境的定时摄取"一节）。`input/` 中的文件由摄取 wrapper 自动加上 `<job-id>_<UTC-时间戳>_` 前缀，每个批次的文件名本身就带有溯源信息。批次质控不通过时，前缀能帮你定位是哪一次定时拉取出了问题。

### 输出结构

```
Output/
├── DOC-001/
│   ├── results.json          # 所有规则的核查结果
│   └── qc_review.json        # 质控评审结果（如被抽中）
├── DOC-002/
│   └── results.json
└── batch_summary.json        # 本批次汇总
```

### batch_summary.json

```json
{
  "batch_id": "BATCH-2025-04-01",
  "total_documents": 50,
  "processed": 50,
  "rules_applied": ["R001", "R002", "R003"],
  "qc_sample_size": 25,
  "qc_sample_rate": 0.5,
  "qc_results": {
    "correct": 23,
    "partial": 1,
    "incorrect": 1,
    "missing": 0
  },
  "accuracy": 0.92,
  "threshold": 0.85,
  "status": "above_threshold",
  "action": "none",
  "timestamp": "2025-04-01T18:00:00Z"
}
```

## 质控日志

所有质控活动记录在 `logs/qc/` 目录下：

```
logs/qc/
├── qc_2025-04-01.json        # 每日质控汇总
├── reviews/                   # 逐案评审记录
│   ├── DOC-001_R001.json
│   └── DOC-001_R002.json
└── trends.json                # 准确率趋势数据
```

### trends.json

追踪关键指标的时间序列，供仪表盘展示使用：

```json
{
  "R001": {
    "history": [
      {"date": "2025-03-28", "accuracy": 0.88, "sample_rate": 1.0, "batch_size": 20},
      {"date": "2025-03-29", "accuracy": 0.90, "sample_rate": 1.0, "batch_size": 15},
      {"date": "2025-03-30", "accuracy": 0.93, "sample_rate": 0.5, "batch_size": 30},
      {"date": "2025-04-01", "accuracy": 0.92, "sample_rate": 0.5, "batch_size": 50}
    ]
  }
}
```

## 两类仪表盘

系统中有两个独立的仪表盘：

- **开发者仪表盘** —— `dashboard_render` 工具，在工作区内基于 `output/results/`、`logs/evolution/`、`output/qc/` 生成。用于你自己审计、以及开发者用户在 BUILD/DISTILL 阶段的日常监控。
- **终端用户仪表盘** —— release 包内自带的 `render_dashboard.py` 脚本（由 `release` 工具产出）。面向非开发者收件人，从一次 `run.py` 调用的结果渲染，与工作区无关。

发布 release 后，把终端用户引导到 release 包内的仪表盘，不是工作区的那个。工作区仪表盘是你自己的开发者视图。

## 开发者用户参与

质量监控不应该让开发者用户去读 JSON 文件。通过仪表盘技能生成可视化报告，开发者用户只需要关注：

- 当前各规则的准确率状态（绿色/黄色/红色）
- 是否有需要人工确认的模糊案例
- 成本趋势是否合理
- 是否有需要决策的上报事项

质控发现的问题，如果属于系统可自行修复的范围（通过演化循环），不需要打扰开发者用户。只有以下情况需要上报：

- 准确率持续下降且演化循环未能修复
- 发现了新的业务场景需要确认核查规则
- 成本异常波动
- 达到 `MAX_ITERATIONS` 仍未解决的问题

## 用户反馈收集

在你创建的每一个核查应用中，都要构建错误报告和评论机制。这不是可选功能——它们是必要的数据来源。

### 两类受众

- **开发者用户**：技术性错误报告——字段级更正、规则重新评估请求、附带上下文的误报/漏报标记。他们可以看到完整的结果细节。
- **终端用户**：简化反馈——标记结果为错误、添加评论、标注严重程度。他们看到的是简洁的界面，不涉及技术内部细节。

### 反馈作为基准真值

当用户对核查结果报告错误时，该更正即为基准真值。它优先于编程智能体的判断和 Worker LLM 的输出。将用户更正立即注入 `evolution-loop`，作为已确认的失败案例——其优先级高于智能体自行检测到的问题。

### 反馈数据流

通过仪表盘收集反馈（参见 `dashboard-reporting`）→ 存储为结构化记录（result_id, reporter_role, feedback_type, corrected_value, comment, timestamp）→ 注入 `evolution-loop` 作为回归测试案例 → 在质控指标中追踪更正趋势。
