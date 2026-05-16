---
name: skill-creator
tier: meta
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill creator（KC 兜底）

这是 Anthropic 上游 `skill-creator` 方法论的中文版，作为编写复杂技能时的深度参考随 KC 一并发布。KC 内部主流的技能编写路径是 `skill-authoring` 技能（核心思想沿袭自本技能）。只有当 `skill-authoring` 的指引对你正在编写的技能复杂度而言不够用时，才直接来查阅 `skill-creator`——例如你想跑正式的评估循环、做带方差分析的基准对比，或对触发用的 description 做优化。关于"先做哪些技能、怎样分组"的决策，请参考 `work-decomposition`。

---

一个用于创建新技能并对其进行迭代改进的技能。

从高层次看，创建一个技能的流程大致如下：

- 先确定这个技能要做什么、以及大致如何完成
- 写出技能的初稿
- 准备少量测试提示词，让带有该技能的 Claude 在其上运行
- 协助用户从定性和定量两个角度评估结果
  - 在测试运行还在后台进行时，先起草一些定量评估项（如果暂时还没有的话）；如果已经有现成的评估，可以直接沿用，或者根据需要进行修改。然后向用户解释这些评估项（已存在的也要把含义说明清楚）
  - 使用 `eval-viewer/generate_review.py` 脚本把结果呈现给用户查看，让他们也能浏览定量指标
- 根据用户对结果的评估反馈（以及定量基准里暴露出的明显缺陷）重写技能
- 反复迭代，直到满意为止
- 扩充测试集，在更大规模上再跑一遍

使用这个技能时，你的工作是判断用户目前处在上述流程的哪个阶段，然后从那里切入帮他们继续推进。比如，用户可能说"我想做一个 X 的技能"。你就可以帮他们澄清需求、写初稿、写测试用例、确定评估方式、跑完所有提示词、再迭代。

另一种情况是，他们已经有一个技能初稿。这时你可以直接跳到评估/迭代那一段循环。

当然，你应当保持灵活。如果用户说"我不想跑一堆评估，咱们就随意一点感觉感觉"，那就这样做也没问题。

技能基本完成之后（顺序仍然是灵活的），你还可以运行技能描述优化器——我们为此专门写了一个脚本——来优化技能的触发表现。

可以了吧？可以了。

## 与用户沟通

skill creator 的使用者可能跨越从对编程行话非常陌生到相当熟悉的整个区间。如果你没听说过的话（也很正常，这个趋势也才刚出现没多久），现在出现了一股潮流：Claude 的能力激发着水管工去打开终端、爸爸妈妈和爷爷奶奶去 google "怎么安装 npm"。不过绝大多数用户应该还是对计算机比较熟悉的。

所以请关注上下文线索，据此判断该如何措辞！默认情况下大概可以这样把握尺度：

- "evaluation" 和 "benchmark" 处于临界状态，但通常可以直接用
- 对于 "JSON" 和 "assertion"，则要看到用户给出明确信号、表明他们了解这些概念之后，再直接使用、不加解释

如果拿不准，简短地解释一下术语也完全可以；只要担心用户可能不懂，就顺手给一个一句话的定义。

---

## 创建一个技能

### 捕捉意图

先从理解用户的意图开始。当前对话里可能已经包含了用户想要沉淀为技能的工作流程（例如他们说"把这个变成一个技能"）。如果是这种情况，先从对话历史中提取答案——用过哪些工具、步骤的顺序、用户做过哪些修正、观察到的输入/输出格式。剩下的缺口由用户来补齐，并在进入下一步之前请他们确认。

1. 这个技能应该让 Claude 能做什么？
2. 这个技能应该在什么时候触发？（什么样的用户话术/语境）
3. 期望的输出格式是什么？
4. 是否需要建立测试用例来验证技能是否工作正常？输出可以被客观验证的技能（文件转换、数据抽取、代码生成、固定流程步骤）会从测试用例中获益。输出偏主观的技能（写作风格、艺术品）通常不需要。请根据技能类型给出合适的默认建议，但最终让用户来决定。

### 访谈与调研

