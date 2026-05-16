#!/bin/bash
# Local helper: rewrite a workspace's .env so TIER1/TIER2 point at DeepSeek
# models instead of the SiliconFlow defaults seeded by `kc-beta init`.
#
# v0.8.2 LOCAL setup — kc-beta defaults stay on SiliconFlow for shipped
# users (per D1 lock 2026-05-16). This script is for the developer's
# personal benches only.
#
# Usage:
#   bash scripts/setup-deepseek-workspace.sh ~/.kc_agent/workspaces/<bench-name>
#
# Idempotent: re-running after an already-DeepSeek .env is a no-op.

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "usage: $0 <workspace-dir>" >&2
  exit 1
fi

WS="$1"
ENV="$WS/.env"

if [ ! -f "$ENV" ]; then
  echo "error: $ENV does not exist (did kc-beta init run?)" >&2
  exit 1
fi

# Detect already-applied state and bail early
if grep -q "^TIER1=deepseek-v4-pro" "$ENV"; then
  echo "$ENV already configured for DeepSeek; no change."
  exit 0
fi

# In-place rewrite. macOS sed needs the empty -i argument.
sed -i.bak \
  -e 's|^TIER1=.*|TIER1=deepseek-v4-pro|' \
  -e 's|^TIER2=.*|TIER2=deepseek-v4-flash|' \
  "$ENV"

# .bak file is sed's safety net — keep it for ~1 cycle then it can be removed
echo "rewrote $ENV (backup at $ENV.bak):"
grep -E '^(TIER1|TIER2)=' "$ENV"
echo ""
echo "Note: worker_api_key + worker_base_url come from ~/.kc_agent/config.json"
echo "      (set globally — no per-workspace edit needed for those)."
