---
name: auto-model-selection
tier: meta
description: >
  Use Context7 CLI to get up-to-date LLM model information. Use whenever you need to
  know about available models, model capabilities, pricing, context window sizes, or
  which model is suitable for a task — including tier assignment, worker LLM workflow
  design, model comparison, and provider-specific API usage. Context7 gives you current
  information that your training data may not have. Requires context7 CLI installed
  (npm i -g context7). Optional plugin.
---

# Auto Model Selection via Context7

## What Context7 Is

Context7 (`c7`) is a lightweight CLI tool that fetches up-to-date documentation for libraries and APIs. Install: `npm i -g context7`. Two commands:
- `c7 library <query>` — search for a library/provider by name
- `c7 docs <libraryId> <query>` — get specific documentation and code examples

## When to Use

- User's `model-tiers.json` is outdated (KC hasn't been updated)
- User switched to a new provider and needs model discovery
- User explicitly asks to update model selections
- Onboarding `/models` endpoint failed and curated list is stale

## How It Works

1. User chooses provider and provides API key (or coding plan)
2. Use `c7 library <provider-name>` to find the provider's library ID
3. Use `c7 docs <id> "available models"` to get current model listings
4. From the docs, identify: model names, capabilities (reasoning, coding, vision), context window sizes, pricing tiers
5. Assign models to tiers based on capability and cost:
   - LLM tier1: most capable (complex judgment, extraction)
   - LLM tier2-3: mid-range (routine extraction, simple judgment)
   - LLM tier4: cheapest (high-volume simple tasks)
   - VLM tier1-3: vision models for document parsing/OCR
6. Update `model-tiers.json` or workspace `.env` with assignments

## Tier Assignment Principles

- Cheapest model that meets accuracy threshold for the task
- Regex is tier0 — smaller than any LLM
- Not all tiers need to be filled — blank tiers are fine if the provider lacks suitable models
- Record what works in AGENT.md for future reference

## Prerequisites

```bash
npm i -g context7
```

Verify: `c7 library openai` should return results.
