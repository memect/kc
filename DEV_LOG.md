# KC Agent CLI — Development Log

## v0.5.0 (2026-04-17)

Block 9 — cron / heartbeat document fetching. Adds scheduled ingestion to
the production loop. KC defines fetch jobs and writes wrapper scripts; the
user installs the scripts via `crontab -e`. Cron invokes the scripts
directly — **no `kc-beta` runtime dependency**, ingestion works while
kc-beta is closed.

### What's new

**Per-session schedule registry** (`schedules.json`). Each entry is a
shell-type job with `id`, `command`, optional `description`, and
`cron_hint`. Tracked by git via Block 11's auto-commit.

**Per-job wrapper scripts** at `workspace/scripts/ingest/<id>.sh`.
Self-contained POSIX `/bin/sh` scripts. KC regenerates them whenever a job
is added or enabled. Each wrapper:

- Exports `WORKSPACE`, `INPUT_DIR`, `PROJECT_DIR` env vars.
- Drops a sentinel file (`mktemp`), then runs the user's command.
- Uses `find -newer` against the sentinel to detect newly-arrived files in
  `input/` (portable across BSD `find` on macOS and GNU `find` on Linux).
- Prefixes new arrivals with `<job-id>_<UTC-timestamp>_<original-name>`,
  skipping files already prefixed (idempotent re-runs).
- Appends start + exit lines to `logs/ingest.log`.
- Propagates the user command's exit code so cron's failure email fires.

**`schedule_fetch` tool** — KC manages the registry from inside the agent:

| Operation | What it does |
|-----------|--------------|
| `add` | Register a job. Writes `schedules.json` and renders the wrapper script. |
| `list` | Show registered jobs + tail of `logs/ingest.log`. |
| `remove` | Delete a job. Removes its wrapper. |
| `enable` / `disable` | Toggle without removing. Disable removes the wrapper. |
| `print_crontab` | Generate paste-ready crontab lines for all enabled jobs. |

**`/schedule` slash command** — TUI display of jobs, last log entries, and
pending-input file count.

**Welcome banner** — shows `📥 N file(s) pending in input/` when there's
unprocessed material from cron jobs.

### What changed under the hood

- `src/agent/scheduler.js` (NEW) — registry I/O, wrapper rendering, crontab
  formatting, log tailing, pending-input count.
- `src/agent/tools/schedule-fetch.js` (NEW) — the `schedule_fetch` tool.
- `src/agent/engine.js` — registers `ScheduleFetchTool` (12 → 13 core tools).
- `src/cli/index.js` — `/schedule` slash command, `Scheduler` import,
  pending-input count passed to `WelcomeBanner`.
- `src/cli/components.js` — `WelcomeBanner` accepts `pendingInputCount` and
  renders the cyan note when > 0.
- `template/skills/{en,zh}/meta-meta/bootstrap-workspace/SKILL.md` — new
  "Scheduled Ingestion" section.
- `template/skills/{en,zh}/meta-meta/quality-control/SKILL.md` — short note
  in "Batch Processing" mentioning the `<job-id>_<timestamp>_` filename
  convention and `archive_file` cleanup step.

### Why no `kc-beta ingest` subcommand

The OS scheduler invokes the wrapper script directly. KC is involved only
when the user is interacting (defining jobs, viewing status). The wrapper
is plain shell, runs everywhere `/bin/sh` exists, and survives KC upgrades
or breakages.

### Verification

- Wrapper renders correctly for arbitrary user commands; new files arrive
  with `<job-id>_<UTC-timestamp>_` prefix.
- Idempotent — running twice doesn't double-prefix existing files.
- Failing user command propagates exit code (verified with `exit 7`).
- Disable removes the wrapper script.
- `print_crontab` generates paste-ready lines using absolute paths.
- All 22 en + 22 zh skills still index after skill updates.
- 13 tools registered (was 12).

### What's deferred

