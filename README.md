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

KC drives a single coding agent through six phases:

| Phase | What it does |
|-------|-------------|
| **BOOTSTRAP**       | Set up the workspace, detect rules/samples in your project |
| **EXTRACTION**      | Decompose regulation documents into atomic, testable rules |
| **SKILL_AUTHORING** | Write a verification skill for each rule (Anthropic skill-creator format) |
| **SKILL_TESTING**   | Run skills on samples, iterate via the evolution loop |
| **DISTILLATION**    | Convert proven skills into cheap worker-LLM workflows |
| **PRODUCTION_QC**   | Run workflows on production batches with confidence-based sampling |

The conductor LLM (your main model) drives all reasoning. Worker LLM tools
are gated to DISTILL phases only, so the build phase is always grounded in
high-quality output.

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
/status              Session, model, phase, context usage
/tasks               Show task list and progress
/clear               Clear conversation (workspace preserved)
/compact             Summarize older messages via the conductor
/sessions            List all sessions
/resume <name>       Resume a previous session
/rename <name>       Rename current session
/exit                Save state and quit
```

`--en` / `--zh` flags override language for one session without writing config.

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

**v0.3.1 — beta.** Production-readiness update covering the seven blocks
of the v3 design plan: dual-directory permissions, AGENT.md per-project
context, PDF review dashboard skill, parsing/extraction skill rewrites,
production-experience meta-skill polish, model-tier baseline + Context7
plugin, and ralph-loop autonomous task execution.

We are inviting a small group of developer users to test before public launch.
Bug reports and PRs welcome at <https://github.com/kitchen-engineer42/kc-cli>.

---

## License

MIT. Bundled meta-skills under `template/skills/` are proprietary —
distributed via npm but not open-source. See `template/skills/LICENSE` for
terms.

---

*Built by Memium / kitchen-engineer42.*