主动询问关于边界情况、输入/输出格式、示例文件、成功标准和依赖项的问题。在把这一部分敲定之前，不要急着写测试提示词。

留意可用的 MCP——如果它们对调研有帮助（搜索文档、查找相似技能、了解最佳实践），并且环境支持子代理就并行调研，否则就在主线程内联进行。带着上下文进入，可以减轻用户的负担。

### 编写 SKILL.md

基于对用户的访谈结果，填写以下组成部分：

- **name**：技能标识符
- **description**：何时触发、做什么。这是最主要的触发机制——既要写技能"做什么"，又要写"什么场景下使用它"的具体描述。所有"何时使用"的信息都放在这里，不要放在正文里。注意：当前 Claude 容易"触发不足"——明明应该用的技能却不调用。为了对冲这种倾向，请把技能描述写得稍微"催促"一点。比如，与其写"用于构建一个简单快速的仪表盘，以展示 Anthropic 内部数据。"，不如写"用于构建一个简单快速的仪表盘，以展示 Anthropic 内部数据。只要用户提到 dashboard、数据可视化、内部指标，或者想要展示任何类型的公司数据，都要使用这个技能，即使他们没有显式说出 'dashboard' 这个词。"
- **compatibility**：依赖的工具、依赖项（可选，很少需要）
- **技能的剩余部分 :)**

### 技能写作指南

#### 技能的解剖结构

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### 渐进式信息披露

技能采用三层加载体系：
1. **元数据**（name + description）——始终在上下文里（约 100 词）
2. **SKILL.md 正文**——技能被触发时进入上下文（理想情况下少于 500 行）
3. **打包资源**——按需加载（无上限；脚本可以执行而无需被加载进上下文）

这些字数都是大概数字，必要时可以放宽。

**关键模式：**
- 把 SKILL.md 控制在 500 行以内；如果接近上限，就再加一层目录层级，并清楚地告诉调用该技能的模型"下一步该去哪里"。
- 在 SKILL.md 中清晰地引用其他文件，并说明何时去读它们
- 对于较大的参考文件（>300 行），请加上目录

**按领域组织**：当一个技能要支持多个领域/框架时，按变体组织：
```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```
Claude 只会读取相关的那一份参考文件。

#### 不让用户惊讶的原则

这点几乎不言自明，但还是要说：技能不得包含恶意代码、漏洞利用代码，或任何可能危及系统安全的内容。技能的实际内容不应让用户对其意图感到意外——如果你向用户描述这个技能，它的真实行为应该与描述一致。不要配合用户写出误导性的技能，或者用于未授权访问、数据外泄等恶意目的的技能。但像"扮演 XYZ 角色"这种是可以的。

#### 写作模式

指令尽量使用祈使句。

**定义输出格式**——可以这样写：
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**示例模式**——加入一些示例会很有帮助。可以按下面这种格式写（不过如果示例里出现了 "Input" 和 "Output"，可以适当变通一下）：
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### 写作风格

尽量向模型解释清楚某件事情为什么重要，而不是堆砌生硬死板的"必须 MUST"。运用心智理论，把技能写得通用一些，而不是死扣具体例子。先写一版初稿，然后过一段时间用全新的眼光重新审视、加以改进。

### 测试用例

写完技能初稿后，准备 2–3 条贴近实际的测试提示词——也就是真实用户实际可能说出的话。把它们摆给用户看：[不必照搬这段措辞]"这里有几条我想跑一下的测试用例，看着合适吗？还要再加几条吗？"然后就去跑。

把测试用例保存到 `evals/evals.json`。这一步先不写断言（assertion），只写提示词。断言会在下一步、运行测试的过程中起草。

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

完整 schema（包括稍后再加入的 `assertions` 字段）见 `references/schemas.md`。

## 运行并评估测试用例

这一节是一个连续的整体——不要中途停下。不要使用 `/skill-test` 或任何其他测试用的技能。

把结果放在 `<skill-name>-workspace/` 下，与技能目录平级。在 workspace 内部，按迭代分组（`iteration-1/`、`iteration-2/` 等），每个测试用例再各占一个目录（`eval-0/`、`eval-1/` 等）。不必一开始就把所有目录建好——边做边建即可。

