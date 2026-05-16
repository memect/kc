---
name: auto-model-selection
tier: meta
description: >
  Use Context7 CLI for up-to-date model facts (size, API format, context window) and the
  guidance below for "what kind of models are good for what part of a doc verification app".
  Consult whenever you need to pick a model for a tier slot, decide between provider
  alternatives, or sanity-check an existing tier assignment. Context7 gives you fresh
  facts; this skill gives you the heuristic that maps those facts onto KC's pipeline.
  Optional plugin (Context7 install: npm i -g context7).
---

# Auto Model Selection

Model selection is not a frequently called skill — for most users, the
tiers in workspace `.env` are already set sensibly, and a 4-tier
cost-sensitive selection is overkill. This skill exists for two
moments: when the conductor is bootstrapping fresh tier assignments
(rare), and as a reference inside `skill-to-workflow` when a workflow
needs to pick which worker LLM is right for its job.

The teaching below is empirical — what the author has found works in
this domain. Treat it as a starting heuristic with a 3-6 month shelf
life, since model families update quickly.

## Worker LLM family — practical heuristic

- **Qwen family** — robust and cheap for general worker work. The
  flagship MoE in this family at any given time is usually one of the
  best workhorses for routine extraction / classification. Smaller
  sizes (3B-70B) are plentiful and reliable. Good default.
- **DeepSeek** — excellent on more complicated tasks. Worth reaching
  for when the rule involves multi-step reasoning, nested judgment,
  or anything where Qwen's shorter-context behavior shows strain.
- **GLM and Kimi** — also strong for the same complicated-task range
  as DeepSeek. Trade-off: they don't usually ship smaller variants
  (3B-70B), so they're tier1/tier2 only, not tier3/tier4.

## Flagship-MoE shape and the tier1 baseline

The current generation of flagship MoE LLMs has a recognizable shape:
total parameter count in the 200-400B range, ~20B of activated expert
size per token. Examples (these will be stale within months): Qwen's
flagship MoE in the 200-400B-A20B band, DeepSeek-V4-Flash, etc.

This shape is a good first-choice worker LLM — not necessarily the
absolute best at tier1, but a reasonable benchmark to start from.
When you're picking a tier1 model, start from one of these and only
move if you have a specific reason.

## Smaller LLMs — basically free below 30B

Once you drop below ~30B parameters, models are extremely cheap on
most providers. Qwen ships a ton of choices in this range and they
work well.

Two rules for picking in this range:
- **Avoid "coder" variants** (models with `coder` / `code` in the
  name) at small sizes — these are mostly unreliable for general
  worker tasks. Use them only when the task is literally code-related.
- **Prefer no-thinking-mode variants** when available. Tasks assigned
  to small workers are simple and fixed; extra thinking buys nothing
  and adds latency + token cost.

## VLM / OCR selection

First question: what's the visual task?

- **Characters in scanned docs, seal stamps, handwriting** — use a
  dedicated OCR model. Current strong choices (subject to change):
  Paddle-OCR family, GLM-OCR, DeepSeek-OCR. Previous versions still
  work fine. No need to use a larger general VLM for plain character
  recognition.
- **Graphs, complex tables, structures with strange or no frame
  lines** — try a larger and more expensive general VLM. The
  structure-understanding gap between OCR-specific models and
  general VLMs widens fast on these cases.

When in doubt, run the cheapest OCR option first and only upgrade if
the cheap path misses structure information.

## Context7 — model facts on demand

The heuristics above are about *which kind* of model to pick. For the
specific facts (current model names, exact context window, pricing,
API format), use Context7:

```bash
c7 library <provider-name>
c7 docs <libraryId> "available models"
```

Two commands. The first finds the provider's library ID, the second
fetches up-to-date docs and code examples. Useful when:

- Workspace `model-tiers.json` looks stale (KC hasn't been updated
  since the last model launch)
- User switched providers and needs model discovery
- The `/models` endpoint on a new provider was empty or unhelpful
- You're sanity-checking that a model name in `.env` is still served

Install: `npm i -g context7`. Verify: `c7 library openai` should
return results.

## When tier1/tier2 are picked

The tier assignment ends up driving cost. Cheapest model that meets
the accuracy bar wins. Regex is the implicit "tier 0" and should be
the first reach when the rule can be satisfied by pattern matching
alone — see `skill-to-workflow` for when to escalate from regex to
worker LLMs.

Not all tiers need to be filled. Blank tier3/tier4 slots are fine if
the provider doesn't ship suitable small models. Record what works in
`AGENT.md` so the next session inherits the choice.

## Refresh cadence

This skill's heuristics will drift. Author plans to revisit every
3-6 months as new model generations land. If you find yourself
applying advice here that contradicts what Context7 shows today,
trust Context7 — the facts have moved.