- **Auto-trigger KC processing on ingest.** Block 8 (release/run mode) is
  the right place for headless processing of fresh batches.
- **OS-specific helpers** (launchd plists, systemd timers, Windows Task
  Scheduler). Cron is the lingua franca; users on other schedulers know
  how to convert.
- **Built-in source-type plugins** (HTTP fetcher, S3 client, Google Drive,
  etc.). Shell command is universal — compose anything via curl/rclone/
  `lark-cli`/python.

---

## v0.4.0 (2026-04-17)

Block 11 — file system refactor. Adopts git as the per-session versioning
backbone, adds tool-call offloading, and ships three new workspace tools
(`copy_to_workspace`, `snapshot`, `archive_file`). Preceded by a design doc
(`docs/file_system_design.md`) reviewed and approved before implementation.

### What's new

**Git-backed per-session workspace.** Each session's workspace directory is
now a git repository. Every write to a tracked path (skills, workflows,
rules, glossary, AGENT.md, tasks.json) is auto-committed by
`Workspace.autoCommit()` with a trace ID in the commit message. KC uses git
directly via `sandbox_exec` for diff, rollback, and branching:

```
sandbox_exec({command: "git log --oneline -10", cwd: "workspace"})
sandbox_exec({command: "git diff HEAD~3 -- rule_skills/R001/SKILL.md", cwd: "workspace"})
sandbox_exec({command: "git checkout HEAD~5 -- rule_skills/R001/", cwd: "workspace"})
```

`.gitignore` ships from `template/workspace.gitignore` and excludes runtime
noise (`logs/`, `sub_agents/`, `input/`, `output/`, `samples/`,
`session-state.json`, `.env`). `git status` shows only meaningful changes.

If git isn't installed, KC prints a one-line warning and continues with
auto-commit disabled — workspace still works, version history is just off.

**Tool-call offloading** (LangChain *Anatomy of an Agent Harness* pattern).
Tool outputs above ~2000 tokens (configurable) are written to
`logs/tool_results/<traceId>.txt`. Conversation history holds a head + tail
digest (~1.6KB) with a pointer; the agent reads the full file with
`workspace_file` only if it needs detail. Errors offload at a smaller
threshold (~500 tokens). The event log keeps the full content regardless,
so audits never lose data.

**Three new workspace tools:**

- `copy_to_workspace` — pull a specific file from the project directory
  into `refs/` with provenance recorded in `refs/manifest.json`. Files
  larger than `largeRefThresholdMB` (default 10 MB) are written but added
  to `.gitignore` so they don't bloat git history. Default behavior remains
  reading project files in place via `scope: "project"`.
- `snapshot` — freeze the current workspace state. Auto-commits any
  pending changes, creates git tag `snap/<slug>`, writes
  `snapshots/<slug>/snapshot.json`. Used for release bundles (Block 8) and
  before risky operations.
- `archive_file` — move a file to an `archived/` subdirectory next to it
  (e.g. `input/doc.pdf` → `input/archived/doc.pdf`). Uses `git mv` for
  tracked files so history is preserved. Reverse moves intentionally use
  plain `sandbox_exec mv` — no separate `unarchive` tool.

### What changed under the hood

- `src/agent/workspace.js` — added `_initGitRepo`, `autoCommit`, `setPhase`,
  `gitAvailable`, static `isGitInstalled`. Constructor now takes
  `{gitAutoCommit}` option.
- `src/agent/version-manager.js` — stripped to just `generateTraceId`
  (now exported as a top-level function and as a class method for back-compat).
  No more `versions.json` writes.
- `src/agent/tools/workspace-file.js` — `_write` now calls
  `workspace.autoCommit()` instead of `versionManager.onWrite()`.
- `src/agent/tools/copy-to-workspace.js`, `snapshot.js`, `archive-file.js` —
  three new tools.
- `src/agent/engine.js` — added `_maybeOffload` for tool-call offloading,
  registered the three new tools, propagates phase to `workspace.setPhase()`
  on transition and resume.
