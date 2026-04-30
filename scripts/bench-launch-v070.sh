#!/usr/bin/env bash
# bench-launch-v070.sh — launch a v0.7.0 verification session with one
# of the two contestant conductors. Run each in its own Terminal tab.
# Workspaces are under bench-*-v070 to keep distinct from E2E #5
# (those live under bench-* without the suffix).
#
# Usage:
#   ./scripts/bench-launch-v070.sh glm        # SiliconFlow GLM-5.1, 200K
#   ./scripts/bench-launch-v070.sh deepseek   # DeepSeek API v4 Pro, 400K
#
# Watch for (post-v0.7.0):
#   - force-bypass count (events.jsonl phase_transition forced=true) ≤ 3/12 vs E2E #5's 12/12
#   - engine milestones match disk reality at every phase boundary
#   - GLM heap < 2 GB (vs 3.8 GB in E2E #5) — budget-aware compact + E1m + per-provider cap
#   - Anthropic-style thinking_delta + signature_delta round-trip works (validates Group L)
#   - finalization auto-copies template/release/v1/ → output/releases/v1/ on phase entry,
#     run.py exits 0 on a smoke input
#   - parser native rate ≥ 95% on samples/ (mammoth + word-extractor + LibreOffice fallback)
#   - case-collision warning surfaces on macOS for SKILL.md/skill.md attempts (Group M)

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 {glm|deepseek}" >&2
  exit 1
fi

# Shared across both sessions — workers stay on SiliconFlow's TIER1-4
# pool so the only variable is the conductor model.
export KC_WORKER_PROVIDER=siliconflow
export KC_WORKER_API_KEY=sk-vmvteahukhncdvreaazgnyxhrogbnjahthlrgvjvmxryvyiq
export KC_WORKER_BASE_URL=https://api.siliconflow.cn/v1

# v0.7.0 hardens reasoning_content round-trip (engine.js v0.6.3 path +
# Group L Anthropic SSE thinking_delta). Leave thinking-mode on so the
# verification benchmarks flagship behavior. Set KC_DISABLE_THINKING=1
# manually if you need a non-thinking comparison run.

case "$1" in
  glm)
    # GLM-5.1 on SiliconFlow's deployment caps prompts at ~202,752
    # tokens — E2E #5 hit HTTP 413 at 203,363 with KC_CONTEXT_LIMIT=400000.
    # v0.7.0 E3 added providerContextCap=200000 so config layer auto-clamps;
    # setting KC_CONTEXT_LIMIT=200000 here makes the cap explicit and
    # avoids the auto-clamp warning on every launch.
    export KC_CONTEXT_LIMIT=200000
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-glm-v070"
    CONDUCTOR_LABEL="Pro/zai-org/GLM-5.1 (siliconflow, 200K ctx)"
    ;;
  deepseek)
    # DeepSeek API has genuine 1M-token native context. KC's earlier
    # 400K-on-everything choice was the right ceiling for serial
    # ralph-loop — keep it. v0.7.0 E2's budget-aware compact threshold
    # is now token-based, so this won't trigger excess compact churn.
    export KC_CONTEXT_LIMIT=400000
    export KC_PROVIDER=deepseek
    export KC_CONDUCTOR_MODEL=deepseek-v4-pro
    export KC_LLM_API_KEY=sk-5267402b58f14d63bb9f2ab211057ca3
    export KC_LLM_BASE_URL=https://api.deepseek.com
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-deepseek-v070"
    CONDUCTOR_LABEL="deepseek-v4-pro (deepseek, 400K ctx)"
    ;;
  *)
    echo "unknown session: $1 (valid: glm, deepseek)" >&2
    exit 1
    ;;
esac

cat <<EOF
─────────────────────────────────────────────────────
  v0.7.0 verification launcher — session: $1
  Conductor:  $CONDUCTOR_LABEL
  Workers:    $KC_WORKER_PROVIDER TIER1-4
  Workspace:  $KC_WORKSPACE_ROOT
  Context:    $KC_CONTEXT_LIMIT
  Thinking:   on (KC_DISABLE_THINKING unset)
  Tagged at:  $(cd "$(dirname "$0")/.." && git describe --tags --always 2>/dev/null || echo "unknown")
─────────────────────────────────────────────────────
EOF

cd /Users/mac/Desktop/kc_cli/archive/test_data_3_lite
exec kc-beta
