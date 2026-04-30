#!/usr/bin/env python3
"""
KC release runner v1.

Entry point for a self-contained KC release bundle. Loads the manifest,
iterates rules, dispatches each rule's workflow against the supplied
input documents, writes per-document verdict JSONs to output/results/.

Usage:
    python3 run.py <input_dir>
    python3 run.py <input_dir> --rules R001,R005,R012
    python3 run.py --doc <single_file>           # single-doc smoke test

The bundle is shipped from KC's finalization phase. KC's run-in-CLI
mode is the source of truth; this is the ship-as-artifact form for
re-running verification on new document batches without the full KC
toolchain installed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Add kc_runtime to path so submodules import cleanly when run from any cwd.
sys.path.insert(0, str(HERE))

from kc_runtime import doc_parser, confidence  # noqa: E402


def _load_json(path: Path, *, required: bool = False, default=None):
    if not path.exists():
        if required:
            raise SystemExit(
                f"required file missing: {path}\n"
                f"this release bundle was shipped without a complete manifest.\n"
                f"re-run KC finalization or contact the bundle author."
            )
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _select_rules(catalog, rule_filter):
    if not rule_filter:
        return catalog
    wanted = set(rule_filter.split(","))
    return [r for r in catalog if r.get("id") in wanted]


def _list_input_docs(input_dir: Path):
    if not input_dir.is_dir():
        raise SystemExit(f"input_dir not a directory: {input_dir}")
    docs = []
    for entry in sorted(input_dir.iterdir()):
        if entry.is_file() and not entry.name.startswith("."):
            docs.append(entry)
    return docs


def _run_workflow(rule_id: str, workflow_path: Path, doc_path: Path) -> dict:
    """
    Dispatch a single workflow against a single document.

    Each workflow is a stand-alone Python script that takes a document
    path on argv and emits a JSON verdict on stdout. Workflows are
    sandbox-runnable: no shared module state, no special imports beyond
    stdlib + kc_runtime.
    """
    if not workflow_path.exists():
        return {
            "rule_id": rule_id,
            "verdict": "ERROR",
            "confidence": 0.0,
            "error_type": "workflow_missing",
            "reason": f"workflow not found: {workflow_path.name}",
        }
    try:
        proc = subprocess.run(
            [sys.executable, str(workflow_path), str(doc_path)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode != 0:
            return {
                "rule_id": rule_id,
                "verdict": "ERROR",
                "confidence": 0.0,
                "error_type": "workflow_exit_nonzero",
                "reason": (proc.stderr or proc.stdout or "").strip()[:500],
            }
        # Workflow contract: last stdout line is the verdict JSON.
        last = next(
            (line for line in reversed(proc.stdout.splitlines()) if line.strip()),
            None,
        )
        if not last:
            return {
                "rule_id": rule_id,
                "verdict": "ERROR",
                "confidence": 0.0,
                "error_type": "empty_workflow_output",
            }
        verdict = json.loads(last)
        verdict.setdefault("rule_id", rule_id)
        return verdict
    except subprocess.TimeoutExpired:
        return {
            "rule_id": rule_id,
            "verdict": "ERROR",
            "confidence": 0.0,
            "error_type": "workflow_timeout",
        }
    except json.JSONDecodeError as exc:
        return {
            "rule_id": rule_id,
            "verdict": "ERROR",
            "confidence": 0.0,
            "error_type": "workflow_output_not_json",
            "reason": str(exc),
        }


def main():
    parser = argparse.ArgumentParser(prog="run.py", description="KC release runner")
    parser.add_argument("input_dir", nargs="?", help="Directory of input documents")
    parser.add_argument("--doc", help="Single document path (smoke-test mode)")
    parser.add_argument("--rules", help="Comma-separated rule_ids to run (default: all)")
    parser.add_argument("--output-dir", default=str(HERE / "output" / "results"))
    args = parser.parse_args()

    if not args.input_dir and not args.doc:
        parser.error("either input_dir or --doc is required")

    manifest = _load_json(HERE / "manifest.json", required=True)
    catalog = _load_json(HERE / "catalog.json", required=False, default=[])
    historical = _load_json(
        HERE / "confidence_calibration.json",
        required=False,
        default={"historical_accuracy": {}},
    )

    rules = _select_rules(catalog, args.rules)
    if not rules:
        raise SystemExit("no rules to run (catalog empty or filter excluded all)")

    if args.doc:
        docs = [Path(args.doc).resolve()]
    else:
        docs = _list_input_docs(Path(args.input_dir).resolve())

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    workflows = manifest.get("workflows", {})
    summary = {"total_runs": 0, "by_verdict": {}, "errors": 0}

    for doc in docs:
        # Lightweight parse — let the workflow do its own parse if needed,
        # but offer a doc_parser preflight so workflows can rely on the
        # text being available.
        try:
            doc_parser.preflight(doc)
        except Exception as exc:
            print(f"[run.py] preflight failed for {doc.name}: {exc}", file=sys.stderr)

        results = {}
        for rule in rules:
            rule_id = rule.get("id")
            if not rule_id:
                continue
            wf_relpath = workflows.get(rule_id)
            if not wf_relpath:
                results[rule_id] = {
                    "rule_id": rule_id,
                    "verdict": "NO_WORKFLOW",
                    "confidence": 0.0,
                }
                continue
            wf_path = HERE / wf_relpath
            verdict = _run_workflow(rule_id, wf_path, doc)
            verdict = confidence.calibrate(verdict, historical)
            results[rule_id] = verdict
            summary["total_runs"] += 1
            v = verdict.get("verdict", "UNKNOWN")
            summary["by_verdict"][v] = summary["by_verdict"].get(v, 0) + 1
            if v == "ERROR":
                summary["errors"] += 1

        out_file = output_dir / f"{doc.stem}.json"
        out_file.write_text(
            json.dumps(
                {"document": str(doc), "results": results}, ensure_ascii=False, indent=2
            ),
            encoding="utf-8",
        )

    summary_path = output_dir / "summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