- `src/agent/pipelines/initializer.js` — no longer creates `versions.json`;
  auto-commits AGENT.md after seeding.
- `src/agent/context.js` — AGENT_IDENTITY gains a "File System" section
  describing git, offloading, and the three new tools.
- `src/config.js` — new keys: `gitAutoCommit`, `toolOutputOffloadTokens`,
  `toolOutputOffloadErrorTokens`, `largeRefThresholdMB`.
- `src/cli/index.js` — startup banner if git is missing.
- `template/workspace.gitignore` — new file shipped to every session.
- `template/skills/{en,zh}/meta-meta/version-control/SKILL.md` — new
  "Git Is the Source of Truth" section.

### Verification

Phase-by-phase smoke tests run during implementation:

- Phase 1a: fresh session → `.git/` + initial commit exist; `rules/` write
  triggers auto-commit; `logs/` write does not.
- Phase 1b: 50KB content → 1.7KB digest with pointer; offload file written;
  small content → no offload.
- Phase 1c: small file copied + git-tracked; 12MB file copied but added to
  `.gitignore`; manifest with provenance written; traversal blocked.
- Phase 1d: snapshot creates tag + commit + manifest; archive uses
  `git mv` for tracked files (history preserved) and `fs.rename` fallback
  for ignored files; conflict detection works.
- Phase 2: full engine constructs with 12 tools; system prompt mentions
  every new piece; all 22 en + 22 zh skills still index.

### Migration (additive)

Existing pre-v0.4.0 workspaces auto-init on next launch — initial commit
captures whatever's there as `"Migrated session <id> to git-tracked workspace"`.
Old `versions.json` is left untouched. No data loss; pre-migration history
just isn't reconstructable (old manifest was metadata-only). Going forward,
full git history accumulates.

### Defaults

| Key | Default | Override |
|-----|---------|----------|
| `gitAutoCommit` | `true` | env `GIT_AUTO_COMMIT`, global config `git_auto_commit` |
| `toolOutputOffloadTokens` | `2000` | env `TOOL_OUTPUT_OFFLOAD_TOKENS` |
| `toolOutputOffloadErrorTokens` | `500` | env `TOOL_OUTPUT_OFFLOAD_ERROR_TOKENS` |
| `largeRefThresholdMB` | `10` | env `LARGE_REF_THRESHOLD_MB` |

### Documentation

- New: `docs/file_system_design.md` — design doc (architectural decisions, layout, tool contracts, phased plan).
- New: `docs/file_system.md` — user-facing reference.

---

## v0.3.2 (2026-04-17)

Block 10 partial — project glossary supplement to rule-extraction, rule-graph,
and entity-extraction skills. Pure methodology text changes (same pattern as
Blocks 4 and 5). No code, no scripts, no behavior changes.

### What's added

**Project glossary as a living artifact.** A project-scoped vocabulary of
entities, terms, and patterns the verification system encounters. Built
during EXTRACTION alongside the rule catalog, enriched throughout
BUILD and DISTILL phases as KC sees more samples and refines its own
ground-truth extractions.

- **`rule-extraction/SKILL.md` (en + zh)** — new "Project Glossary"
  section after "Rule Catalog". Covers what the glossary is (canonical
  names + aliases keep entity references consistent across rules), when
  to seed it (during initial extraction), storage shape
  (`rules/glossary.json` next to `catalog.json`, JIT schema), and that
  it is a living document — not frozen at end of extraction.
- **`rule-graph/SKILL.md` (en + zh)** — new "Project Glossary" section
  before "Three Uses". The glossary is the canonical-label registry
  that makes `shares_entity` edges meaningful; without it, rules
  targeting the same entity under different names produce broken
  matches. Edges should reference glossary canonical labels.