### 第 1 步：在同一轮里启动全部运行（with-skill 与 baseline）

针对每个测试用例，在同一轮里启动两个子代理——一个带技能，一个不带。这一点很重要：不要先把 with-skill 的那一轮全跑完、之后再回来补 baseline。所有任务一次性启动，让它们大约同时完成。

**带技能的运行：**

```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**基线运行**（同样的提示词，但 baseline 的设置取决于情境）：
- **创建新技能时**：完全不带任何技能。同样的提示词，不传 skill path，输出保存到 `without_skill/outputs/`。
- **改进已有技能时**：用旧版本作为基线。开始改之前先把技能快照一份（`cp -r <skill-path> <workspace>/skill-snapshot/`），然后让基线子代理指向这个快照。输出保存到 `old_skill/outputs/`。

为每个测试用例写一份 `eval_metadata.json`（断言此时可以留空）。给每个 eval 起一个能体现其测试目的的描述性名字——不要只叫 "eval-0"。这个名字也用作目录名。如果本次迭代用了新的或修改过的 eval 提示词，请为每个新的 eval 目录都创建这些文件——不要假设前一轮的元数据会自动延续过来。

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### 第 2 步：在运行进行中起草断言

不要光等运行结束——这段时间可以利用起来。为每个测试用例起草定量断言，并向用户解释这些断言。如果 `evals/evals.json` 里已经有断言，过一遍并向用户说明每条检查的是什么。

好的断言是客观可验证的，并且名字有描述性——在基准查看器里一眼就能看出每条到底在检查什么。主观性的技能（写作风格、设计质感）更适合做定性评估——不要硬把断言套到需要人类判断的事情上。

起草完之后，把断言更新进 `eval_metadata.json` 和 `evals/evals.json`。同时也告诉用户他们会在查看器里看到什么——既包括定性的输出，也包括定量的基准指标。

### 第 3 步：随着任务完成抓取计时数据

每个子代理任务结束时，你会收到一条通知，里面包含 `total_tokens` 和 `duration_ms`。请立刻把这些数据保存到对应运行目录下的 `timing.json`：

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

这是你抓取这些数据的唯一机会——它们随任务通知一起来，并不会被持久化到别的地方。请收到一条就处理一条，不要等着攒一批再处理。

### 第 4 步：评分、汇总、并启动查看器

所有运行结束之后：

1. **为每个运行打分**——派一个评分子代理（或者直接在主线程里打分），让它读 `agents/grader.md` 并对每条断言进行评估。把结果保存到对应运行目录下的 `grading.json`。grading.json 里的 expectations 数组必须使用字段 `text`、`passed`、`evidence`（不要用 `name`/`met`/`details` 或其他变体）——查看器依赖这几个确切的字段名。对于能够通过程序检查的断言，写一段脚本去跑，而不要靠肉眼比对——脚本更快、更可靠，而且能在多次迭代中重复使用。

2. **汇总成基准**——在 skill-creator 目录下运行汇总脚本：
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
   它会产生 `benchmark.json` 和 `benchmark.md`，里面包含每种配置的通过率、耗时、token 用量，给出均值 ± 标准差以及差值。如果要手动生成 benchmark.json，查看器期望的精确 schema 见 `references/schemas.md`。
请把每个 with_skill 版本放在它对应的 baseline 之前。

3. **过一遍分析师视角**——读一下基准数据，把汇总数据可能掩盖掉的模式挖出来。`agents/analyzer.md`（"Analyzing Benchmark Results" 一节）里有要点清单——比如那些不管有没有技能都会通过的断言（无区分度）、方差很高的 eval（可能不稳定）、以及时间和 token 的权衡。

4. **启动查看器**，同时展示定性输出和定量数据：
   ```bash
   nohup python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
   到第 2 次及以后的迭代，还要加上 `--previous-workspace <workspace>/iteration-<N-1>`。

   **Cowork / 无界面环境：** 如果 `webbrowser.open()` 不可用，或者环境根本没有显示器，请用 `--static <output_path>` 来生成一份独立的 HTML 文件，而不是启动服务器。用户点击 "Submit All Reviews" 时反馈会被下载为 `feedback.json` 文件。下载之后，把 `feedback.json` 拷进 workspace 目录，下一轮迭代会读取它。

