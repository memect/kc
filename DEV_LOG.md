# KC Agent CLI — Development Log

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
