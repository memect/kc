/**
 * Provider registry for Multi-LLM support.
 * Centralizes provider metadata, default models, and model classification.
 *
 * Model tier assignments (LLM + VLM) are loaded from model-tiers.json
 * so they can be updated without touching code.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {Record<string, {conductor: string, llm: Record<string,string>, vlm: Record<string,string>}>} */
let MODEL_TIERS;
try {
  MODEL_TIERS = JSON.parse(
    readFileSync(join(__dirname, "model-tiers.json"), "utf-8")
  );
} catch {
  MODEL_TIERS = {};
}

/** Helper: get tier config for a provider, with fallbacks */
function getTierConfig(providerId) {
  return MODEL_TIERS[providerId] || { conductor: "", llm: {}, vlm: {} };
}

// A2: Per-provider context-window caps. Without these, every provider
// inherited the generic 200000-token default from config.js, which caused
// silent empty-response failures on smaller-window models (xfyun
// astron-code-latest behaves like it has ~32K during E2E #3). The
// _maybeWindowAfterToolResult threshold only fires around 70% of budget, so
// with a 200K budget on a 32K-limit model windowing never fires in time.
// These numbers are conservative minimums — users can still override via
// KC_CONTEXT_LIMIT env or kc_context_limit in global config.
const DEFAULT_CONTEXT_LIMIT = 200000;