注意：请使用 generate_review.py 来生成查看器；没必要手写 HTML。

5. **告诉用户**类似这样的话："我已经把结果在你的浏览器里打开了。有两个标签页——'Outputs' 让你逐个测试用例查看并留下反馈，'Benchmark' 展示定量比较结果。看完之后回来告诉我一声。"

### 用户在查看器里看到什么

"Outputs" 标签页每次只展示一个测试用例：
- **Prompt**：当时给出的任务
- **Output**：技能生成的文件，能内联渲染的就内联展示
- **Previous Output**（迭代 2 起）：折叠区域，展示上一轮迭代的输出
- **Formal Grades**（若打了分）：折叠区域，展示每条断言的通过/失败
- **Feedback**：一个文本框，输入时会自动保存
- **Previous Feedback**（迭代 2 起）：上一轮的反馈意见，显示在文本框下方

"Benchmark" 标签页展示统计汇总：通过率、耗时、token 用量，按配置分组，并附带每个 eval 的明细和分析师的观察笔记。

导航方式是 prev/next 按钮或键盘方向键。看完后他们点 "Submit All Reviews"，所有反馈会保存到 `feedback.json`。

### 第 5 步：读取反馈

用户告诉你他们看完了之后，读取 `feedback.json`：

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

反馈为空意味着用户觉得没问题。请把改进精力集中在那些用户提出了具体意见的测试用例上。

事情做完之后记得把查看器服务进程关掉：

```bash
kill $VIEWER_PID 2>/dev/null
```

---

## 改进技能

这一段是整个循环的核心。你跑完了测试用例，用户也评审了结果，接下来要根据他们的反馈把技能做得更好。

### 怎样思考改进

1. **从反馈中泛化。** 这里大局上要明白的是：我们想做的是能被使用上百万次（也许字面意义上、甚至更多次，谁知道呢）、横跨各种各样提示词的技能。眼下你和用户只是反复在少数几个例子上迭代，因为这样推进得快。这些例子用户烂熟于心，新输出他们一眼就能评估。但如果你和用户共同开发出来的技能只在这几个例子上管用，那就毫无意义。与其塞进各种过拟合的小补丁、或者堆上一堆压迫性的 MUST，不如在遇到某个顽固问题时换条路子：尝试新的比喻、推荐不一样的工作模式。试一下成本很低，说不定就撞到一个特别好的写法。

2. **保持提示词精简。** 把那些没在出力的内容删掉。除了看最终输出，请务必读一下完整的 transcript——如果发现技能让模型在无谓的事情上浪费时间，可以试着去掉造成这种浪费的部分，看看效果。

3. **解释"为什么"。** 努力把你要求模型做的每件事背后的**原因**讲清楚。今天的 LLM 是*聪明*的。它们有不错的心智理论，在有好用的引导框架时能跳出机械执行、把事情真正做成。即使用户的反馈很简短、甚至带着不耐烦，也要努力理解任务本身，理解用户为什么这样写、他们究竟写了什么，然后把这种理解传递到指令里去。如果你发现自己在用大写 ALWAYS 或 NEVER、或者用上特别死板的结构，那是个黄色警示——尽可能换种说法，把背后的道理讲明白，让模型理解你为什么要求做这件事。这样更人性、也更有力、更有效。

4. **留意各个测试用例之间的重复劳动。** 阅读测试运行的 transcript，留意几个子代理是不是都各自独立写了类似的辅助脚本、或者走了同样的多步流程。如果 3 个测试用例里子代理都各自写了一个 `create_docx.py` 或 `build_chart.py`，那就是一个很强的信号：这个技能应该把那段脚本打包进来。写一次，放到 `scripts/`，然后让技能去调用它。这样以后每次调用都不必从零再造一遍。

这项任务相当重要（我们可是想在这上面每年创造数十亿美元的经济价值！），而思考时间从来不是瓶颈；请慢慢来，反复琢磨。我建议先写一版修订稿，然后用全新的眼光再看一遍，进一步打磨。真的努力站到用户的位置，去理解他们想要什么、需要什么。

