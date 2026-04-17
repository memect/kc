---
name: bootstrap-workspace
description: Initialize and configure a document verification workspace. Use when a developer user first opens this workspace, when .env needs configuration, or when the business scenario needs to be understood. Guides the coding agent through reading regulation documents, understanding the developer user's business context, configuring model tiers and thresholds, and establishing the working relationship. Covers initial conversation with developer user to scope the verification task, set expectations, and agree on checkpoints.
---

# Bootstrap Workspace

You are replacing a team of business analysts, prompt engineers, and QA engineers. Before writing a single line of code, understand what that team would ask first.

## First Actions

1. Read everything in `Rules/`. Understand the domain, the regulation structure, the language, and the level of specificity.
2. Scan `Samples/` to understand the document types, formats (PDF, DOCX, scans), typical length, and structural patterns.
3. Review `.env` to understand the current configuration. Check that API keys are set and models are accessible.

## Discuss with Developer User

Before proceeding, have a focused conversation with the developer user to align on:

### Scope
- What type of documents are being verified? (contracts, filings, reports, etc.)
- What regulations or rules apply? Are they all in Rules/, or are some implicit domain knowledge?
- How many distinct rules are there, roughly? Dozens? Hundreds?
- Are there rules already sorted into a spreadsheet (xlsx/csv) with clear scope definitions?

### Granularity
- How fine-grained should each rule be? A single clause? A paragraph? A section?
- Some rules are naturally atomic ("the interest rate must not exceed X%"). Others are compound ("the disclosure section must contain items A, B, C, and each must meet criteria D, E, F"). Discuss how to decompose compound rules.
- If the developer user has pre-sorted rules, follow their structure. Do not re-decompose unless they ask.

### Expectations
- What accuracy is acceptable? The default in `.env` is 0.9 for both skills and workflows. Is this right for this business scenario?
- Are some rules more critical than others? Should critical rules have higher thresholds?
- What is the expected production volume? How many documents per batch?
- How fast do results need to be? Same-day? Real-time?

### Checkpoints
- Explain the lifecycle to the developer user: you will first verify documents yourself (skill phase), then build automated workflows (workflow phase), then monitor in production (QC phase).
- Agree on when the developer user wants to review progress. After the first rule? After all rules? After workflow distillation?
- Establish how the developer user wants to see results (HTML dashboard, direct conversation, output files).

## .env Configuration Guidance

Walk through `.env` parameters with the developer user:

- **TIER1-4**: Model tiers from most capable to most efficient. TIER1 is used when accuracy matters most. TIER4 is used when the task is well-understood and speed/cost matters. The coding agent decides per-task, but the developer user should confirm the available models match their API access.
- **OCR_MODEL_TIER1-3**: For document parsing when text extraction fails. Only relevant if documents include scanned pages, complex tables, or charts.
- **SKILL_ACCURACY**: The accuracy threshold before a skill is considered "proven" and ready for workflow distillation. Default 0.9. Higher means more iteration before moving on, but more reliable workflows.
- **WORKFLOW_ACCURACY**: The accuracy threshold before a workflow is deployed to production. Default 0.9. This is measured against the coding agent's own skill-based results as ground truth.
- **MONITOR_FREQUENCY**: How aggressively to sample and review production results. `high` = slower decay (review more for longer), `mid` = balanced, `low` = faster decay (trust workflows sooner).
- **MAX_ITERATIONS**: Safety valve. After this many evolution cycles on a single rule, escalate to the developer user instead of continuing to iterate.

## Setting Up the Workspace

After the conversation:

1. Ensure all workspace folders exist (Rules/, Samples/, Input/, Output/).
2. Create a `logs/` directory for iteration logs.
3. Create a `workflows/` directory for distilled Python workflows.
4. Create a `rule-skills/` directory where individual rule skill folders will live.
5. Initialize version tracking (a `versions.json` manifest).
6. Log the bootstrap conversation summary for future reference.

## Scheduled Ingestion (Production)

Once a project is past bootstrap and into production, fresh documents often arrive on a regular cadence — daily regulator drops, hourly API pulls, batch uploads from upstream systems. Use the `schedule_fetch` tool to register ingestion jobs the OS scheduler runs while kc-beta is closed:

- Each job is a shell command (rsync, curl, custom script) that lands files in `$INPUT_DIR`.
- KC writes a wrapper script under `scripts/ingest/<job-id>.sh`; the user installs the script line into their crontab via `crontab -e`.
- Newly-arrived files are auto-prefixed with `<job-id>_<UTC-timestamp>_` so origin and arrival time are visible in the filename.
- View status with `/schedule` or `schedule_fetch list`. Tail of `logs/ingest.log` shows recent runs.

Discuss the cadence with the developer user during bootstrap — knowing the production input rhythm shapes how skills and workflows should be written (batch vs streaming, idempotency requirements, etc.).

## When to Re-Bootstrap

Return to this skill when:
- The developer user adds new regulation documents to Rules/.
- The business scenario changes significantly.
- Model availability changes (new models added, old models deprecated).
- Thresholds need adjustment based on production experience.
