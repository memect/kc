# **背景**

作为pdf2skills/anything2ontology的产品负责人，我的团队每个人都对这两个项目以及pdf2app的快速应用构建有非常明确的了解。他们也都有自己创作的app模板。

团队成员在日常工作中高强度使用Claude Code和skills，并对skills这一概念有深入了解。

现在，我自己完成了kc_reborn和kc_cli两个项目，对harness以及app往上抽象一层的概念有了一些了解。我需要让我的团队成员和我对齐认知，并以后在这一层上交付现在app模板定位上的东西。

我正在计划一个白板讨论和demo，给大家看下KC项目做了什么并分享一些经验。

# **相关参考**

相关项目和文档（内容非常多，不需要全量读取）。请先看看所有项目的readme，KC直接相关两个项目的dev_log很重要：
- desktop/kc_cli
- desktop/kc_reborn
- desktop/Anything2Ontology
- desktop/pdf2skills-doc-base

另有本项目内直接相关的文档，在kc_cli/docs目录下，可以仔细阅读。

可以去Anthropic和OpenAI的官方网站找一些文档和技术博客，关注harness这一概念。这些信息务必以这两家的官方口径为准，不要夹杂其他不可靠信源的内容。

# **分享讨论大纲**

1. KC Agent CLI工具是什么，能做什么。他的“bootstrap -> 抽取规则 -> 自己执行 -> 总结规则skills -> 蒸馏成workflow -> 持续反思迭代进化”工作流程是怎样的。
2. 从我最初的设想 docs/initial_spec_draft.md 出发，介绍我的产品定位和产品哲学是什么。
3. kc_cli的详细架构图，重点放在设计和技术栈上。
4. 简单介绍agent harness是什么，一般有什么组建，跟kc_cli中的什么组建能够对得上。
5. 在开发kc_cli的过程中我遇到了什么问题，我是怎么解决的。按优先级来排序，不用包含所有的细枝末节，bug解决/前端小改动等可以忽略。
6. 能够抽象并分享给大家的经验，如果我们以后其他类型的app抽象一层都想做一个kc类似的“生产agent系统的agent”，并灵活利用harness的各种组件，应该从我这里学到什么。