- **`entity-extraction/SKILL.md` (en + zh)** — light cross-reference
  near "Schema Design". The glossary is a useful resource for keeping
  entity names schema-aligned. Whether it ever drives pattern-based
  matching is a per-project judgment, not a prescribed pattern.

### Deferred Block 10 supplements (TODO for v0.3.3+)

Three candidates considered during planning but deferred — original Block 10
description was largely covered by Blocks 4-5 already, leaving these as
narrower opportunities:

- **Semantic density preprocessing.** For long regulations, score
  paragraphs cheaply (regulatory phrase markers, threshold density)
  with worker LLM calibration on borderline cases, to focus extraction
  on rule-bearing sections first. From pdf2skills.
- **Cross-document rule deduplication.** When extracting from multiple
  regulations or revisions, similarity-match new rules against the
  existing catalog (merge / link / add). From pdf2skills' SKU-fusion.
- **Sharpen completeness checking.** Label-hierarchy approach for
  coverage validation. From A2O.

### Translation note

`rule-extraction` and `entity-extraction` zh files were already English
placeholders prior to this release; new sections were added in English
to preserve each file's existing language consistency. `rule-graph` zh
is fully translated, so the new section was written in Chinese to match.
A full zh translation pass for the placeholder skills is out of scope for
this release.

### Verification

- All 22 en + 22 zh skills still load via SkillLoader.
- Description frontmatter unchanged on all six modified files (no risk
  of skill-index breakage).
- Cross-references read coherently: rule-extraction → rule-graph →
  entity-extraction → rule-extraction (no orphaned links).

---

## v0.3.1 (2026-04-17)

Audit-and-fix release for the v3 production-readiness work (Blocks 0-7).
No new features — verified each block works end-to-end and patched bugs
the original implementation missed. Adds project README and npm metadata.

### Critical fixes

- **`engine.js`: removed duplicate `compact()` definition.** Block 7 had
  defined a second `compact(keepRecent)` at the end of the file that
  shadowed the working `compact({ recentCount })` from Block 2 of v0.2.0.
  The shadowing version tried `this.history.messages = ...`, which throws
  because `messages` is a getter-only property on `ConversationHistory`.
  Result: `runTaskLoop` would crash on the first auto-continued task once
  history grew past 15 messages. Verified end-to-end with a 25-message
  smoke test post-fix.
- **`runTaskLoop`: pass compact options as object, not positional.**
  Updated the two `compact(...)` callsites inside `runTaskLoop` to use
  the surviving `{ recentCount: 8 }` form. Previously `compact(8)` would
  destructure `8` as an object, get `undefined`, and silently fall back
  to keeping 20 messages instead of 8 — defeating the inter-task
  compaction strategy that prevents context blowup with many rules.
- **`document-parse.js`: stop polluting VLM output when `canvas` package
  is missing.** The previous fallback pushed bare `--- Page N (VLM) ---`
  headers with no content, which inflated the output to look like a
  successful parse. Now returns `null` immediately so the escalation
  chain falls through to MineRU.

### Packaging / publish prep

- **`package.json`**: bumped to **0.3.1**. Added `homepage`, `repository`,
  `bugs` fields pointing at the GitHub repo. Included `README.md` and
  `QUICKSTART.md` in the npm `files` allowlist so they ship with the
  installed package.
- **`README.md`**: new project README describing what KC is, the dual-
  directory architecture, phase model, ralph-loop, provider matrix, and
  pointers to docs.

### Verification

Block-by-block smoke tests against the working tree:

- Block 0 — `loadSettings()` returns `effective*()` worker fallback methods
  that resolve to conductor config when worker config is empty;
  `model-tiers.json` loads correctly via `getModelTierConfig()`.
- Block 1 — `Workspace` resolves dual scopes; `..` traversal blocked for
  both `resolvePath()` and `resolveProjectPath()`.
- Block 2 — `AGENT.md` template copied to workspace at bootstrap;
  `engine._readAgentMd()` returns it; `ContextAssembler.build({agentMd})`
  injects after the agent identity block.
