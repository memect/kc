# Block 11 — File System Design

**Status:** approved. Phase 0 complete. Phase 1a ready to start.
**Author/date:** kitchen-engineer42 / 2026-04-17
**Related:** v3 design plan Block 11; LangChain *Anatomy of an Agent Harness* (file-system section); pre-existing TODOs from Blocks 1, 3, 11.

---

## 1. Goals

The file system is "the most foundational harness primitive" (LangChain). For KC it serves three roles:

1. **Context management.** Large tool outputs (parsed PDFs, search hits, workflow runs) should live on disk, not in conversation history. Context stays cheap; KC fetches detail on demand.
2. **Durable state.** Skills, workflows, rule catalogs, results — every artifact survives across sessions, can be diffed against earlier versions, and can be rolled back.
3. **Collaboration.** Sub-agents, future external tools (Block 9 cron, Block 8 release runner, Block 12 Feishu plugin), and humans operate against the same workspace through stable file conventions.

Concrete needs that drive this refactor:

- **Block 8 (release):** snapshots — freeze a workspace state for a deployable bundle.
- **Block 9 (cron):** lifecycle — incoming docs accumulate without a strategy.
- **Block 11 TODOs:** real version history, selective project→workspace copy, large-file handling.
- **LangChain pattern:** tool-call offloading.

---

## 2. Locked Decisions

These five decisions were made in conversation and are the foundation of the rest of this doc:

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Versioning: git, per-session repo** | Battle-tested, free, agent already knows git CLI for diff/rollback/branch. Replaces the metadata-only `versions.json` manifest with real content history. |
| 2 | **Tool-call offloading: include now** | Highest-leverage LangChain pattern. Conversation history holds head + tail; full output lives at `logs/tool_results/<id>.txt`. |
| 3 | **Large files: reference-by-path default + `copy_to_workspace` tool** | Default behavior unchanged (project files read in place). New tool for the targeted cases where KC needs a working copy with provenance. No dedup overhead. |
| 4 | **Lifecycle: directory convention** | `input/processed/`, `input/archived/`, etc. KC moves files between directories. No metadata system, no state machine. |
| 5 | **Migration: additive** | New features only kick in for new sessions. Old workspaces keep working. Beta tool, lowest risk. |

---

## 3. Post-Refactor Directory Layout

```
~/.kc_agent/workspaces/<sessionId>/
├── .git/                         # NEW — per-session git repo, auto-commits
├── .gitignore                    # NEW — exclude logs/, sub_agents/, large refs
├── AGENT.md                      # unchanged — per-project memory
│
├── rules/                        # tracked by git
│   ├── catalog.json
│   ├── glossary.json             # from v0.3.2
│   └── <regulation_files>
│
├── rule_skills/                  # tracked by git
│   └── R001/
│       ├── SKILL.md
│       └── scripts/
│
├── workflows/                    # tracked by git
│   └── R001/
│       ├── workflow_v1.py
│       └── prompts/
│
├── refs/                         # NEW — staging area for selective copies from project dir
│   └── <copied-files>            # tracked by git iff small (<10MB); manifested in refs/manifest.json
│
├── snapshots/                    # NEW — release/checkpoint snapshots (git tags + bundle metadata)
│   └── <label>/snapshot.json
│
├── input/                        # incoming docs from project / cron — NOT tracked by git
│   ├── <doc.pdf>                 # active (just landed)
│   ├── processed/                # NEW — KC moves here after a workflow consumes it
│   │   └── <doc.pdf>
│   └── archived/                 # NEW — older processed docs, kept for audit
│       └── <doc.pdf>
│
├── output/                       # workflow + agent results — NOT tracked by git
│   ├── results/
│   │   ├── <rule>_<doc>.json     # active result
│   │   └── archived/             # NEW — older results
│   ├── dashboards/               # rendered HTML
│   └── releases/                 # NEW — release bundles for Block 8
│       └── v1/
│           ├── manifest.json
│           ├── workflows/
│           └── README.md
│
├── samples/                      # unchanged
│
├── sub_agents/                   # unchanged — NOT tracked by git
│   └── <taskId>/
│
├── logs/                         # unchanged + NEW subdir — NOT tracked by git
│   ├── events.jsonl
│   ├── conversation/
│   └── tool_results/             # NEW — full tool outputs offloaded from context
│       └── <traceId>.txt
│
├── tasks.json                    # ralph-loop — tracked by git
├── session-state.json            # NOT tracked by git (changes constantly)
└── versions.json                 # DEPRECATED — kept for back-compat read; no new writes (git replaces it)
```

