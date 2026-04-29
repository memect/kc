# KC Agent 团队分享讲稿（第二讲）

> 2026-04-27 | 产品研发组全体内部分享
> 讲者：产品负责人
> 听众：pdf2skills / Anything2Ontology / pdf2app / kc 团队成员
>
> 上一次分享：[`team_demo_script_0411.md`](./team_demo_script_0411.md) — 介绍了 KC Agent 是什么、六阶段 pipeline、设计哲学、harness 概念、关键问题与决策。
>
> 这次分享是顺着上次往前推一步。**重点不在重复"KC 是什么"，而在过去这两周半在工程和方法论上的几个新认识**。从 v0.2.1 到 v0.6.2，14 个版本，跑了 4 次大型 E2E 测试，掉过 5 个大坑。我会沿着四个一级标题展开。
>
> 关联项目：kc_cli, kc_reborn（已冻结）, Anything2Ontology, pdf2skills-doc-base, AMC verification app
>
> 必读背景：[`feishu-doc-base/2026-04-10_产品哲学：从SAM到pdf2skills的主线叙事.md`](../../feishu-doc-base/2026-04-10_产品哲学：从SAM到pdf2skills的主线叙事.md) 与 [`2026-04-14_产品哲学：六个月后再回来看的预言.md`](../../feishu-doc-base/2026-04-14_产品哲学：六个月后再回来看的预言.md)。这次的四个一级标题，本质上都是这两份哲学文档的工程注脚。

---

## 0. 在四个标题之前：上一次哲学讨论留下的几个锚点

这次讲之前先做一个对齐——下面这些概念全部来自上面两份产品哲学文档，我会反复用到，**先在白板上画出来**：

1. **生产工具的工具**（2024.12，SAM 时代提出）。系统自身有较高容错宽容度，**只要在有限次数内跑通一次，产出一个稳定的工具就可以**。
2. **指挥 / 谱曲 / 演奏**（Conductor / Composer / Performer）。SOTA 推理模型 → SOTA 编码模型 → 最小可用模型。**蒸馏就是去掉指挥和谱曲，只留演奏家**。
3. **JIT**（Just In Time）。Schema 是 JIT 的，上下文是 JIT 的，工具选择本身也是 JIT 的——**没有一个工具永远是好的，但永远有一个工具在这次任务中是最好的**。
4. **剥洋葱**（Onion Peeler）。先做一个垃圾跑通全链路，再一层层让系统变好。
5. **三次折叠**：第一次（SAM）把"每条规则手写工作流"折叠成"自动生成工作流"；第二次（KC）把"人类架构师设计验证系统"折叠成"agent 自动设计验证系统"；第三次（？）把"人类 PM 设计 harness"折叠成"meta-agent 自动设计 harness"。
6. **绳子和棍子是同一只手**。Guardrail（不让 agent 做坏事）和 enablement（让 agent 能做好事）应该在同一个系统里、用同一套机制管理——它们是 tool registry 的两面。
7. **Harness 是新的操作系统**。Session = 文件系统，Harness = 进程调度器，Sandbox = 容器。这不是巧合。
8. **结构是什么不重要，有一个结构很重要**。轮子。
9. **Bootstrap myself**。每隔一段时间，给未来的自己留一份"现在认为是对的"的文档——一年半之后回来看哪些还对、哪些已经被实践证伪。

四个一级标题，每一个都对应这九个锚点中的一个或几个。下面进入正题。

---

## 1.4 企业即文档，企业业务分析即文档核查