- Block 3 — `SkillLoader` discovers all 22 skills (en); multi-line YAML
  `description: >` is parsed correctly for `pdf-review-dashboard`.
- Block 4 — `document-parse.js` escalation chain (pdfjs → VLM → MineRU)
  intact; `force_method` accepts `pdfjs|vlm|mineru|ocr`.
- Block 5 — Production-experience supplements present in
  `entity-extraction`, `compliance-judgment`, `rule-extraction`,
  `skill-authoring`, `skill-to-workflow`.
- Block 6 — `model-tiers.json` populated for all 10 providers; startup
  warning fires when all worker tiers blank; `auto-model-selection`
  meta-meta skill discoverable.
- Block 7 — `TaskManager` CRUD works; `runTaskLoop` no longer crashes
  during auto-continue; context compaction keeps history bounded between
  tasks (verified 25 → 10 messages, returns proper result keys).

---

## v0.3.0 (2026-04-16)

Production-readiness update implementing v3 design blocks 0-6. Focuses on dual-directory workspace, per-project context, skill improvements, and plugin architecture.

### Block 0: Align Both Versions
- **kc_reborn frozen** — all development on kc_cli (pure Node.js)
- **Separate worker LLM config** — optional worker provider/key/URL, falls back to conductor config
- **`src/model-tiers.json`** — standalone file for LLM (tier1-4) and VLM (tier1-3) per provider, easily editable without touching code
- **VLM tiers** — 3-tier vision model assignments for OCR/document parsing
- `providers.js` reads model selections from `model-tiers.json` instead of hardcoding
- `config.js` gains `effective*()` methods for worker config fallback

### Block 1: Permission Design
- **Dual-directory model** — project dir (CWD at launch) + workspace (`~/.kc_agent/workspaces/{sessionId}/`)
- **`scope` parameter** on `workspace_file`, `document_parse`, `document_search` tools (`"workspace"` | `"project"`)
- **`cwd` parameter** on `sandbox_exec` (`"workspace"` | `"project"`)
- `workspace.js` gains `projectDir` + `resolveProjectPath()` with traversal protection
- Project-aware bootstrap — initializer detects rules/samples in project dir
- Backup recommendation in TUI welcome banner
- Session state persists/restores `projectDir` for `/resume`

### Block 2: AGENT.md
- **Per-project system prompt** — `AGENT.md` created in workspace at bootstrap
- Agent can read and modify it; changes take effect on next turn
- `context.js` accepts `agentMd` param, injected after `AGENT_IDENTITY`

### Block 3: Better Dashboard
- **PDF review dashboard** — two-column HTML: PDF viewer (left) + verification results (right)
- Click result → PDF jumps to page with highlight animation
- Base64 embedded PDF, pdf.js CDN, dark theme, resizable split pane
- Packaged as meta-meta skill `pdf-review-dashboard` (optional plugin)
- Fixed `skill-loader.js` multi-line YAML description parsing

### Block 4: Improve Skills for Doc Parsing & Data Extraction
- **entity-extraction** — reframed method selection as cost-accuracy search (regex is "smallest model")
- **compliance-judgment** — removed fixed method ordering, KC picks per rule
- **document-parsing** — rearranged escalation: pdfjs → provider VLM → MineRU (optional)
- **document-parse.js** — implemented `_tryVlm()` with provider VLM API call
- **NEW `document-chunking`** — fast/cheap batch chunking meta skill
- **tree-processing** — refocused on production chunking (observe → pattern → code)
- **rule-extraction** — clarified one-off (fuzzy) vs data extraction (repeating, unified schema)
- **AGENT_IDENTITY** — updated extraction guidance to cost-accuracy framing

### Block 5: Polish Meta Skills from Historical Docs
- 6 targeted supplements from production experience (2025-11 summary doc + SAM design doc):
  - 3-part rule decomposition (location → extraction → judgment) + scope classification
  - Post-processing > prompt negation anti-pattern
  - Pipeline node decomposition principle
  - Exit criteria design-first pattern
  - Chain optimization goal (shortest chain → smallest model → shortest prompt)