### 迭代循环

改完技能之后：

1. 把改进应用到技能上
2. 把所有测试用例都重新跑一遍，写到一个新的 `iteration-<N+1>/` 目录里，也包括 baseline 运行。如果你在做的是创建新技能，baseline 一直是 `without_skill`（不带任何技能）——这在所有迭代里保持不变。如果你在改进已有技能，那么用哪种作为 baseline 由你判断：用户最初带进来的原始版本，还是上一轮迭代的版本。
3. 启动评审器，并把 `--previous-workspace` 指向前一次迭代
4. 等用户评审完、告诉你结束为止
5. 读取新的反馈，再改进，再迭代

一直循环下去，直到：
- 用户说他们满意了
- 所有反馈都为空（全都看着没问题）
- 你已经不再做出有意义的进展

---

## 进阶：盲对比

在需要对一个技能的两个版本做更严格比较的情况下（比如用户问"新版本到底是不是真的更好？"），有一套盲对比体系。详情请读 `agents/comparator.md` 和 `agents/analyzer.md`。基本思路是：把两份输出交给一个独立代理、但不告诉它哪份是哪份，让它来评判质量。然后再分析"赢的那份为什么赢"。

这个步骤是可选的，需要子代理，多数用户用不到。人工评审循环通常已经够用。

---

## 描述优化

SKILL.md 前置元信息（frontmatter）里的 description 字段是决定 Claude 是否调用一个技能的主要机制。在创建或改进一个技能之后，可以主动提议优化它的 description，以提升触发的准确性。

### 第 1 步：生成触发评估查询

写出 20 条 eval 查询——里面既有"应当触发"的，也有"不应当触发"的。保存为 JSON：

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

这些查询必须真实可信，是 Claude Code 或者 Claude.ai 的用户实际会输入的内容。不要抽象的请求，而要具体、有细节的请求。比如带上文件路径、用户工作或处境的私人化背景、列名和取值、公司名、URL，加一点点小故事。其中一些可以是全小写、带缩写、带错字或是口语化的。请使用不同长度，重点放在边界情况上而不是泾渭分明的简单例子（用户后面会有机会确认）。

不好的写法：`"Format this data"`、`"Extract text from PDF"`、`"Create a chart"`

好的写法：`"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

对于 **应当触发** 的查询（8–10 条），要想着覆盖度。同一个意图要有不同的表达方式——有些正式、有些随意。也要包含用户没有明说技能名或文件类型、但显然需要这个技能的情形。再放进几个不常见的用例，以及该技能与其他技能竞争、但应该胜出的情形。

对于 **不应当触发** 的查询（8–10 条），最有价值的是那些"擦肩而过"的——和技能共享一些关键词或概念，但实际上需要的是别的东西。要想到相邻领域、关键词上的歧义（朴素的关键词匹配会误触发但其实不该触发）、以及虽然涉及到这个技能能做的事但更适合用别的工具完成的情形。

要避免的关键问题：不要把"不应触发"的查询写得明显与技能无关。把"写一个斐波那契函数"作为 PDF 技能的反例就太简单了——什么都测不出来。负例应当真正具有迷惑性。

### 第 2 步：与用户一起评审

用 HTML 模板把这套 eval 集合呈给用户评审：

1. 从 `assets/eval_review.html` 读取模板
2. 替换占位符：
   - `__EVAL_DATA_PLACEHOLDER__` → eval 项的 JSON 数组（不要加外层引号——它是一句 JS 变量赋值的右值）
   - `__SKILL_NAME_PLACEHOLDER__` → 技能的名字
   - `__SKILL_DESCRIPTION_PLACEHOLDER__` → 技能当前的 description
3. 写到一个临时文件（例如 `/tmp/eval_review_<skill-name>.html`）然后打开：`open /tmp/eval_review_<skill-name>.html`
4. 用户可以编辑查询、切换 should-trigger、增删条目，然后点击 "Export Eval Set"
5. 文件会下载到 `~/Downloads/eval_set.json`——记得在 Downloads 目录里挑最新的那一份，以免出现多版本（如 `eval_set (1).json`）

这一步很关键——评估查询写得不好，会得到不好的 description。

### 第 3 步：运行优化循环

告诉用户："这个会花一点时间——我会在后台跑优化循环，并定期回来看看进展。"

把 eval 集合保存到 workspace，然后在后台运行：

```bash
python -m scripts.run_loop \
  --eval-set <path-to-trigger-eval.json> \
  --skill-path <path-to-skill> \
  --model <model-id-powering-this-session> \
  --max-iterations 5 \
  --verbose