const PROVIDERS = [
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    contextLimit: 200000, // GLM-5.1, Kimi-K2.5 — 200K native
    defaultModel: getTierConfig("siliconflow").conductor || "glm-5",
    defaultTiers: getTierConfig("siliconflow").llm,
    defaultVlm: getTierConfig("siliconflow").vlm,
    labels: {
      en: "SiliconFlow (recommended for China)",
      zh: "SiliconFlow（国内推荐）",
    },
  },
  {
    id: "aliyun",
    name: "Aliyun",
    // Coding plan URL — regular API uses dashscope.aliyuncs.com/compatible-mode/v1
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    codingPlanUrl: "https://coding.dashscope.aliyuncs.com/v1",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: null, // Aliyun coding plan doesn't support /models
    supportsCodingPlanKey: true,
    contextLimit: 131072, // Qwen3.x family — 128K on the coding plan
    defaultModel: getTierConfig("aliyun").conductor || "qwen3.6-plus",
    defaultTiers: getTierConfig("aliyun").llm,
    defaultVlm: getTierConfig("aliyun").vlm,
    // Curated model list (coding plan doesn't have /models endpoint)
    curatedModels: [
      { id: "qwen3.6-plus", ownedBy: "qwen" },
      { id: "qwen3.5-plus", ownedBy: "qwen" },
      { id: "qwen3-max-2026-01-23", ownedBy: "qwen" },
      { id: "qwen3-coder-next", ownedBy: "qwen" },
      { id: "qwen3-coder-plus", ownedBy: "qwen" },
      { id: "glm-5", ownedBy: "zhipu" },
      { id: "glm-4.7", ownedBy: "zhipu" },
      { id: "kimi-k2.5", ownedBy: "kimi" },
      { id: "MiniMax-M2.5", ownedBy: "minimax" },
    ],
    labels: {
      en: "Aliyun Bailian",
      zh: "阿里云百炼",
    },
  },
  {
    id: "volcanocloud",
    name: "VolcanoCloud",
    // Regular Ark API — serves doubao / deepseek / glm-4-7-251222.
    // Coding plan uses api/coding/v3 and serves glm-5.1 (aliased to glm-4.7
    // server-side, thinking model).
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    codingPlanUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: null, // VolcanoCloud — use curated list
    supportsCodingPlanKey: true,
    contextLimit: 200000, // H2: glm-5.1 on coding plan has 200K native
    defaultModel: getTierConfig("volcanocloud").conductor || "doubao-seed-2-0-pro-260215",
    defaultTiers: getTierConfig("volcanocloud").llm,
    defaultVlm: getTierConfig("volcanocloud").vlm,
    curatedModels: [
      { id: "glm-5.1", ownedBy: "zhipu" },
      { id: "doubao-seed-2-0-pro-260215", ownedBy: "bytedance" },
      { id: "deepseek-v3-2-251201", ownedBy: "deepseek" },
      { id: "glm-4-7-251222", ownedBy: "zhipu" },
      { id: "doubao-1-5-pro-32k-250115", ownedBy: "bytedance" },
      { id: "doubao-seed-2-0-mini-260215", ownedBy: "bytedance" },
      { id: "doubao-seed-2-0-lite-260215", ownedBy: "bytedance" },
      { id: "doubao-1-5-lite-32k-250115", ownedBy: "bytedance" },
    ],
    labels: {
      en: "VolcanoCloud (ByteDance)",
      zh: "火山云（字节跳动）",
    },
  },
  {
    id: "xfyun",
    name: "XfYun Astro",
    // iFlytek Astro coding plan — OpenAI-compatible endpoint. Only exposes
    // a single model (astron-code-latest) today, so no /models discovery and
    // the tier assignment in model-tiers.json only fills tier1 / conductor.
    baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: null,
    // xfyun astron-code-latest — empirical ~32K-64K window per E2E #3. Set
    // conservatively at 32K so windowing fires early and the provider never
    // sees a request it will silently fail on.
    contextLimit: 32768,
    defaultModel: getTierConfig("xfyun").conductor || "astron-code-latest",
    defaultTiers: getTierConfig("xfyun").llm,
    defaultVlm: getTierConfig("xfyun").vlm,
    curatedModels: [
      { id: "astron-code-latest", ownedBy: "iflytek" },
    ],
    labels: {
      en: "iFlytek XfYun Astro (coding plan, single-model)",
      zh: "科大讯飞 Astro 编程套餐（单模型）",
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    authType: "x-api-key",
    apiFormat: "anthropic",
    modelsEndpoint: null, // Use curated list
    contextLimit: 400000, // Claude 4.x family — 400K on current long-context tier
    defaultModel: getTierConfig("anthropic").conductor || "claude-sonnet-4-20250514",
    defaultTiers: getTierConfig("anthropic").llm,
    defaultVlm: getTierConfig("anthropic").vlm,
    curatedModels: [
      { id: "claude-opus-4-20250514", ownedBy: "anthropic" },
      { id: "claude-sonnet-4-20250514", ownedBy: "anthropic" },
      { id: "claude-haiku-4-5-20251001", ownedBy: "anthropic" },
    ],
    labels: {
      en: "Anthropic",
      zh: "Anthropic",
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    contextLimit: 128000, // gpt-4o — 128K
    defaultModel: getTierConfig("openai").conductor || "gpt-4o",
    defaultTiers: getTierConfig("openai").llm,
    defaultVlm: getTierConfig("openai").vlm,
    labels: {
      en: "OpenAI",
      zh: "OpenAI",
    },
  },
  {
    id: "zhipu",
    name: "Zhipu/GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    contextLimit: 200000, // GLM official (bigmodel.cn) — 200K on GLM-4.x/5.x tiers
    defaultModel: getTierConfig("zhipu").conductor || "glm-4-plus",
    defaultTiers: getTierConfig("zhipu").llm,
    defaultVlm: getTierConfig("zhipu").vlm,
    labels: {
      en: "Zhipu GLM",
      zh: "智谱 GLM",
    },
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    contextLimit: 245760, // MiniMax-M2.5 — 240K
    defaultModel: getTierConfig("minimax").conductor || "MiniMax-M2.5",
    defaultTiers: getTierConfig("minimax").llm,
    defaultVlm: getTierConfig("minimax").vlm,
    labels: {
      en: "MiniMax",
      zh: "MiniMax",
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    // OpenRouter proxies many models; defaulting to 200K matches the underlying
    // frontier Anthropic/Google routes most users pick. Lower-context models
    // behind OpenRouter will still work, just won't benefit from early windowing.
    contextLimit: 200000,
    defaultModel: getTierConfig("openrouter").conductor || "anthropic/claude-sonnet-4-20250514",
    defaultTiers: getTierConfig("openrouter").llm,
    defaultVlm: getTierConfig("openrouter").vlm,
    labels: {
      en: "OpenRouter",
      zh: "OpenRouter",
    },
  },
  {
    id: "bedrock",
    name: "Bedrock",
    baseUrl: "",
    authType: "aws-sigv4",
    apiFormat: "anthropic",
    modelsEndpoint: null,
    contextLimit: 200000, // Bedrock Anthropic routes mirror native Claude 200K
    defaultModel: getTierConfig("bedrock").conductor || "anthropic.claude-sonnet-4-20250514-v1:0",
    defaultTiers: getTierConfig("bedrock").llm,
    defaultVlm: getTierConfig("bedrock").vlm,
    labels: {
      en: "AWS Bedrock (not yet supported)",
      zh: "AWS Bedrock（暂未支持）",
    },
  },
  {
    id: "custom",
    name: "Custom",
    baseUrl: "",
    authType: "bearer",
    apiFormat: "openai",
    modelsEndpoint: "/models",
    defaultModel: getTierConfig("custom").conductor || "",
    defaultTiers: getTierConfig("custom").llm,
    defaultVlm: getTierConfig("custom").vlm,
    labels: {
      en: "Custom (enter base URL)",
      zh: "自定义（输入接口地址）",
    },
  },
];

/**
 * Known model capability rankings (partial — used to sort discovered models).
 * Pattern-matched against lowercase model ID. Higher = more capable.
 * Aligned with kc_reborn providers.py _MODEL_RANKING.
 */
const MODEL_RANKING = {
  // Anthropic
  "claude-opus-4": 100,
  "claude-sonnet-4": 90,
  "claude-haiku-4": 70,
  // OpenAI
  "gpt-4o": 90,
  "gpt-4o-mini": 70,
  "gpt-4-turbo": 85,
  "o1": 95,
  "o3": 95,
  // Qwen (Aliyun Bailian)
  "qwen3.6-plus": 90,
  "qwen3.5-plus": 85,
  "qwen3-max": 88,
  "qwen3-coder-next": 85,
  "qwen3-coder-plus": 80,
  "qwen-plus": 75,
  "qwen-turbo": 60,
  "qwen3.5-397b": 85,
  "qwen3.5-122b": 75,
  "qwen3.5-35b": 65,
  // Zhipu
  "glm-5.1": 92,
  "glm-5": 90,
  "glm-4.7": 80,
  "glm-4": 75,
  // Others
  "kimi-k2.5": 85,
  "kimi-k2": 80,
  // iFlytek Astro
  "astron-code": 90,
  "minimax-m2": 80,
  "deepseek-v3": 85,
  "deepseek-r1": 90,
  // VolcanoCloud (ByteDance Doubao)
  "doubao-seed-2-0-pro": 90,
  "doubao-seed-2-0-code": 88,
  "doubao-seed-2-0-mini": 75,
  "doubao-seed-2-0-lite": 65,
  "doubao-seed-1-8": 85,
  "doubao-seed-1-6": 80,
  "doubao-1-5-pro": 80,
  "doubao-1-5-lite": 60,
};

/**
 * Estimate model capability rank (0-100) based on known patterns.
 * @param {string} modelId
 * @returns {number}
 */
function rankModel(modelId) {
  const lower = modelId.toLowerCase();
  for (const [pattern, rank] of Object.entries(MODEL_RANKING)) {
    if (lower.includes(pattern)) return rank;
  }
  return 50; // Unknown model: assume mid-tier
}

/**
 * Patterns to filter out non-chat models from discovery results.
 */
const EXCLUDE_PATTERNS = [
  /embed/i, /tts/i, /whisper/i, /dall-e/i, /audio/i, /image/i,
  /moderation/i, /rerank/i,
];

/** @returns {Array} All provider definitions */
export function getProviders() {
  return PROVIDERS;
}

/**
 * @param {string} id - Provider ID
 * @returns {object|undefined}
 */
export function getProviderById(id) {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Get display labels for the onboard menu.
 * @param {string} lang - "en" or "zh"
 * @returns {Array<{id: string, label: string}>}
 */
export function getProviderLabels(lang) {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.labels[lang] || p.labels.en || p.name,
  }));
}