### Block 6: Model Selection for Different Tiers
- Baseline criteria verified (5/5 met)
- Startup warning when all worker tiers blank
- **NEW `auto-model-selection`** meta-meta skill — Context7 CLI for auto model discovery (optional plugin)
- Broad trigger: anytime KC needs model knowledge (tier assignment, workflow design, model comparison)

---

## v0.2.1 (2026-04-10)

Provider registry alignment with kc_reborn.

- **Aligned `src/providers.js` with `kc_reborn/providers.py`**: Same model ranking system (0-100 scores), same tier distribution logic (>=85 tier1, >=70 tier2, >=55 tier3, rest tier4), same default model assignments per provider.
- **VolcanoCloud defaults fixed**: Now uses actual coding plan model IDs (`doubao-seed-2-0-pro-260215`, `deepseek-v3-2-251201`, `glm-4-7-251222`, etc.) instead of outdated generic names.
- **Curated model lists**: Providers without `/models` endpoint (Aliyun Bailian, VolcanoCloud, Anthropic) now ship curated model lists used during onboarding for auto-discovery and tier proposal.
- **Aliyun Bailian coding plan**: Conductor defaults to `glm-5`, tier1 worker to `qwen3.6-plus` (has vision/OCR capability), tiers 2-4 left blank — a capable tier1 worker handles all tasks.
- **Bedrock**: Updated to use `anthropic` apiFormat, model IDs match Bedrock ARN format.
- **Onboard flow**: Checks curated model lists before querying `/models` endpoint, so providers that don't support the endpoint still get model discovery during setup.
- Added `getCuratedModels()` export and `rankModel()` utility.

---

## v0.2.0 (2026-04-10)

Major update addressing stability, multi-provider support, and UX improvements. Implements all 6 items from `global_update_design_v2.md`.

### 1. Multi-LLM Provider Support

- **10 provider presets**: SiliconFlow, Aliyun Bailian (with coding plan key support), Anthropic, OpenAI, VolcanoCloud (ByteDance), Zhipu GLM, MiniMax, OpenRouter, AWS Bedrock (stub), Custom
- **Full Anthropic Messages API support**: SSE stream normalization (content_block_delta, input_json_delta, tool_use blocks) mapped to OpenAI chunk shape so the engine needs no changes
- **Auto-discovery**: After entering API key during onboard, KC probes `GET /models` to discover available models and proposes tier assignments automatically
- **Provider-agnostic config**: `LLM_API_KEY` / `LLM_BASE_URL` replace `SILICONFLOW_*` keys (old keys still accepted)
- **Aliyun coding plan**: Sub-option during onboard for subscription-based access with separate base URL
- New file: `src/providers.js` — provider registry with model classification heuristics

### 2. Context Engineering

- **Retry mechanism** (`src/agent/retry.js`): 10 retries with exponential backoff (1s-60s), jitter, Retry-After header support. Retries transient errors (429, 5xx, network), fails fast on auth/validation errors (400, 401, 403)
- **Event log** (`src/agent/event-log.js`): Append-only JSONL log (`logs/events.jsonl`) with sequence numbers and timestamps. Every agent event (user messages, LLM calls, tool executions, phase transitions, errors) is persisted. Source of truth for session history.
- **Token estimation** (`src/agent/token-counter.js`): Character-based heuristic (~4 chars/token for Latin, ~1.5 tokens/CJK character). Used for context display and windowing thresholds.
- **Context display**: Status bar shows `CTX: 45.2k/200k (23%)` with color coding (green < 60%, yellow < 80%, red >= 80%)
- **`/compact` command**: Summarizes older messages via conductor LLM call, keeps recent 20 messages intact. Falls back to mechanical summary if LLM call fails.
- **Automatic context windowing** (`src/agent/context-window.js`): When messages approach 85% of context limit, older messages are mechanically compressed with phase summaries injected. Applied transparently before each LLM call.
- **Session persistence** (`src/agent/session-state.js`): Saves `session-state.json` with current phase, pipeline milestones, phase summaries. Saved on phase transitions, turn completion, `/compact`, and graceful exit (Ctrl+C, Ctrl+D, `/exit`).
- **`/resume <name>` command**: Fully functional session resume. Reconstructs engine from persisted conversation history + session state. Restores phase, pipeline milestones, and phase summaries.
- **Pipeline export/import**: All 6 pipeline subclasses now implement `exportState()` / `importState()` for cross-session persistence.