```

请使用系统提示词里那个 model ID（也就是驱动当前会话的那个模型），这样触发测试和用户实际体验保持一致。

它运行期间，请周期性地 tail 一下输出，向用户汇报当前是第几轮迭代、得分是什么样子。

它会自动完成整个优化循环。它会把 eval 集合按 60% 训练 / 40% 留出测试拆开，先评估当前 description（每条查询跑 3 次以得到稳定的触发率），再调用 Claude 根据失败用例提出改进建议。它会在新 description 上重新跑训练集和测试集，最多迭代 5 轮。结束时，它会在浏览器里打开一份 HTML 报告，展示每一轮的结果，并返回包含 `best_description` 的 JSON——是按测试集得分而不是训练集得分挑出来的，以避免过拟合。

### 技能触发机制的工作原理

理解触发机制有助于设计更好的 eval 查询。技能会以 name + description 的形式出现在 Claude 的 `available_skills` 列表里，Claude 根据这个 description 决定是否查阅一个技能。一个要点是：Claude 只会在它自己很难独立完成的任务上去查阅技能——像"读一下这份 PDF"这种简单的一步式查询可能并不会触发技能，哪怕 description 完美匹配，因为 Claude 用基础工具就能直接处理。复杂的、多步骤的、或者专业性强的查询，在 description 匹配的前提下能够可靠地触发技能。

这意味着你的 eval 查询要足够有分量，让 Claude 真的能从查阅技能中获益。"读一下文件 X"这种简单查询不是好的测试用例——不管 description 写得多好，它们都不会触发技能。

### 第 4 步：应用结果

从 JSON 输出里取出 `best_description`，更新技能 SKILL.md 的前置元信息。给用户看一下前后对比，并报告分数。

---

### 打包与呈现（仅在有 `present_files` 工具时进行）

先检查你是否有 `present_files` 工具。如果没有，跳过这一步。如果有，就把技能打包，并把 .skill 文件呈现给用户：

```bash
python -m scripts.package_skill <path/to/skill-folder>
```

打包完之后，告诉用户生成的 `.skill` 文件的路径，他们就可以安装它了。

---

## Claude.ai 专用说明

在 Claude.ai 上，核心工作流不变（起草 → 测试 → 评审 → 改进 → 重复），但因为 Claude.ai 没有子代理，一些机制需要相应调整：

**运行测试用例**：没有子代理就意味着没有并行执行。对每个测试用例，先读技能的 SKILL.md，然后照着它的指示自己来完成测试提示词的任务。一次跑一个。这样的严谨度不如让独立子代理来跑（你既写了技能，也在执行它，会带着完整的上下文），但作为合理性检查仍然有价值——而且人工评审环节会作为补偿。跳过基线运行——就按照用户要求用技能完成任务即可。

**评审结果**：如果你打不开浏览器（比如 Claude.ai 的 VM 没有显示器，或者你在远端服务器上），那就完全跳过浏览器评审器。改为直接在对话中展示结果。对每个测试用例，展示提示词和输出。如果输出是一个用户需要看的文件（比如 .docx 或 .xlsx），先把它存到文件系统里、再告诉他们路径，让他们下载并查看。在对话中直接征求反馈："看着怎么样？有什么想改的吗？"

**基准化**：跳过定量基准——它依赖的基线比较在没有子代理时本来就没什么意义。把精力放在来自用户的定性反馈上。

**迭代循环**：和之前一样——改进技能、重跑测试用例、收集反馈——只是中间不走浏览器评审器。如果有文件系统，你仍然可以把结果按迭代目录整理起来。

**Description 优化**：这一节需要 `claude` 命令行工具（具体来说是 `claude -p`），它只在 Claude Code 里可用。如果你在 Claude.ai，就跳过这一节。

**盲对比**：需要子代理。跳过。

**打包**：`package_skill.py` 脚本只要有 Python 和文件系统就能跑。在 Claude.ai 上你也可以运行它，用户可以下载生成的 `.skill` 文件。

**更新一个已存在的技能**：用户可能让你更新一个已存在的技能，而不是创建新技能。这时：
- **保留原有的名字。** 注意原技能的目录名和 `name` 字段，原样使用。例如已安装的技能叫 `research-helper`，就输出 `research-helper.skill`（不要写成 `research-helper-v2`）。
- **先复制到可写入的位置再编辑。** 已安装的技能路径可能是只读的。先复制到 `/tmp/skill-name/`，在那里编辑，再从副本打包。
- **如果要手动打包，先在 `/tmp/` 里组装好**，然后再复制到输出目录——直接写入输出目录可能因权限失败。

---

## Cowork 专用说明

如果你在 Cowork 环境里，主要要知道这几件事：

- 你有子代理，所以主流程（并行启动测试用例、跑基线、打分等等）都能照常工作。（不过如果你遇到严重的超时问题，把测试提示词改成串行执行也是可以的。）
- 你没有浏览器、也没有显示器，所以在生成 eval 查看器时请使用 `--static <output_path>` 生成一份独立 HTML，而不是启动服务器。然后把这个链接抛出来，用户可以点开在自己浏览器里查看。
- 出于一些原因，Cowork 这个环境似乎容易让 Claude 在跑完测试后不去生成 eval 查看器——所以再次强调：不管是 Cowork 还是 Claude Code，跑完测试之后你都应当先生成 eval 查看器、让用户先看一遍例子，然后再亲自去改进技能、做更正——而且必须使用 `generate_review.py`（不要自己手写一份花式 HTML）。抱歉这里我要全大写一下：先把 EVAL VIEWER *生成出来*，再去自己评估输出。目的是让人尽快看到结果！
- 反馈机制不同：因为没有在跑的服务器，查看器里的 "Submit All Reviews" 按钮会把 `feedback.json` 作为文件下载。你之后从那个位置去读取它（可能需要先申请访问权限）。
- 打包能用——`package_skill.py` 只需要 Python 和文件系统。
- Description 优化（`run_loop.py` / `run_eval.py`）在 Cowork 下应当也没问题，因为它是通过子进程调用 `claude -p`，不是浏览器；但还是请等到技能整体做完、用户也认可后再做这一步。
- **更新一个已存在的技能**：用户可能让你更新一个已存在的技能，而不是创建新技能。参照上方 Claude.ai 节里的"更新一个已存在的技能"指引执行。

---

## 参考文件

agents/ 目录下是各种专用子代理的指令文件。需要派出对应的子代理时再去读取。

- `agents/grader.md` — 如何对照输出来评估断言
- `agents/comparator.md` — 如何对两份输出做盲式 A/B 对比
- `agents/analyzer.md` — 如何分析为什么某一版本胜出

references/ 目录下是额外的文档：
- `references/schemas.md` — evals.json、grading.json 等的 JSON 结构

---

最后再把核心循环重申一次，以示强调：

- 弄清楚这个技能要解决什么问题
- 起草或编辑这个技能
- 让带有这个技能的 Claude 在测试提示词上运行
- 与用户一道评估输出：
  - 生成 benchmark.json 并运行 `eval-viewer/generate_review.py` 来辅助用户评审
  - 跑一遍定量评估
- 反复迭代，直到你和用户都满意
- 把最终的技能打包，并交付给用户

如果你那边有 TodoList 这种工具，请把这些步骤加进去，免得忘记。如果你在 Cowork 环境，请特别把 "Create evals JSON and run `eval-viewer/generate_review.py` so human can review test cases" 加进 TodoList，确保它真的会被执行。

祝顺利！

---

*方法论改编自 [anthropics/skills](https://github.com/anthropics/skills)（Apache 2.0）。*
