---
name: version-control
tier: meta
description: Manage versioning of skills, workflows, prompts, and system configuration throughout the lifecycle. Use when skills are modified, workflows are regenerated, prompts are updated, or any artifact needs rollback capability. Covers what to version, how to version with file-system conventions, maintaining a version manifest, and rollback procedures. Also use when comparing performance between versions or when production results need to trace back to the exact workflow version that produced them.
---

# 版本控制与制品溯源

## Git 即唯一真相源

工作区是一个 git 仓库。每次对受跟踪路径（skills、workflows、rules、glossary、AGENT.md、tasks.json）的写入，都由 KC 自动提交，提交信息中带有 trace ID。这意味着：

- `git log --oneline` 就是本次 session 中所有有意义变更的时间线。
- `git diff HEAD~3 -- rule_skills/R001/` 显示某个技能在最近三次有意义写入间的变化。
- `git checkout HEAD~5 -- workflows/R001/` 回滚一个工作流，不影响其他任何东西。
- `snapshot` 工具用来标记值得记住的时刻（发版、"高风险操作前"），用 `git checkout snap/<label>` 恢复。

通过 `sandbox_exec` 加 `cwd: "workspace"` 直接跑 git 命令。不要绕开 git —— 它就是审计链路本身。

下文中按版本号复制文件名（`workflow_v1.py`、`workflow_v3.py`）和 CHANGELOG.md 的约定依然有用，但作用是 *在单个技能文件夹内提升人类可读性* —— 让智能体直接对比，不必每次都去翻 git 历史。系统的真相记录在 git，不在已废弃的 `versions.json` manifest（新工作区不再写入这个文件）。

## 设计目标

这套版本控制机制不是为了多人协作——在这个系统中，编程智能体是唯一的执行者。版本控制的目的是：

1. **可回退**：任何修改如果导致回归，能立即恢复到上一个正常版本
2. **可溯源**：生产环境输出的每一条核查结果，都能追溯到产出它的工作流版本、提示词版本、技能版本
3. **可对比**：能清晰地比较不同版本之间的性能差异，作为迭代决策的依据

轻量是原则。不需要 Git 那样的完整版本控制系统。基于文件系统的命名约定和一份版本清单即可。

## 需要版本管理的制品

### 技能（Skills）

- `rule-skills/R001-xxx/SKILL.md`
- `rule-skills/R001-xxx/scripts/*.py`
- `rule-skills/R001-xxx/references/*.md`

技能的版本通过 CHANGELOG.md 追踪，文件本身只保留最新版本。重大变更前手动备份。

### 工作流（Workflows）

- `workflows/R001-xxx/workflow_v1.py`
- `workflows/R001-xxx/workflow_v2.py`
- ...

工作流采用文件名版本号机制，所有历史版本的文件共存于同一目录。

### 提示词（Prompts）

- `workflows/R001-xxx/prompts/extract_dates_v1.md`
- `workflows/R001-xxx/prompts/extract_dates_v2.md`

提示词与工作流类似，采用文件名版本号，历史版本保留。

### 配置（Configs）

- `workflows/R001-xxx/config.json`

配置文件只保留当前版本，但每次修改前将旧版本记录到版本清单中。

## 不需要版本管理的内容

- **日志文件**（`logs/`）：日志本身就是时间序列数据，天然具有版本属性
- **输出结果**（`Output/`）：每次产出带有时间戳和版本引用，无需单独版本化
- **测试样本**（`assets/samples.json`）：只增不减，通过 `discovered_in` 字段标注来源轮次
- **规则目录**（`rule-catalog.json`）：实时状态文件，不需要版本历史

## 文件系统版本命名规范

### 工作流与提示词

采用 `_v{N}` 后缀：

```
workflow_v1.py    # 初始蒸馏版本
workflow_v2.py    # 第一次优化
workflow_v3.py    # 第二次优化

extract_dates_v1.md   # 初始提示词
extract_dates_v2.md   # 优化后的提示词
```