### 3. Better Configuration Interaction

- **`kc-beta config` command**: New category-based config editor (LLM Provider, Model Tiers, Quality Thresholds, Language). Edit settings in categories, saves after each change.
- **Simplified onboard**: Threshold prompts removed from onboard flow (moved to `kc-beta config`). Onboard now focuses on: language, provider, API key, model discovery, conductor model, worker tiers.
- **UX hints**: Grey "(Press Enter to keep)" / "(Press Enter to use default)" hints on all prompts.
- **Post-onboard hint**: Tells user about `kc-beta config` for advanced settings.

### 4. Session Language Override

- **`--en` / `--zh` flags**: `kc-beta --en` or `kc-beta --zh` overrides language for one session only without changing global config.

### 5. Web Search Tool

- **`web_search` tool** (`src/agent/tools/web-search.js`): Tavily API integration. Supports `query`, `search_depth` (basic/advanced), `max_results` (max 10).
- **Domain priority guardrail**: Tool description explicitly instructs the LLM to prioritize user-provided documents over web results.
- **Graceful degradation**: Returns informative error if `TAVILY_API_KEY` is not configured.
- Config: `TAVILY_API_KEY` in `.env` or global config.

### 6. Always-Visible Activity Indicator

- **Persistent spinner**: Activity indicator now shows whenever KC is working, not just during initial LLM response wait.
- **Contextual status**: "Thinking..." (LLM streaming), "Running [tool_name]..." (tool execution), "Analyzing results..." (between tool result and next LLM call).

### Breaking Changes

- `.env` template now uses `LLM_API_KEY` / `LLM_BASE_URL` instead of `SILICONFLOW_API_KEY` / `SILICONFLOW_BASE_URL`. Old keys are still accepted via fallback in `src/config.js`.
- `kc-beta onboard` no longer prompts for advanced thresholds. Use `kc-beta config` instead.

### Files Added (8)

| File | Purpose |
|------|---------|
| `src/providers.js` | Provider registry, model classification |
| `src/agent/retry.js` | Exponential backoff retry |
| `src/agent/event-log.js` | JSONL event log |
| `src/agent/token-counter.js` | Token estimation |
| `src/agent/context-window.js` | Automatic context windowing |
| `src/agent/session-state.js` | Session state persistence |
| `src/cli/config.js` | Category-based config editor |
| `src/agent/tools/web-search.js` | Tavily web search tool |

---

## v0.1.2 (2026-04-08)

Initial beta release. Pure Node.js CLI agent for document verification.

- 6-phase pipeline: Bootstrap, Extraction, Skill Authoring, Skill Testing, Distillation, Production QC
- BUILD mode (agent does all work) + DISTILL mode (worker LLMs)
- 14 tools: sandbox_exec, workspace_file, document_parse, document_search, rule_catalog, evolution_cycle, dashboard_render, agent_tool, worker_llm_call, workflow_run, tier_downgrade, qc_sample
- Ink/React terminal UI with streaming, tool blocks, status bar
- Meta-methodology skills (en/zh) bundled in template/
- SiliconFlow + Aliyun + Anthropic + OpenAI provider presets
- Session management: /sessions, /rename, /clear
