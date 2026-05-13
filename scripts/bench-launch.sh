#!/usr/bin/env bash
# bench-launch.sh — launch a benchmark session with one of the contestant
# conductors. Usage:  ./scripts/bench-launch.sh {glm|deepseek|xiaomi|tencent}
# Run each in its own Terminal tab. Workspaces are isolated per session.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 {glm|deepseek|xiaomi|tencent}" >&2
  exit 1
fi

# v0.7.3: secrets live outside the repo. Put bench keys in
# ~/.kc_agent/.bench-env (KC_WORKER_API_KEY, DEEPSEEK_API_KEY,
# XIAOMI_API_KEY, TENCENT_API_KEY) — sourced here, not committed.
if [ -f "$HOME/.kc_agent/.bench-env" ]; then
  set -a
  . "$HOME/.kc_agent/.bench-env"
  set +a
fi

if [ -z "${KC_WORKER_API_KEY:-}" ]; then
  echo "ERROR: KC_WORKER_API_KEY not set." >&2
  echo "  Put 'KC_WORKER_API_KEY=sk-...' in ~/.kc_agent/.bench-env" >&2
  echo "  or export it in your shell before running this script." >&2
  exit 1
fi

# Shared across all 3 sessions
export KC_CONTEXT_LIMIT=400000
export KC_WORKER_PROVIDER=siliconflow
export KC_WORKER_BASE_URL=https://api.siliconflow.cn/v1
# All 3 contestants (GLM-5.1, DeepSeek v4 Pro, MiMo v2.5 Pro) are hybrid
# reasoning models. v0.6.3 adds reasoning_content round-trip in engine.js
# so thinking-mode now works correctly across all providers — leaving it
# enabled benchmarks the flagship behavior. Set KC_DISABLE_THINKING=1
# manually if you ever need to compare against non-thinking output.

case "$1" in
  glm)
    # Conductor inherits global config (siliconflow + Pro/zai-org/GLM-5.1)
    # plus the .env's SILICONFLOW_API_KEY. No KC_PROVIDER override needed.
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-glm"
    CONDUCTOR_LABEL="Pro/zai-org/GLM-5.1 (siliconflow, from global config)"
    ;;
  deepseek)
    if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
      echo "ERROR: DEEPSEEK_API_KEY not set (required for deepseek session)." >&2
      echo "  Put 'DEEPSEEK_API_KEY=sk-...' in ~/.kc_agent/.bench-env." >&2
      exit 1
    fi
    export KC_PROVIDER=deepseek
    export KC_CONDUCTOR_MODEL=deepseek-v4-pro
    export KC_LLM_API_KEY="$DEEPSEEK_API_KEY"
    export KC_LLM_BASE_URL=https://api.deepseek.com
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-deepseek"
    CONDUCTOR_LABEL="deepseek-v4-pro (deepseek)"
    ;;
  xiaomi)
    if [ -z "${XIAOMI_API_KEY:-}" ]; then
      echo "ERROR: XIAOMI_API_KEY not set (required for xiaomi session)." >&2
      echo "  Put 'XIAOMI_API_KEY=tp-...' in ~/.kc_agent/.bench-env." >&2
      exit 1
    fi
    export KC_PROVIDER=xiaomi
    # Endpoint normalizes model IDs to lowercase — uppercase is rejected with
    # "Not supported model". Confirmed via /v1/models listing on 2026-04-28.
    export KC_CONDUCTOR_MODEL=mimo-v2.5-pro
    export KC_LLM_API_KEY="$XIAOMI_API_KEY"
    export KC_LLM_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-xiaomi"
    CONDUCTOR_LABEL="mimo-v2.5-pro (xiaomi)"
    ;;
  tencent)
    if [ -z "${TENCENT_API_KEY:-}" ]; then
      echo "ERROR: TENCENT_API_KEY not set (required for tencent session)." >&2
      echo "  Put 'TENCENT_API_KEY=sk-tp-...' in ~/.kc_agent/.bench-env." >&2
      exit 1
    fi
    export KC_PROVIDER=tencent
    # hy3-preview is a hidden flagship — accepts requests but doesn't appear
    # in /models listing. Probe on 2026-04-28 confirmed: standard OpenAI SSE,
    # no reasoning_content emission (non-thinking by default).
    # Official spec: 256K context. Setting KC limit to 200K per Yibo's call.
    # (Empirically Token Plan endpoint may cap below 256K — see obs doc; if
    # 500s recur, drop further.)
    export KC_CONDUCTOR_MODEL=hy3-preview
    export KC_LLM_API_KEY="$TENCENT_API_KEY"
    export KC_LLM_BASE_URL=https://api.lkeap.cloud.tencent.com/plan/v3
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-tencent"
    # Override the bench-wide 400K — hy3 official limit is 256K, KC stays under.
    export KC_CONTEXT_LIMIT=200000
    # Higher retry budget remains useful for genuinely transient blips.
    export KC_MAX_RETRIES=20
    CONDUCTOR_LABEL="hy3-preview (tencent, 200K ctx)"
    ;;
  *)
    echo "unknown session: $1 (valid: glm, deepseek, xiaomi, tencent)" >&2
    exit 1
    ;;
esac

cat <<EOF
─────────────────────────────────────────────────────
  E2E #5 launcher — session: $1
  Conductor: $CONDUCTOR_LABEL
  Workers:   $KC_WORKER_PROVIDER (Pro/zai-org/GLM-5, Pro/moonshotai/Kimi-K2.5, ...)
  Workspace: $KC_WORKSPACE_ROOT
  Context:   $KC_CONTEXT_LIMIT
─────────────────────────────────────────────────────
EOF

cd /Users/mac/Desktop/kc_cli/archive/test_data_3_lite
exec kc-beta
