---
name: version-control
description: Manage versioning of skills, workflows, prompts, and system configuration throughout the lifecycle. Use when skills are modified, workflows are regenerated, prompts are updated, or any artifact needs rollback capability. Covers what to version, how to version with file-system conventions, maintaining a version manifest, and rollback procedures. Also use when comparing performance between versions or when production results need to trace back to the exact workflow version that produced them.
---

# Version Control

Version control here is about auditability and rollback, not collaboration. You need to know what changed, when, why, and be able to undo it if the change made things worse.

## Git Is the Source of Truth

The workspace is a git repository. Every workspace write to a tracked path (skills, workflows, rules, glossary, AGENT.md, tasks.json) is auto-committed by KC with a trace ID in the commit message. This means:

- `git log --oneline` is the timeline of every meaningful change in this session.
- `git diff HEAD~3 -- rule_skills/R001/` shows what changed in a skill across the last three meaningful writes.
- `git checkout HEAD~5 -- workflows/R001/` rolls back a workflow without touching anything else.
- The `snapshot` tool tags moments worth remembering (releases, "before risky operation"); restore with `git checkout snap/<label>`.

Use `sandbox_exec` with `cwd: "workspace"` to run git commands directly. Don't fight git — it's the audit trail.

The conventions below (per-version filename copies, `CHANGELOG.md`) are still useful for *human readability inside a single skill folder* — having `workflow_v1.py` and `workflow_v3.py` side-by-side lets the agent compare them without reading git history. But the system of record is git, not the deprecated `versions.json` manifest (which is no longer written for new workspaces).

## What to Version

Everything that affects verification results:

- **Rule skills**: SKILL.md edits, script changes, reference updates, new corner cases.
- **Workflows**: Python code, LLM prompts, model assignments, configuration.
- **System configuration**: .env threshold changes, model tier updates.
- **Rule catalog**: New rules added, rules modified, rules deprecated.

What NOT to version:
- Logs (they are append-only, versioning is inherent).
- Output results (they already reference the workflow version that produced them).
- Temporary analysis files.

## How to Version

### File-System Based Versioning

Keep it simple. No database, no external tools. File naming + a JSON manifest.

**Workflows**: Each iteration is a separate file.
```
workflows/rule_001/
  workflow_v1.py
  workflow_v2.py    # Fixed extraction regex
  workflow_v3.py    # Downgraded to TIER3
  prompts/
    extract_v1.txt
    extract_v2.txt  # Simplified prompt
  config.json       # Points to active versions
```

**Skills**: Track changes in a changelog within the skill folder.
```
rule-skills/rule-001-capital-adequacy/
  SKILL.md              # Current version
  CHANGELOG.md          # What changed and when
  assets/
    samples.json        # Grows over time (append-only)
    corner_cases.json   # Grows over time (append-only)
```

### Version Manifest

Maintain a `versions.json` at the workspace root that tracks the active version of each artifact:

```json
{
  "last_updated": "2026-04-01T14:30:00Z",
  "rules": {
    "R001": {
      "skill_version": "2026-03-28",
      "workflow_version": "v3",
      "workflow_file": "workflows/rule_001/workflow_v3.py",
      "prompt_version": "v2",
      "model_tier": "TIER3",
      "status": "production"
    }
  }
}
```

This manifest is the single source of truth for what is currently active. Update it whenever you change the active version of anything.

## When to Create a New Version

**Always create a new version before modifying a working artifact.** The rule is simple:

1. The current artifact is working (or at least, it is the best you have).
2. You want to try a change.
3. Copy the current artifact to a new version file.
4. Make the change in the new version.
5. Test the new version.
6. If it is better, update the manifest to point to the new version.
7. If it is worse, the old version is still there unchanged.

Never modify a version file in place. Version files are immutable once created.

## Rollback

When a new version performs worse than the previous one:

1. Update the manifest to point back to the previous version.
2. Log the rollback: what was tried, what went wrong, why the previous version is better.
3. Keep the failed version file for reference — do not delete it. It records what does not work.

## Result Traceability

Every verification result in Output/ should include metadata linking it to the exact versions that produced it:

```json
{
  "rule_id": "R001",
  "workflow_version": "v3",
  "prompt_version": "v2",
  "model_used": "Qwen/Qwen3.5-122B-A10B",
  "timestamp": "2026-04-01T14:30:00Z"
}
```

This enables debugging: if a result is wrong, you can trace it to the exact workflow, prompt, and model that produced it.

## Verification Trace IDs

Beyond version traceability (which version produced a result), embed a permanent trace ID in every verification result that links to the exact source evidence.

### Trace ID Structure

```json
{
  "trace_id": "R001-DOC042-P3-S2-C120:180",
  "source_location": {
    "document": "report_2024_q1.pdf",
    "page": 3,
    "section": "3.2 Capital Adequacy",
    "char_range": [120, 180]
  },
  "rule_version": "v1.2",
  "workflow_version": "v3",
  "model_tier": "TIER3"
}
```

### Key Properties

- **Embedded, not logged**: Trace IDs live IN the verification result data, not in a separate log. They survive export, re-import, aggregation, and downstream consumption.
- **Permanent**: Once assigned, a trace ID never changes. Re-verifying the same document generates a new trace ID — old ones remain in historical results.
- **Self-contained**: The trace ID encodes enough information to locate the source evidence without consulting external indexes.

### Why This Matters

When an auditor asks "why did you determine this loan complies with Article 15?", the trace ID points directly to the exact text passage, the exact rule version, and the exact workflow that made the determination. Without trace IDs, this reconstruction requires correlating logs, results, and source documents manually — which in a regulatory audit is unacceptable.

See `references/trace-id-spec.md` for the full format specification and generation algorithm.

## Integration with Evolution Loop

Every evolution cycle (see `evolution-loop`) should:
1. Create new version files for any changes.
2. Update the manifest.
3. Log the version change with the evolution iteration number.

The version history, combined with the evolution logs, gives you a complete timeline of how the system evolved and why.
