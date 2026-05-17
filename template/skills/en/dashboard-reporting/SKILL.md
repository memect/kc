---
name: dashboard-reporting
tier: meta-meta
description: Generate HTML dashboards for developer users to visualize verification results, system progress, and quality metrics. Use when a testing round completes, when production batches finish processing, when the developer user wants visual reporting, or when they explicitly ask for it. Dashboards are self-contained HTML files. Use this skill **when there's something visual worth showing** — not as a default deliverable. For routine status updates use KC's TUI. The dashboard is a complement to direct reporting, not a substitute.
---

# Dashboard Reporting

The dashboard is one channel — and not always the most economical one — for letting the developer user see what's going on. KC already reports status directly in the TUI; the HTML dashboard exists for things that are **worth seeing visually**: distributions, timelines, heatmaps, side-by-side comparisons, drill-down tables.

Don't treat dashboard generation as a checkbox to satisfy this skill. Treat it as a deliverable the developer user actually asked for, or where a picture genuinely saves them time over reading TUI output or JSON.

## Minimum vs. nice-to-have

When the developer user asks for a dashboard, **start with the minimum and expand only if it adds real value**.

### Minimum

A useful dashboard at the floor:
- A summary header: total documents, top-line pass/fail/missing counts.
- A per-rule table: rule_id, accuracy, pass / fail / NA counts, optional confidence column.
- A list of failed cases the user can click into for details (rule, extracted value, expected value, comment).

That's enough to ship. If the user can answer "is this batch healthy and which rules failed" in 3 seconds, the minimum is done.

### Nice-to-have

Add these only when they're justified by the data on hand or the user's actual need:
- Confidence distribution histogram (useful when confidence is calibrated and the user cares about the distribution shape).
- Accuracy-over-time line chart (useful only when there's enough history to draw a meaningful curve).
- Per-product-type / per-issuer breakdown (useful when the corpus has meaningful segmentation).
- Cost metrics (useful when cost is a live concern; otherwise skip).
- Drill-down navigation (summary → rule → document).
- Inline feedback widgets (correction-on-click, flag-as-wrong).

Don't add a section to look thorough. An empty "Confidence distribution" chart with no calibrated data is worse than no chart.

## Dashboard types (when to use which)

### Results dashboard
After a batch of documents is processed. The minimum above usually covers it.

### Progress dashboard
On demand, to show the system's evolution across phases. Lifecycle status per rule, rule catalog table, evolution timeline. Mostly useful when the developer user wants a "where are we" snapshot mid-build.

### Quality dashboard
After QC review cycles. Accuracy-over-time, sampling rate trend, flagged issues, cost. Useful when QC has accumulated enough cycles to show a trend.

If only one of the three would actually help the developer user right now, build only that one. Don't generate all three by default.

## Feedback collection (optional but recommended when applicable)

When the dashboard is destined for an audience that's going to review the results (developer user, end user, domain expert), include feedback widgets. When the dashboard is purely for developer-user inspection mid-build, feedback widgets are usually overkill — they pretend at a workflow the user isn't going to follow.

### Developer-user feedback

Full result detail visible. Useful widgets:
- Field-level correction: click an extracted value, provide the right one.
- Result override: change pass to fail (or vice versa) with a reason.
- Comment: free-text annotation on any result.

### End-user feedback

Simplified results visible. Useful widgets:
- Flag-as-wrong: one-click to report a result believed incorrect.
- Comment: brief text explanation.
- Severity indicator: critical / important / minor.

### Feedback as ground truth

User-reported errors are ground truth. They override agent judgment and worker-LLM output. Flow:

1. Submit via dashboard → stored as structured record.
2. Schema: `{result_id, trace_id, reporter_role, feedback_type, original_result, corrected_value, comment, timestamp}`.
3. Records feed into `evolution-loop` as confirmed failures.
4. Surface feedback trends in subsequent dashboards (correction rate over time, most-reported issues, rules with highest correction rates).

## Technology

Self-contained HTML with embedded CSS / JavaScript.
- **No external dependencies.** No CDN links, no npm packages, no server. Everything inlined.
- **No server required.** Developer user double-clicks the HTML file.
- **Responsive layout.** Should work on desktop and mobile.
- **Dark/light mode** — respect system preference or provide a toggle.

For charts, use inline SVG or a lightweight chart library inlined as a `<script>` tag.

## Data sources

Dashboards read from:
- `Output/` for verification results.
- `logs/` for evolution and testing history.
- `versions.json` (or git log) for current system state.
- QC review records (stored alongside `Output/`).

The generation script should accept input paths and produce a single HTML file.

## Generation triggers

Generate dashboards when:
- A testing round completes AND there's enough data to be worth visualizing.
- A production batch finishes AND the developer user wants a visual.
- A QC review cycle completes.
- The developer user explicitly requests one.

Don't auto-generate on every minor event — the dashboards pile up fast and the user won't open most of them. When unsure, ask the user ("Want me to generate a dashboard?") instead of producing one unprompted.

Store generated dashboards in `Output/dashboards/` with timestamped filenames for history.

## Design principles

- **Lead with the summary.** Developer user should understand health in 3 seconds.
- **Drill down on demand.** Summary → rule-level → document-level. Don't overwhelm with details upfront.
- **Color coding.** Green for pass/healthy, red for fail/critical, yellow for warning/attention. Simple and universal.
- **Actionable.** Every flagged issue should suggest a next step.

A starter script is available in `scripts/generate_dashboard.py`. Adapt to the specific scenario — and feel free to trim the script when half its sections wouldn't have content. A small dashboard that answers the user's question beats a comprehensive one they don't need.

## Relationship to TUI reporting

KC's TUI already supports rich status reporting during the run. Use TUI for:
- Ongoing progress narration.
- Per-phase summaries.
- Quick "what just happened" updates.
- Anything that can be communicated in a few lines of text.

Use HTML dashboards for:
- Visual artifacts that wouldn't fit (distributions, charts, filterable tables).
- Hand-off to non-KC users (developer-user reviewing later, end-user audience).
- Persistent records the user wants to revisit.

When in doubt, prefer the TUI. A short status message the user is already reading beats a dashboard they have to open.
