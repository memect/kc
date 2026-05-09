---
name: work-decomposition
description: 在 rule_extraction → skill_authoring 过渡阶段决定如何把规则集拆分为 TaskBoard 任务。涵盖排序方法（难度优先 / Shannon–Huffman、广度优先、深度优先、二分切分）、分组策略（多条规则合并到一个任务 vs. 各自独立的判断标准）、三轴难度评估、以及如何写一份贯穿全流程都能用得上的 PATTERNS.md 项目记忆。当进入 rule_extraction、进入 skill_authoring 或感觉 TaskBoard 走偏想要重新拆分时使用。
---

# 工作拆分（Work Decomposition）

KC 的 main agent 是指挥者。指挥者决定下一步做什么——而这个决定凌驾于后续所有选择之上。错误的拆分会让整个会话变得昂贵：规则顺序错了，agent 会把同一种结构重新设计三遍；不相关的规则被合并到一个 skill 里，最终 check.py 就会变成 E2E #4 那种"统一执行器"反模式；本应合并的相关规则被分散到不同 skill，agent 会把同样的 chunker 逻辑重新推导 17 次。

这份 skill 是指挥者做这类决定的操作手册。它放在 `meta-meta/` 下，因为工作拆分是系统级的纪律，不是某条规则的具体技巧。互补的 `task-decomposition`（同样在 `meta-meta/` 下）覆盖单条规则**内部**的结构——locate → extract → normalize → judge → comment。本 skill 覆盖的是规则**集合**该如何切分成 TaskBoard 任务。

## 何时使用本 skill

- **进入 rule_extraction 时**。读完法规、拆出规则之后，在宣布该阶段完成之前，先决定这些规则会以什么顺序被处理、是否分组。覆盖审计与 chunk refs 都是这两个决定下游的工作。
- **进入 skill_authoring 时**。TaskBoard 是空的（引擎不再自动生成 per-rule 任务）。从 `describeState` 读取规则列表，决定分组与顺序，然后为每个工作单元调用 `TaskCreate`。
- **运行中觉得拆分不对时**。如果 TaskBoard 越走越奇怪（规则按错误顺序累积、明明该合并的两条规则被拆到两个任务里），停下来重新拆分。暂停 5 分钟重新规划的代价，会在接下来 2 条规则里被更合理的形状收回。

## 锁定原则

1. **硬跟踪、软执行（Hard tracking, soft executing）**。无论你怎么分组，引擎都从磁盘事实推导里程碑（`rule_skills/<id>/SKILL.md`、`check_*.py`、`workflows/<id>/...`）。覆盖率由引擎核实；分组由你自己决定。聪明的任务命名绕不过下限，但下限也不规定任务形状。
2. **最难的规则信息量最大**。难规则会强迫你把 chunker、分类器、verdict 形状、worker LLM 层级都设计到位。简单规则可以廉价地复用这套机制的子集。先把硬 case 落实，简单 case 自然继承。
3. **PATTERNS.md 是承重的记忆**。没有持续累积的参考文件，每条规则都从空白开始，同一种形状会被反复设计。有了它，工作能复利。

---

## 排序方法

明确选一种，把选择本身写进 PATTERNS.md 的第一条。"我用 Shannon–Huffman，因为 R028 的多方主体 verdict 形状会决定其他规则的 chunker"是合法决定；"我从 catalog.json 顶端开始一条条往下做"不是——那只是没有决定。

### Shannon–Huffman（难度优先）—— 推荐默认

先处理**最难**的规则。把这条难规则需要的 chunker、verdict 形状、worker 层级当作设计下限。后续规则按难度递减处理，每一条都是已经搭好的机制的退化形态。

**何时选**：规则集合复杂度不均匀，并且你怀疑少数几条难规则会决定整体形状（合规/监管类工作几乎总是如此）。E2E #5 里 GLM 阴差阳错走的就是这条路，最终在真实 LLM 驱动的 workflow 上拿到了 0.6% ERROR；DS 走自底向上，最终 78% 的 verdict 是 NOT_APPLICABLE。