### What's tracked vs. ignored by git

- **Tracked:** `AGENT.md`, `rules/`, `rule_skills/`, `workflows/`, `refs/` (small only), `snapshots/`, `tasks.json`. These are the durable artifacts whose history matters.
- **Ignored:** `logs/`, `sub_agents/`, `input/`, `output/`, `samples/`, `session-state.json`. These are high-volume runtime data, not source-of-truth artifacts.

Rationale: `git status` should be informative for the agent. If it shows 200 files of session noise, the agent can't see the meaningful changes.

---

## 4. Git Integration

### Initialization

When a new session is created (`Workspace` constructor), if `.git/` doesn't exist:

1. `git init` (default branch: `main`)
2. Write `.gitignore` (template included in `template/`)
3. Initial empty commit: `"Session <sessionId> initialized"`
4. Configure local `user.name` and `user.email` to `"kc-agent"` and `"agent@kc.local"` (so commits don't depend on the user's global git config)

### Auto-commit on workspace writes

`WorkspaceFileTool._write()` (after writing the file content):

1. If file is in a tracked directory: `git add <path> && git commit -m "<auto-generated message>"`
2. Auto-message format: `"[<phase>] <op> <path> [trace:<id>]"` — e.g. `"[skill_authoring] update rule_skills/R001/SKILL.md [trace:20260417_1142_R001_v3]"`
3. If commit fails (nothing to commit, hooks fail), log it but don't fail the tool call.
4. Trace ID still generated by `VersionManager.generateTraceId()` for cross-referencing with the event log.

### What `VersionManager` becomes

- The **manifest writer** is removed. `versions.json` becomes deprecated (only read for back-compat with old workspaces).
- The **trace ID generator** stays. `generateTraceId(ruleId, label)` still produces strings used for cross-referencing tool results, snapshots, etc.
- The **`shouldVersion(path)`** method stays — it's now used to decide which writes trigger an auto-commit.

### Agent access

The agent uses the existing `sandbox_exec` tool with `cwd: "workspace"` to run git commands directly:

```
sandbox_exec({command: "git log --oneline -10", cwd: "workspace"})
sandbox_exec({command: "git diff HEAD~3 -- rule_skills/R001/SKILL.md", cwd: "workspace"})
sandbox_exec({command: "git checkout HEAD~5 -- rule_skills/R001/", cwd: "workspace"})
```

No new git-specific tool. `AGENT_IDENTITY` gets a short note that the workspace is a git repo and the agent can use git CLI for history operations.

### Branching

Not auto-created. If the agent wants to experiment, it can `git checkout -b experiment-X` on its own. Documented in skill text but not forced.

---

## 5. Tool-call Offloading

### Current flow

```
runTurn()
  → tool execute → ToolResult{content: "<all of it>"}
  → eventLog.append("tool_result", {output: content.slice(0,5000)})  ← clipped, lossy
  → history.addRaw({role:"tool", content})                          ← FULL into context
```

Problem: `document_parse` on a 50-page PDF returns ~50KB of text. That entire 50KB ends up in conversation history, gets resent on every subsequent turn, and inflates context dramatically. Meanwhile the event log only retains 5KB so the audit trail is incomplete.

### New flow

```
runTurn()
  → tool execute → ToolResult{content}
  → if estimateTokens(content) > THRESHOLD (e.g. 2000 tokens):
       traceId = versionMgr.generateTraceId("tool", toolName)
       fs.writeFileSync(`logs/tool_results/${traceId}.txt`, content)
       digest = head(content, 800 chars) + "\n[…truncated, full at: logs/tool_results/" + traceId + ".txt — read with workspace_file…]\n" + tail(content, 800 chars)
       history.addRaw({role:"tool", content: digest, _trace: traceId})
       eventLog.append("tool_result", {output: content, isError, traceId})  ← log full
     else:
       history.addRaw({role:"tool", content})    ← unchanged path for small outputs
       eventLog.append("tool_result", {output: content, isError})
```

Key points:

- **Threshold configurable** in `config.js` (`TOOL_OUTPUT_OFFLOAD_TOKENS`, default 2000). Below threshold = no change, above = offload.
- **Head + tail (not just head)** because tool outputs often have important info at the start (status line, format header) AND end (final result, error trailer).
- **Pointer is the file path**, fetched via the existing `workspace_file` tool (`scope: "workspace", path: "logs/tool_results/<id>.txt"`). No new tool needed.
- **Event log gets the full content** — this is the one place we keep everything, so audit and replay still work.
- **Errors always offload** above a smaller threshold (e.g. 500 tokens), so a noisy traceback doesn't drown context but is still recoverable.

### Skill update needed

`AGENT_IDENTITY` (in `context.js`) gains a one-paragraph note:

> Tool outputs above ~2000 tokens are offloaded — you'll see a digest with `[…truncated, full at: logs/tool_results/<id>.txt …]`. Read the file with `workspace_file({operation:"read", path:"logs/tool_results/<id>.txt"})` only if you need the full content. Don't re-read by default — context budget matters.

---

## 6. New Tools

### `copy_to_workspace`

```yaml
name: copy_to_workspace
description: Copy a specific file from the user's project directory into the workspace (refs/) for KC to work on as a local copy. Use when you need a working copy with provenance — e.g., when modifying a sample, or when a workflow needs the file to be inside the workspace. Default behavior remains: read project files in place via scope="project". Only copy when you genuinely need to.
inputSchema:
  source_path: string         # relative path within project dir
  target_name: string?        # optional; defaults to basename of source
  reason: string?             # optional; logged for provenance
```

Behavior:

