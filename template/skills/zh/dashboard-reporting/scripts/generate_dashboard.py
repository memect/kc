"""
Dashboard Generator — Starter Script

Generates a self-contained HTML dashboard from verification results.
This is a starting point. The coding agent should customize it for the
specific business scenario.

Usage:
    python generate_dashboard.py --input <output_dir> --output <dashboard.html>

Input: A directory containing verification result JSON files.
Output: A single self-contained HTML file.
"""

import argparse
import json
import os
from datetime import datetime
from pathlib import Path


def load_results(input_dir: str) -> list[dict]:
    """Load all JSON result files from the input directory."""
    results = []
    for f in Path(input_dir).glob("**/*.json"):
        if "dashboard" in str(f) or "versions" in str(f):
            continue
        try:
            with open(f) as fh:
                data = json.load(fh)
                if isinstance(data, list):
                    results.extend(data)
                elif isinstance(data, dict) and "results" in data:
                    results.extend(data["results"])
                elif isinstance(data, dict) and "rule_id" in data:
                    results.append(data)
        except (json.JSONDecodeError, KeyError):
            continue
    return results


def compute_summary(results: list[dict]) -> dict:
    """Compute summary statistics from results."""
    total = len(results)
    if total == 0:
        return {"total": 0, "pass": 0, "fail": 0, "missing": 0, "error": 0}

    summary = {
        "total": total,
        "pass": sum(1 for r in results if r.get("result") == "pass"),
        "fail": sum(1 for r in results if r.get("result") == "fail"),
        "missing": sum(1 for r in results if r.get("result") == "missing"),
        "error": sum(1 for r in results if r.get("result") == "error"),
    }
    summary["pass_rate"] = round(summary["pass"] / total * 100, 1)
    return summary


def compute_per_rule(results: list[dict]) -> dict:
    """Compute per-rule statistics."""
    rules = {}
    for r in results:
        rule_id = r.get("rule_id", "unknown")
        if rule_id not in rules:
            rules[rule_id] = {"total": 0, "pass": 0, "fail": 0, "results": []}
        rules[rule_id]["total"] += 1
        if r.get("result") == "pass":
            rules[rule_id]["pass"] += 1
        elif r.get("result") == "fail":
            rules[rule_id]["fail"] += 1
        rules[rule_id]["results"].append(r)

    for rule_id, data in rules.items():
        data["accuracy"] = round(data["pass"] / data["total"] * 100, 1) if data["total"] > 0 else 0

    return rules


def generate_html(summary: dict, per_rule: dict, failed_cases: list[dict]) -> str:
    """Generate a self-contained HTML dashboard."""

    rule_rows = ""
    for rule_id, data in sorted(per_rule.items()):
        color = "#4caf50" if data["accuracy"] >= 90 else "#ff9800" if data["accuracy"] >= 70 else "#f44336"
        rule_rows += f"""
        <tr>
            <td>{rule_id}</td>
            <td>{data['total']}</td>
            <td>{data['pass']}</td>
            <td>{data['fail']}</td>
            <td style="color: {color}; font-weight: bold;">{data['accuracy']}%</td>
        </tr>"""

    fail_rows = ""
    for case in failed_cases[:100]:  # Limit to first 100
        fail_rows += f"""
        <tr>
            <td>{case.get('document', 'N/A')}</td>
            <td>{case.get('rule_id', 'N/A')}</td>
            <td>{case.get('extracted_value', 'N/A')}</td>
            <td>{case.get('comment', 'N/A')}</td>
            <td>{case.get('confidence', 'N/A')}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KC Reborn — Verification Dashboard</title>
<style>
    :root {{ --bg: #1a1a2e; --surface: #16213e; --text: #e0e0e0; --accent: #4caf50; --warn: #ff9800; --err: #f44336; }}
    @media (prefers-color-scheme: light) {{
        :root {{ --bg: #f5f5f5; --surface: #ffffff; --text: #333333; }}
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 20px; }}
    h1 {{ margin-bottom: 20px; }}
    .summary {{ display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }}
    .card {{ background: var(--surface); padding: 20px; border-radius: 8px; min-width: 140px; text-align: center; }}
    .card .number {{ font-size: 2em; font-weight: bold; }}
    .card .label {{ font-size: 0.85em; opacity: 0.7; margin-top: 4px; }}
    table {{ width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 8px; overflow: hidden; margin-bottom: 24px; }}
    th, td {{ padding: 10px 14px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }}
    th {{ background: rgba(0,0,0,0.2); font-weight: 600; }}
    h2 {{ margin: 20px 0 12px; }}
    .timestamp {{ opacity: 0.5; font-size: 0.85em; margin-bottom: 20px; }}
</style>
</head>
<body>
<h1>Verification Dashboard</h1>
<div class="timestamp">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</div>

<div class="summary">
    <div class="card"><div class="number">{summary['total']}</div><div class="label">Total</div></div>
    <div class="card"><div class="number" style="color: var(--accent);">{summary['pass']}</div><div class="label">Pass</div></div>
    <div class="card"><div class="number" style="color: var(--err);">{summary['fail']}</div><div class="label">Fail</div></div>
    <div class="card"><div class="number" style="color: var(--warn);">{summary.get('missing', 0)}</div><div class="label">Missing</div></div>
    <div class="card"><div class="number">{summary.get('pass_rate', 0)}%</div><div class="label">Pass Rate</div></div>
</div>

<h2>Per-Rule Breakdown</h2>
<table>
    <thead><tr><th>Rule</th><th>Total</th><th>Pass</th><th>Fail</th><th>Accuracy</th></tr></thead>
    <tbody>{rule_rows}</tbody>
</table>

<h2>Failed Cases</h2>
<table>
    <thead><tr><th>Document</th><th>Rule</th><th>Extracted Value</th><th>Comment</th><th>Confidence</th></tr></thead>
    <tbody>{fail_rows if fail_rows else '<tr><td colspan="5" style="text-align:center; opacity:0.5;">No failures</td></tr>'}</tbody>
</table>
</body>
</html>"""
    return html


def main():
    parser = argparse.ArgumentParser(description="Generate verification dashboard")
    parser.add_argument("--input", required=True, help="Directory containing result JSON files")
    parser.add_argument("--output", default="dashboard.html", help="Output HTML file path")
    args = parser.parse_args()

    results = load_results(args.input)
    summary = compute_summary(results)
    per_rule = compute_per_rule(results)
    failed_cases = [r for r in results if r.get("result") == "fail"]

    html = generate_html(summary, per_rule, failed_cases)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    print(f"Dashboard generated: {output_path}")


if __name__ == "__main__":
    main()
