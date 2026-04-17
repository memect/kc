#!/bin/sh
# Serve this release directory locally so dashboards open in a browser.
# Generated HTML files (e.g. result_*.html, dashboard.html) become reachable
# at http://localhost:<port>/...
#
# Usage:
#   ./serve.sh           # default port 8080
#   ./serve.sh 9000      # custom port
#
# Stop with Ctrl-C.

PORT="${1:-8080}"
cd "$(dirname "$0")" || exit 1
echo "Serving $(pwd) on http://localhost:${PORT}/"
exec python -m http.server "$PORT"
