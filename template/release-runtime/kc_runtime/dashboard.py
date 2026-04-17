"""
End-user dashboard renderer — Python port of DashboardRenderTool._renderHtml.

Takes a release-run result JSON (the output of run.py) and emits a static
HTML dashboard. Dark theme, two tabs (Summary + Per-Rule), no external
dependencies, no JS framework — vanilla JS for tab switching only.
"""

import html as _html
import json
from datetime import datetime, timezone


def render(result, manifest):
    """
    result: dict from run.py — keys: release, snapshot_tag, input,
            started_at, duration_ms, results: [{rule_id, value, confidence,
            confidence_band, extraction_method, exit_code, raw}]
    manifest: dict from the bundle's manifest.json (for header info)
    Returns: a complete HTML string.
    """
    label = manifest.get("label", result.get("release", ""))
    snap_tag = manifest.get("snapshot_tag", result.get("snapshot_tag", ""))
    input_doc = result.get("input", "")
    started = result.get("started_at", "")
    duration_ms = result.get("duration_ms", 0)
    rules = manifest.get("rules", [])
    rule_titles = {r["id"]: r.get("title", "") for r in rules}
    results = result.get("results", [])
    generated_at = datetime.now(timezone.utc).isoformat()

    # Aggregates
    total = len(results)
    by_band = {"high": 0, "medium": 0, "low": 0}
    failed = 0
    for r in results:
        b = r.get("confidence_band") or "low"
        by_band[b] = by_band.get(b, 0) + 1
        if r.get("exit_code", 0) != 0:
            failed += 1

    summary_rows = []
    for r in results:
        rid = r.get("rule_id", "")
        title = rule_titles.get(rid, "")
        value = _short(r.get("value") or _value_from_raw(r.get("raw")))
        conf = r.get("confidence", 0)
        b = r.get("confidence_band") or "low"
        method = r.get("extraction_method") or "?"
        exit_code = r.get("exit_code", 0)
        status_icon = "✓" if exit_code == 0 else "✗"
        status_class = f"band-{b}" if exit_code == 0 else "band-fail"
        summary_rows.append(
            f"<tr class='{status_class}'>"
            f"<td>{status_icon}</td>"
            f"<td><code>{_html.escape(rid)}</code></td>"
            f"<td>{_html.escape(title)}</td>"
            f"<td>{_html.escape(value)}</td>"
            f"<td>{conf:.3f}</td>"
            f"<td>{_html.escape(b)}</td>"
            f"<td>{_html.escape(method)}</td>"
            f"</tr>"
        )

    detail_blocks = []
    for r in results:
        rid = r.get("rule_id", "")
        title = rule_titles.get(rid, "")
        raw_json = json.dumps(r.get("raw") or {}, ensure_ascii=False, indent=2)
        detail_blocks.append(
            f"<div class='detail-card'>"
            f"<h3><code>{_html.escape(rid)}</code> &middot; {_html.escape(title)}</h3>"
            f"<dl>"
            f"<dt>Value</dt><dd>{_html.escape(_short(r.get('value') or _value_from_raw(r.get('raw'))))}</dd>"
            f"<dt>Confidence</dt><dd>{r.get('confidence', 0):.3f} ({_html.escape(r.get('confidence_band') or '')})</dd>"
            f"<dt>Method</dt><dd>{_html.escape(r.get('extraction_method') or '?')}</dd>"
            f"<dt>Exit code</dt><dd>{r.get('exit_code', 0)}</dd>"
            f"</dl>"
            f"<details><summary>Raw workflow output</summary>"
            f"<pre>{_html.escape(raw_json)}</pre>"
            f"</details>"
            f"</div>"
        )

    return TEMPLATE.format(
        label=_html.escape(label),
        snap_tag=_html.escape(snap_tag),
        input_doc=_html.escape(input_doc),
        started=_html.escape(started),
        duration_s=f"{duration_ms / 1000:.2f}",
        total=total,
        high=by_band["high"],
        medium=by_band["medium"],
        low=by_band["low"],
        failed=failed,
        summary_rows="\n".join(summary_rows) or "<tr><td colspan='7'>(no results)</td></tr>",
        detail_blocks="\n".join(detail_blocks) or "<p>(no results)</p>",
        generated_at=generated_at,
    )


def _short(s, n=80):
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def _value_from_raw(raw):
    if not isinstance(raw, dict):
        return ""
    for k in ("extracted_value", "value", "result"):
        if k in raw:
            return raw[k]
    return ""


TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KC Release {label} — Verification Result</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 1100px; margin: 0 auto; padding: 24px;
         background: #0a0a0a; color: #e5e5e5; }}
  h1 {{ color: #f4f4f5; font-size: 1.5em; margin-bottom: 4px; }}
  .meta {{ color: #737373; font-size: 0.85em; margin-bottom: 24px; }}
  .meta code {{ color: #a3a3a3; }}
  .card {{ background: #171717; border: 1px solid #262626; border-radius: 8px;
          padding: 16px; margin: 12px 0; }}
  .metrics {{ display: flex; gap: 32px; flex-wrap: wrap; }}
  .metric .value {{ font-size: 2em; font-weight: 600; }}
  .metric .label {{ font-size: 0.8em; color: #737373; text-transform: uppercase; letter-spacing: .03em; }}
  .v-high {{ color: #22c55e; }}
  .v-med {{ color: #eab308; }}
  .v-low {{ color: #f97316; }}
  .v-fail {{ color: #ef4444; }}
  .tabs {{ display: flex; gap: 0; border-bottom: 1px solid #262626; margin: 24px 0 12px; }}
  .tab {{ padding: 8px 16px; cursor: pointer; color: #737373; border-bottom: 2px solid transparent; user-select: none; }}
  .tab.active {{ color: #f4f4f5; border-bottom-color: #22c55e; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid #262626; font-size: 0.92em; }}
  th {{ color: #737373; font-weight: 500; font-size: 0.78em; text-transform: uppercase; letter-spacing: .04em; }}
  td code {{ color: #a3a3a3; }}
  tr.band-high td:nth-child(6) {{ color: #22c55e; }}
  tr.band-medium td:nth-child(6) {{ color: #eab308; }}
  tr.band-low td:nth-child(6) {{ color: #f97316; }}
  tr.band-fail td:nth-child(6) {{ color: #ef4444; }}
  .detail-card {{ background: #171717; border: 1px solid #262626; border-radius: 8px;
                 padding: 14px 18px; margin: 14px 0; }}
  .detail-card h3 {{ margin: 0 0 10px; font-size: 1em; color: #e5e5e5; }}
  .detail-card dl {{ display: grid; grid-template-columns: 100px 1fr; gap: 4px 16px; margin: 0; }}
  .detail-card dt {{ color: #737373; font-size: 0.85em; }}
  .detail-card dd {{ margin: 0; color: #e5e5e5; }}
  details summary {{ cursor: pointer; color: #a3a3a3; font-size: 0.85em; margin-top: 8px; }}
  pre {{ background: #0d0d0d; border: 1px solid #262626; border-radius: 4px;
        padding: 10px; overflow-x: auto; font-size: 0.82em; color: #d4d4d4; }}
  .footer {{ color: #525252; font-size: 0.78em; margin-top: 32px; text-align: center; }}
</style>
</head>
<body>
<h1>KC Release <code>{label}</code></h1>
<p class="meta">
  Snapshot: <code>{snap_tag}</code> &middot;
  Input: <code>{input_doc}</code> &middot;
  Started: <code>{started}</code> &middot;
  Duration: <code>{duration_s}s</code>
</p>

<div class="card metrics">
  <div class="metric"><div class="value">{total}</div><div class="label">Rules run</div></div>
  <div class="metric"><div class="value v-high">{high}</div><div class="label">High confidence</div></div>
  <div class="metric"><div class="value v-med">{medium}</div><div class="label">Medium</div></div>
  <div class="metric"><div class="value v-low">{low}</div><div class="label">Low</div></div>
  <div class="metric"><div class="value v-fail">{failed}</div><div class="label">Failed</div></div>
</div>

<div class="tabs">
  <div class="tab active" data-target="summary" onclick="kcShow('summary', this)">Summary</div>
  <div class="tab" data-target="detail" onclick="kcShow('detail', this)">Per-rule detail</div>
</div>

<div id="summary" class="view">
  <div class="card">
    <table>
      <tr><th></th><th>Rule</th><th>Title</th><th>Value</th><th>Conf.</th><th>Band</th><th>Method</th></tr>
      {summary_rows}
    </table>
  </div>
</div>

<div id="detail" class="view" style="display:none">
  {detail_blocks}
</div>

<p class="footer">Generated {generated_at} — KC Agent CLI</p>

<script>
function kcShow(id, tab) {{
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  document.getElementById(id).style.display = '';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
}}
</script>
</body>
</html>
"""
