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
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
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

  // Resolve provider metadata for authType/apiFormat defaults
  const provider = gc.provider || "siliconflow";
  const providerDef = getProviderById(provider);

  const settings = {
    // Provider identity
    provider,
    authType: gc.auth_type || providerDef?.authType || "bearer",
    apiFormat: gc.api_format || providerDef?.apiFormat || "openai",

    // Conductor LLM (generic keys with legacy fallback)
    llmApiKey: env.LLM_API_KEY || env.SILICONFLOW_API_KEY || gc.api_key || "",
    llmBaseUrl: env.LLM_BASE_URL || env.SILICONFLOW_BASE_URL || gc.base_url || "https://api.siliconflow.cn/v1",
    kcModel: gc.conductor_model || "glm-5",
    kcMaxTokens: 65536,

    // Tier models (from .env or global config tiers)
    tier1: env.TIER1 || gc.tiers?.tier1 || "",
    tier2: env.TIER2 || gc.tiers?.tier2 || "",
    tier3: env.TIER3 || gc.tiers?.tier3 || "",
    tier4: env.TIER4 || gc.tiers?.tier4 || "",

    // VLM tiers (vision/OCR models)
    vlmTier1: env.VLM_TIER1 || gc.vlm_tiers?.tier1 || "",
    vlmTier2: env.VLM_TIER2 || gc.vlm_tiers?.tier2 || "",
    vlmTier3: env.VLM_TIER3 || gc.vlm_tiers?.tier3 || "",

    // Worker LLM — optional, defaults to conductor config
    workerProvider: gc.worker_provider || "",
    workerApiKey: env.WORKER_API_KEY || gc.worker_api_key || "",
    workerBaseUrl: env.WORKER_BASE_URL || gc.worker_base_url || "",
    workerAuthType: gc.worker_auth_type || "",
    workerApiFormat: gc.worker_api_format || "",

    // Document parsing
    mineruApiUrl: env.MINERU_API_URL || "",
    mineruApiKey: env.MINERU_API_KEY || "",

    // Workspace
    kcWorkspaceRoot: gc.workspace_root || path.join(os.homedir(), ".kc_agent", "workspaces"),
    kcExecTimeout: parseInt(env.KC_EXEC_TIMEOUT || "30", 10),

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

    // Context management
    kcContextLimit: parseInt(env.KC_CONTEXT_LIMIT || "200000", 10),
    toolOutputOffloadTokens: parseInt(env.TOOL_OUTPUT_OFFLOAD_TOKENS || gc.tool_output_offload_tokens?.toString() || "2000", 10),
    toolOutputOffloadErrorTokens: parseInt(env.TOOL_OUTPUT_OFFLOAD_ERROR_TOKENS || gc.tool_output_offload_error_tokens?.toString() || "500", 10),

    // File system (Block 11)
    gitAutoCommit: (env.GIT_AUTO_COMMIT ?? gc.git_auto_commit ?? true) !== false &&
                   (env.GIT_AUTO_COMMIT !== "false") &&
                   (gc.git_auto_commit !== false),
    largeRefThresholdMB: parseInt(env.LARGE_REF_THRESHOLD_MB || gc.large_ref_threshold_mb?.toString() || "10", 10),

    // Language
    language: env.LANGUAGE || gc.language || "en",
  };

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
