#!/usr/bin/env python3
"""
KC release runner — standalone, no kc-beta dependency.

Loads the bundled release manifest, runs each rule's workflow against an
input document, scores confidence, aggregates results.

Usage:
    python run.py <input-doc> [--rule R001] [--output result.json] [--dashboard]

Required env vars (same conventions as KC's .env):
    LLM_API_KEY, LLM_BASE_URL
    TIER1, TIER2, TIER3, TIER4   (any subset of model lists, comma-separated)

Workflows are invoked as `python <workflow_path> <input-doc>` and must emit
their result as a single JSON object on the last line of stdout.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# kc_runtime is bundled next to this file
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from kc_runtime import confidence as kc_conf
from kc_runtime import dashboard as kc_dash


def main():
    ap = argparse.ArgumentParser(description="Run a KC release on a document.")
    ap.add_argument("input", help="Path to the input document (PDF, DOCX, TXT, ...)")
    ap.add_argument("--rule", help="Run only this rule id (default: all rules in catalog)")
    ap.add_argument("--output", "-o", help="Write aggregated JSON here (default: stdout)")
    ap.add_argument("--dashboard", action="store_true",
                    help="Also emit an HTML dashboard next to the JSON output")
    args = ap.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        _die(f"Input file not found: {input_path}")

    manifest = _load_json(HERE / "manifest.json", required=True)
    catalog = _load_json(HERE / "catalog.json", required=False) or []
    historical = _load_calibration(HERE / "confidence_calibration.json")
    corner_cases = _load_json(HERE / "corner_cases.json", required=False)

    rules = manifest.get("rules", [])
    if args.rule:
        rules = [r for r in rules if r.get("id") == args.rule]
        if not rules:
            _die(f"No rule '{args.rule}' in manifest")

    if not _check_env():
        sys.exit(2)

    started = datetime.now(timezone.utc).isoformat()
    t0 = time.monotonic()

    results = []
    any_failure = False
    for rule in rules:
        result = _run_one(rule, input_path, catalog,
                          historical=historical, corner_cases=corner_cases)
        results.append(result)
        if result.get("exit_code", 0) != 0:
            any_failure = True

    duration_ms = int((time.monotonic() - t0) * 1000)
    aggregated = {
        "release": manifest.get("label"),
        "snapshot_tag": manifest.get("snapshot_tag"),
        "input": str(input_path),
        "started_at": started,
        "duration_ms": duration_ms,
        "results": results,
    }

    out_text = json.dumps(aggregated, ensure_ascii=False, indent=2)
    if args.output:
        out_path = Path(args.output).resolve()
        out_path.write_text(out_text, encoding="utf-8")
        print(f"Wrote {out_path}", file=sys.stderr)
    else:
        print(out_text)

    if args.dashboard:
        html = kc_dash.render(aggregated, manifest)
        if args.output:
            html_path = Path(args.output).with_suffix(".html")
        else:
            html_path = HERE / f"result_{int(time.time())}.html"
        html_path.write_text(html, encoding="utf-8")
        print(f"Dashboard: {html_path}", file=sys.stderr)

    sys.exit(1 if any_failure else 0)


def _run_one(rule, input_path, catalog, *, historical, corner_cases):
    rule_id = rule.get("id")
    workflow_rel = rule.get("workflow")
    if not workflow_rel:
        return _error_result(rule_id, "no workflow path in manifest")

    workflow_abs = (HERE / workflow_rel).resolve()
    if not workflow_abs.is_file():
        return _error_result(rule_id, f"workflow not found: {workflow_rel}")

    try:
        proc = subprocess.run(
            ["python", str(workflow_abs), str(input_path)],
            capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return _error_result(rule_id, "workflow timed out (300s)")
    except FileNotFoundError:
        return _error_result(rule_id, "`python` not found on PATH")

    raw_stdout = (proc.stdout or "").strip()
    raw_data = _parse_last_json_line(raw_stdout)

    extracted_value = _extract_value(raw_data)
    method = (raw_data or {}).get("extraction_method") or "llm"
    source_text = (raw_data or {}).get("raw_text") or ""

    conf = kc_conf.score(
        rule_id=rule_id,
        extracted_value=str(extracted_value),
        source_text=source_text,
        method=method,
        document=str(input_path),
        historical=historical,
        corner_cases=corner_cases,
    )

    return {
        "rule_id": rule_id,
        "value": extracted_value,
        "confidence": conf,
        "confidence_band": kc_conf.band(conf),
        "extraction_method": method,
        "exit_code": proc.returncode,
        "raw": raw_data if raw_data is not None else {"stderr": (proc.stderr or "")[:2000]},
    }


def _error_result(rule_id, msg):
    return {
        "rule_id": rule_id,
        "value": None,
        "confidence": 0.0,
        "confidence_band": "low",
        "extraction_method": "fallback",
        "exit_code": 2,
        "raw": {"error": msg},
    }


def _parse_last_json_line(text):
    if not text:
        return None
    # Walk lines from the bottom, return the first that parses as a JSON object
    for line in reversed(text.split("\n")):
        line = line.strip()
        if not line:
            continue
        if line[0] not in "{[":
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def _extract_value(raw):
    if not isinstance(raw, dict):
        return None
    for k in ("extracted_value", "value", "result"):
        if k in raw:
            return raw[k]
    return None


def _load_json(path, *, required):
    if not path.is_file():
        if required:
            _die(f"Required file missing: {path.name}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        _die(f"Invalid JSON in {path.name}: {e}")


def _load_calibration(path):
    data = _load_json(path, required=False)
    if not data:
        return {}
    return data.get("historical_accuracy") or data or {}


def _check_env():
    missing = []
    for k in ("LLM_API_KEY",):
        if not os.environ.get(k):
            missing.append(k)
    tiers = [t for t in ("TIER1", "TIER2", "TIER3", "TIER4") if os.environ.get(t)]
    if not tiers:
        missing.append("at least one of TIER1..TIER4")
    if missing:
        print("Missing env vars: " + ", ".join(missing), file=sys.stderr)
        print("Workflows in this release call worker LLMs and need these set.", file=sys.stderr)
        return False
    return True


def _die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