版本号单调递增，从不复用。即使 v3 回退到 v1 的逻辑，也不删除 v2 和 v3，而是创建 v4（内容与 v1 相同，但在版本清单中注明原因）。

### 技能文件

技能采用 CHANGELOG.md 记录变更，主文件始终覆盖更新：

```markdown
## v1.2 - 2025-04-01
- 补充框架合同展期的判定逻辑
- 来源：演化循环第3轮

## v1.1 - 2025-03-28
- 修正边界条件：日期等于到期日视为通过
- 来源：演化循环第2轮

## v1.0 - 2025-03-25
- 初始版本
```

如果需要回退技能，根据 CHANGELOG 中的描述手动恢复。对于关键技能，可在修改前备份为 `SKILL.md.bak`。

## 版本清单：versions.json

工作空间根目录的 `versions.json` 是全局版本清单，记录所有制品的当前版本及历史版本摘要。

```json
{
  "workspace_version": "1.0.0",
  "last_updated": "2025-04-01T18:00:00Z",
  "skills": {
    "R001-invoice-date-validity": {
      "current_version": "v1.2",
      "skill_accuracy": 0.95,
      "last_modified": "2025-04-01",
      "status": "workflow_distilled"
    },
    "R002-amount-consistency": {
      "current_version": "v1.0",
      "skill_accuracy": 0.88,
      "last_modified": "2025-03-30",
      "status": "skill_testing"
    }
  },
  "workflows": {
    "R001-invoice-date-validity": {
      "current_version": "v2",
      "workflow_accuracy": 0.92,
      "model_tier": "TIER3",
      "prompt_versions": {
        "extract_dates": "v2",
        "judge_validity": "v1"
      },
      "distilled_from_skill_version": "v1.2",
      "last_modified": "2025-04-01",
      "status": "production"
    }
  },
  "config": {
    "env_hash": "a3b2c1d4",
    "last_modified": "2025-03-25"
  }
}
```

### 版本清单的更新时机

每次以下操作发生时，必须同步更新 versions.json：

- 技能 CHANGELOG 新增条目
- 工作流创建新版本文件
- 提示词创建新版本文件
- 模型层级变更
- 工作流进入或退出生产状态

## 何时创建新版本

**核心规则：在修改任何可工作的制品之前，先创建新版本。**

具体而言：

### 必须创建新版本的场景

- 优化工作流的提取逻辑 → 创建 `workflow_v{N+1}.py`
- 修改提示词 → 创建 `prompt_v{N+1}.md`
- 演化循环要求修改判定逻辑 → 更新技能 CHANGELOG，创建工作流新版本

### 不需要创建新版本的场景

- 修正注释或格式（不影响逻辑的变更）
- 更新测试样本数据
- 修改日志内容

## 回退操作

当新版本导致回归或性能下降时，执行回退：

### 回退步骤

1. 在 versions.json 中将 `current_version` 修改为目标版本
2. 在工作流 config.json 中更新版本引用
3. 在 `logs/evolution/` 中记录回退原因
4. **不要删除失败的版本文件**——保留用于后续分析

### 回退日志

```json
{
  "action": "rollback",
  "rule_id": "R001",
  "artifact": "workflow",
  "from_version": "v3",
  "to_version": "v2",
  "reason": "v3 在框架合同场景下准确率从 92% 下降到 78%",
  "timestamp": "2025-04-01T20:00:00Z",
  "failed_version_kept": true
}
```

## 结果溯源

生产环境输出的每一条核查结果都必须包含版本信息：

```json
{
  "document_id": "DOC-2025-0042",
  "rule_id": "R001",
  "verdict": "pass",
  "produced_by": {
    "workflow_version": "v2",
    "prompt_versions": {
      "extract_dates": "v2",
      "judge_validity": "v1"
    },
    "model_tier": "TIER3",
    "skill_version": "v1.2",
    "workspace_version": "1.0.0"
  },
  "timestamp": "2025-04-01T18:30:00Z"
}
```