1. Resolve `source_path` against `workspace.projectDir` (with traversal protection).
2. Check size — if > 10 MB, write to `refs/<target_name>` and add `refs/<target_name>` to `.gitignore` (large files don't go into git history).
3. If ≤ 10 MB, copy to `refs/<target_name>` and let it be git-tracked normally.
4. Append entry to `refs/manifest.json`:
   ```json
   {"target": "refs/sample.pdf", "source": "samples/sample.pdf", "size": 1234567, "copied_at": "...", "reason": "needed local copy for OCR test"}
   ```
5. Return: `"Copied to refs/<target_name>. Provenance recorded."`

### `snapshot`

```yaml
name: snapshot
description: Create a named snapshot of the current workspace state. Used to freeze a moment for a release bundle (Block 8) or before risky operations. The snapshot is a git tag plus a manifest noting which files were tracked at the time.
inputSchema:
  label: string               # human-readable label, e.g., "release-v1", "before-skill-rewrite"
  notes: string?              # optional description
```

Behavior:

1. Slug the label (`release-v1` → `release_v1`).
2. `git add -A && git commit -m "snapshot: <label>"` (no-op if clean).
3. `git tag snap/<slug>`.
4. Write `snapshots/<slug>/snapshot.json`:
   ```json
   {"label": "release-v1", "tag": "snap/release_v1", "commit": "<sha>", "created_at": "...", "notes": "..."}
   ```
5. Return: tag name + commit SHA.

The agent later reproduces the snapshot state with `git checkout snap/release-v1` (or via copying the tagged tree).

### `archive_file` (lifecycle helper)

```yaml
name: archive_file
description: Move a file from its active location to an archived/ subdirectory. Use for input docs after processing, or for old result files when they're no longer the primary view. Purely a directory move — no metadata change, no deletion.
inputSchema:
  path: string                # relative workspace path
  target_subdir: string?      # default "archived" — placed under <parent>/<target_subdir>/
```

Behavior:

1. Resolve `path` (workspace scope only).
2. `mkdir -p <parent>/<target_subdir>` and `mv path <parent>/<target_subdir>/<basename>`.
3. If file was git-tracked: `git mv` instead of plain `mv` so history is preserved.
4. Auto-commit if the move was inside a tracked dir.

Note: KC could do this with `sandbox_exec` and `mv`, but exposing it as a tool makes lifecycle decisions visible in the event log and standardizes the convention.

---

## 7. Tool Changes

### `workspace_file`

- No schema change.
- `_write()` now also triggers auto-commit (via the new helper in `Workspace` or `VersionManager`).
- `_list()` skips files in `.gitignore` patterns by default to keep output focused (a new `show_ignored: bool` param can opt back in).

### `document_parse`, `document_search`, `workflow_run`, `evolution_cycle`

- No tool-side change. They produce content; the engine decides whether to offload.

### `sandbox_exec`

- Unchanged. Already supports `cwd: "workspace"`. The agent can run git via this tool.

---

## 8. Engine Changes

### `engine.js` — tool result handling

Modify the section in `runTurn` that processes tool results (around the `tool_result` event emit):

```js
// After: const result = await this.toolRegistry.execute(...)
const offload = this._maybeOffload(tc.name, result);
const historyContent = offload ? offload.digest : result.content;
const traceId = offload?.traceId || null;

this.eventLog.append("tool_result", {
  name: tc.name,
  output: result.content,           // full, always
  isError: result.isError,
  traceId,
});
yield new AgentEvent({
  type: "tool_result",
  name: tc.name,
  output: historyContent,           // digest if offloaded
  isError: result.isError,
});
this.history.addRaw({
  role: "tool",
  tool_call_id: tc.id,
  content: historyContent,
});
```

Where `_maybeOffload(name, result)` is a new method on `AgentEngine`:

```js
_maybeOffload(toolName, result) {
  const threshold = result.isError
    ? this.config.toolOutputOffloadErrorTokens || 500
    : this.config.toolOutputOffloadTokens || 2000;
  const tokens = estimateTokens(result.content);
  if (tokens <= threshold) return null;

  const traceId = this.versionManager.generateTraceId("tool", toolName);
  const offloadDir = path.join(this.workspace.cwd, "logs", "tool_results");
  fs.mkdirSync(offloadDir, { recursive: true });
  fs.writeFileSync(path.join(offloadDir, `${traceId}.txt`), result.content, "utf-8");

  const HEAD = 800, TAIL = 800;
  const digest =
    result.content.slice(0, HEAD) +
    `\n\n[…truncated, full at: logs/tool_results/${traceId}.txt — ${tokens} tokens…]\n\n` +
    result.content.slice(-TAIL);
  return { traceId, digest };
}
```

### `Workspace` — git init on construction

```js
// In Workspace constructor, after fs.mkdirSync(this.path, ...)
this._initGitRepo();

// New private method
_initGitRepo() {
  const gitDir = path.join(this.path, ".git");
  if (fs.existsSync(gitDir)) return;
  // git init, write .gitignore, initial commit, set local user
  // (uses execSync — git is required)
}
```

The `.gitignore` template lives at `template/workspace.gitignore`:

```
logs/
sub_agents/
input/
output/
samples/
session-state.json
.DS_Store
*.log
```

### `Workspace` — autoCommit helper

```js
autoCommit(relPath, message) {
  // git add <relPath> && git commit -m message; ignore "nothing to commit"
}
```

`WorkspaceFileTool._write()` calls this after every workspace write to a tracked directory.

---

## 9. Migration (additive — what it actually means)

**For existing workspaces** (no `.git/` directory):
- Workspace constructor sees no `.git/`, runs `_initGitRepo()` on first launch with the new code. Initial commit captures whatever's currently there as `"Migrated to git-tracked workspace at <date>"`.
- Old `versions.json` stays in place. `VersionManager` still reads it (for `latestVersion` queries on history that predates git). New writes don't append to it.
- The new `input/processed/`, `input/archived/`, etc. subdirectories are created lazily on first use (when `archive_file` runs).
- `logs/tool_results/` is created lazily on first offload.

**For new workspaces:**
- Everything fresh, full new layout from the start.

**No data loss.** Worst case for a migrated workspace: the pre-migration history is lost (we never had it anyway — `versions.json` was metadata-only). Going forward, full git history accumulates.

**Git missing — graceful fallback.** If `git --version` fails at session start, KC prints a short startup banner ("git not found — version history disabled this session") and continues with `gitAutoCommit` effectively `false`. Workspace still works; only auto-commits are skipped. Tool-call offloading, lifecycle conventions, and `copy_to_workspace` are all unaffected. This keeps KC usable on systems without git rather than blocking launch.

---

## 10. Config Additions

In `config.js` and the onboarding flow:

| Key | Default | Purpose |
|-----|---------|---------|
| `toolOutputOffloadTokens` | 2000 | Threshold for offloading non-error tool output |
| `toolOutputOffloadErrorTokens` | 500 | Lower threshold for errors (always recoverable, less context cost) |
| `gitAutoCommit` | `true` | If `false`, file system works without git (fallback for git-less environments) |
| `largeRefThresholdMB` | 10 | Files copied via `copy_to_workspace` larger than this go to `.gitignore` |

These don't need onboarding prompts — sensible defaults, expose only via `kc-beta config` advanced section.

---

## 11. Phased Implementation (after this design is approved)

| Phase | Scope | Effort |
|-------|-------|--------|
| **1a — Git foundation** | `Workspace._initGitRepo`, `.gitignore` template, `autoCommit` helper, `WorkspaceFileTool._write` integration. Also delete the now-redundant manifest write in `VersionManager`. | 1 day |
| **1b — Tool-call offloading** | `engine._maybeOffload`, `runTurn` integration, config keys, `logs/tool_results/` dir. | 1-2 days |
| **1c — `copy_to_workspace` tool** | New tool, `refs/` dir, manifest, large-file gitignore handling. | 1 day |
| **1d — `snapshot` + `archive_file` tools** | Two small tools. | 1 day |
| **2 — Skill updates** | `AGENT_IDENTITY` paragraph on git + offloading; `version-control`, `quality-control`, `bootstrap-workspace` skills get short additions about new lifecycle conventions and snapshot tool. | 1 day |
| **3 — Migration safety + docs** | Git-installed check at startup, fallback if disabled, `docs/file_system.md` user-facing reference, DEV_LOG entry, version bump to 0.4.0. | 1 day |

**Total estimate:** ~6-8 working days. Comfortably inside the 1-2 week budget the user picked.

---

## 12. Verification Plan

### Phase 1a (git foundation)
- Launch a fresh session → verify `.git/` exists, initial commit present.
- Edit `rule_skills/R001/SKILL.md` via `workspace_file` → verify `git log` shows an auto-commit.
- Edit `logs/events.jsonl` indirectly (a tool runs) → verify NOT committed (gitignored).

### Phase 1b (offloading)
- Run `document_parse` on a 50-page PDF → verify history entry contains digest with pointer; `logs/tool_results/<id>.txt` exists with full content; event log has full output.
- Run a small tool (e.g., `workspace_file list`) → verify NOT offloaded.

### Phase 1c (copy)
- `copy_to_workspace({source_path: "samples/x.pdf"})` → verify `refs/x.pdf` exists, `refs/manifest.json` updated.
- Same with a 50MB file → verify `.gitignore` updated to exclude it.

### Phase 1d (snapshot + archive)
- `snapshot({label: "test"})` → verify git tag `snap/test` and `snapshots/test/snapshot.json` exist.
- `archive_file({path: "input/doc.pdf"})` → verify file moved to `input/archived/doc.pdf`, git history preserved (if tracked).

### End-to-end
- Run a fresh BOOTSTRAP → EXTRACTION cycle → verify auto-commits at each meaningful write; offloading kicks in for `document_parse`; `git log` reads as a coherent project history.
- Resume an old session (pre-migration) → verify init commit fires, no errors, agent can continue working.

---

## 13. Out of Scope

Things that came up but are deliberately deferred:

- **Full content-addressed dedup of large refs.** Reference-by-path covers it; if dedup becomes important later, add it then.
- **GC / quota / TTL for archived files.** Disk is cheap at beta scale. Revisit if storage becomes a problem.
- **Multi-agent locking / file conflict resolution.** Sub-agents share workspace today via append-only conventions; if Block 13 adds true multi-agent coordination, lock files can come then.
- **Cross-session sharing.** Each session has its own git repo. No cross-session branching. If users need to fork a session, they can `cp -r` the session dir manually.
- **Deeper `versions.json` migration.** We keep it readable for backward compat but don't extract its history into git. Old metadata stays as-is; new git history starts at migration.
- **`/git` slash command in TUI.** Agent uses `sandbox_exec` for git. A first-class `/git log` could come later if it's a frequent UX need.

---

## 14. Resolved Decisions (from review)

1. **`samples/` stays gitignored.** Git tracks KC's *outputs* (skills, workflows, rules, glossary), not the user's source documents. Original-file safety is enforced by KC's behavior restrictions and tool-use instructions, not by git as a backup mechanism.
2. **Provenance lives at `refs/manifest.json`** (alongside the copied files), not under `logs/`.
3. **No `unarchive` tool.** If KC needs to move a file back from `archived/`, it uses `sandbox_exec` with `mv`. Lifecycle is deliberately one-directional in the tool surface.
4. **Snapshot behavior:** auto-commit any pending changes before tagging. Keeps the snapshot tool low-friction.
5. **Git missing:** simple startup banner + graceful fallback (no auto-commit), not a hard fail. See Section 9.

Status: **design approved.** Ready to start Phase 1a.
