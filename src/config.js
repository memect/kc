import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getProviderById } from "./providers.js";

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".kc_agent");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");

function loadGlobalConfig() {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Parse a .env file into a key-value object.
 * Handles KEY=VALUE lines, ignores comments and blank lines.
 */
// v0.8 P1-B: exported so engine.js can re-overlay workspace .env after
// the workspace directory is known (cli/index.js calls loadSettings()
// without a workspace path because the path isn't known until the engine
// constructs the Workspace object).
export function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  // v0.7.0 H9: defend bootstrap against a .env that exists but isn't
  // readable (permission denied, unexpected directory, encoding error,
  // race with concurrent write). Old code threw and crashed config
  // bootstrap before the CLI was even up — return empty {} on any
  // read failure so the user sees the more actionable
  // "no API key configured" error from loadSettings instead.
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }
  const env = {};
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Load settings by merging: global config (lowest) -> workspace .env (highest).
 * Supports both new generic keys (LLM_API_KEY) and legacy keys (SILICONFLOW_API_KEY).
 * @param {string} [workspacePath] - Optional workspace directory for .env override
 */
export function loadSettings(workspacePath) {
  const gc = loadGlobalConfig();
  const env = workspacePath ? loadEnvFile(path.join(workspacePath, ".env")) : {};

  // Session-scoped overrides (process.env). Internal knob for benchmarking
  // — lets a single launch swap conductor/workspace/context without touching
  // ~/.kc_agent/config.json. Not exposed in --help or onboard.
  const penv = process.env;

  // Resolve provider metadata for authType/apiFormat defaults
  const provider = penv.KC_PROVIDER || gc.provider || "siliconflow";
  const providerDef = getProviderById(provider);

  const settings = {
    // Provider identity
    provider,
    authType: gc.auth_type || providerDef?.authType || "bearer",
    apiFormat: gc.api_format || providerDef?.apiFormat || "openai",

    // Conductor LLM (process.env wins → workspace .env → global config)
    llmApiKey: penv.KC_LLM_API_KEY || env.LLM_API_KEY || env.SILICONFLOW_API_KEY || gc.api_key || "",
    llmBaseUrl: penv.KC_LLM_BASE_URL || env.LLM_BASE_URL || env.SILICONFLOW_BASE_URL || gc.base_url || "https://api.siliconflow.cn/v1",
    kcModel: penv.KC_CONDUCTOR_MODEL || gc.conductor_model || "glm-5",
    kcMaxTokens: parseInt(env.KC_MAX_TOKENS || gc.kc_max_tokens?.toString() || "65536", 10),

    // Tier models (from .env or global config tiers)
    tier1: env.TIER1 || gc.tiers?.tier1 || "",
    tier2: env.TIER2 || gc.tiers?.tier2 || "",
    tier3: env.TIER3 || gc.tiers?.tier3 || "",
    tier4: env.TIER4 || gc.tiers?.tier4 || "",

    // VLM tiers (vision/OCR models). v0.7.4: accept OCR_MODEL_TIER* as
    // alias since template/.env.template + initializer.js seed that name.
    // VLM_TIER* takes precedence when both are set.
    vlmTier1: env.VLM_TIER1 || env.OCR_MODEL_TIER1 || gc.vlm_tiers?.tier1 || "",
    vlmTier2: env.VLM_TIER2 || env.OCR_MODEL_TIER2 || gc.vlm_tiers?.tier2 || "",
    vlmTier3: env.VLM_TIER3 || env.OCR_MODEL_TIER3 || gc.vlm_tiers?.tier3 || "",

    // Worker LLM — optional, defaults to conductor config (process.env wins)
    workerProvider: penv.KC_WORKER_PROVIDER || gc.worker_provider || "",
    workerApiKey: penv.KC_WORKER_API_KEY || env.WORKER_API_KEY || gc.worker_api_key || "",
    workerBaseUrl: penv.KC_WORKER_BASE_URL || env.WORKER_BASE_URL || gc.worker_base_url || "",
    workerAuthType: gc.worker_auth_type || "",
    workerApiFormat: gc.worker_api_format || "",

    // Document parsing
    mineruApiUrl: env.MINERU_API_URL || "",
    mineruApiKey: env.MINERU_API_KEY || "",

    // Workspace (process.env wins — for parallel benchmark runs)
    kcWorkspaceRoot: penv.KC_WORKSPACE_ROOT || gc.workspace_root || path.join(os.homedir(), ".kc_agent", "workspaces"),
    // v0.8 P1-F sandbox_exec timeout model. Default 120s (Claude Code parity),
    // max 600s (10 min) ceiling. Agent can pass per-call timeout_ms up to max.
    // Legacy KC_EXEC_TIMEOUT (seconds) accepted as deprecation alias for default.
    kcExecDefaultTimeoutMs: parseInt(
      env.KC_EXEC_DEFAULT_TIMEOUT_MS ||
      (env.KC_EXEC_TIMEOUT ? String(parseInt(env.KC_EXEC_TIMEOUT, 10) * 1000) : "") ||
      "120000",
      10,
    ),
    kcExecMaxTimeoutMs: parseInt(env.KC_EXEC_MAX_TIMEOUT_MS || "600000", 10),
    // Legacy alias kept for any consumer reading it directly. Computed
    // from the new ms-based field for consistency. New code should read
    // kcExecDefaultTimeoutMs / kcExecMaxTimeoutMs.
    kcExecTimeout: parseInt(env.KC_EXEC_TIMEOUT || "120", 10),

    // Accuracy thresholds
    skillAccuracy: parseFloat(env.SKILL_ACCURACY || gc.accuracy_threshold?.toString() || "0.9"),
    workflowAccuracy: parseFloat(env.WORKFLOW_ACCURACY || "0.9"),

    // Advanced thresholds (from onboarding or .env)
    systemicThreshold: parseFloat(env.SYSTEMIC_THRESHOLD || gc.systemic_threshold?.toString() || "0.10"),
    spotCheckRate: parseFloat(env.SPOT_CHECK_RATE || gc.spot_check_rate?.toString() || "0.10"),
    tierTolerance: parseFloat(env.TIER_TOLERANCE || gc.tier_tolerance?.toString() || "0.05"),

    // Evolution
    maxIterations: parseInt(env.MAX_ITERATIONS || "20", 10),
    monitorFrequency: env.MONITOR_FREQUENCY || "mid",

    // Web search
    tavilyApiKey: env.TAVILY_API_KEY || gc.tavily_api_key || "",

    // Context management — A2: prefer per-provider cap from providers.js
    // over the generic 200000 default. process.env.KC_CONTEXT_LIMIT wins
    // (session-scoped override for benchmarking long-context models without
    // editing global config), then workspace .env, then global config, then
    // provider.contextLimit, then a safe 200000 fallback.
    //
    // v0.7.0 E3 (#96): providerContextCap is the deployment hard ceiling
    // (e.g., SiliconFlow's GLM-5.1 caps at 202_752 despite the model's
    // native 1M). Effective contextLimit = min(user-requested,
    // providerContextCap). E2E #5 GLM hit HTTP 413 because user set
    // KC_CONTEXT_LIMIT=400000 but the deployment refused at ~203k.
    // The cap is applied AFTER user-priority resolution so the user
    // can't accidentally bypass it.
    kcContextLimit: (() => {
      const requested = parseInt(
        penv.KC_CONTEXT_LIMIT ||
          env.KC_CONTEXT_LIMIT ||
          gc.kc_context_limit?.toString() ||
          providerDef?.contextLimit?.toString() ||
          "200000",
        10,
      );
      const cap = providerDef?.providerContextCap;
      if (typeof cap === "number" && cap > 0 && requested > cap) {
        // Surface a one-time warning so users notice the clamp without
        // burying it in events.jsonl.
        // eslint-disable-next-line no-console
        console.warn(
          `[config] KC_CONTEXT_LIMIT=${requested} clamped to ${cap} ` +
          `(provider ${providerDef.id} hardCap). E2E #5 hit HTTP 413 at ` +
          `~203k on SiliconFlow GLM-5.1; cap protects against deployment ` +
          `hard-ceiling rejections.`,
        );
        return cap;
      }
      return requested;
    })(),
    toolOutputOffloadTokens: parseInt(env.TOOL_OUTPUT_OFFLOAD_TOKENS || gc.tool_output_offload_tokens?.toString() || "2000", 10),
    toolOutputOffloadErrorTokens: parseInt(env.TOOL_OUTPUT_OFFLOAD_ERROR_TOKENS || gc.tool_output_offload_error_tokens?.toString() || "500", 10),
    maxMessageTokens: parseInt(env.MAX_MESSAGE_TOKENS || gc.max_message_tokens?.toString() || "60000", 10),

    // File system (Block 11)
    gitAutoCommit: (env.GIT_AUTO_COMMIT ?? gc.git_auto_commit ?? true) !== false &&
                   (env.GIT_AUTO_COMMIT !== "false") &&
                   (gc.git_auto_commit !== false),
    largeRefThresholdMB: parseInt(env.LARGE_REF_THRESHOLD_MB || gc.large_ref_threshold_mb?.toString() || "10", 10),

    // Language
    language: env.LANGUAGE || gc.language || "en",

    // B0.6: Parallel ralph-loop guard. Parallelism > 1 is a LOADED footgun
    // until the heap-safety conformance gate (B0.7) passes. Unsetting the
    // verified flag forces serial execution — KC_PARALLELISM_VERIFIED must
    // be set explicitly after heap.jsonl shows a flat RSS trajectory over
    // ≥ 2h. This prevents accidental $100+ runaway runs.
    //
    // Source priority (highest first): process.env (B3 CLI flag sets this)
    // → workspace .env → global config. Parsed here; the actual effective
    // value is computed by a helper below that downgrades to 1 if the
    // verified flag isn't set.
    parallelismVerified: (() => {
      const raw = (process.env.KC_PARALLELISM_VERIFIED ||
        env.KC_PARALLELISM_VERIFIED || gc.parallelism_verified || "").toString();
      return raw === "1" || raw.toLowerCase() === "true";
    })(),
    parallelismRequested: (() => {
      const raw = process.env.KC_PARALLELISM || env.KC_PARALLELISM || gc.parallelism;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) return 1;
      return Math.min(n, 8); // max 8 per plan — prevents API-spend runaway
    })(),
  };

  // Effective parallelism is silently clamped to 1 unless KC_PARALLELISM_VERIFIED
  // is set. Callers (engine.runTaskLoop, /parallelism slash command, CLI flag)
  // should read this instead of parallelismRequested.
  settings.effectiveParallelism = () =>
    settings.parallelismVerified ? settings.parallelismRequested : 1;

  // Effective worker config (falls back to conductor config)
  settings.effectiveWorkerProvider = () => settings.workerProvider || settings.provider;
  settings.effectiveWorkerApiKey = () => settings.workerApiKey || settings.llmApiKey;
  settings.effectiveWorkerBaseUrl = () => {
    if (settings.workerBaseUrl) return settings.workerBaseUrl;
    // If worker uses a different provider, use that provider's default base URL
    if (settings.workerProvider && settings.workerProvider !== settings.provider) {
      const wp = getProviderById(settings.workerProvider);
      return wp?.baseUrl || settings.llmBaseUrl;
    }
    return settings.llmBaseUrl;
  };
  settings.effectiveWorkerAuthType = () => {
    if (settings.workerAuthType) return settings.workerAuthType;
    if (settings.workerProvider && settings.workerProvider !== settings.provider) {
      const wp = getProviderById(settings.workerProvider);
      return wp?.authType || settings.authType;
    }
    return settings.authType;
  };
  settings.effectiveWorkerApiFormat = () => {
    if (settings.workerApiFormat) return settings.workerApiFormat;
    if (settings.workerProvider && settings.workerProvider !== settings.provider) {
      const wp = getProviderById(settings.workerProvider);
      return wp?.apiFormat || settings.apiFormat;
    }
    return settings.apiFormat;
  };

  return settings;
}

export { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_PATH };