**为何用 "Huffman" 而不是 "Shannon" 来类比**：Huffman 编码先处理低频符号来构造最优前缀码。KC 的对应物是单条成本高、出现频率低的规则——R028 那种类型，数量少但主导整个设计空间。先碰它们，简单规则就能廉价继承框架。

**编译器设计上的对应**：在最坏情况被正确处理之前，不要先优化常见情况。常见情况快没用——如果最坏情况要重新设计整个流水线。

### 广度优先（轮询）

先把每条规则都做到浅层（skill 骨架 + 第一遍正则），然后回头逐条加深。适用情景：

- 整体集合的覆盖比单条规则的深度更重要（例如急需一份覆盖报告）
- 你还不知道哪些规则难
- 你在试新方法学，想先廉价地在多条规则上验证流水线形状

**陷阱**：你可能在浅层 skill 上宣布 rule_extraction 完成，从此再没回头加深。比深度优先更糟，因为光看覆盖率，门控看上去是过的。

### 深度优先（一次只做一条，做到底）

把规则 1 完整做完（SKILL.md + check.py + 测试通过）再碰规则 2。适用情景：

- 规则之间高度独立（合规工作里少见）
- 指挥模型 context 较小，规则之间反复加载形状的成本不高
- 你在跑通端到端流水线，确认能产出之前不去铺规模

**陷阱**：第一条规则的形状被写死；第 5 条之后才发现要重构，意味着 1–4 都要重写。配合 PATTERNS.md 来缓解。

### 二分切分

按一个有意义的轴把规则集分成两半（公募/私募、文档类型、法规章节），然后递归。适用情景：

- 切分轴是结构性的（例如银行类规则 vs 信托类规则）——可以为各分区分别建工具
- 某些分区可以整块跳过（D6 适用性判断说"这个语料不适用"）

**陷阱**：在切分轴并不真实存在时过早分区。agent 投入两套工具，最后发现需要共同的底座。先用 2–3 条规则在每一侧验证切分再投入。

### "最简单的先做" —— 不要默认选这个

很有诱惑力，因为它能积累信心、能很快出可见的产出。**对监管规则集不要默认选这个**——简单规则不会教给你任何能迁移到难规则上的东西，框架会围绕错误形状结晶。只在你为一个全新项目调试工具链、必须先证明流水线能产出**任何**东西时再用它。

---

## 规则分组

默认是**一条规则 → 一个任务 → 一个 skill 目录**。这样覆盖率可量、TaskBoard 清晰。只有当合并真的能减少总工作量、又不会把不相关的关切耦合起来时，才合并。

### 何时合并

把多条规则合并到一个任务（以及一个 check_r###_r###.py 文件）只有在以下条件**全部**满足时：

- 这些规则共享同一个 source chunk（看的是同一段法规的同一段文字）
- 它们共享同一种输入形态（例如同一张必填字段表）
- 一条规则的判断逻辑是另一条的子串或近似变体
- 一次失败通常意味着多条规则同时失败（R013 不可能在 R015 失败的情况下通过）

例：R013 / R015 / R017 都在检查报告第 3 页那张表是否包含某些必填字段。同一个 chunk、同一次 parse、同一种 verdict 形状。合并为 `check_r013_r015_r017.py`，并创建一个任务：`TaskCreate({id: "R013-R015-R017-skill_authoring", title: "R013/R015/R017 — 必填字段表", phase: "skill_authoring"})`。引擎从文件系统推导里程碑时会识别这个合并 check.py，给三个 rule_id 都计入覆盖。

### 何时保持独立

任何**一项**满足时就保持独立：

- 规则引用不同章节——即使概念上相关（例如 R013 的披露内容和 R028 的托管责任都属"报告"，但章节不同、证据链不同）
- 规则需要不同的 worker LLM 层级（R005 需要旗舰模型做精细判断，R001 是正则）
- 规则适用于不同文档类型（一条只对公募基金报告生效，另一条只对私募基金报告生效）
- 一条规则的失败模式是另一条规则的特殊失败模式（不要把父规则和子规则合并——子规则的检查会冗余地重新执行父规则的检查）

