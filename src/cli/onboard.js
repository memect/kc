import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import { getProviders, getProviderById, getProviderLabels, classifyModels, getCuratedModels } from "../providers.js";
import { LLMClient } from "../agent/llm-client.js";

const CONFIG_DIR = path.join(os.homedir(), ".kc_agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;

const L = {
  en: {
    title: "KC Agent Setup",
    existingConfig: "Existing config found. Press Enter to keep current values.",
    langPrompt: "Language",
    langOptions: ["English", "中文"],
    providerPrompt: "LLM Provider",
    current: "current",
    choose: "Choose",
    baseUrl: "Base URL",
    baseUrlRequired: "Base URL is required for custom provider.",
    apiKey: "API Key",
    apiKeyRequired: "required",
    apiKeyKeep: "Press Enter to keep",
    apiKeyMissing: "API key is required. Run 'kc-beta onboard' again.",
    keyType: "Key Type",
    keyTypeOptions: ["API Key (pay-per-use)", "Coding Plan Key (subscription)"],
    conductorModel: "Conductor Model",
    workerTiers: "Worker LLM Tiers",
    vlmTiers: "VLM Tiers (Vision/OCR)",
    tierHint: "Press Enter to accept defaults",
    workerConfig: "Worker LLM Provider",
    workerSameProvider: "Use same provider for worker LLMs?",
    yesNo: "Y/n",
    accuracy: "Accuracy Threshold",
    saved: "Saved to",
    runHint: "Run {cmd} to start the agent.",
    discovering: "Discovering available models...",
    discoveryFailed: "Could not auto-discover models. Using provider defaults.",
    discoveryFound: "Found {n} models. Suggested tier assignments:",
    discoveryAccept: "Press Enter to accept, or type model name to override",
    enterSkip: "Press Enter to skip",
    enterDefault: "Press Enter to use default",
    bedrockWarn: "AWS Bedrock is not yet fully supported. Authentication will fail at runtime.",
  },
  zh: {
    title: "KC Agent 配置向导",
    existingConfig: "检测到已有配置。按回车保留当前值。",
    langPrompt: "语言",
    langOptions: ["English", "中文"],
    providerPrompt: "大模型服务商",
    current: "当前",
    choose: "选择",
    baseUrl: "接口地址",
    baseUrlRequired: "自定义服务商必须填写接口地址。",
    apiKey: "API 密钥",
    apiKeyRequired: "必填",
    apiKeyKeep: "回车保留当前密钥",
    apiKeyMissing: "API 密钥为必填项。请重新运行 'kc-beta onboard'。",
    keyType: "密钥类型",
    keyTypeOptions: ["API Key（按量付费）", "Coding Plan Key（包年包月）"],
    conductorModel: "主模型",
    workerTiers: "Worker 模型分层",
    vlmTiers: "VLM 视觉模型分层（OCR）",
    tierHint: "回车接受默认值",
    workerConfig: "Worker LLM 服务商",
    workerSameProvider: "Worker LLM 使用同一服务商？",
    yesNo: "Y/n",
    accuracy: "准确率阈值",
    saved: "已保存至",
    runHint: "运行 {cmd} 启动 Agent。",
    discovering: "正在发现可用模型...",
    discoveryFailed: "无法自动发现模型，使用默认配置。",
    discoveryFound: "发现 {n} 个模型。建议分层：",
    discoveryAccept: "回车接受，或输入模型名称覆盖",
    enterSkip: "回车跳过",
    enterDefault: "回车使用默认值",
    bedrockWarn: "AWS Bedrock 尚未完全支持。运行时认证将失败。",
  },
};

function ask(rl, question, defaultValue = "", hint = "") {
  const suffix = defaultValue ? ` ${DIM}[${defaultValue}]${RESET}` : "";
  const hintText = hint
    ? ` ${GRAY}(${hint})${RESET}`
    : defaultValue
      ? ` ${GRAY}(Press Enter to keep)${RESET}`
      : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}${hintText}: `, (answer) => resolve(answer.trim() || defaultValue));
  });
}

export async function onboard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { /* ignore */ }
  }
  const isUpdate = Object.keys(existing).length > 0;

  console.log();
  console.log(`  ${BOLD}KC Agent Setup / KC Agent 配置向导${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(40)}${RESET}`);
  console.log();

  // --- Language ---
  console.log(`  ${CYAN}Language / 语言:${RESET}`);
  console.log(`    1. English`);
  console.log(`    2. 中文`);
  const langDefault = existing.language === "zh" ? "2" : "1";
  const langChoice = await ask(rl, `  ${GRAY}>${RESET} Choose / 选择`, langDefault);
  const lang = langChoice === "2" ? "zh" : "en";
  const t = L[lang];
  console.log();

  if (isUpdate) {
    console.log(`  ${DIM}${t.existingConfig}${RESET}`);
    console.log();
  }

  // --- Provider ---
  const providers = getProviders();
  const labels = getProviderLabels(lang);
  console.log(`  ${CYAN}${t.providerPrompt}:${RESET}`);
  for (let i = 0; i < labels.length; i++) {
    const marker = providers[i].id === existing.provider ? ` ${GREEN}(${t.current})${RESET}` : "";
    console.log(`    ${i + 1}. ${labels[i].label}${marker}`);
  }
  const providerIdx = parseInt(await ask(rl, `  ${GRAY}>${RESET} ${t.choose}`, "1"), 10) - 1;
  const provider = providers[Math.max(0, Math.min(providerIdx, providers.length - 1))];
  console.log();

  // Bedrock warning
  if (provider.id === "bedrock") {
    console.log(`  ${YELLOW}⚠ ${t.bedrockWarn}${RESET}`);
    console.log();
  }

  // --- Base URL ---
  let baseUrl = provider.baseUrl;
  if (provider.id === "custom") {
    baseUrl = await ask(rl, `  ${t.baseUrl}`, existing.base_url || "");
    if (!baseUrl) { console.log(`  ${RED}${t.baseUrlRequired}${RESET}`); rl.close(); process.exit(1); }
    console.log();
  }

  // --- Aliyun coding plan key sub-option ---
  let useCodingPlan = false;
  if (provider.supportsCodingPlanKey) {
    console.log(`  ${CYAN}${t.keyType}:${RESET}`);
    console.log(`    1. ${t.keyTypeOptions[0]}`);
    console.log(`    2. ${t.keyTypeOptions[1]}`);
    const keyTypeChoice = await ask(rl, `  ${GRAY}>${RESET} ${t.choose}`, "1");
    useCodingPlan = keyTypeChoice === "2";
    if (useCodingPlan && provider.codingPlanUrl) {
      baseUrl = provider.codingPlanUrl;
    }
    console.log();
  }

  // --- API Key ---
  // Only offer to "keep" an existing key when the user hasn't switched
  // providers. Otherwise an accidental Enter would silently save the OLD
  // provider's key against the NEW provider's base URL — silent breakage.
  const keyIsForSameProvider = existing.provider === provider.id;
  const maskedExisting = keyIsForSameProvider && existing.api_key
    ? existing.api_key.slice(0, 6) + "..." + existing.api_key.slice(-4)
    : "";
  const keyHint = maskedExisting ? t.apiKeyKeep : t.apiKeyRequired;
  const keyPrompt = maskedExisting
    ? `  ${CYAN}${t.apiKey}${RESET} ${DIM}(${maskedExisting})${RESET}`
    : `  ${CYAN}${t.apiKey}${RESET} ${YELLOW}(${t.apiKeyRequired})${RESET}`;
  const apiKey = await ask(rl, keyPrompt, "", keyHint);
  const finalKey = apiKey || (keyIsForSameProvider ? existing.api_key : "") || "";
  if (!finalKey) { console.log(`  ${RED}${t.apiKeyMissing}${RESET}`); rl.close(); process.exit(1); }
  console.log();

  // --- Auto-discovery ---
  let discoveredModels = null;
  let suggestedTiers = null;
  let suggestedConductor = null;

  // Try curated models first (for providers without /models endpoint)
  const curated = getCuratedModels(provider.id);

  if (curated) {
    // Use curated model list
    discoveredModels = curated;
    const classified = classifyModels(curated);
    suggestedTiers = classified.tiers;
    suggestedConductor = classified.conductor;
    console.log(`  ${GREEN}✓${RESET} ${t.discoveryFound.replace("{n}", curated.length)}`);
    if (suggestedConductor) {
      console.log(`    ${DIM}Conductor: ${suggestedConductor}${RESET}`);
    }
    for (const [tier, models] of Object.entries(suggestedTiers)) {
      if (models) console.log(`    ${DIM}${tier.toUpperCase()}: ${models}${RESET}`);
    }
    console.log();
  } else if (provider.modelsEndpoint) {
    // Query /models endpoint
    console.log(`  ${DIM}${t.discovering}${RESET}`);
    try {
      const tempClient = new LLMClient({
        apiKey: finalKey,
        baseUrl: baseUrl,
        authType: provider.authType,
        apiFormat: provider.apiFormat,
      });
      discoveredModels = await tempClient.listModels();

      if (discoveredModels && discoveredModels.length > 0) {
        const classified = classifyModels(discoveredModels);
        suggestedTiers = classified.tiers;
        suggestedConductor = classified.conductor;
        console.log(`  ${GREEN}✓${RESET} ${t.discoveryFound.replace("{n}", discoveredModels.length)}`);
        if (suggestedConductor) {
          console.log(`    ${DIM}Conductor: ${suggestedConductor}${RESET}`);
        }
        for (const [tier, models] of Object.entries(suggestedTiers)) {
          if (models) console.log(`    ${DIM}${tier.toUpperCase()}: ${models}${RESET}`);
        }
      } else {
        console.log(`  ${DIM}${t.discoveryFailed}${RESET}`);
      }
    } catch {
      console.log(`  ${DIM}${t.discoveryFailed}${RESET}`);
    }
    console.log();
  }

  // --- Conductor model ---
  const defaultModel = suggestedConductor || provider.defaultModel || existing.conductor_model || "";
  const model = await ask(
    rl,
    `  ${CYAN}${t.conductorModel}${RESET}`,
    defaultModel,
    isUpdate ? t.enterDefault : "",
  );
  console.log();

  // --- Worker LLM provider (optional) ---
  // Ask worker-provider BEFORE tier prompts so that when worker differs from
  // conductor (e.g. conductor=xfyun single-model, worker=siliconflow) the
  // tier-default suggestions come from the WORKER provider's model-tiers.json
  // entry, not the conductor's. Previous ordering defaulted tiers from the
  // conductor and produced nonsensical defaults for single-model conductors.
  console.log(`  ${CYAN}${t.workerConfig}${RESET}`);
  const sameProvider = await ask(rl, `  ${t.workerSameProvider}`, "Y", t.yesNo);
  let workerProvider = "";
  let workerApiKey = "";
  let workerBaseUrl = "";
  let workerAuthType = "";
  let workerApiFormat = "";
  let tierProviderDef = provider;  // where tier defaults come from

  if (sameProvider.toLowerCase() === "n" || sameProvider.toLowerCase() === "no") {
    // Pick a different provider for workers
    console.log();
    console.log(`  ${CYAN}${t.providerPrompt} (Worker):${RESET}`);
    for (let i = 0; i < labels.length; i++) {
      console.log(`    ${i + 1}. ${labels[i].label}`);
    }
    const wIdx = parseInt(await ask(rl, `  ${GRAY}>${RESET} ${t.choose}`, "1"), 10) - 1;
    const wp = providers[Math.max(0, Math.min(wIdx, providers.length - 1))];
    workerProvider = wp.id;
    workerAuthType = wp.authType;
    workerApiFormat = wp.apiFormat;
    workerBaseUrl = wp.baseUrl;
    tierProviderDef = wp;

    if (wp.id === "custom") {
      workerBaseUrl = await ask(rl, `  ${t.baseUrl}`, existing.worker_base_url || "");
    }

    // Worker API key. Show masked existing key in the prompt (matches the
    // main-provider prompt style) so the user can confirm what's saved
    // without guessing. Like the main key, only offer to "keep" the existing
    // value if the WORKER provider itself hasn't changed — otherwise Enter
    // would silently carry the previous worker provider's key across.
    const workerKeyIsForSameProvider = existing.worker_provider === wp.id;
    const wMasked = workerKeyIsForSameProvider && existing.worker_api_key
      ? existing.worker_api_key.slice(0, 6) + "..." + existing.worker_api_key.slice(-4)
      : "";
    const wKeyHint = wMasked ? t.apiKeyKeep : t.apiKeyRequired;
    const wKeyPrompt = wMasked
      ? `  ${CYAN}${t.apiKey} (Worker)${RESET} ${DIM}(${wMasked})${RESET}`
      : `  ${CYAN}${t.apiKey} (Worker)${RESET} ${YELLOW}(${t.apiKeyRequired})${RESET}`;
    workerApiKey = await ask(rl, wKeyPrompt, "", wKeyHint);
    workerApiKey = workerApiKey || (workerKeyIsForSameProvider ? existing.worker_api_key : "") || "";
  }
  console.log();

  // --- Worker LLM tiers (defaults come from tierProviderDef set above) ---
  // When worker==conductor, these default from the conductor's model-tiers.json
  // entry. When worker is a separate provider, they default from the WORKER
  // provider's entry — so e.g. siliconflow's GLM-5.1 tier1 defaults apply.
  console.log(`  ${CYAN}${t.workerTiers}${RESET} ${DIM}(${t.tierHint})${RESET}`);
  const tiers = {};
  const tierSuggested = tierProviderDef.id === provider.id ? suggestedTiers : null;
  for (const tier of ["tier1", "tier2", "tier3", "tier4"]) {
    const def = tierSuggested?.[tier] || tierProviderDef.defaultTiers?.[tier] || existing?.tiers?.[tier] || "";
    tiers[tier] = await ask(
      rl,
      `    ${tier.toUpperCase()}`,
      def,
      t.discoveryAccept ? "" : "",
    );
  }
  console.log();

  // --- VLM tiers (vision/OCR) — also from worker provider when split ---
  console.log(`  ${CYAN}${t.vlmTiers}${RESET} ${DIM}(${t.tierHint})${RESET}`);
  const vlmTiers = {};
  for (const tier of ["tier1", "tier2", "tier3"]) {
    const def = tierProviderDef.defaultVlm?.[tier] || existing?.vlm_tiers?.[tier] || "";
    vlmTiers[tier] = await ask(
      rl,
      `    ${tier.toUpperCase()}`,
      def,
    );
  }
  console.log();

  rl.close();

  // Preserve existing thresholds or set defaults (editable via 'kc-beta config')
  const accuracy = existing.accuracy_threshold ?? 0.9;
  const systemicThreshold = existing.systemic_threshold ?? 0.10;
  const spotCheckRate = existing.spot_check_rate ?? 0.10;
  const tierTolerance = existing.tier_tolerance ?? 0.05;

  const config = {
    language: lang,
    provider: provider.id,
    api_key: finalKey,
    base_url: baseUrl,
    auth_type: provider.authType,
    api_format: provider.apiFormat,
    conductor_model: model,
    tiers,
    vlm_tiers: vlmTiers,
    // Worker LLM (optional — empty means use conductor config)
    worker_provider: workerProvider,
    worker_api_key: workerApiKey,
    worker_base_url: workerBaseUrl,
    worker_auth_type: workerAuthType,
    worker_api_format: workerApiFormat,
    // Thresholds
    accuracy_threshold: accuracy,
    systemic_threshold: systemicThreshold,
    spot_check_rate: spotCheckRate,
    tier_tolerance: tierTolerance,
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");

  console.log(`  ${GREEN}✓${RESET} ${t.saved} ${GRAY}${CONFIG_PATH}${RESET}`);
  console.log();
  console.log(`  ${t.runHint.replace("{cmd}", `${BOLD}kc-beta${RESET}`)}`);
  const configHint = lang === "zh"
    ? `  ${DIM}运行 ${BOLD}kc-beta config${RESET}${DIM} 调整阈值和高级设置。${RESET}`
    : `  ${DIM}Run ${BOLD}kc-beta config${RESET}${DIM} to adjust thresholds and advanced settings.${RESET}`;
  console.log(configHint);
  console.log();
}