这样，当质控发现某条结果有误时，可以精确定位到产出它的工作流版本和提示词版本，避免在排查过程中浪费时间。

## 核查溯源标识（Trace ID）

版本溯源解决的是「哪个版本产出了这条结果」。溯源标识解决的是更深一层的问题：**这条核查结论的证据在原文的哪个位置？**

在每条核查结果中嵌入一个永久性溯源标识，直接链接到原始证据的精确位置。

### 溯源标识结构

```json
{
  "trace_id": "R001-DOC042-P3-S2-C120:180",
  "source_location": {
    "document": "bank_annual_report_2024.pdf",
    "page": 3,
    "section": "3.2 资本充足率",
    "char_range": [120, 180]
  },
  "rule_version": "v1.2",
  "workflow_version": "v2",
  "model_tier": "TIER3"
}
```

### 三个关键属性

- **嵌入式，非日志式**：溯源标识嵌入在核查结果数据内部，而非保存在独立的日志文件中。无论结果被导出、重新导入、聚合还是被下游系统消费，溯源标识始终随结果同行。
- **永久性**：溯源标识一旦生成，永不修改。对同一文档重新核查会生成新的溯源标识——旧标识保留在历史结果中。
- **自包含**：溯源标识本身编码了足够的信息来定位原始证据，无需查询外部索引。

### 为什么这很重要

如银保监会现场检查时，审计人员问「你们为什么判定这笔贷款符合第十五条？」——溯源标识可以直接指向原文的精确段落、判定时使用的规则版本和工作流版本。没有溯源标识，这种回溯需要手动关联日志、结果和原始文档——在监管审计中，这种手动关联是不可接受的。

参见 `references/trace-id-spec.md` 获取完整的格式规范和生成算法。

## 与演化循环的集成

演化循环的每一轮迭代，都是版本控制的触发事件：

```
演化循环第 N 轮开始
  → 记录当前版本快照
  → 执行修改
  → 创建新版本
  → 测试
  → 如果回归 → 回退版本
  → 如果通过 → 更新版本清单
演化循环第 N 轮结束
```

版本控制为演化循环提供安全网——无论怎么改，都可以回到上一个已知好的状态。

## 版本对比

当需要评估不同版本的性能差异时，利用日志中的测试结果进行对比：

```json
{
  "comparison": {
    "rule_id": "R001",
    "versions": ["v1", "v2"],
    "metrics": {
      "v1": {"accuracy": 0.85, "avg_cost": 0.005, "model_tier": "TIER2"},
      "v2": {"accuracy": 0.92, "avg_cost": 0.003, "model_tier": "TIER3"}
    },
    "conclusion": "v2 在准确率和成本两个维度均优于 v1"
  }
}
```

这些对比数据也是仪表盘展示的重要素材。

## 每条规则的 check.py —— 改写 v2 之前先保留 v1

当你要把某条规则的验证逻辑从 v1（通常是纯 regex）迭代到 v2 （通常引入 LLM 判断或混合方案）时，**改写之前先把 v1 复制为同目录下的同级文件**：

```bash
cp rule_skills/Rxx/check.py rule_skills/Rxx/check_v1.py
# 然后再把新版本写到 check.py
```

约定：
- `check.py` 永远指向当前最优版本
- `check_v1.py`、`check_v2.py`、…… 保留各代历史

这样 v1 就和 v2 并排放在同一个目录里，不必再依赖 workspace 的 git 历史去翻找（`git log -- check.py` 能恢复，但每次都翻阅本身就是摩擦）。引擎级别的 `verify_engine_v1.py` / `verify_engine_v2.py` 分别保留各代编排器；每条规则的 check.py 需要自己的命名约定来配合。
