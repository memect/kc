#!/usr/bin/env bash
# bench-launch-v071.sh — launch a v0.7.1 verification session with one
# of the two contestant conductors. Run each in its own Terminal tab.
# Workspaces are under bench-*-v071 to keep distinct from E2E #6
# (those live under bench-*-v070).
#
# Usage:
#   ./scripts/bench-launch-v071.sh glm        # SiliconFlow GLM-5.1, 200K
#   ./scripts/bench-launch-v071.sh deepseek   # DeepSeek API v4 Pro, 400K
#
# Watch for (post-v0.7.1):
#   - skill_testing → distillation natural advance (no force) — Group 1a
#     broadened skillsTested derivation reads output/*.json with rule_id
#     field, so per-rule sandbox results in output/results/ now count.
#     Validates the headline drift fix from E2E #6 audit.
#   - phaseMisfitHint nudges fire on ephemeral sandbox_exec test runs —
#     Group 1b. Visible as <system-reminder> in tool results when agent
#     runs `python check.py samples/foo.txt` without persisting verdict
#     to rule_skills/<id>/test_results.json or output/<...>.json.
#   - chunk_refs / coverage_audit advisories appear on rule_extraction
#     phase_advance attempts when those criteria are missing — Group 2a/2b.
#   - phase_advance refusal text now surfaces engineCounts so the agent
#     sees the precise milestone deltas — Group 2c.
#   - PATTERNS.md written as opening step-2 (vs DS's post-rollback in
#     E2E #6) — Group 3b reinforcement in work-decomposition skill.
#   - check.py files contain real verification logic (vs DS's
#     {"pass": null, "method": "stub"} pattern) — Group 3a anti-pattern
#     teaching.
#
# Targets:
#   - Force-bypass count ≤ 2/N transitions per session (was 3/3 GLM,
#     7/8 DS in v070 run)
#   - skillsTested derivation reflects disk reality at advance time
#   - No regression in v0.7.0 wins (filesystem-derived gates,
#     agent-owned tasking, release template usage)

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
    # Conductor inherits global config (siliconflow + Pro/zai-org/GLM-5.1
    # from ~/.kc_agent/config.json) plus .env's SILICONFLOW_API_KEY.
    # No KC_PROVIDER override needed.
    export KC_CONTEXT_LIMIT=200000
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-glm-v071"
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
    export KC_WORKSPACE_ROOT="$HOME/.kc_agent/bench-deepseek-v071"
    CONDUCTOR_LABEL="deepseek-v4-pro (deepseek, 400K ctx)"
    ;;
  *)
    echo "unknown session: $1 (valid: glm, deepseek)" >&2
    exit 1
    ;;
esac

cat <<EOF
─────────────────────────────────────────────────────
  v0.7.1 verification launcher — session: $1
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
