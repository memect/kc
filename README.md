# KC Agent CLI (`kc-beta`)

> Build, distill, and run document verification systems with an LLM agent.
> Pure Node.js. One binary. Bring your own model.

KC is a coding agent purpose-built for **rule-based document verification**:
read a regulation, decompose it into atomic verification rules, write skills
to check each rule against sample documents, and (optionally) distill those
skills into cheap worker-LLM workflows for production batch processing.

It is designed for the developer at a bank, insurer, or law firm who needs
to verify hundreds of documents against dozens of compliance rules — and
wants the system to be transparent, testable, and ownable.

---

## Quick Install

```bash
npm install -g kc-beta
kc-beta onboard      # configure provider + API key
cd my-project        # a folder containing rules/ and samples/
kc-beta              # launch the agent

# v0.8.1+ unattended runs: type the slash command inside the kc-beta TUI
> /marathon Verify the new regulation against samples/. Iterate twice. If
  most workflows work with regex, build another version using tier1+tier2
  worker LLMs more aggressively.
# Marathon mode chains turns automatically. /marathon off disengages.
# /marathon status shows the driver state.
```

Requires **Node.js 20+**. See [QUICKSTART.md](./QUICKSTART.md) for the full setup walkthrough.

---

## v0.8 Highlights

- **`/marathon <goal>` slash command** (v0.8.1; replaces the v0.8.0
  separate-process `kc-marathon` CLI). Activates an inline driver inside
  the running kc-beta TUI. Goal embedded in the command. `/marathon off`
  to disengage manually; `/marathon status` to inspect. F5
  one-phase-per-prompt stays enabled for interactive sessions and
  bypasses cleanly when marathon is active. Status-bar shows
  `🏃 MARATHON` only when active — no clutter in normal mode. v0.8.0's
  separate-process driver was scrapped after E2E #11 found drivers
  died silently when their parent terminal closed (SIGHUP unhandled).
- **Skill usage counter** — passive Layer-B measurement of which skills
  the engine actually ships to the LLM. `skill_byte_send` events go to
  events.jsonl; the audit script aggregates per-phase × per-skill.
  Agent-blind by design.
- **`worker_llm_call` batch mode** — `prompts: [...]` array input with
  concurrency control (default 5, max 10). Pairs with a canonical
  `workflows/common/llm_client.py` shim (taught in `skill-to-workflow`)
  so distilled workflows route through the engine where possible and
  log to `output/llm_ledger.jsonl` when they don't.
- **`sandbox_exec` timeout model** — default 120s (was 30s); per-call
  `timeout_ms` up to 600s for known-slow commands. Configurable via
  `KC_EXEC_DEFAULT_TIMEOUT_MS` + `KC_EXEC_MAX_TIMEOUT_MS`.
- **Prescriptive phase-advance hints** — refusal messages now name
  concrete next-action artifacts (`workflows/<rule_id>/workflow_v1.py`,
  `output/results/production_qc_results.json`, etc.) instead of
  descriptive `engineCounts` only.
- **`check.py` substantiveness audit** — engine detects stub-shaped
  rule_skills/<id>/check.py files (NOT_APPLICABLE-only returns with no
  workflow delegation). Surfaced in milestones; opt-in enforcement via
  `KC_ENFORCE_CHECK_PY_SUBSTANTIVE=1`.

Plus engine-fix carryover from the v0.7.5 audit cycle: H3 calibration
aggregator schema, milestone-derivation gaps (review_001.json + multi-
path coverage_report.md), VLM runtime hardcode (workspace .env overlay),
heap_mb periodic-write fix, stale release detection, taskboard skill
availability in every phase. Full list: see DEV_LOG v0.8 entry.

---

## What It Does

KC drives a single coding agent through seven phases:

| Phase | What it does |
|-------|-------------|
| **BOOTSTRAP**       | Set up the workspace, detect rules/samples in your project |
| **EXTRACTION**      | Decompose regulation documents into atomic, testable rules |
| **SKILL_AUTHORING** | Write a verification skill for each rule (Anthropic skill-creator format) |
| **SKILL_TESTING**   | Run skills on samples, iterate via the evolution loop |
| **DISTILLATION**    | Convert proven skills into cheap worker-LLM workflows |
| **PRODUCTION_QC**   | Run workflows on production batches with confidence-based sampling |
| **FINALIZATION**    | Package deliverables — canonical layout, README, coverage report, final dashboard (v0.6.0) |

The conductor LLM (your main model) drives all reasoning. Worker LLM tools
are gated to DISTILL + FINALIZATION phases, so the build phase is always
grounded in high-quality output.