v0.6.2 D2 的反模式说法已经把失败情形说得很清楚了：
> 如果你发现自己在写 unified_qc.py 那种绕过单 rule skill 的大杂烩，那就是说明你的 per-rule skill 是错的。是去修它们，不是去替换它们。

那段话来自 E2E #4：一个指挥模型写了 2,400 行 `unified_qc.py` 一次性跑所有规则。结果出现 1,150 条 ERROR verdict（16.6%），因为每条规则的失败都连带把所有其他规则的判定也带崩了。Per-rule skill 是 KC 的粒度单元，这是有原因的。

### 反模式：check.py 是 stub + workflow.py 才是真逻辑

**不要**把 `rule_skills/<id>/check.py` 写成一个把真实逻辑推迟到
`workflows/<id>/workflow.py` 的占位文件。KC 的设计意图是：SKILL.md
+ check.py 是**正典**核查；workflow.py 是**蒸馏后、更便宜**的形式
（regex 优先 + LLM 回退）。关系是 skill → workflow，不是反过来。

❌ 不要这样：
```python
# rule_skills/R001/check.py —— STUB，真逻辑在别处
def check(text):
    rule_ids = re.findall(r"R\d{3}", load_skill())
    return {rid: {"pass": None, "method": "stub",
                  "note": "待技能测试阶段实现"} for rid in rule_ids}
# 实际核查逻辑只在 workflows/R001/workflow_v1.py 里
```

✅ 应该这样：
```python
# rule_skills/R001/check.py —— 正典核查
def check(text):
    matches = re.findall(r"...", text)  # 真实规则逻辑
    return {"rule_id": "R001", "passed": bool(matches),
            "evidence": matches[:3], "method": "regex"}

# workflows/R001/workflow_v1.py —— 蒸馏后的便宜形式
def run(text, llm_fn=None):
    result = check(text)             # skill 提供基线
    if not result["passed"] and llm_fn:
        result = llm_verify(text, llm_fn)  # FAIL 时升级到 LLM
    return result
```

为什么重要：蒸馏阶段下游消费者（release 工具、run.py 运行器）加载
的是 workflow.py。如果 check.py 是 stub，skill 的方法论（SKILL.md）
就只剩文档作用，而核查逻辑被分散到 N 个 workflow 文件里。后续对
skill 的迭代（法规解释变化、生产中发现的边缘情形）需要一个**正典
位置**来更新——也就是 skill——而不是 N 个已经各自漂移的 workflow。

E2E #6 v070 暴露了这个反模式（DS 把所有 bundled skill 的 check.py
都写成 `{"pass": null, "method": "stub"}` 推给 workflows/）。
v0.7.1 把这个反模式显式写进 skill。

E2E #7 v071 显示这个反 stub 的引导在两个 conductor 上都生效（两条 run
里都没有 `{"pass": null}` 这种 stub 模式），但是 **DS 仍然把"正典 vs
蒸馏"的关系搞反了**：DS 写了 6 个主题分组的 skill 文件夹，每个只有
SKILL.md（没有 check.py），真正的验证代码却在
`workflows/<skill>/check.py` 里。没有 stub 是好事；关系搞反不是 ——
要修改一条规则的逻辑就得同时改 SKILL.md（文档）和 workflow check.py
（代码），单一信息源就丢了。

GLM v071 反而把正典模式落地了：97/97 个 skill 都同时有 SKILL.md 和
真正的 `check.py`（regex + 适用性判断的代码，中位 143 行），而
`workflows/<id>/workflow_v1.py` 是一个 50 行的薄壳，只是 import 并
调用 skill 的 check.py：

```python
# workflows/D01-01/workflow_v1.py — 薄壳，52 行
import importlib.util, json
from pathlib import Path

def run(doc_text: str, meta: dict = None) -> dict:
    check_path = Path(__file__).parent.parent.parent / "rule_skills" / "D01-01" / "check.py"
    spec = importlib.util.spec_from_file_location("check", check_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    result = mod.check(doc_text, meta)
    result["_workflow"] = "D01-01_v1"
    return result
```