/**
 * Classify a list of discovered models into tier assignments.
 * Uses the same ranking-based approach as kc_reborn's propose_tiers().
 *
 * @param {Array<{id: string, name?: string}>} models - Models from /models endpoint or curated list
 * @returns {{ conductor: string, tiers: {tier1: string, tier2: string, tier3: string, tier4: string}, unclassified: string[] }}
 */
export function classifyModels(models) {
  // Filter out non-chat models
  const chatModels = models.filter((m) => {
    const name = m.id || m.name || "";
    return !EXCLUDE_PATTERNS.some((re) => re.test(name));
  });

  // Rank and sort by capability
  const ranked = [...chatModels].sort((a, b) => rankModel(b.id) - rankModel(a.id));

  // Select conductor (highest ranked)
  const conductor = ranked[0]?.id || "";

  // Distribute across tiers by rank
  const tierBuckets = { tier1: [], tier2: [], tier3: [], tier4: [] };

  for (const m of ranked) {
    const rank = rankModel(m.id);
    if (rank >= 85) tierBuckets.tier1.push(m.id);
    else if (rank >= 70) tierBuckets.tier2.push(m.id);
    else if (rank >= 55) tierBuckets.tier3.push(m.id);
    else tierBuckets.tier4.push(m.id);
  }

  const tiers = {
    tier1: tierBuckets.tier1.slice(0, 3).join(", "),
    tier2: tierBuckets.tier2.slice(0, 3).join(", "),
    tier3: tierBuckets.tier3.slice(0, 2).join(", "),
    tier4: tierBuckets.tier4.slice(0, 2).join(", "),
  };

  const unclassified = ranked.filter((m) => rankModel(m.id) === 50).map((m) => m.id);

  return { conductor, tiers, unclassified };
}

/**
 * Get curated models for providers that don't support /models endpoint.
 * @param {string} providerId
 * @returns {Array<{id: string, ownedBy: string}>|null}
 */
export function getCuratedModels(providerId) {
  const provider = getProviderById(providerId);
  return provider?.curatedModels || null;
}

/**
 * Get the raw model tier config for a provider (from model-tiers.json).
 * @param {string} providerId
 * @returns {{ conductor: string, llm: Record<string,string>, vlm: Record<string,string> }}
 */
export function getModelTierConfig(providerId) {
  return getTierConfig(providerId);
}
