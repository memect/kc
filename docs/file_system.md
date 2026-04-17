# KC Workspace File System

This is a user-facing reference for the file system layout introduced in v0.4.0 (Block 11). For the design rationale and locked architectural decisions, see [`file_system_design.md`](./file_system_design.md).

---

## Where Things Live

KC operates on two directories at runtime:

- **Project directory** — wherever you ran `kc-beta`. Read in place via `scope: "project"` on file tools. KC does not write here unless you explicitly ask. Original samples and regulations stay where they are.
- **Workspace** — `~/.kc_agent/workspaces/<sessionId>/`. KC's working directory. Skills, workflows, results, logs, and version history live here.

Each workspace is a per-session **git repository**.

---

## Workspace Layout

```
~/.kc_agent/workspaces/<sessionId>/
├── .git/                  # session-local git repo
├── .gitignore             # ships from the bundled template
├── AGENT.md               # per-project memory (KC can edit)
│
├── rules/                 # tracked
│   ├── catalog.json
│   ├── glossary.json      # project-scoped vocabulary (v0.3.2+)
│   └── <regulations>
│
├── rule_skills/R001/...   # tracked — one folder per rule
├── workflows/R001/...     # tracked — distilled worker-LLM workflows
│
├── refs/                  # tracked (small files only); see "Selective copies"
│   ├── manifest.json      # provenance for each copy
│   └── <copied files>
│
├── snapshots/             # tracked — release/checkpoint manifests
│   └── <label>/snapshot.json
│
├── input/                 # ignored — incoming docs (cron lands here in Block 9)
│   └── archived/          # KC moves processed docs here
├── output/                # ignored — workflow + agent results
│   ├── results/
│   │   └── archived/
│   └── dashboards/
│
├── samples/               # ignored — user reference samples (read in place from project)
├── sub_agents/<taskId>/   # ignored — sub-agent scratch space
├── logs/                  # ignored — append-only audit trail
│   ├── events.jsonl       # the source of truth for session history
│   ├── conversation/
│   └── tool_results/      # full content of large tool outputs (see "Tool offloading")
│
├── tasks.json             # tracked — ralph-loop task list
├── session-state.json     # ignored — phase + pipeline state
└── versions.json          # legacy — only present in workspaces created before v0.4.0
```

### What git tracks

- `AGENT.md`, `rules/`, `rule_skills/`, `workflows/`, `refs/` (small only), `snapshots/`, `tasks.json`, `.gitignore`.
- These are KC's **outputs** — the artifacts whose history matters for audit and rollback.

### What git ignores

- `logs/`, `sub_agents/`, `input/`, `output/`, `samples/`, `session-state.json`, `.env`.
- These are runtime noise or user source material — not KC's outputs.

`git status` in the workspace shows only meaningful work — never 200 lines of session noise.

---

## Auto-commit

Every write to a tracked path goes through `Workspace.autoCommit()` and produces a git commit with a trace ID, e.g.:

```
c200ae9 [skill_authoring] update rule_skills/R001/SKILL.md [trace:20260417_141523_R001_update]
```

The trace ID also appears in the event log entry for the same write, so you can cross-reference.

KC can use git directly via `sandbox_exec`:

```
sandbox_exec({command: "git log --oneline -10", cwd: "workspace"})
sandbox_exec({command: "git diff HEAD~3 -- rule_skills/R001/SKILL.md", cwd: "workspace"})
sandbox_exec({command: "git checkout HEAD~5 -- rule_skills/R001/", cwd: "workspace"})
```

### Git missing → soft fallback

If `git --version` fails at startup, KC prints a one-line warning and continues with `gitAutoCommit` effectively off. All other features (file tools, offloading, copy/snapshot/archive) still work; only version history is disabled.

---

## Tool-call Offloading

Tool outputs above ~2,000 tokens (configurable via `toolOutputOffloadTokens`) are automatically written to `logs/tool_results/<traceId>.txt`. The conversation history holds a head + tail digest with a pointer:

```
…first 800 chars…

[…truncated, 12500 tokens; full at logs/tool_results/<traceId>.txt — read with workspace_file if needed…]

…last 800 chars…
```

Errors offload at a lower threshold (~500 tokens) since they often contain noisy tracebacks.

The event log keeps the **full** content regardless — audits never lose data.

---

## Three workspace tools beyond `workspace_file` and `sandbox_exec`

### `copy_to_workspace`

Pull a specific file from the project directory into `refs/` when KC needs a workspace-local working copy. Default behavior remains: read project files in place via `scope: "project"`.

```
copy_to_workspace({
  source_path: "samples/foo.pdf",
  target_name: "foo.pdf",   # optional
  reason: "needed local copy for OCR test"
})
```

Files larger than `largeRefThresholdMB` (default 10 MB) are written but added to `.gitignore` so they don't bloat git history. Provenance for every copy is recorded in `refs/manifest.json`.

### `snapshot`

Freeze the current workspace state — git tag plus a manifest under `snapshots/<slug>/snapshot.json`. Use before risky operations or for release bundles (Block 8).

```
snapshot({label: "release-v1", notes: "first release candidate"})
```

Auto-commits any pending changes before tagging, so the snapshot is always a valid commit. Restore later with `git checkout snap/release-v1`.

### `archive_file`

Move a file to an `archived/` subdirectory next to it. Use after a workflow consumes an input doc, or when an old result is no longer the primary view.

```
archive_file({path: "input/doc.pdf"})
# → input/archived/doc.pdf
```

If the file is git-tracked, uses `git mv` so history is preserved. Reverse moves (un-archive) are intentionally not exposed — use `sandbox_exec mv` for the rare reverse case.

---

## Migration from pre-v0.4.0 workspaces

Existing workspaces (no `.git/`) are auto-migrated on the next launch:

1. `Workspace` constructor sees no `.git/` and runs `git init`.
2. Initial commit captures everything currently in the dir as `"Migrated session <id> to git-tracked workspace"`.
3. The new directories (`refs/`, `snapshots/`, `input/archived/`, `output/results/archived/`, `logs/tool_results/`) are created lazily on first use.
4. Old `versions.json` stays where it is — nothing reads or writes it any more.

No data loss. Pre-migration history just isn't reconstructable (the old manifest only stored metadata, not content). Going forward, full git history accumulates.

---

## Configuration

Defaults live in `config.js` and can be overridden via `kc-beta config`, the project `.env`, or the global config:

| Key | Default | Purpose |
|-----|---------|---------|
| `gitAutoCommit` | `true` | Disable to skip git init / auto-commit (rare; useful in CI or git-less envs) |
| `toolOutputOffloadTokens` | `2000` | Threshold for offloading non-error tool output |
| `toolOutputOffloadErrorTokens` | `500` | Lower threshold for error output |
| `largeRefThresholdMB` | `10` | Files copied via `copy_to_workspace` larger than this are gitignored |

Env-var equivalents (in workspace `.env`): `GIT_AUTO_COMMIT`, `TOOL_OUTPUT_OFFLOAD_TOKENS`, `TOOL_OUTPUT_OFFLOAD_ERROR_TOKENS`, `LARGE_REF_THRESHOLD_MB`.

---

## What this design does NOT do

Deliberately deferred:
- Content-addressed dedup of large refs (reference-by-path covers it).
- Garbage collection / quota / TTL on archived files.
- Multi-agent file locking.
- Cross-session sharing (each session has its own git repo).
- A first-class `/git` slash command in the TUI (use `sandbox_exec`).

See [`file_system_design.md`](./file_system_design.md) §13 for the full out-of-scope list.
