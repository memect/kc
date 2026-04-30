#!/usr/bin/env python3
"""
Render a single-page HTML dashboard from the run.py output directory.

Usage:
    python3 render_dashboard.py [output/results dir]
    python3 render_dashboard.py output/results/  > dashboard.html

Reads every <doc>.json under the given directory + summary.json, renders
a self-contained HTML page (inline CSS, no external assets) showing per-
document verdict tables + an overall summary. Designed to be opened
directly in a browser.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from html import escape


VERDICT_COLORS = {
    "PASS": "#16a34a",
    "FAIL": "#dc2626",
    "PARTIAL": "#f59e0b",
    "PARTIAL_PASS": "#f59e0b",
    "NOT_APPLICABLE": "#6b7280",
    "UNDETERMINED": "#9ca3af",
    "INCONCLUSIVE": "#9ca3af",
    "NO_WORKFLOW": "#7c3aed",
    "ERROR": "#000000",
}


def _color(verdict: str) -> str:
    return VERDICT_COLORS.get(verdict, "#374151")


def _render_doc(doc_path: Path) -> str:
    data = json.loads(doc_path.read_text(encoding="utf-8"))
    rows = []
    for rule_id, verdict in sorted(data.get("results", {}).items()):
        v = verdict.get("verdict", "UNKNOWN")
        conf = verdict.get("confidence", 0.0)
        reason = verdict.get("reason", "") or verdict.get("error_type", "")
        rows.append(
            f"<tr>"
            f"<td><code>{escape(rule_id)}</code></td>"
            f"<td><span class='verdict' style='background:{_color(v)}'>{escape(v)}</span></td>"
            f"<td>{conf:.2f}</td>"
            f"<td>{escape(str(reason))[:200]}</td>"
            f"</tr>"
        )
    name = escape(Path(data.get("document", doc_path.stem)).name)
    return (
        f"<section><h2>{name}</h2><table><thead><tr>"
        f"<th>Rule</th><th>Verdict</th><th>Conf</th><th>Reason</th>"
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table></section>"
    )


def render(results_dir: Path) -> str:
    doc_files = sorted(p for p in results_dir.glob("*.json") if p.name != "summary.json")
    summary = {}
    summary_path = results_dir / "summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))

    summary_rows = "".join(
        f"<li><b>{escape(v)}</b>: {n}</li>"
        for v, n in sorted(summary.get("by_verdict", {}).items(), key=lambda kv: -kv[1])
    )

    body_sections = "\n".join(_render_doc(p) for p in doc_files)

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>KC verification dashboard</title>
<style>
  body {{ font: 14px system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; color: #111; }}
  h1 {{ font-size: 1.5em; }}
  h2 {{ font-size: 1.1em; margin-top: 2em; border-bottom: 1px solid #e5e7eb; padding-bottom: .3em; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: .5em; }}
  th, td {{ text-align: left; padding: .4em .6em; border-bottom: 1px solid #f3f4f6; vertical-align: top; }}
  th {{ background: #f9fafb; font-weight: 600; }}
  code {{ font-family: ui-monospace, monospace; }}
  .verdict {{ display: inline-block; padding: 2px 8px; border-radius: 4px; color: white; font-weight: 600; font-size: .85em; }}
  .summary {{ background: #f9fafb; padding: 1em; border-radius: 6px; }}
  .summary ul {{ margin: 0; padding-left: 1.2em; }}
</style>
</head><body>
<h1>KC verification — release v1</h1>
<div class="summary">
  <p><b>Total runs:</b> {summary.get("total_runs", 0)} ·
     <b>Errors:</b> {summary.get("errors", 0)} ·
     <b>Documents:</b> {len(doc_files)}</p>
  <ul>{summary_rows or '<li>No verdicts</li>'}</ul>
</div>
{body_sections}
</body></html>
"""


def main():
    if len(sys.argv) > 1:
        results_dir = Path(sys.argv[1]).resolve()
    else:
        results_dir = Path(__file__).resolve().parent / "output" / "results"
    if not results_dir.is_dir():
        print(f"results directory not found: {results_dir}", file=sys.stderr)
        sys.exit(1)
    print(render(results_dir))


if __name__ == "__main__":
    main()