这是 v0.7.2+ 的正典模式：workflow 是个壳，指向 skill 的 check.py。
迭代规则验证逻辑时，编辑 `rule_skills/<id>/check.py`，workflow 不用动。
v0.7.2 把引导说得更清楚：既不要 stub，也要保留正典关系（skill 是
正典，workflow 是蒸馏过的薄壳）。

### 合并 check 的命名约定

确实需要合并时，文件名要把范围写明：

- `check_r013_r015_r017.py` — 三条具体规则
- `check_r002_r007.py` — 连续区间（R002 到 R007）
- `check_r013-r017.py` — 替代写法，也接受

引擎从文件系统推导里程碑时会解析这些文件名，把范围内每条 rule_id 都算进覆盖。合并既是代码组织也是文档——下游消费者（workflow-run、dashboards、release 工具）通过文件名判断覆盖。

---

## 难度评估 —— 三轴评分

在确定顺序之前，对每条提取出来的规则在三个轴上打分。一次快速 worker LLM 调用即可（tier3 足够，不是要做深判断），把结果写到 `rules/difficulty.json`，指挥者随后在排 TaskBoard 顺序时读取。

### 轴 1 — 思维链深度

这条规则需要多少次串联判断？数一下 agent 必须依次完成的操作：

- 1：`text contains "行业统一信息披露渠道"`（正则）
- 2：先分类产品类型，再检查渠道（两步）
- 3+：分类产品类型 → 定位披露段落 → 解析表格 → 与另一段的表格做比较（多步）

打分：1 / 2 / 3+。

### 轴 2 — 模块数量

这条规则包含多少个独立子检查？"模块"指逻辑上可分离的谓词。

- 1：单一谓词（"必须提及渠道 A"）
- 2-3：小型必填列表（"必须提及 A、B、C、D"）
- 4+：长清单或条件分支（"如果是公募，则渠道 X+Y；如果是私募，则渠道 Z；任何情况下还要包含管理人身份"）

打分：1 / 2-3 / 4+。

### 轴 3 — 跨规则交互

这条规则是否引用其他规则、依赖其输出，或必须与之保持一致性？

- 0：独立（多数规则）
- 1：交叉引用一条其他规则（例如 R007 引用 R013 的表格存在性）
- 2+：与多条规则紧耦合，需要跨规则的一致性推理

打分：0 / 1 / 2+。

### 总难度

三轴求和（最低 1+1+0=2，最高 3+3+2=8）。降序排序。前 2-3 条是你的设计下限——先做它们。

70 条规则的语料典型分布大致：
- 10-15 条难（求和 5-8）
- 30-40 条中（求和 3-4）
- 20-30 条易（求和 2）

不要把分级做过头。它是规划辅助，不是契约。如果工作中你发现一条评 2 的实际是 6，更新 PATTERNS.md，把剩余队列重新排序。

---

## PATTERNS.md —— 项目记忆纪律

KC 的 main agent 在阶段之间没有连续记忆。每次 agent 重新读 `describeState`，看到的都是同一份规则列表和同一份里程碑。没有外部累积参考的话，每条规则的设计都从零开始。

`rules/PATTERNS.md` 就是那份参考。Agent 自己拥有它（通过 `workspace_file` 写入，不通过任何 tool wrapper）。引擎在 skill_authoring + skill_testing 阶段的每次系统提示中都会带上它。上限约 5 KB，token 成本可忽略。

### 写什么 —— 能迁移的形状

一条好的 PATTERNS.md 条目记录的是某个能在**下一条**规则上**省工作**的东西。三类合法内容：

✅ **可迁移的形状** —— verdict 形状、chunker 粒度、接口决定，后续规则会复用。

```
R028（托管责任）需要多方 verdict 形状：
  { primary_party: PASS|FAIL, secondary_parties: [...], reasons: [...] }
作为有多个责任主体的规则的默认形状。
在 R029、R031 上确认可复用。
```

✅ **项目级约束** —— 关于语料或环境的事实，影响多条规则。

```
样本语料表头中英双语（EN+ZH）。
Chunker 必须按 ZH 表头切分，不是 EN —— 5 份样本上验证过。
不这样做，R013 / R015 / R017 都会少抽。
```

