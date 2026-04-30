#!/bin/sh
# Minimal local-preview server for the KC release dashboard.
# Renders dashboard.html if missing, then serves on PORT (default 8765).

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

PORT="${PORT:-8765}"

if [ ! -f dashboard.html ] || [ output/results/summary.json -nt dashboard.html ]; then
  echo "rendering dashboard.html..."
  python3 render_dashboard.py output/results/ > dashboard.html
fi

echo "serving on http://localhost:$PORT/dashboard.html"
exec python3 -m http.server "$PORT"
