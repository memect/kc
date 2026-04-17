#!/usr/bin/env python3
"""
Re-render an HTML dashboard from an existing run.py result JSON.

Useful when run.py was invoked without --dashboard, or when the dashboard
template is updated and you want to re-render past results.

Usage:
    python render_dashboard.py <result.json> [--output dashboard.html]
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from kc_runtime import dashboard as kc_dash


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("result", help="Path to a result.json produced by run.py")
    ap.add_argument("--output", "-o", help="HTML output path (default: alongside result)")
    args = ap.parse_args()

    result_path = Path(args.result).resolve()
    if not result_path.is_file():
        print(f"error: result file not found: {result_path}", file=sys.stderr)
        sys.exit(2)

    manifest_path = HERE / "manifest.json"
    if not manifest_path.is_file():
        print(f"error: manifest.json not found alongside this script", file=sys.stderr)
        sys.exit(2)

    result = json.loads(result_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    html = kc_dash.render(result, manifest)

    out_path = Path(args.output) if args.output else result_path.with_suffix(".html")
    out_path.write_text(html, encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