---

## Architecture

```
~/.kc_agent/
  config.json                       # provider, API key, model tiers
  workspaces/<sessionId>/           # KC's working files
    rules/, rule_skills/, workflows/, samples/, output/, logs/
    AGENT.md                        # per-project context (KC can edit)
    tasks.json                      # ralph-loop task list
    session-state.json              # phase + pipeline state for /resume

your-project/                       # where you launched kc-beta
  rules/        # source regulations (KC reads with scope="project")
  samples/      # sample documents
  Output/       # KC writes user-facing reports here
```

**Dual-directory design.** KC has full read/write to its own workspace plus
*scoped* read/write to your project directory. Source files stay in your
project; KC's working artifacts stay in `~/.kc_agent/workspaces/`.

**Phase-gated tools.** Worker LLM, workflow runner, tier downgrade, and QC
sampling tools only register during DISTILL phases. BUILD phases force the
conductor to do the intellectual work directly — the results are the
ground-truth baseline for distillation.

**Skills as first-class deliverables.** Every rule produces a self-contained
skill folder (SKILL.md + scripts + references + samples). For complex rules
that worker LLMs can't reliably handle, the skill itself — run by a capable
agent — is the production solution.

---

## Provider Support

10 providers configured out of the box:

- **SiliconFlow** (default, recommended for China)
- **Aliyun Bailian** (with coding-plan key support)
- **VolcanoCloud** (ByteDance Doubao)
- **Anthropic** (Messages API native)
- **OpenAI**
- **Zhipu GLM**
- **MiniMax**
- **OpenRouter**
- **AWS Bedrock** (stub)
- **Custom** (any OpenAI-compatible endpoint)

Model assignments live in [`src/model-tiers.json`](./src/model-tiers.json) —
edit directly to update tier-1 through tier-4 LLM and tier-1 through tier-3
VLM (vision) models per provider, no code changes needed.

You can use **separate providers** for the conductor and worker LLMs (e.g.,
Anthropic conductor + SiliconFlow workers).

---

## Ralph-Loop Autonomous Execution

When KC extracts rules, it automatically generates a per-rule task list and
processes them one at a time. Between tasks the conductor's context is
compacted aggressively, so context stays bounded even with 50+ rules.

```
SKILL_AUTHORING  [████████░░░░] 8/12
✓ R001  Registered capital check
✓ R002  Net asset adequacy
▸ R003  Related-party disclosure   ← current
·  R004  Risk capital calculation
...
```

Use `/tasks` to see the full list. The agent decides *how* to do each task;
the task manager only tells it *what's next*.

---

## Slash Commands

```
/help                Show available commands
/status              Session, model, phase, context usage, parallelism
/tasks               Show task list and progress
/tools               List registered tools + which phase gates each (v0.6.0)
/phase [sub]         advance | status | <name> — manual phase override
/parallelism [N]     Show / set parallel ralph-loop worker count 1-8 (v0.6.0)
/schedule            Show scheduled ingestion jobs
/clear               Clear conversation (workspace preserved)
/compact             Summarize older messages via the conductor
/sessions            List all sessions
/resume <name>       Resume a previous session
/rename <name>       Rename current session
/exit                Save state and quit
```

`--en` / `--zh` / `--parallelism=N` flags override for one session without writing config.

**v0.6.0 TUI upgrades:** input stays active during streaming (type-ahead
queues automatically), left/right arrow keys move the cursor, up/down
recalls session history, Ctrl-A/Ctrl-E jump to start/end. CTX status bar
smooths over 30 samples and tracks a session peak.

---

## Optional Plugins

Some heavyweight features ship as **meta-meta skills** the agent invokes on
demand, rather than always-on dependencies:

- **`pdf-review-dashboard`** — Two-column HTML dashboard (PDF on the left,
  verification results on the right, click-to-jump) for manual review and
  ground-truth collection.
