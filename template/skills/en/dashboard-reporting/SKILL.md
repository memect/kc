---
name: dashboard-reporting
tier: meta-meta
description: Generate HTML dashboards for developer users to visualize verification results, system progress, and quality metrics. Use when a testing round completes, when production batches finish processing, when the developer user wants to see the system's status, or at any point where visual reporting would help communicate progress. Dashboards should be self-contained HTML files that can be opened by double-clicking. Also use when the developer user asks about results, accuracy, or system health.
---

# Dashboard Reporting

The dashboard is the developer user's window into the system. They should not need to read logs or parse JSON to understand what is happening. Give them a clear, visual summary that leads with what matters.

## Dashboard Types

### Results Dashboard
Generated after each batch of documents is processed.

Key elements:
- **Summary bar**: Total documents, pass rate, fail rate, missing rate, error rate.
- **Per-rule breakdown**: Table showing each rule's pass/fail counts, accuracy, and average confidence.
- **Failed cases**: List of documents that failed, with the rule, extracted value, expected value, and comment. Sortable and filterable.
- **Confidence distribution**: Histogram showing how many results fall in each confidence band.

### Progress Dashboard
Generated on demand to show the system's evolution.

Key elements:
- **Lifecycle status**: Which rules are in which phase (skill testing, workflow testing, production, stable).
- **Rule catalog**: Table of all rules with their current status, accuracy, and version.
- **Evolution timeline**: For each rule, how many iterations it took, what was the accuracy at each step.
- **Model tier assignments**: Which model is being used for each step of each rule.

### Quality Dashboard
Generated after quality control reviews.

Key elements:
- **Accuracy over time**: Line chart showing per-rule and overall accuracy across batches.
- **Sampling rate over time**: Showing how monitoring is decreasing (or not).
- **Flagged issues**: Open issues that need developer user attention.
- **Cost metrics**: LLM calls and tokens per document, per rule.

## Feedback Collection

Every dashboard must include mechanisms for users to report errors and comment directly on verification results. This is not a nice-to-have — user feedback is the most valuable data source in the system.

### Developer User Feedback

Developer users see full result detail. Their feedback interface should support:
- **Field-level correction**: Click on an extracted value, provide the correct value.
- **Result override**: Change a pass to fail (or vice versa) with a reason.
- **Rule re-evaluation request**: Flag a result for re-processing with a different approach.
- **Comment**: Free-text annotation on any result.

### End User Feedback

End users of the verification app see simplified results. Their interface should support:
- **Flag as wrong**: One-click to report a result they believe is incorrect.
- **Add comment**: Brief text explaining what they think is wrong.
- **Severity indicator**: How impactful is this error? (Critical / Important / Minor)

### Feedback as Ground Truth

User-reported errors are ground truth. They override the coding agent's judgment and the worker LLM's output. The feedback data flow:

1. User submits feedback via dashboard → stored as structured record.
2. Record schema: `{result_id, trace_id, reporter_role, feedback_type, original_result, corrected_value, comment, timestamp}`.
3. Feedback records are fed into the `evolution-loop` as confirmed failures.
4. Dashboard surfaces feedback trends: correction rate over time, most-reported issues, rules with highest user correction rates.

Build the feedback collection mechanism alongside the dashboard generation — they are not separate features. Every generated HTML dashboard should include the feedback UI, even if it initially writes to a local JSON file that the coding agent reads on the next iteration.

## Technology

Self-contained HTML with embedded CSS and JavaScript. Requirements:
- **No external dependencies.** No CDN links, no npm packages, no server. Everything is inlined.
- **No server required.** The developer user double-clicks the HTML file to open it in their browser.
- **Responsive layout.** Should work on both desktop and mobile screens.
- **Dark/light mode.** Respect the system preference or provide a toggle.

For charts, use inline SVG or a lightweight chart library that can be embedded (e.g., Chart.js or lightweight alternatives, inlined as a script tag).

## Data Sources

Dashboards read from:
- `Output/` for verification results.
- `logs/` for evolution and testing history.
- `versions.json` for current system state.
- QC review records (stored alongside Output/).

The dashboard generation script should accept input paths and produce a single HTML file.

## Generation Triggers

Generate dashboards automatically after:
- Each testing round completes (skill testing or workflow testing).
- Each production batch finishes processing.
- Each quality control review cycle.
- Developer user explicitly requests it.

Store generated dashboards in `Output/dashboards/` with timestamps in filenames for history.

## Design Principles

- **Lead with the summary.** The developer user should understand the system's health in 3 seconds.
- **Drill down on demand.** Summary → rule-level → document-level. Do not overwhelm with details upfront.
- **Color coding.** Green for pass/healthy, red for fail/critical, yellow for warning/attention. Simple and universal.
- **Actionable.** Every flagged issue should suggest what to do next.

A starter script is available in `scripts/generate_dashboard.py`. Adapt it to the specific business scenario.
