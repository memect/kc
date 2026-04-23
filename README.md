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
```

Requires **Node.js 20+**. See [QUICKSTART.md](./QUICKSTART.md) for the full setup walkthrough.

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

**v0.6.0 — first architectural beta.** This release lands:

- Parallel ralph-loop (up to 8 concurrent workers) with a heap-safety
  conformance gate
- Native chunker + RAG (onion-peeler + CJK bigram keyword index +
  one-shot LLM bundle classifier, ported from the AMC verification app)
- Source-context auto-attach on skill_authoring tasks (rule NL + evidence
  chunks + sibling rules injected into the prompt, no manual search needed)
- Workspace file locking for shared coordination files (`rules/catalog.json`,
  `rules/manifest.json`, `tasks.json`, etc.)
- `agent_tool` gets `wait` / `poll` / `list` / `kill` operations +
  `stale_subagents` phase-advance signal
- New FINALIZATION phase packages the session into a shippable deliverable
  (canonical `rule_skills/` layout + README + coverage report + final
  dashboard)
- Input stays active during streaming (type-ahead queue), arrow keys +
  history recall, CTX smoothing + peak, per-provider context-limit caps,
  `/tools`, `/parallelism`, and more

See [DEV_LOG.md](./DEV_LOG.md) for the full v0.6.0 change breakdown and
[docs/update_design_v5.md](./docs/update_design_v5.md) for the plan that
drove it.

Bug reports and PRs welcome at <https://github.com/kitchen-engineer42/kc-cli>.

---

## License

MIT. Bundled meta-skills under `template/skills/` are proprietary —
distributed via npm but not open-source. See `template/skills/LICENSE` for
terms.

---

*Built by Memium / kitchen-engineer42.*
