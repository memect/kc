# KC Agent CLI (Beta) — Quickstart

## Install

```bash
npm install -g kc-beta
```

Requires **Node.js 20+**.

## Setup

Run the onboarding wizard to configure your LLM provider and API keys:

```bash
kc-beta onboard
```

You'll be prompted to choose:

1. **Language** — English or 中文
2. **LLM Provider** — SiliconFlow, Aliyun Bailian, Anthropic, OpenAI, VolcanoCloud, Zhipu GLM, MiniMax, OpenRouter, or custom
3. **API Key** — your provider API key (supports both API keys and Aliyun/VolcanoCloud coding plan keys)
4. **Model Discovery** — KC auto-discovers available models via API or curated lists and suggests tier assignments with capability-based ranking
5. **Conductor Model** — the main model that drives the agent
6. **Worker LLM Tiers** — tier1 (best) through tier4 (cheapest) for verification tasks
7. **VLM Tiers** — vision models for OCR/document parsing (tier1-3)
8. **Worker Provider** (optional) — use a different provider for worker LLMs (defaults to conductor provider)

Config is saved to `~/.kc_agent/config.json` and shared across projects.

### Edit Settings Later

```bash
kc-beta config
```

Category-based editor for: LLM provider, model tiers, VLM tiers, worker LLM provider, quality thresholds, language.

## Create a Project

```bash
kc-beta init my-project
kc-beta init my-project --lang=zh   # Chinese skills
```

This creates a workspace with:

```
my-project/
  .env              # Project-level config (overrides global)
  Rules/            # Put regulation documents here
  Samples/          # Put sample documents here
  Input/            # Production batches
  Output/           # Verification results
  skills/           # Meta-methodology skills (en or zh)
```

## Start the Agent

```bash
kc-beta             # default language from config
kc-beta --en        # this session in English (does not change config)
kc-beta --zh        # this session in Chinese (does not change config)
```

Launch from your project directory — KC has full read/write access to the folder you launch from:

```bash
cd my-project
kc-beta
```

The agent starts in **BOOTSTRAP** phase. It will:

1. Set up the workspace structure
2. Detect regulations and samples in your project directory
3. Ask about your verification scenario

Once regulations and samples are in place, the agent advances through 6 phases automatically:

| Phase | What happens |
|-------|-------------|
| **BOOTSTRAP** | Workspace setup, understand the scenario |
| **EXTRACTION** | Decompose regulations into atomic rules |
| **SKILL_AUTHORING** | Write verification skills for each rule |
| **SKILL_TESTING** | Test skills, iterate via evolution loop |
| **DISTILLATION** | Convert skills to worker LLM workflows |
| **PRODUCTION_QC** | Run workflows on production docs with QC |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Session info, model, phase, context usage |
| `/clear` | Clear conversation history |
| `/compact` | Summarize older messages to reduce context usage |
| `/sessions` | List all sessions |
| `/resume <name>` | Resume a previous session (restores phase + pipeline state) |
| `/rename <name>` | Rename current session |
| `/exit` | Save state and quit |

## Keyboard Shortcuts

- **Enter** — Send message
- **Ctrl+C** — Clear queue (if streaming) or save & exit
- **Ctrl+D** — Save & exit

## Status Bar

The status bar shows:
- Session ID and current phase
- **Context usage**: `CTX: 45.2k/200k (23%)` — turns green/yellow/red as context fills

## Per-Project Config

Override global settings in your project's `.env`:

```env
LLM_API_KEY=sk-xxx
LLM_BASE_URL=https://api.siliconflow.cn/v1

TIER1=Pro/zai-org/GLM-5
TIER2=
TIER3=
TIER4=

SKILL_ACCURACY=0.9
WORKFLOW_ACCURACY=0.9
MAX_ITERATIONS=20

# Optional: web search via Tavily
TAVILY_API_KEY=tvly-xxx
```

Legacy keys (`SILICONFLOW_API_KEY`, `SILICONFLOW_BASE_URL`) are still accepted for backward compatibility.

## Web Search

KC can search the web using Tavily when information is not available in your provided documents. Set `TAVILY_API_KEY` in your `.env` or global config. KC prioritizes your domain documents over web results.

## Troubleshooting

- **"No API key configured"** — Run `kc-beta onboard` first
- **Connection errors** — Check your API key and base URL. KC retries up to 10 times with exponential backoff on transient failures.
- **Context too long** — Use `/compact` to summarize older messages, or let automatic windowing handle it
- **Resume after crash** — Use `/resume <session-name>` to pick up where you left off
- **Node version** — Requires Node.js 20+. Check with `node --version`