✅ **反模式 + 原因** —— 你试过、为什么失败、应该怎么改。

```
试 tier4 出 JSON verdict → 80% 的时候返回空。
tier3（Qwen3.5）字段名会幻觉。最终选 tier2（DeepSeek-V3.2）
作为所有结构化输出规则的默认。Tier1 只留给证据模糊时的
verdict 推理（R005、R024）。
```

### 不写什么 —— 日志倾倒反模式

下面这些只增加 token 成本、不增加决策价值。未来的你读 PATTERNS.md 是为了搞清楚**接下来怎么做**，不是回放**已经发生了什么**。

❌ **完成日志** —— 已经在 tasks.json + 文件系统里。

```
R001 完成。R002 完成。R003 部分通过。R004 完成。
```

❌ **工具调用回声** —— 已经在 events.jsonl 里。

```
调 workspace_file 写 check_R013.py。再调 sandbox_exec。
然后把结果交给 worker_llm_call。
```

❌ **文件系统权威事实** —— 引擎从磁盘自己推导。

```
Workflows 都在 workflows/R001_workflow.py 这种位置。一共 28 个。
```

❌ **对话总结** —— PATTERNS.md 不是叙事文档，agent 和用户都不会当故事读。

```
跟用户讨论之后，决定先做银行类规则。用户提到信托产品不在范围。
```

如果某个项目级决定来自对话，写成约束而不是叙述：

```
本次运行排除信托产品（D6 适用性 NO）。
跳过 R078、R092、R104 —— 它们的 skill 只是占位。
```

### 何时更新、何时追加

- **追加**：发现了新的、能迁移的东西。
- **更新已有条目**：在更晚的规则上做事时发现一种更好的抽象。不要被第一条难规则的形状锁死——JIT 编译器在 profile 数据推翻早期假设时会重编译；PATTERNS.md 也应当这样演进。
- **删除条目**：发现一条之前写的是错的。在文件底部用一行简要原因标记删除：

```
[DELETED 2026-04-29] "FAIL verdict 一律用 tier1"
原因：R005 + R007 在 tier2 上工作良好；tier1 只留给证据真正
歧义的情形（整个集合大概 3 条规则）。
```

### 容量

PATTERNS.md 全文控制在约 5 KB 之内。超过时，剪掉最不可执行的条目（最近 5 条规则里没影响过任何决定的那些）。记忆是给"正在用"的，不是给"看过"的。

---

## 综合起来 —— 开局序列

进入 skill_authoring、TaskBoard 为空时：

1. **读 `describeState`**。看规则列表、里程碑（哪些规则有 chunk refs / 是否做了覆盖审计），以及现存的 PATTERNS.md。
2. **如果 PATTERNS.md 为空**：花约 2 个回合定排序方法 + 头 3-5 条 pattern。在写任何 skill 代码之前，PATTERNS.md 是第一份产出。
3. **如果 `rules/difficulty.json` 已存在**：按难度降序排规则。按本 skill 的规则适当分组。为每个工作单元调 `TaskCreate`。
4. **如果 `rules/difficulty.json` 不存在**：决定是否花 worker LLM 调用做分级（>20 条规则的语料几乎总是值得）。跑分级（每条规则一次 tier3 调用，可以按 10 条一组批处理），写 `rules/difficulty.json`，再回到第 3 步。
5. **挑第一个任务**。做到完整（skill + check + 至少一次本地测试）。把学到的写进 PATTERNS.md。换下一个任务。
6. **任务做到第 5 个、第 10 个时**：停下来重读 PATTERNS.md。如果新积累的 pattern 暗示要重构早期工作，**现在做**（便宜）而不是更晚（昂贵）。

### 调用 TaskCreate / TaskUpdate / TaskComplete

引擎注册了三个任务面板工具（v0.7.3+）：

