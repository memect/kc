# Claude Code Skill Format Specification

Distilled from the official Anthropic skill-creator. This is the authoritative reference for writing correctly formatted skill folders.

## Skill Folder Structure

```
skill-name/
├── SKILL.md          (required)  Metadata + instructions
├── scripts/          (optional)  Executable code
├── references/       (optional)  Detailed documentation, loaded on demand
└── assets/           (optional)  Templates, data files, images
```

The directory name must match the `name` field in SKILL.md frontmatter exactly.

## SKILL.md Format

### Frontmatter (YAML)

```yaml
---
name: skill-identifier
description: What this skill does and when to use it.
---
```

**Required fields:**

| Field | Constraints |
|-------|-------------|
| `name` | Max 64 chars. Lowercase letters, numbers, hyphens only. No leading/trailing/consecutive hyphens. Must match parent directory name. |
| `description` | Max 1024 chars. Non-empty. Describe what it does AND when to use it. |

**Optional fields:** `license`, `compatibility`, `metadata`

### Description Best Practices

The description is the primary triggering mechanism — Claude uses it to decide when to invoke the skill. Make descriptions "pushy" to combat under-triggering:

- Include both capability AND trigger contexts.
- Use specific keywords the user might mention.
- List concrete use cases.
- State what NOT to use it for.
- Aim for 100-200 words.

### Markdown Body

Following the frontmatter, write instructions in Markdown. Guidelines:

- **Under 500 lines.** If approaching this, move detail to references/.
- **Imperative form.** "Extract the value" not "The value should be extracted."
- **Explain the why** behind instructions, not just the what.
- **Include examples** when they clarify the expected behavior. One or two well-chosen examples beat ten mediocre ones.

## Progressive Disclosure

Skills use three-level loading:

1. **Metadata** (name + description): Always in context. ~100 tokens.
2. **SKILL.md body**: Loaded when skill triggers. <500 lines ideal.
3. **Bundled resources**: Loaded on demand. Unlimited size. Scripts can execute without loading.

Reference files clearly from SKILL.md with guidance on when to read them. For large reference files (>300 lines), include a table of contents.

## File Referencing

Use relative paths from the skill root:
```markdown
See [the reference guide](references/regulation.md) for the full regulation text.
Run the check script: `python scripts/check.py`
```

## Naming Conventions

- Directory names: lowercase with hyphens (`my-skill`, not `MySkill` or `my_skill`)
- Keep names short and descriptive
- For rule skills, prefix with the rule ID: `rule-001-capital-adequacy`