> 团队内部成员 01fish 在 2026 年 2 月 17 日发表了《企业即文档》一文（[原文链接](https://mp.weixin.qq.com/s/ANNqbPaZV5nEb12QliSbFA)、本地 PDF：`feishu-doc-base/企业即文档.pdf`）。这篇文章把"为什么我们要做 KC 这种东西"放进了一个比团队内部哲学讨论大得多的产业语境里。我借这次分享展开讲一下我对这篇文章的理解，以及它怎么直接接到 KC 在做的事情上——再放一个稍微大胆一点的延伸。

### 1.4.1 我对《企业即文档》一文的理解

01fish 那篇的核心命题就一句话：**企业 = 文档。这不是比喻，是等式**。

他论证这个等式的方式是把"企业"拆成三个组件——人、专业沉淀、流程与沟通——然后逐个证明这三样东西**在本质上都是文档**：

- **人**的核心价值 = 知识 + 判断模式 + 关系网络。知识可以写下来。判断模式可以写成"遇到 X 情况，先考虑 Y，再排除 Z"的决策框架。关系网络是当前最难文档化的部分（但 CRM、LinkedIn、AI 社交工具正在快速数字化它）。
- **专业沉淀**本身就是文档的别名。SOP 是文档、代码库是文档、设计规范是文档、客户案例是文档。"只在老员工脑子里"的经验不是不能文档化，是还没有文档化。
- **流程**天然是结构化信息——输入、处理、输出、判断条件、异常处理——**这恰恰是文档最擅长描述、AI 最擅长执行的东西**。

数据上有几个值得记的：Panopto 调研 **42%** 的机构知识仅存在于个别员工头脑中；McKinsey 测算知识工作者每周 **9.3 小时**花在"找东西"上；IDC 测算 1000 人企业每年因知识管理低效**损失 240 万美元**。**企业确实是文档，只是 42% 的文档从来没有被写下来。**

这篇文章最有冲击力的部分是把"X 即文档"这件事放进一个三波递进的产业史框架里：

| 波次 | 时间 | 输入（文档） | 编译器 | 输出（运行时） |
|-----|------|------------|--------|----------------|
| 1. **基础设施即代码**（IaC） | 2009 | YAML 配置文件 | Terraform / K8s | 服务器集群 |
| 2. **软件即文档**（Vibe Coding） | 2025 | 自然语言需求 | AI 大模型 | 代码 |
| 3. **企业即文档**（Enterprise as Documentation） | 2026 | 企业文档 | AI agent | 一家运转的公司 |

这三波**逻辑完全同构**：手动操作 → 文档描述 → 自动执行。每一波的产物都是下一波的基础设施——IaC 让云可编程 → 可编程的云支撑 AI 训练 → 大模型催生 vibe coding → vibe coding 降低 agent 门槛 → agent 让"企业即文档"成为现实。**每一层踩在上一层肩膀上。**

01fish 列了三家"已经在用文档驱动公司"的先行者：

- **Amazon 6-pager**（2004 起）：Bezos 禁 PPT，所有会议以 6 页叙述文档开始，会前 30 分钟全体安静阅读。"PPT 是销售工具。在公司内部，你最不该做的事就是销售。"二十年下来，**6-pager 不是决策的记录，6-pager 就是决策本身**。
- **GitLab Handbook**（全远程）：2700 多页公开手册。联合创始人原则只有一条："**If it's not in the Handbook, it's not real**"——理论上，仅凭这份手册可以重建 GitLab 的全部运营。
- **Stripe**：Collison 每月发内部长文，所有会议前必须先发结构化文档（问题、拟议方案、开放性问题）。**不允许即兴讨论**。

它们的共同点：**不是用文档来记录公司运行，而是用文档来驱动公司运行**。文档不是附属品，是主体。

01fish 还给了一个很狠的反例——Klarna 2024 年宣布 AI 客服"相当于 700 个全职"、裁员 22%，一年后开始重新招人。**问题不在 AI 不行，在 Klarna 没做好文档化**。质量标准没写下来、异常处理没写下来、客户语境没写下来——agent 就像没有培训材料的新员工，聪明但不知道该干什么。这就是"**Klarna 效应**"。

最后他给出一个新等式：

> 传统逻辑：企业竞争力 = 人才 + 资本 + 品牌 + 技术壁垒
> 新等式：**企业竞争力 = 文档质量 × agent 执行能力**

以及一句金句：

> **Agent 不是新员工。文档才是新员工。Agent 只是文档的运行时环境。**

我对这篇文章的总评是：**它把'为什么我们要做 KC'这件事放进了一个产业级别的脉络里**。我们之前讨论 KC 是从内部往外讲——产品哲学、SAM 弧、剥洋葱、JIT；01fish 这篇是从外部往内推——AI agent 已经基础设施化了，企业要被这股力量加速，**前提是企业先把自己写成文档**。两条路在中间汇合的位置就是 KC 在做的事。

值得注意一点 01fish 自己也说了的边界——**不是所有东西都能文档化**。老销售和客户十年的信任、创始人面对未知市场的直觉、团队之间的微妙默契……这些隐性知识目前无法被结构化。"企业即文档"是个方向，不是终点。**它能覆盖的部分（流程、决策框架、专业方法论）已经足够庞大、足够值得做；它覆盖不了的部分恰恰是人在这个等式里不可替代的原因**。这个限定很重要，否则就成了 hype。

### 1.4.2 企业业务分析即文档核查

这一节是从概念层把 01fish 那篇的命题往前推一步。**不是把业务分析的每个动作映射到 KC 的每个模块上**——那种对应是工程层面的，意思不大；真正想讲的是**这两件事在概念上是同一件事**。

#### 业务分析这个职业其实有很多名字

业务分析、咨询、解决方案、售前、需求工程、流程梳理，再加上最近这几年的提示工程——**这些名字背后是同一件事**：

> 通过**数据结构化**和**知识建模**的手段，**把业务问题转化为可被某种系统稳定执行的形式**。

把这句话拆开看：

- **业务问题**是什么？是一个机构（银行、医院、保险、律所、监管）面对的具体烦恼——"我们的合规审核每年要 50 个人、还经常漏审"、"我们的客服回答不一致"、"我们的尽调报告 80% 内容是重复劳动"。
- **数据结构化**是什么？把散落在 PDF、邮件、口述、Excel、PPT 里的原始信息，整理成可以被进一步处理的形式——schema、表格、流程图、规则集、决策树。
- **知识建模**是什么？比数据结构化更上一层——不只是"把数据放进格子"，而是**找出数据背后的概念、关系、约束、推理**，变成一个**模型**。这个模型可以是本体（ontology）、可以是规则系统（rule engine）、可以是流程模型（workflow）、可以是 prompt 模板，也可以是 KC 这种 skills + workflows 的组合。
- **可被稳定执行**是什么？业务问题的最终交付不是一份 PPT 或一本咨询报告，而是**某种能在生产环境中重复运行的系统**。CRM 配置、规则引擎、工作流、ML 模型、agent + skills——形态各代不同，但终点都是这个。

**业务分析这个职业的所有名字（咨询、解决方案、售前、提示工程……）都是这件事在不同时代、不同行话里的不同称呼**。咨询师交付 Word + PPT，解决方案架构师交付架构图 + 配置，售前交付 demo + 报价，提示工程师交付 prompt + skills——载体在变，**核心动作没变：把模糊的业务问题结构化、建模化、可执行化**。

#### 为什么这件事在"企业即文档"的视角下就是文档核查

01fish 那篇的等式是 **企业 = 文档**。把这个等式代回业务分析的定义里：

> 业务分析 = 通过结构化和知识建模把**业务问题**转化为**可执行系统**
> 业务问题 ≈ 企业现状（一组现有文档：法规、SOP、合同、记录、流程图）
> 可执行系统 ≈ 一组新文档（规则集、skills、workflows）+ 执行它们的运行时
>
> 所以业务分析 ≈ **从一组旧文档（现状）推导出一组新文档（解决方案），并保证两者之间的语义对齐**

而**"保证两组文档之间的语义对齐"——这个动作的标准名字就叫文档核查**。

文档核查在大众认知里是个窄概念——"对照一条规则查一份合同"。但它的本意远比这个宽：**任何"在多份信息源之间建立一致性、对齐、覆盖关系"的认知活动都是文档核查**。

所以反过来——**业务分析的本质就是文档核查**。咨询师对照客户的现状文档和最佳实践文档做差距分析（gap analysis），是文档核查。解决方案架构师对照需求文档和系统能力文档做匹配，是文档核查。售前对照客户痛点和产品功能做映射，是文档核查。提示工程师对照业务规则和模型行为做对齐，**也是文档核查**。

只是这件事过去没有被这么叫，**因为没有一个工具或方法论让它可以被这么叫**。在 LLM 之前，"文档核查"听上去就是合规岗位的体力活；在 LLM 之后，**它变成了一个可工程化的、有方法论的、可交付的范畴**。

#### 这种概念重框架化对 KC 的产品定位意味着什么

我之前讲 KC 的时候习惯说"它是一个文档核查 agent"。沿着上面的论证走下来，这个表述其实**框窄了**。更准确的表述是：

> **KC 是一个把"业务分析"这件事工程化的 agent harness**——它把咨询、解决方案、售前、提示工程这一系列工作背后共同的"数据结构化 + 知识建模 + 可执行化"动作收敛成了一套可重复的工程范式。

这个表述带来三个推论：

1. **客户画像不是"需要做合规核查的金融机构"，是"需要把业务问题结构化的任何机构"**。这是一个广得多的范畴——任何有复杂内部知识、需要稳定执行某类决策的组织。金融合规只是其中信号最强的一个细分。

2. **价值主张不是"用 AI 替代核查员"，是"让你的业务分析产物自己会运行"**。咨询行业过去交付 PPT 和 Word，现在可以交付 workspace。这是交付物形态的代际变化——跟 IaC 改写运维、Vibe Coding 改写开发的代际变化是同一类。

3. **真正的对照系不是其他 AI 公司，是麦肯锡、埃森哲、四大、本土咨询和 BA 工具栈（Excel + Visio + Confluence）**。这些行业过去几十年都在做"把业务问题结构化"这件事——只是用人力做。**KC 不是让 AI 入侵咨询，是让咨询的产物升级成可执行物**。

这个重新定位也让我们 04-14 那篇暴论里的"在抽象层通用、在具体层确定"有了一个更清晰的落点：**抽象层是"业务问题→可执行系统"这个通用模式，具体层是某个领域（金融合规 / 医疗审核 / 法律尽调 / 监管检查）的具体方法论**。Harness 编码抽象层，Skills 编码具体层。

### 1.4.3 暴论：太史公曰也是文档核查

这是这一节的最后一个延伸，跟一年前 04-14 那篇暴论一样的形态——**先抛出来，6 个月后看对不对**。

**暴论：太史公曰也是文档核查。**

司马迁写《史记》，每篇结尾来一段"太史公曰"——他的史评。但司马迁前面那 130 篇本纪、世家、列传是怎么写出来的？

**他在做的就是文档核查**。

读各方原始档案：诸侯国实录、宫廷起居注、奏章、铭文、诏书、口述史料、私家著述。这些文档之间互相矛盾、有缺、有伪、有立场。司马迁要做的事：

```
搜集多源文档（诸侯档案 / 起居注 / 奏章 / 口述 / 实地走访）
        ↓
辨伪、比对、调和（同一件事，三个来源说法不同，谁可信？）
        ↓
建立人物 / 事件 / 时间线的一致性（entity resolution + cross-document verification）
        ↓
对模糊地带做判断（"司马公曰：……"——这是 SOTA 模型在做的 reasoning）
        ↓
输出结构化的历史叙事（catalog.json 的史学版本）
```

**史官的工作流和现代业务分析师的工作流是同构的，跟 KC 的 BUILD 阶段也是同构的**。

把这个观察推到极致——**所有"试图从多源、多版本、有冲突的文档中提炼一致性结论"的工作，本质都是文档核查**。

随手列一下都属于这个类别的工作：

- **史官写史**（司马迁、希罗多德、Edward Gibbon）
- **企业并购尽调**（律师 + 财务读上千份合同 / 财报 / 内部文件，找一致性 + 风险）
- **新闻 fact-checking**（多源信息比对，建立 cross-document consistency）
- **医疗病案审核**（CDS：clinical decision support，跨多份病历 / 检查报告 / 用药记录建立一致性）
- **法律判例分析**（律师在前案中找一致性，做类比推理）
- **学术综述（systematic review）**（Cochrane review 是这事的标准化版本）
- **监管检查**（监管员对一家被检机构的所有报告做合规一致性检查）
- **人物背景调查**（情报、KYC、AML）
- **科学论文复现性核查**（reading a paper + its data + its code，建立 consistency）
- **侦探办案**（不夸张，办案就是从口供 / 物证 / 监控记录这些"多源文档"里建立一致性）

**这十种工作里，KC 这套方法论原则上都能用**。

具体怎么用？回到 04-14 文档里那张折叠的纸：

> Harness（通用编排）+ Pipeline（领域阶段）+ Skills（具体方法论）+ Evolution Loop（运行时适配）。**在抽象层通用，在具体层确定**。

KC 的 7 个 harness 组件（LLMClient、ToolRegistry、EventLog、ContextWindow、SessionState、Retry、Workspace）是场景无关的，**任何"文档核查"任务都能复用**。需要替换的只是：

1. **Pipeline 阶段定义**——史官写史的 pipeline 不是 BOOTSTRAP→EXTRACTION→AUTHORING→TESTING→DISTILLATION→QC→FINALIZATION，是 SOURCE_GATHERING→CROSS_VERIFICATION→ENTITY_RESOLUTION→NARRATIVE_DRAFTING→COMMENTARY → ARCHIVE。但**形态是同构的**。
2. **Tool 集**——史官需要的 `archaeology_search` / `bronze_inscription_parse` / `genealogy_resolve` 这些工具我们没写，但 `BaseTool` 接口拿过去直接能用。
3. **Skills 内容**——领域知识不一样，但 skill 文件夹结构（SKILL.md + scripts/ + references/ + assets/）是通用的。

**这就是 04-14 那个"三次折叠"的预言在另一个维度的展开**。第二次折叠把"人类业务分析师"折叠成"agent + skills + harness"；推到尽头，**"业务分析师"这个范畴本身可以扩展到一切文档核查工作者，包括史官**。

#### 这个暴论的工程意涵

讲到这里有人会问：那我们就该去做"AI 司马迁"了？不是。这是个**视野上的判断**，不是产品上的判断。

真正的工程意涵有两条：

**A. KC 的 harness 必须保持领域无关**。每次写 KC 的代码，问自己一个问题——这段逻辑是不是在偷偷假设"用户在做金融合规"？如果是，把它推进 skills / pipeline 这一层，**让 harness 保持纯净**。这样三年后某个考古学家想拿 KC 去做甲骨文断代，他只需要写 skills，不需要改 harness。

**B. Skills 这一层应该按"文档核查的方法论维度"组织，不是按"金融场景的具体规则"组织**。这件事 meta skills 层面已经做对了——`document-parsing`、`tree-processing`、`entity-extraction`、`compliance-judgment`、`cross-document-verification`、`corner-case-management`、`evolution-loop` 这些都是**通用方法论**，不是金融场景。任何文档核查任务的方法论都在这里面。

#### 6 个月后值得验证

跟 04-14 暴论一样，把这个暴论拆成可证伪命题：

1. 6 个月后，是否有人（团队内 / 外部）拿 KC 的 harness 跑了**非金融**的文档核查任务？
2. 跑这个非金融任务时，**harness 一行代码不改**，只换 pipeline 定义和 skills，能不能跑通？
3. 能不能找一个跟金融完全无关的场景做 demo？候选：医学论文 fact-check、法律判例对齐、科技报告 cross-verification……

如果这三件事 6 个月后能做到，**"企业业务分析即文档核查"就升级成了"任何文档核查都是同一回事"**。

如果做不到，回头审视 harness 是不是其实偷偷有金融偏见——这种"自查"比扩张本身更有价值。

### 1.4.4 这一节跟后面四个一级标题怎么咬合

最后串一下这一节跟 3-6 这四节的关系：

- **第 3 节（指令式-声明式光谱）**：01fish 那篇里的"agent 不是新员工，文档才是新员工"——文档处于光谱的什么位置，决定了 agent 能不能稳定执行。光谱左端（指令式）是 SOP；光谱右端（声明式）是企业文化。Klarna 的失败就是把客服文档放在了过于声明式的位置，agent 接不住。
- **第 4 节（Towards Agent Harness, and Beyond）**：01fish 的"agent 是文档的运行时环境"和我们讲的"harness 是 agent 时代的操作系统"是同一件事的两个表述。**文档 = 程序，agent = 进程，harness = OS**。
- **第 5 节（Shell Endures, Excel Revisited）**：01fish 描述的"CLAUDE.md + skill 文件 + status.md + context.md = 一家运转的公司"——这就是当代的工作簿。把 .xlsx 替换成 workspace，把 VBA 替换成 skills，**Excel 时代的所有权和可移植性原则在这里被保留**。
- **第 6 节（不断革命论）**：01fish 列的三波"X 即文档"，每波之间间隔在缩短（IaC 用了 15 年；vibe coding 不到 1 年成为词典词；agent 8 年要翻 22 倍）。这跟我们讲的"14 个版本 16 天"的 KC 迭代节奏是同一种现象——**前一波的产物变成后一波的基础设施，迭代速度指数加速**。

我们做 KC 的人在 2026 年 4 月这个时间点上，**恰好站在 01fish 描述的第三波"企业即文档"的最前沿**。我们做的不是"另一个 LLM 应用"，是这一波产业革命的工具链。

---

### 3.0 这一节的哲学背景：指挥/谱曲/演奏

讲这个光谱之前先把一年前那个角色比喻摆出来：

> **指挥（Conductor）**：推理、拆解任务、流程编排——SOTA 推理模型
> **谱曲（Composer）**：撰写具体的提示词或代码——SOTA 编码模型
> **演奏（Performer）**：运行提示词和代码——最小可用模型
>
> 蒸馏的目标是用高成本、高能力的工具完成一次性的知识建模，然后产出一个用低成本模型就能重复运行的工具。**快察的竞争力是把田园牧歌稳定转化成联合收割机。**
>
> （摘自 2026-04-10 产品哲学文档，原始概念形成于 2025 年初的 KC v0.1 期间）

下面这一节讲的"指令式-声明式光谱"，本质上是在问一个具体问题：**指挥和谱曲做完之后，演奏家手里拿到的是什么？**——是一份完整的乐谱（最指令式）、还是一组主题动机让演奏家自己即兴（最声明式）、还是介于两者之间？

### 3.1 一个被忽视的事实：「构建一个核查系统」本身就是一段代码

我们做了这么多年文档验证，做出来的东西可以放到一个光谱上：

```
完全指令式 ─────────────────────────────────── 完全声明式
正则 / Python      Workflow            Skill      Meta-skill / SOP        裸 LLM 直问
                  (代码 + prompt)    (业务逻辑+脚本)
   演奏家 ←——————————————————————————————→ 指挥家
```

最左边是**完全指令式**：每一步怎么走、什么字段、什么阈值，都用代码写死。零成本，零灵活。这是只剩演奏家的乐谱。

最右边是**完全声明式**：把法规和样本一股脑甩给一个大模型，让它自己看着办。最灵活，但贵、慢、不可控。这是连指挥都不要、让一个全能音乐家自己看着办。

中间这块光谱不是一个二选一，是一个**滑动条**。我们这个项目（kc_cli/kc_reborn）干的事情，就是**让 Agent 自己决定每一段任务该滑到哪里**——指挥决定哪几段交给谱曲家、哪几段交给最便宜的演奏家。

### 3.2 每一代模型的甜点区不一样

这是 v0.3.x 那个时间点开始我才真正想清楚的事情。我们配了四层 worker LLM（TIER1 ~ TIER4），其实每一层在光谱上的甜点区都不一样：

| 模型层级 | 典型代表 | 在光谱上的甜点区 | 适合干什么 |
|---------|---------|-----------------|-----------|
| TIER4（小） | Qwen-3-8B、轻量小模型 | 偏指令式 | 短 prompt + 结构化输出 + 单一任务（"提取这个金额"） |
| TIER3（中） | DeepSeek-v3-flash、Qwen-3-30B | 中偏指令式 | 中等 prompt + 一次决策 + 已知 schema |
| TIER2（中-高） | GLM-4.7、Doubao-pro | 中偏声明式 | 多字段提取 + 简单合规判断 + 一定的语境推理 |
| TIER1（高） | GLM-5.1、Qwen3.6-plus | 偏声明式 | 多步推理、跨段比对、JSON 修复、bundle classification |
| Conductor（SOTA） | Opus 4.6、GLM-5.1 1M、DeepSeek-v4-pro | 完全声明式 | 读法规、设计 skill、做 evolution loop、与 user 协商 |

这个表的关键不是"模型越大越好"，而是：**指令式那一端永远比声明式便宜，但需要更多的人或 Agent 提前把工作做完。**

「把工作做完」具体指三件事：把任务拆小、把 schema 定好、把上下文窄到模型能容纳。这三件事 KC 在 BUILD 阶段全做了——它就是这个光谱上**让小模型能干活**的那个工程师。

### 3.3 Skill 这个文件夹结构本身是个声明式封装

回到 skill 文件夹：

```
rule-001-capital-adequacy/
  SKILL.md           # 声明式：what to check, where to look, how to judge
  scripts/check.py   # 指令式：正则 / 阈值比较 / 数值归一化
  references/        # 原始法规文本（事实，不是指令）
  assets/            # 样本和边界案例
```

注意它的内部分层：

- `SKILL.md` 是**给 SOTA agent 看的方法论**，不是 prompt template。它告诉 agent："这条规则在查什么、在文档哪里、怎么判定通过/失败"——但不规定 agent 必须按什么顺序、用什么工具。
- `scripts/check.py` 是**给小模型/代码看的指令**。日期解析、阈值比较、中文数字转换——确定的事情就用代码写死。
- `references/` 是**事实**，不是命令。法规原文不应该混在 prompt 里。
- `assets/corner_cases.json` 是**结构化的特例**，独立管理，不污染主逻辑。

**为什么这么分？**因为同一个 skill 在不同场景下要被光谱上不同位置的执行者消费：

- BUILD 阶段，**conductor SOTA 模型**直接读 SKILL.md 来执行验证（声明式消费）
- DISTILLATION 阶段，conductor 读 SKILL.md 之后**蒸馏成 workflow**——把声明式的方法论转成更指令式的 Python + 小模型 prompt 组合
- PRODUCTION 阶段，**worker 小模型**只看蒸馏后的 prompt，配合代码执行（指令式消费）

skill-authoring/SKILL.md 里有一段话写得很重——**一条规则一个 skill 目录是默认形态**，只有同一证据 + 一同成败两个条件都满足时才能合并。这是个工程纪律，不是模型决定。

### 3.4 反模式：unified runner

讲一下 E2E #4（资管新规测试 004）跑出来的一个标志性失败。这次测试 110 条规则，agent 跑了 22 小时被我们 OOM 之前 kill 掉。事后看 disk：

- 110 个独立 `check_r###.py` 存在 ✅
- 但同时 agent 写了一个 `unified_qc.py`，把全部 110 条规则塞进同一个 Python 文件，**绕过了它自己不信任的那 110 个独立技能**
- 6,930 条生产检查里，**16.6% 是 ERROR**（import 错误、字段缺失、schema 违反）
- production_qc 阶段相位计数器卡在 0，因为 agent 走的是 unified 路径，引擎没办法记账

为什么会出现这种事？因为光谱上的每一格都有它自己的诱惑：

- 写 110 个独立 skill 慢、要分别测、要分别 debug
- 写一个 unified runner 看上去能用一个 Python 文件、一个 LLM call 把所有规则一起跑完，**短期看效率最高**
- 但下游的整个机制（skill_testing 的 evolution loop、distillation 的 baseline 对比、production_qc 的分层抽样、finalization 的 coverage report）**全部依赖"一条规则 = 一个独立可验证产物"这个前提**

unified runner 是个**局部最优解，全局是错的**。我们在 v0.6.2 的 skill-authoring/SKILL.md 里专门加了一段 "反模式：unified runner" 把这件事写死。

这是模型在光谱上**自由滑动**的代价——它会为了局部效率把整个声明式架构推平。**得有人/有机制在合适的位置打个桩。**

### 3.5 桩怎么打：三层硬约束

按"约束力从弱到强"排：

**最弱的一层：方法论文本**。template/skills/ 里的 23 个 meta / meta-meta skill 文件全是这种。"反模式：unified runner" 写在 SKILL.md 里就是这一层。SOTA 模型读到了**通常**会遵守，但只是 prompt-level 软约束。

**中间一层：阶段门控（phase-gated tools）**。这是 v0.2.x 就引入的。BUILD 阶段，`worker_llm_call` / `workflow_run` / `tier_downgrade` / `qc_sample` 这四个 distill 工具**根本不注册**——LLM 在系统 prompt 里看不到它们。这是个**物理隔离**，比写"BUILD 阶段不要调用 worker_llm_call"在 system prompt 里强一万倍。

实际效果：v0.1.2 早期版本里 KC 会在 EXTRACTION 阶段偷偷调用 `worker_llm_call`，把规则抽取这种知识性工作甩给小模型——因为这样它"看上去更有效率"。我们靠 phase gating 在工具层把这个口子彻底堵住。

**最强的一层：引擎计数器（engine-emitted milestones）**。v0.6.1 的核心架构升级。"hard tracking, soft executing"。

> Tracking 必须由引擎在工具调用真实发生时记账（`tasksCompleted`、`workflowsTested`、`batchesProcessed`），phase 推进必须验证这些计数器。
> Executing 是 agent 的判断——它选哪条规则先做、怎么分组、用什么顺序，全部留给它自由发挥。

E2E #4 失败的本质是：**tracking 太软**，phase 推进只看 LLM 自己的叙述（"我已经写完 110 个 skill 了"），而不看引擎的真实计数（`skillsTested: []`、`batchesProcessed: 0`）。结果是跑了 22 小时之后我们才发现：**summary 说全部 6 阶段完成，磁盘上只有 39/220 个 task 真的做了**。

v0.6.1 的修复是把每个 phase 的 `exitCriteriaMet()` 都接到引擎计数器上。任何阶段推进都要 `tasksCompleted + tasksFailed === total`，任何 production_qc 完成都要 `batchesProcessed > 0`。phase summary 还会被引擎自动追加一行硬计数：

```
[SKILL_AUTHORING → SKILL_TESTING]: <agent's narrative>
  (engine) rulesCovered: 110/110, skillDirsAuthored: 20, tasksCompleted: 110/110
```

如果 agent 的叙述跟引擎计数对不上，前面会被自动加上 `⚠️ POSSIBLE MISMATCH:`——不阻塞，但留痕。

### 3.6 一句总结

每一代模型在光谱上的甜点区不一样，**但光谱上的每一格都需要适配的工程纪律来约束**。Skill 文件夹结构、phase gating、engine milestones 是我们摸索出来的三层约束。**约束本身就是这个项目的产品。**

回到指挥/谱曲/演奏的比喻：**KC 真正在做的事，不是把演奏交给小模型，而是让指挥学会判断"哪一段乐谱该写到什么程度的指令式才不出事"**。一个不写谱直接让演奏家即兴的指挥，跟一个把每个音符都画十六分音符的指挥，都不是好指挥。三层约束教 KC 怎么判断分寸。

---

## 4. 自动化构建文档核查系统是怎么实现的：Towards Agent Harness, and Beyond

### 4.0 这一节的哲学背景：Harness 是新的操作系统

> 软件工程的核心交付物正在发生代际迁移：
>
> ```
> 1960s: 机器码 → 汇编       （抽象了硬件）
> 1970s: 汇编 → C/结构化编程  （抽象了指令集）
> 1990s: C → Java/OOP        （抽象了内存管理）
> 2010s: OOP → 云原生/容器    （抽象了基础设施）
> 2020s: 代码 → Prompt/Skills （抽象了算法）
> 2026:  Skills → Harness     （抽象了工程过程本身）
> ```
>
> Harness 之于 agent，正如操作系统之于应用程序。Anthropic Managed Agents 已经在用操作系统的概念定义他们的架构（Session=文件系统、Harness=进程调度器、Sandbox=容器）。这不是巧合。操作系统的价值从来不是运行某个具体程序，而是提供一个让任何程序都能运行的环境。
>
> （摘自 2026-04-14 产品哲学补记）

下面这一节，**就是把 KC 当作"一个早期的、不成熟的、但确实在按 OS 抽象方向演进的系统"来讲**。Towards Agent Harness 是讲 KC 怎么把这个 OS 的雏形搭起来；And Beyond 是讲——OS 搭好之后，真正的产品价值在 OS 之外。

### 4.1 把"自动化"还原回基础动作

「KC 自动构建一个文档核查系统」听起来很大。拆开看其实是一个非常朴素的循环：

```
读法规 → 提取规则 → 写 skill → 跑 sample 测 → 改 skill → 蒸馏成 workflow → 抽样质控 → 打包交付
```

让 LLM 自动跑这个循环，工程上需要四样东西：

1. **一个能反复调 LLM 并把工具调用塞回去的循环**——这就是 harness
2. **一组工具**——sandbox_exec、workspace_file、document_parse、worker_llm_call 等等
3. **一组方法论**——meta skills，告诉 LLM 在每一步该怎么思考
4. **一些机制让循环跑得稳**——重试、上下文裁剪、会话恢复、阶段推进、并发控制

Anthropic 把这套东西叫做 Agent Harness。我们 KC 的 harness 是一段大约 1500 行的 Node.js（`src/agent/engine.js`），但它的概念骨架完全可以套到 Anthropic 在 [Managed Agents Engineering](https://www.anthropic.com/engineering/managed-agents) 里描述的那三个抽象上。

### 4.2 Anthropic Managed Agents 的三个抽象

这里我先复述上次讲过的内容，因为这是这一节的概念基础：

| 组件 | OS 类比 | 职责 |
|------|---------|------|
| **Session** | 文件系统 / 事务日志 | "An append-only log of everything that happened." |
| **Harness** | 进程调度器 | "The loop that calls Claude and routes Claude's tool calls to the relevant infrastructure." |
| **Sandbox** | 容器 / 虚拟机 | "An execution environment where Claude can run code and edit files." |

关键设计哲学是 **"Brain vs Hands 解耦"**：
- Harness 无状态，崩溃后通过 `wake(sessionId)` 从 Session 恢复
- Sandbox 可替换，"cattle not pets"——崩溃后 Harness 直接启动新容器
- 接口稳定（`execute(name, input) → string`），背后实现自由
- 上下文工程跟 Session 分离——Session 只管完整存储，Harness 决定每次喂多少给 LLM

性能收益：p50 TTFT -60%、p95 TTFT -90%。

### 4.3 KC 的 harness 怎么映射

从 v0.1.2 长不稳定的早期版本，到 v0.6.2 这个相对成熟的版本，KC 的 harness 实际上**就是在反复重写自己来贴近这套抽象**。每个版本的进步都能套进这个框架：

| Managed Agents | KC v0.1.2（最早） | KC v0.6.2（现在） |
|-----------|--------------|--------------|
| Session = 完整事件日志 | 只有 ConversationHistory（messages.json）线性增长 | EventLog（JSONL，按序号 + 类型选择性读取）+ SessionState（phase / milestones）+ heap.jsonl（每 60s 采样）|
| Harness 无状态 | 进程退出 = 状态丢失 | `AgentEngine.resume(sessionId)`：恢复 phase / milestones / pipeline state；workspace 是 git 仓库，写操作自动 commit |
| Sandbox 可替换 | 直接 `child_process.spawn` | 仍然本地，但 `BaseTool.execute(input) → ToolResult` 接口已经稳定，未来切到云容器只需替换 SandboxExecTool 后端 |
| Brain 与 Hands 解耦 | Tool 直接拿 API key、直接拼 fetch 调用 | LLMClient 抽出 `_buildHeaders` / `_getEndpoint` / `_buildStreamBody` 三个协议适配点；Anthropic SSE 归一化（`_parseAnthropicSSE`）跟 OpenAI chunk 格式合并；调用方完全无感 |
| 上下文工程独立 | 没有，messages 无限增长 | TokenCounter（CJK 感知估算）→ ContextWindow（70% 阈值自动裁剪 + post-tool-result 安全网）→ /compact（LLM 摘要 + 机械降级）三层独立组件 |
| 多 Brain 多 Hands | 单进程 | `agent_tool` 派生子 agent；`--parallelism=N` 最多 8 个并发 worker；`KC_PARALLELISM_VERIFIED=1` gate 防止意外烧钱 |

把每一行的左→右画成一条迁移路径，整个 KC 的 14 个版本就是按这条路径走的。**架构演进有方向，不是随机修 bug。**

### 4.4 Beyond Harness：让自动化真的能交付

这是这一节的关键转折——**只有 harness 不够。**

从 v0.4.0 到 v0.6.2，越来越多的力气花在 harness *之上*。原因很简单：harness 跑得再稳，agent 也只是个能反复调 LLM 的循环。**真正决定能不能交付的是 harness 之外的那些东西。**

我把这些东西分四类：

#### 4.4.1 让循环跑得稳：基础设施层

- **指数退避重试**（`withRetry`）：10 次重试，408/429/500/502/503/504/520/522/524 可重试，400/401/403/404/422 立即抛
- **上下文裁剪三段式**：TokenCounter → ContextWindow → /compact
- **Per-message content cap**（v0.5.2）：单条消息超 60K token 截断，head + tail 保留 + 指针指向 events.jsonl
- **Chunked compact**（v0.5.2）：旧历史按 30K token 切块独立摘要，单块过大降级机械摘要——再大的会话也能 compact
- **Empty response guard**（v0.6.0 A3）：连续两个空响应直接停 turn，不无限循环
- **Stream termination tagging**（v0.6.0 A8）：HTTP error / SSE overflow / aborted / connect_error 区分写入事件日志
- **session-state.json sync file lock**（v0.6.2 J3）：并发 ralph-loop worker + 主进程的 saveState 不会互踩
- **heap.jsonl 永久采样 + components 字段**（v0.6.0 B0、v0.6.2 K1）：每 60s 一行 RSS / heap / external / 组件分解（history / eventLog / toolResults / subagents / bundleCache），`scripts/heap-analyze.js` 给 FLAT / DRIFTING / GROWING 判定

#### 4.4.2 让 agent 决定不出格：边界层

- **Phase gating**（v0.2.x 起）：BUILD 阶段不注册 distill 工具，物理隔离
- **PHASE_ORDER + 邻接检查**（v0.5.3 + v0.6.2 J2）：默认拒绝非邻接、非线性 phase 转换；force=true 才允许跳；rollback 时自动重置 `_lastReady` 防止 auto-advance bounce-back
- **VALID_TASK_ID 路径白名单**（v0.5.3 P0）：sub-agent task_id 走 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` 正则——堵住 "../../tmp/pwn" 这一类 LLM-controlled path 攻击
- **stale_subagents acknowledgement**（v0.6.2 J1）：`phase_advance` 工具检测到还有 subagent 在跑就拒绝；agent 必须显式 `acknowledge_stale_subagents: true` 或者 `force: true`
- **sandbox_exec audit**（v0.6.0 H6）：检测到命令在写共享协调路径（catalog.json、tasks.json、manifest.json）时自动加 ⚠️ 警告
- **engine milestone gates**（v0.6.1 A1-A6）：上一节说过，引擎计数器是 phase 推进的 ground truth

#### 4.4.3 让 agent 干的活能被人看见：可视化层

- **TUI 实时显示**（Ink 6 + React 19）：StreamingText（流式文本）、ToolBlock（工具调用块，4 行预览 + 折叠）、CookingSpinner（"Thinking..." / "Running {tool}..." / "Analyzing results..."）、StatusBar（CTX% / phase / session / parallelism）
- **Slash 命令**：/status / /tasks / /tools / /phase / /parallelism / /schedule / /compact / /resume / /rename / /sessions / /clear / /exit
- **Welcome banner**（v0.5.x）：开机第一屏列出版本、script path、worker tier 快照、pending input 文件数
- **PDF Review Dashboard**（v0.3.0）：单 HTML 文件，左 PDF 预览（pdf.js + base64 内嵌）右验证结果表格，点击行 → PDF 跳页 + 高亮——开发者用户对照原文做 ground truth review
- **Final dashboard**（v0.6.0 E1）：FINALIZATION phase 自动生成的最终报告快照
- **/tools 列表**（v0.6.0 F5）：列出所有注册工具 + 各自的 phase gating，让用户清楚看到当前可用什么

#### 4.4.4 让 agent 干的活能离开 KC：交付层

这是最重要的一类。**Agent harness 跑完之后留下来的东西必须能脱离 harness 独立运行。**

- **`release` 工具**（v0.5.1 Block 8）：把当前 workspace 打包成 `output/releases/<slug>/`——独立 Python runner、confidence scorer Python 移植版（精确数值对齐）、workflows pinned copy、HTML dashboard generator、`serve.sh` 一行 http server。**完全没有 kc-beta 运行依赖**。任何有 Python 3 + worker LLM API key 的人都能 `python run.py <doc>` 拿到验证结果。
- **`schedule_fetch` 工具**（v0.5.0 Block 9）：KC 定义 cron job 并写 wrapper script；用户自己 `crontab -e` 安装。Cron 直接调用 wrapper——**ingestion 不依赖 kc-beta 进程**。
- **git-backed workspace**（v0.4.0 Block 11）：每次 skill / workflow / rules / glossary / AGENT.md / tasks.json 写入都自动 commit；trace ID 进 commit message。`sandbox_exec git log/diff/checkout` 这套就够了，不需要任何 KC 内置 version manager。
- **Native chunker + RAG**（v0.6.0 Group C）：`document_chunk`（onion-peeler header-based splitting）+ `bundle_search`（CJK bigram + English word keyword index）+ `document_classify`（balanced-brace JSON 修复 + keyword fallback）。**没有 embedding model 依赖，没有 Python 依赖**。从 AMC verification app 移植过来。

我把这一类叫做"**让产物自己活着**"。Harness 是工厂，但工厂出来的车得能开出工厂。

### 4.5 绳子和棍子是同一只手

讲到这里我要把 04-14 文档里那段"绳子和棍子"摆出来，因为它正好对应了 4.4 那四类工作里的第二类（边界层）：

> 人类只有两种工具，绳子和棍子。绳子把好东西留在身边，棍子让坏东西远离自己。但实际上他们是一个东西——手。绳子是张开的手掌，棍子是握紧的拳头。

KC 里的对应：

| 角色 | KC 中的实现 |
|------|-----|
| **绳子（留住好东西）** | Skills 注入 context、CornerCaseRegistry、EventLog（跨会话经验留存）、git workspace（每个版本留痕）、SessionState（phase / milestones 持久化恢复）|
| **棍子（推开坏东西）** | Phase-gated tool registration（不该用的工具物理不可见）、Systemic threshold（失败率 ≥10% 强制重写不允许打补丁）、Retry 的 non-retryable 分类（401/403 立即失败）、Context windowing（过时信息被压缩）、VALID_TASK_ID 路径白名单 |

**它们都是同一个接口** —— `BaseTool.execute(input) → ToolResult`。注册什么是 enablement，不注册什么是 guardrail。这个观察的工程意涵很明确：**约束和赋能应该在同一个系统中、用同一套机制管理。**

KC 的 phase transition 就是个范本——`_registerToolsForPhase()` 同时改变了"能做什么"和"不能做什么"。我们没有为 phase gating 单独搞一个 PolicyEngine，没有什么"约束规则的子系统"——它就是 ToolRegistry 本身的另一个状态。

### 4.6 一句总结

Harness 是底座，是 agent 时代的"操作系统"——但**让 agent 真正能交付一个文档核查系统**这件事的工程量远超 harness 本身——基础设施、边界、可视化、交付，每一层都得做。Towards Agent Harness 是上半场，And Beyond 是下半场，下半场的活更多。

而 OS 的工程哲学（接口稳定、绳子棍子同一只手、组件可替换、cattle not pets）正在成为我们做这件事的指导方针。**KC 在工程上越来越像写 OS，不像写 app**。

---

## 5. 快查 CLI：The Shell Endures, Excel Revisited

这一节换个角度。前两节讲的是产品、是工程；这一节讲的是**为什么这个产品要长成 CLI**。

### 5.0 这一节的哲学背景：知识属于人民 + LLM 时代再造 Excel

> 德鲁克是对的，毛主席更是对的：知识不该成为垄断的生产资料，它应该被还给人民用于生产。一本会计准则，不应该需要先花三年考 CPA 才能运用。
>
> 我们要造的是一个**在 LLM 时代再造 Excel 的东西**——一个可以将任何领域的专业知识转化为可重复使用的工具的系统。Excel 可以是一个课程表、一个财务报表系统或一个数据库。我们要的是同样形态的载体，但里面装的智能升级了。
>
> （摘自 2026-04-10 产品哲学第一、第二章）

这一节讲 CLI 不是工程口味问题。是这个：**用户必须能拥有自己的工作簿**。CLI + 文件系统 workspace 是当代能做到这件事的最优形态。下面分两部分讲——为什么 shell 不死、为什么 workspace 是当代的 .xlsx。

### 5.1 The Shell Endures：终端为什么还活着

每隔几年总有人宣告 CLI 已死。GUI、Web、移动端、低代码、no-code、对话式 UI——但开发者工具领域，shell 依然是黏性最高的形态。Claude Code 自己就是一个证据，VSCode、Cursor、Copilot 都没替代掉 `claude` 这条命令。

我自己做 KC 之前在 GUI / Web / Electron 几个方向上都试过。这次彻底回到 CLI，理由很具体：

**1. 可组合性**。`kc-beta` 是个 npm 全局命令，输入 / 输出 stdin / stdout。可以管道、可以重定向、可以塞进 cron、可以塞进 git pre-commit hook。GUI 程序做不到这种"作为零件"的能力。

**2. 可编程性靠文件**。所有配置都是文件：

- 项目级 `.env`（覆盖全局）
- 全局 `~/.kc_agent/config.json`（`kc-beta onboard` / `kc-beta config` 编辑）
- workspace `AGENT.md`（per-project system prompt，agent 自己也可以读写）
- workspace `rules/`、`samples/`、`Output/`、`tasks.json`、`session-state.json`、`logs/`
- meta skills `template/skills/{en,zh}/meta-meta/...`

每个文件单独都能用 `cat` / `vim` / `grep` 处理。要 export？拷贝目录。要 share？打 zip。要 version control？workspace 本身就是个 git 仓库（v0.4.0 起）。

**3. 流式输出 + 可追溯**。LLM 的 token 是流式吐出来的；GUI 必须做特殊渲染才能展示，CLI 天然支持。同时所有事件都写 `logs/events.jsonl`，所有写操作都自动 commit。**任何时刻 freeze 这个 workspace，过一周回来还能继续 `/resume`**。

**4. 一个 npm install 就完事**。不需要 Electron、不需要 ChromiumEmbedded、不需要 Python 虚拟环境（KC 自己是 Node，用户层只用 npm）。`kc-beta` 单进程、< 5 个生产依赖（ink、ink-text-input、ink-spinner、react、pdfjs-dist）、< 50MB。

这四点合起来，**CLI 不只是一种 UI，它是一种交付形态**。把 agent 做成 CLI，等于把 agent 嵌进了用户已经熟悉的整个 Unix / Mac / Linux 工具生态里。Shell endures because composability endures.

### 5.2 Excel Revisited：每个时代都有自己的"用户能拥有的计算工具"

为什么提 Excel？因为 Excel 是历史上少数几个让普通人**真正拥有**计算工具的产品。

```
1980s-2000s     Excel/VBA      数据 + 公式 + 图表 + 宏       会计、分析师、PM
2010s-2020s     Jupyter        数据 + 代码 + 图 + 注释        数据科学家、研究员
2025+           Agent + Skills + Rules + Workspace             领域专家 + agent
```

每一代都有同一个内核：**用户拥有自己的"工作簿"，能看见全部状态，能离线工作，能交给别人。**

KC 的 workspace 就是这个时代的"工作簿"：

| Excel 概念 | KC workspace 对应 |
|-----------|------------------|
| 工作簿（.xlsx 文件） | `~/.kc_agent/workspaces/<sessionId>/` 目录 |
| 单元格 / 公式 | `rule_skills/<rule>/SKILL.md` + `scripts/check.py` |
| 数据 sheet | `Rules/`、`Samples/`、`Input/`、`Output/` |
| 函数库（VBA / Python add-in） | `template/skills/` 里 23 个 meta / meta-meta skill |
| 撤销 / 重做 | git history（v0.4.0 起每次写自动 commit） |
| 数据透视表 / 图表 | `dashboard_render` + `pdf-review-dashboard` |
| 另存为独立文件分发 | `release` 工具打的 `output/releases/<slug>/` 包 |

**Excel 时代和现在的关键差别**：Excel 的"智能"主要是公式（确定的、声明式），偶尔加一点 VBA 宏。现在的"智能"是声明式的方法论 + LLM 的生成 + 可执行代码。**载体没变，载体里装的智能升级了**。

这个比喻有几个工程意涵：

**A. 必须保住"用户拥有"。** 用户能拷贝整个 workspace 出去，没有云端依赖，没有账号绑定，没有"非订阅状态下打不开的工作簿"。这就是为什么 KC 是本地 CLI 不是 SaaS——本地 CLI 是当代的 .xlsx，SaaS 是当代的 Google Sheets。两种都有市场，但**只有前者保住了所有权**。

**B. 必须保住"全部状态可见"。** Excel 的全部状态都在那一张表里。KC 做了同样的事：

- `rules/catalog.json` — 全部规则的索引
- `rule_skills/<rule>/` — 每条规则的逻辑、脚本、参考、样本
- `tasks.json` — ralph-loop 任务清单
- `session-state.json` — 当前 phase / milestones
- `logs/events.jsonl` — 完整事件流
- `logs/heap.jsonl` — 内存采样曲线
- `logs/evolution/<rule>/iteration_<N>.json` — 每轮进化迭代的结构化日志

**任何 KC 没显式公开的状态都是 bug**。这是个工程纪律。

**C. 必须保住"离线 + 离开 KC 也能用"。** Excel 文件给 100 年后的人也能看（只要有 reader）。KC 走的是同样的路：`release` 工具打出来的包用 stock Python 3 就能跑，未来即使 KC 项目挂了，老的 release 包仍然能用。

### 5.3 KC TUI 的设计来源：抄 Claude Code

具体到 TUI 层面，我们的设计原则是**直接抄 Claude Code 的实现**——这个反复在团队 feedback 里出现，已经写成 `feedback_kc_tui_follow_claude_code.md`：

- **Clear-on-compact**（v0.5.4）：`/compact` 之后清屏，只留一行 summary。Claude Code 的行为，避免 pre-compact scrollback 占内存。
- **Truncate tool output**（v0.5.4）：每个 ToolBlock 一行 header（工具名 + 行数 + 字节数）+ 4 行预览 + `…N 行已省略`。完整内容在 `logs/events.jsonl`。错误永远完整渲染（短而关键）。
- **Virtualize messages**（v0.5.4）：只把最后 50 条消息塞进 Ink 渲染树。早期消息 React state 里还在（给 /compact 用），但不在每帧 diff——避免 1000 条消息每次 keystroke 都重渲染导致 typing lag + 4GB OOM。
- **Memoized ToolBlock**（v0.6.0 B0.5）：`React.memo` 包裹 ToolBlock，避免 setMessages / setStreamingText 每次都重渲全部 50 个 tool block。
- **Type-ahead during streaming**（v0.6.0 F2）：流式响应期间输入框依然 active，提交进队列，显示 `(N queued)`。
- **Arrow keys + history recall**（v0.6.0 F3）：左右光标移动 + 上下历史回溯 + Ctrl-A/Ctrl-E 跳行首/行尾——zsh / bash 用户的肌肉记忆。
- **Soft-threshold 提示**（v0.5.4）：CTX 60% 显示 `💾 建议 /compact` 灰提示——不弹窗，不打断，只在用户已经看的状态栏里加一行。

为什么直接抄？因为 Anthropic 在 Claude Code 上花的 TUI UX 工程量我们再花一遍是浪费。**不要发明已经有正确答案的轮子，把工程预算花在我们独有的领域问题上**——文档核查、phase 编排、skill 蒸馏、ralph-loop 并发。

### 5.4 一句总结

CLI 是当代**用户能真正拥有的 agent 形态**。KC workspace 是当代的 .xlsx：用户拥有、全部状态可见、离线可用、可独立交付。TUI 抄 Claude Code，工程预算留给领域问题。

回到"知识属于人民"——**这不是口号**。Workspace 拷得走、release 包能脱离 KC 跑、git history 全留痕、配置全在文本文件里——**所有权完整保留在用户手里**。这一点比任何具体功能都重要。SaaS 是订阅，CLI 是所有权。我们卖的是后者。

---

## 6. 好东西都是总结出来的：Agent Builder 的不断革命论

最后这一节是关于**怎么做 KC 这种产品本身**，是一个元层级的话题。听众可以拿这个去理解他们自己手上的 pdf2skills、A2O、AMC verification app 的演进路径。

### 6.0 这一节的哲学背景：三次折叠 + 文因 + Bootstrap myself

这一节我把 04-14 那篇"六个月后再回来看的预言"整段引出来——它就是这一节的脊梁：

**三次折叠**：
- **第一次折叠**（SAM，2024）：把"每条规则手写工作流"折叠成"自动生成工作流"。
- **第二次折叠**（KC，2026）：把"一个人类架构师设计验证系统"折叠成"一个 agent 自动设计验证系统"。
- **第三次折叠**（？）：把"一个人类 PM 设计 harness 的 pipeline 和 tool 集"折叠成"一个 meta-agent 自动设计 harness"。

**文因传递的不是结果，是方法论**。基因传递的不是某个具体的蛋白质，而是**制造蛋白质的方法**。DNA 不编码结果，编码过程。同理，文因传递的不应该是某条具体的合规规则，而是**处理这类知识的方法论**——这正是 meta skills（业务方法论）和 meta-meta skills（系统方法论）的区分。

**Bootstrap myself**。每隔一段时间，给未来的自己留一份"现在认为是对的"的文档——一年半之后回来看哪些还对、哪些已经被实践证伪。这不是写日记，是给后人留下可证伪的命题，让自己有迭代的依据。

**蒸馏的终局是编译**。早期编译器（一次性翻译）→ JIT 编译器（运行时翻译，根据数据优化热点）→ Profile-guided optimization（用实际运行数据反馈生成更好的下一版）。KC 当前的蒸馏是早期编译器；未来的蒸馏会变成 JIT 编译器；再往后就是 PGO——**workflow 在生产环境中持续自我优化的活体**。

带着这四组概念，看下面这一节。

### 6.1 14 个版本，4 次 E2E，每个版本只解决前一个版本暴露的问题

下面这张表是 v0.1.2 到 v0.6.2 的节奏——你可以看到每一次重要演进都直接对应**一次 field test 暴露的问题**：

| 版本 | 时间 | 触发 | 主要变化 |
|-----|-----|------|---------|
| v0.1.2 | 2026-04-08 | 初始 beta | SiliconFlow 单供应商，14 工具，6 阶段 |
| v0.2.0 | 2026-04-10 | GDPR + 用户协议 AB 测试，两版本都在 1 小时后失败 | 多供应商、Anthropic SSE 归一化、ContextWindow 三段式裁剪、EventLog 持久化、SessionState 跨会话恢复、retry exp.backoff |
| v0.2.1 | 2026-04-10 | onboard 配置体验混乱 | Provider Registry 与 kc_reborn 对齐，curated model lists，config 编辑器 bug fix |
| v0.3.0 | 2026-04-16 | 团队多场景使用，需要 plugin 能力 | dual-directory（项目 dir + workspace dir），AGENT.md 每项目 system prompt，PDF Review Dashboard，document-chunking + entity-extraction skill |
| v0.3.1 | 2026-04-17 | publish 准备，audit 发现 v0.3.0 的 compact() 重复定义 bug | engine.compact() 修复，runTaskLoop pass options 修正，document-parse VLM fallback 修正，npm metadata |
| v0.3.2 | 2026-04-17 | Block 10 partial | 项目术语表（glossary）补充进 rule-extraction、rule-graph、entity-extraction skill |
| v0.4.0 | 2026-04-17 | 文件系统设计需求 | git-backed workspace（自动 commit）、tool-call offloading（>2K token 落盘）、copy_to_workspace / snapshot / archive_file 三个新工具 |
| v0.5.0 | 2026-04-17 | 生产环境需要"无 KC 跑"的 ingestion | schedule_fetch 工具，per-job wrapper script，cron 直接调用，独立于 kc-beta 进程 |
| v0.5.1 | 2026-04-17 | 用户需要把 workflow 交给非 KC 用户 | release 工具，独立 Python runner + confidence Python 移植，"无 kc-beta 运行依赖" |
| v0.5.2 | 2026-04-17 | 真实数据 manual testing 暴露 4 个 bug | compact / windowing 在 ~300K context 失败修复、phase 状态栏 stuck 修复、/rename 实际不 rename 修复、sub-agent shared-state 架构故障重写 |
| v0.5.3 | 2026-04-17 | ultra-review v0.5.2 发现 P0 path traversal | agent_tool VALID_TASK_ID 沙箱、_enforceTokenBudget Anthropic-400 + summary preservation、_capContent CJK doubling、phase_advance 邻接 guard、_maybeAutoAdvance edge-trigger |
| v0.5.4 | 2026-04-18 | 12 小时租赁合同 E2E #1 | phase 卡 bootstrap、catalog.json 对象 shape、TUI OOM、compact 太晚、rule_catalog field shape——五个 P0 |
| v0.5.5 | 2026-04-20 | 真正第一次 field-test v0.4.0+ | 4 个长会话 race / API 形状 bug、xfyun coding plan provider |
| v0.5.6 | 2026-04-22 | volcanocloud 新 coding plan 上线，主力供应商切换 | volcanocloud `glm-5.1` coding plan 接入，dual-key 模式 |
| v0.6.0 | 2026-04-23 | v5 design 大整合 | 7 阶段（加 FINALIZATION）、parallel ralph-loop（最多 8 并发）、native chunker + RAG（从 AMC 移植）、source-context auto-attach、workspace file locking、agent_tool wait/poll/list/kill、UX polish 一大堆 |
| v0.6.1 | 2026-04-26 | E2E #4（22 小时，OOM 前 kill） | hard tracking soft executing 原则；engine-emitted milestones；phase-gate parity checks；engine-appended phase summaries with mismatch detection |
| v0.6.2 | 2026-04-26 | v0.6.1 deferred 的 nice-to-haves | workflow output normalization（解 Python repr）、skill validator（ast.parse smoke test）、stale_subagents ack、phase rollback formalization、session-state lock、heap component instrumentation、DeepSeek + Xiaomi MiMo provider |

**我刻意把这张表列得这么细，是因为表里藏着一个最关键的工程纪律**：每个版本都先有一个**触发事件**，不是先有"想加什么 feature"。

### 6.2 触发事件的形态

回顾 14 个版本，触发事件主要是这几种，按重要程度从高到低：

**A. E2E 端到端测试**。E2E #1（租赁合同 12 小时）→ v0.5.4。E2E #2 是 corpus prep，没单独触发版本。E2E #3（17 小时 GDPR + 协议）→ v0.6.0 部分内容。E2E #4（资管新规 22 小时 OOM 前 kill）→ v0.6.1。

每次 E2E 都生成一份 `archive/e2e_test_<date>_observations.md`，**那份 observations 文档是下一个版本的设计输入**。

**B. ultra-review 静态审计**。v0.5.2 发布后过 ultra-review 发现 v0.5.3 的 P0 path traversal。v0.6.0 发布后内部 audit 发现 v0.6.1 的 phase gate 软问题。这种 review 发现的多是边界条件 / 安全 / race condition，跟 E2E 互补。

**C. 用户/团队实际使用反馈**。v0.5.5 的 4 个 race bug 全是用户长会话用出来的；v0.5.6 是因为 VolcanoCloud 上线 coding plan，主力供应商切换；v0.6.2 K2 是因为用户拿到 DeepSeek v4 + Xiaomi MiMo 的 token 想接进来。

**D. 上游研究 / 设计**。Anthropic Managed Agents 公测（2026-04-08）→ `docs/managed-agents-analysis.md` → v0.2.0 的 EventLog + SessionState 设计。LangChain 的 Anatomy of an Agent Harness 文章 → v0.4.0 的 tool-call offloading。

**这四种形态合起来，定义了"什么时候做新版本"**。**没有这四种之一的输入，不要写新代码**——上一版本永远还有可优化的地方，但优化是无限的，**field test 暴露的问题才是有限的**。

### 6.3 总结这件事本身就是产品的一部分

这次讲稿和上次（04-11）讲稿之间隔了 16 天、14 个版本。两份讲稿放在一起对比，会发现一个有意思的事——**很多上次没意识到的东西，在这次能讲得更清楚**。

| 上次的认知 | 这次的认知 |
|-----------|-----------|
| Skills 是中间产物，最终目标是 workflow | KC + Skills 本身就是一个生产模式，不蒸馏也能用 |
| 阶段门控防止 agent 调错工具 | 阶段门控 + engine milestone gate + skill validator 三层硬约束的最里一层 |
| Prescription vs Freedom 平衡，让 SOTA 自由发挥 | Hard tracking soft executing — tracking 必须硬，executing 必须软 |
| Append-only event log 是审计基础 | Append-only event log + heap.jsonl + components 分解 + workflow output normalization 是**全栈 observability**，不只是审计 |
| 接口稳定，实现可替换 | 接口稳定，实现可替换，**但还得在合适位置打桩防止接口被 agent 自己绕过**（unified_qc.py 是个反例） |

这种迭代不是因为我们上次写得不好，**是因为只有真的跑了，才能看见**。

我们项目内部把这件事固化成了几个机制：

**1. DEV_LOG.md**。每个版本一段，写"为什么改"在前，"改了什么"在后。1764 行，从 v0.1.2 写到 v0.6.2，是这个项目最有价值的文档。**任何想理解 KC 的新人，第一份要读的就是这个**。

**2. `archive/e2e_test_<date>_observations.md`**。每次 E2E 之后写。**bug inventory 不是为了记录"系统坏了"，而是为了让下一版有据可查**。E2E #4 的 22 小时跑下来产生的 observations 直接驱动了 v0.6.1 的 5 组 phase gate。

**3. 用户级 memory**。我自己跟 Claude 协作时积累的 feedback memory：
- `feedback_kc_tui_follow_claude_code.md` — TUI 抄 Claude Code
- `feedback_two_mode_verification_app.md` — Agent mode = KC-lite agent loop + meta skills + tools
- `feedback_hard_tracking_soft_executing.md` — KC 的 tracking 层必须 engine-verified
- `feedback_flagship_models.md` — 用户说"flagship"指 .env 里的 TIER1 不是猜
- `feedback_prescription_vs_freedom.md` — SOTA 模型用方法论而不是 step-by-step

这五条 memory 就是这个项目最浓缩的方法论沉淀。**它们全部是从一次次"原来这样做不对"的反思里写出来的**。

**4. Skill text 的版本化更新**。Meta skill 不是写完就放着不管。每次 E2E 之后，相关 skill 的 SKILL.md 都会更新——granularity calibration（v0.6.0 H5）、unified runner anti-pattern（v0.6.2 I3）、cross-regulation dedup contract、sub-agent delegation guidance……**Skill 是个活文档，跟着实战走**。

### 6.4 「不断革命论」是什么意思

借这个词不是要搞政治学，是要表达一个具体的工程立场：

**Agent Builder 这个东西，没有"终态"。**

任何"我们已经差不多了，可以稳定下来"的判断，过两次 E2E 就会被打脸。真正稳定的不是当前的实现，而是**保持迭代节奏的那个机制**：触发事件 → observations → design doc → group-by-group commit → DEV_LOG → 下一次 trigger。

具体到这个项目，下一次革命可能是：

- **E2E #5**（v0.6.2 之后）：会暴露什么我们现在还看不到的东西？
- **更长 context 的模型**（DeepSeek v4 1M、Xiaomi MiMo 1M）：当 conductor 上下文涨到 1M 之后，原来 200K 的 ContextWindow 设计够不够？
- **Managed Agents 真实接入**：当 Anthropic MA 从公测转 GA 之后，KC 的 SandboxExecTool 后端要不要切？切了之后凭证隔离、cost、延迟会怎么变？
- **Verification app**（Agent mode + Workflow mode）：当用户拿 release 包去自己环境跑，发现需求是"再让 agent 跑一段"而不是"workflow 死跑"——KC-lite 的 agent loop 怎么从 KC 抽出去？
- **Multi-tenant**：当一台机器要服务多个领域的核查（银行 + 保险 + 律所），workspace 隔离够不够？
- **第三次折叠**：当 KC 的 6 阶段 pipeline 和 13 个 tool 不再是手写的，而是由一个更高层的 agent 根据场景自动生成——meta-meta skills 是不是其实已经在干这件事了，只是还差最后一公里？
- **JIT 蒸馏**（蒸馏=编译这个隐喻成立的话）：能不能让 PRODUCTION_QC 的反馈循环自动触发局部 re-distill？

这些问题没一个我现在有答案的。**但有这个迭代机制在**，每次有触发事件、跑一次、写一份 observations、发一个版本——这个项目就还在往前走。

### 6.5 给 04-14 那份"暴论"打几个工程注脚

04-14 那份"六个月后再回来看的预言"里有一段被我反复想——文末"冷静 Claude 的批注"那一节，列出了几个**值得六个月后验证的具体命题**。借这次分享我把这几个命题对应到 KC 现在的工程状态，给后续 6 个月的复盘留个起点：

| 04-14 命题 | KC 现状（截至 v0.6.2） | 6 个月后怎么验证 |
|-----------|------------------------|------------------|
| 1. KC 是否能在 3 个以上不同业务场景中走通全部 7 个阶段？ | E2E #1（租赁合同）、#3（GDPR + 协议）、#4（资管新规）走通了部分阶段，#4 在 production_qc 失败 | 至少新跑通 2 个全新领域（医疗、保险、税务、招投标任选）+ 让 E2E #5 走完 FINALIZATION |
| 2. Harness 基础设施是否真的实现了复用？ | 接口稳定但没有外部用户在 KC harness 上构建非文档验证 agent | 拿 KC 的 7 个 harness 组件（LLMClient / ToolRegistry / EventLog / ContextWindow / SessionState / Retry / Workspace）单独抽出去，给 pdf2skills 或 AMC 的某个子任务用 |
| 3. Skills 作为独立交付物的占比是多少？ | 部分场景已经只交付 skills 不蒸馏，但没系统统计 | 建立一个 release 类型字段（skills-only / workflows-only / both），在 6 个月窗口内统计分布 |
| 4. Evolution loop 的平均收敛轮次是多少？ | E2E #4 观察到 23 轮，但是因为 unified runner 偏题 | 用 E2E #5 + 之后的几次跑，统计每条规则的 SKILL_TESTING 收敛轮次分布；如果中位数 > 8 轮，说明方法论有问题 |

这是把"暴论"工程化的方式——**不是验证哲学对不对，是把哲学拆成可证伪命题，然后等数据回来打脸**。打脸了就改 skill text 和 DEV_LOG，没打脸就把这条哲学正式收进 README。

### 6.6 蒸馏的终局是编译——这个比喻能往前推到哪

04-14 那份文档里把蒸馏类比成编译，提了三阶段：早期编译器 → JIT → PGO。我借这个比喻继续推一下，看 KC 的蒸馏路径未来 12-18 个月能怎么演化：

| 阶段 | 编译器对应 | KC 当前状态 | 触发条件 |
|-----|-----------|-------------|---------|
| 1. 一次性蒸馏 | Ahead-of-time 编译 | ✅ DISTILLATION 阶段已实现：tier_downgrade 一次性找最便宜可用 tier | 当前默认 |
| 2. 运行时反馈 | JIT 编译 | 🟡 PRODUCTION_QC 收集了置信度数据，但没有自动触发 re-distill | 需要 confidence 长期下降 trigger |
| 3. Profile-guided 自动迭代 | PGO | ❌ 不存在——需要把 production 数据自动 feed 回 evolution loop | E2E #6/#7 数据足够之后才有意义 |

阶段 2 是个**直接可做的工程项**——`PRODUCTION_QC` 已经在记录每条规则的置信度分布，只差一个判定逻辑（"连续 N 个批次某条规则的低置信度比例 > X%"）+ 一个自动 re-distill 的 trigger。这件事我估计 v0.7.x 的窗口内可以做。

阶段 3 更远，但思想已经有了——它就是 `evolution-loop` skill 现在做的"诊断-分类-修复-记录"四步在 production 自动跑一遍。区别只是触发者从 BUILD 阶段的 KC 变成 production 阶段的 confidence scorer。

如果蒸馏=编译这个类比成立，那么 KC 的"竞争对手"不是其他 agent 工具，**是 LLVM**。这个对标听上去夸张，但它给我们一个非常清晰的工程参照：所有 LLVM 解决过的问题（IR 设计、pass 编排、profile 数据格式、debug info 保留）都会在 agent 时代以某种形态重新出现。**先借鉴一遍能少走很多弯路。**

### 6.7 给团队的一个具体建议

各位手上的 pdf2skills、A2O、AMC verification app 都在做类似形态的事情。如果要从 KC 这 16 天的迭代节奏里抄一样东西，我建议抄这个：

**给每个项目都建一份 DEV_LOG.md，每个版本一段，每段开头写"为什么"。**

不是 release notes（"加了 X feature、修了 Y bug"），是**为什么这一版要存在**（"E2E 跑出 Z 问题，所以这一版的目标是消除 Z"）。

写起来 30 分钟，回头看价值百倍。这就是"好东西都是总结出来的"——**总结这件事本身就是产品的一部分**。

更进一步，借用 04-14 文档里的"Bootstrap myself"那个动作：每隔 3 个月，写一份"现在我认为是对的"的产品哲学补记。**不要怕暴论，暴论是用来 6 个月后被打脸或被验证的——两种结果都是有价值的资产**。

---

## 收尾（~3 分钟）

把这次讲的四个一级标题再串一遍，每个都跟开场列的九个哲学锚点对应一下：

**3. 指令式-声明式光谱**（指挥/谱曲/演奏 + JIT 工具选择）：我们做的产品不是 LLM 应用，是**让 agent 在这条光谱上自己滑动并产出可交付物**。每代模型的甜点区不一样，约束机制要分三层（方法论文本 / phase gate / engine milestone），缺一层就出 unified_qc.py 这种事。

**4. Towards Agent Harness, and Beyond**（Harness 是新的 OS + 绳子和棍子是同一只手）：harness 是底座、是 agent 时代的操作系统，但**让自动化真的能交付**这件事的工程量主要在 harness 之外——基础设施、边界、可视化、交付。绳子和棍子是 ToolRegistry 的两面，同一只手。

**5. The Shell Endures, Excel Revisited**（知识属于人民 + LLM 时代再造 Excel）：CLI 是当代**用户能真正拥有的 agent 形态**。Workspace 是当代的 .xlsx。TUI 抄 Claude Code，工程预算留给领域问题。**SaaS 是订阅，CLI 是所有权**。

**6. Agent Builder 的不断革命论**（三次折叠 + 文因载体 + Bootstrap myself + 蒸馏=编译）：14 个版本、4 次 E2E、每个版本只解决前一版本暴露的问题。**总结这件事本身就是产品**。给每个项目都建 DEV_LOG，每段开头写"为什么"。每 3 个月写一次产品哲学补记。

---

最后说一句**真的**最后的话——

04-10 那篇产品哲学文档结尾是这样写的：

> 我们要把被锁在书本、文档和专家脑袋里的知识，用工程化的手段解放出来，变成任何人都能使用的工具。**这不是 AI 的事，这是生产力的事。**

我把 KC 这两周半发生的所有事——14 个版本、3 次 E2E、5 个 P0 bug、`unified_qc.py` 那个反模式教训、`hard tracking soft executing` 那条原则——都放在这句话下面来理解。

**KC 不是一个 AI agent，是一个让"专业知识 → 可执行工具"这条转化通道工程化、可重复、可交付的系统**。AI 只是手段。生产力才是目的。

我们走的路径是：SAM（2024）→ JIT（2025.02）→ Stem cell（2025.03）→ Praxify（2025.12）→ pdf2skills（2026.01）→ KC Agent（2026.04）。

两年走了一圈回到原点，但比起点高了一层。**下一圈估计还会回到现在这个点，但应该会再高一层**。

这就是不断革命论的实义。

Q&A.

---

## 附录 A：关键文件指引（讲完之后可以自己翻）

| 主题 | 文件 |
|------|-----|
| **产品哲学（必读）** | `feishu-doc-base/2026-04-10_产品哲学：从SAM到pdf2skills的主线叙事.md`、`2026-04-14_产品哲学：六个月后再回来看的预言.md`、`feishu-doc-base/企业即文档.pdf`（01fish, 2026-02-17）|
| 项目根 | `kc_cli/README.md`, `kc_cli/QUICKSTART.md` |
| 完整 changelog | `kc_cli/DEV_LOG.md`（1764 行，按版本倒序）|
| 设计文档 | `docs/initial_spec_draft.md`, `docs/global_update_design_v2/v3.md`, `docs/update_design_v5/v6.md`, `docs/file_system_design.md`, `docs/managed-agents-analysis.md` |
| Meta-meta skills（系统架构层） | `template/skills/zh/meta-meta/{rule-extraction, skill-authoring, skill-to-workflow, evolution-loop, task-decomposition, rule-graph, version-control, dashboard-reporting, quality-control, bootstrap-workspace, auto-model-selection, pdf-review-dashboard, skill-creator}` |
| Meta skills（业务方法论层） | `template/skills/zh/meta/{document-parsing, document-chunking, entity-extraction, tree-processing, compliance-judgment, confidence-system, corner-case-management, cross-document-verification, data-sensibility}` |
| Harness 实现 | `src/agent/engine.js`, `src/agent/llm-client.js`, `src/agent/context-window.js`, `src/agent/event-log.js`, `src/agent/session-state.js`, `src/agent/retry.js` |
| Tool 实现 | `src/agent/tools/*.js`（13 个 BUILD 工具 + 4 个 DISTILL 工具） |
| Pipeline 实现 | `src/agent/pipelines/{initializer, extraction, skill-authoring, skill-testing, distillation, production-qc, finalization}.js` |
| TUI | `src/cli/index.js`, `src/cli/components.js`, `src/cli/onboard.js`, `src/cli/config.js` |
| E2E 观察文档 | `archive/e2e_test_<date>_observations.md` |
| 上次讲稿 | `docs/team_demo_script_0411.md`, `docs/team_demo_report_0411.md` |

## 附录 B：演示流程建议（如果有时间 demo）

1. `kc-beta onboard` 走一遍，演示 provider 切换、coding plan key 区分
2. `cd archive/test_data_3 && kc-beta` 启动一个真实 workspace
3. 让 agent 跑 BOOTSTRAP → EXTRACTION 一两轮，让大家看 ToolBlock 折叠、CookingSpinner、StatusBar、CTX% 变化
4. `/tools` 显示当前 phase 的工具集 + gating 状态
5. `/phase advance` 强制推进到 SKILL_AUTHORING，让大家看 phase summary 的 `(engine) ...` 硬计数行
6. `/compact` 演示 LLM summary + clear-on-compact
7. 退出，`/resume` 恢复——演示 SessionState
8. 看 `logs/events.jsonl`、`logs/heap.jsonl`、`session-state.json`——演示 observability
9. `git log --oneline` 看 workspace 自动 commit 链
10. 如果时间够：跑一个 `release` 工具产物，演示离开 KC 还能 `python run.py`