- `TaskCreate({id, title, phase, ruleId?})` —— 在 `tasks.json` 中新增一条任务。`id` 在本会话内必须唯一；per-rule 任务建议用 `<rule_id>-<phase>` 这种稳定形状，分组 / 非规则任务用 `<group-name>-<phase>`。`phase` 是该任务所属的阶段（当前阶段或你预先排好的未来阶段）。`ruleId` 可选 —— 设上之后，引擎在里程碑推导时能把这个 rule_id 计入覆盖。
- `TaskUpdate({id, status?, summary?})` —— 把任务状态改为 `pending` / `in_progress` / `completed` / `failed`，可选附一行简要 summary。
- `TaskComplete({id, summary?})` —— `TaskUpdate({id, status:"completed", summary})` 的语法糖。完成一个工作单元后走这条最常用的路径。

调用 `TaskCreate` 把你的拆分写进面板、本回合结束之后，Ralph 循环会取下一条 pending 任务执行。完成工作、调 `TaskComplete`，循环再前进。如果一条任务无法完成（不可恢复的错误），调 `TaskUpdate({id, status:"failed", summary:"原因"})`，让队列继续推进而不是被堵在那里。

示例：

```
TaskCreate({ id: "R001-skill_authoring", title: "为 R001 撰写 skill",
             phase: "skill_authoring", ruleId: "R001" })

TaskCreate({ id: "trust-bundle-skill_authoring",
             title: "R013/R015/R017 — 必填字段表",
             phase: "skill_authoring" })

TaskComplete({ id: "R001-skill_authoring",
               summary: "正则核查在 89/90 通过；R001 完成" })
```

### 持久化方法论 —— PATTERNS.md 或 phase 日志 或 AGENT.md decisions

原则：在每次 phase 推进之前，把框架级的决定写到磁盘。对话会被 compact、agent 会重启、下一个 phase 会失去上下文。不管你选哪种格式，**写到磁盘** —— 不要依赖会消失的对话上下文。

三种格式都站得住，挑一种坚持下去：

- **`rules/PATTERNS.md`** —— 简洁，只装框架级内容，随项目推进而更新。适合假设可以前置、结构清晰的全新项目。上限 ~5 KB；条目是可迁移的形状 / 项目级约束 / 反模式加原因（参考上面"该写什么"一节）。

- **每阶段写 `logs/phase_<name>_complete.md`** —— 增量式，记录每个 phase 产出了什么、做了哪些决定、下个 phase 继承什么。适合"边发现边定型"的迭代式工作。E2E #7 GLM 用了这个模式：6 篇 phase 文档 + `evolution_summary_v1.2.md`，方法论照样捕获了，只是没写 PATTERNS.md。

- **`AGENT.md` decisions 段 + 领域笔记** —— 叙事风格，是关于"我们知道什么"和"为什么"的活文档。适合需要捕获丰富领域上下文的项目（法规、边缘案例、阈值、样本格式分布）。E2E #7 GLM 的 AGENT.md 里有法规生效日期、产品类型分类、阈值数值、样本格式数量 —— 完全 OK，是相同目标的不同惯用法。

不该做的事：跳过持久化、只靠对话上下文活着。等你写到第 N 条 skill 还没把方法论写到磁盘时，你已经做了 N 个关于 verdict 形状、chunker 边界、worker tier 的隐式决定 —— 每条规则都从零推导，重构要碰 N 个文件而不是一个。

❌ "等我有空再来记录这些洞察。"

✅ "每次 phase 推进之前，把这一阶段学到的东西写到适合本项目惯用法的那个持久化文件里 —— 哪怕只是初稿。"

E2E 历史：
- E2E #6 v070 DS 在用户介入回退之后才写 PATTERNS.md。那之前每条 skill 的设计决定都各自固化，之后还要再碰一遍。v0.7.1 加了"PATTERNS.md FIRST"的引导。
- E2E #7 v071 DS 和 GLM 都没写 PATTERNS.md，但 GLM 写了 6 篇 phase 完成日志和一份内容详尽的 AGENT.md —— 方法论 *捕获了*，只是放在了不同文件里。v0.7.2 把更宽的原则写进 skill：推进之前先持久化，格式灵活。

引擎从文件系统推导里程碑（v0.7.0 Group A）会按磁盘事实核验覆盖率，无论你怎么切分工作。TaskBoard 是你的草稿；磁盘才是契约；持久化文件是项目的记忆。