- **`auto-model-selection`** — Use [Context7](https://github.com/upstash/context7)
  CLI to fetch current model listings when the bundled `model-tiers.json`
  is stale or you've switched providers.

Both are bundled in `template/skills/{en,zh}/meta-meta/` and discovered by
the skill loader at startup.

## Parallel Ralph-Loop (v0.6.0)

`--parallelism=N` (1-8) runs up to N verification tasks concurrently via
subagent orchestration. Safety guardrails:

- Silently clamps to 1 unless `KC_PARALLELISM_VERIFIED=1` is set in the
  workspace `.env` — prevents accidental multi-hundred-dollar runs before
  you've confirmed heap behavior.
- `logs/heap.jsonl` is sampled every 60 s permanently. Run
  `node scripts/heap-analyze.js` to get a FLAT / DRIFTING / GROWING
  verdict from the current workspace's run.
- `rules/catalog.json` writes serialize through a POSIX file lock;
  concurrent workers no longer race each other.
- `agent_tool` operations: `spawn` / `wait` / `poll` / `list` / `kill`
  give the agent visibility and control over its own subagents. A
  `stale_subagents` pipeline event on phase_advance lets the main agent
  clean up before moving on.

Recommended flow: run a 2h serial baseline first, confirm the heap
verdict is FLAT, then set `KC_PARALLELISM_VERIFIED=1` and try N=2.

---

## Configuration

Global config: `~/.kc_agent/config.json` (set by `kc-beta onboard`).
Per-project override: `<project>/.env`.

Edit anytime with the category-based editor:

```bash
kc-beta config
```

Categories: LLM Provider, Model Tiers, VLM Tiers, Worker LLM Provider,
Quality Thresholds, Language.

---

## Documentation

- [QUICKSTART.md](./QUICKSTART.md) — full setup and slash command reference
- [DEV_LOG.md](./DEV_LOG.md) — release history and design rationale
- [docs/global_update_design_v3.md](./docs/global_update_design_v3.md) — v3 design plan and progress tracker
- [docs/initial_spec_draft.md](./docs/initial_spec_draft.md) — original architectural spec

---

## Status

**v0.7.4 — phase-control fix + codex review re-attempt.** Architectural
payload from v0.6.0+ is still in place:

- Parallel ralph-loop (up to 8 concurrent workers) with a heap-safety
  conformance gate
- Native chunker + RAG (onion-peeler + CJK bigram keyword index +
  one-shot LLM bundle classifier, ported from the AMC verification app)
- Agent-owned task board: the agent reads the rule list from
  `describeState`, decides decomposition (per-rule / grouped / range),
  and calls `TaskCreate` / `TaskUpdate` / `TaskComplete` to drive the
  Ralph loop **within the current phase only** (v0.7.4). Source-context
  auto-attach pulls rule NL + evidence chunks + sibling rules into each
  task's prompt.
- Phase boundaries = user checkpoints: the Ralph loop exits at every
  phase transition, returning control to the user. The engine doesn't
  auto-advance; phase advance is explicit (agent's `phase_advance` tool
  call or user re-prompt). Marathon-style end-to-end autonomy lives
  outside the engine.
- Workspace file locking for shared coordination files (`rules/catalog.json`,
  `rules/manifest.json`, `refs/manifest.json`, `tasks.json`,
  `session-state.json`) — every writer goes through `withFileLock`.
- `agent_tool` gets `wait` / `poll` / `list` / `kill` operations +
  `stale_subagents` phase-advance signal
- FINALIZATION phase packages the session into a shippable deliverable
  (canonical `rule_skills/` layout + README + coverage report + final
  dashboard)
- Filesystem-derived phase milestones (v0.7.0+): the engine reads disk
  artifacts for advance criteria, never trusts tool-call assertions
- Input stays active during streaming (type-ahead queue), arrow keys +
  history recall, CTX smoothing + peak, per-provider context-limit caps,
  `/tools`, `/parallelism`, and more

See [DEV_LOG.md](./DEV_LOG.md) for the per-release change breakdowns and
[docs/update_design_v7.md](./docs/update_design_v7.md) for the v0.7.x
plan and patch notes.

Bug reports and PRs welcome at <https://github.com/kitchen-engineer42/kc-cli>.

---

## License

KC v0.7.0+ is **dual-licensed** under [PolyForm Noncommercial 1.0.0](./LICENSE)
plus a separate commercial license available on request.

- **Personal users, students, hobbyists, public-research orgs,
  charities, and government institutions** — use, modify, and self-host
  KC for free under [LICENSE](./LICENSE) (PolyForm Noncommercial 1.0.0).
- **Enterprises in production** (for-profit company workflows, hosting
  KC as a paid service, distributing KC inside a commercial product) —
  require a commercial license. See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md)
  for terms and how to contact us.
- **Redistribution as a competing or independent product** — forbidden
  under both license tracks. Internal forks for licensee use are fine
  with the `Required Notice:` preserved; releasing KC under another
  name as a new offering is not.

KC v0.6.x and earlier remain under MIT for those release versions
(licenses can't be retroactively changed); the v0.7.0 cutover applies
to all subsequent commits and releases.

Bundled meta-skills under `template/skills/` follow the same dual
license as KC itself.

---

*Built by Memium / kitchen-engineer42.*
