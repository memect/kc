# Claude Code 技能格式规范

提炼自 Anthropic 官方的 skill-creator。本文档是编写格式正确的技能目录的权威参考。

## 技能目录结构

```
skill-name/
├── SKILL.md          (必需)  元数据 + 指令
├── scripts/          (可选)  可执行代码
├── references/       (可选)  详细文档，按需加载
└── assets/           (可选)  模板、数据文件、图片
```

目录名必须与 SKILL.md frontmatter 中的 `name` 字段完全一致。

## SKILL.md 格式

### Frontmatter (YAML)

```yaml
---
name: skill-identifier
description: What this skill does and when to use it.
---
```

**必填字段：**

| 字段 | 约束 |
|-------|-------------|
| `name` | 最多 64 字符。只能含小写字母、数字、连字符。开头/结尾不可有连字符，不可出现连续连字符。必须与父目录名一致。 |
| `description` | 最多 1024 字符。非空。同时描述技能"做什么"以及"何时使用"。 |

**可选字段：** `license`、`compatibility`、`metadata`

### Description 写作要点

description 是技能的主要触发机制——Claude 依靠它决定是否调用这个技能。写得"主动"一些，以对抗触发不足：

- 同时包含能力描述与触发场景。
- 使用用户实际可能会说出的关键词。
- 列举具体的使用场景。
- 说明**不适用**的场景。
- 篇幅控制在 100-200 字之间。

### Markdown 正文

紧接 frontmatter，用 Markdown 写指令。遵循以下原则：

- **少于 500 行。** 接近上限时，把细节挪到 references/。
- **祈使句式。** 写"抽取该值"，不写"该值应被抽取"。
- **解释 why**，不仅解释 what。
- **配示例**，当示例能澄清预期行为时。一两个精挑细选的好示例胜过十个平庸的。

## 渐进式披露

技能采用三级加载：

1. **元数据**（name + description）：始终在上下文中。约 100 tokens。
2. **SKILL.md 正文**：技能触发时加载。最好少于 500 行。
3. **打包的资源文件**：按需加载。不限大小。脚本可直接执行而无需加载。

在 SKILL.md 中清晰引用参考文件，并说明何时阅读它们。对较大的参考文件（> 300 行），加上目录。

## 文件引用

使用相对于技能根目录的路径：
```markdown
See [the reference guide](references/regulation.md) for the full regulation text.
Run the check script: `python scripts/check.py`
```

## 命名规范

- 目录名：小写并用连字符分隔（`my-skill`，而非 `MySkill` 或 `my_skill`）
- 名称保持简短而具描述性
- 对应规则的技能，按规则 ID 加前缀：`rule-001-capital-adequacy`
