import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import { getProviders, getProviderById, getProviderLabels } from "../providers.js";

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
    title: "KC Agent Configuration",
    noConfig: "No config found. Run 'kc-beta onboard' first.",
    menu: "Configuration Categories",
    choose: "Choose category (q to quit)",
    categories: ["LLM Provider & API Key", "Model Tiers", "VLM Tiers (Vision/OCR)", "Worker LLM Provider", "Quality Thresholds", "Language"],
    saved: "Saved.",
    back: "← Back to menu",
    enterKeep: "Press Enter to keep",
    enterDefault: "Press Enter to use default",
    currentValue: "current",
    provider: "Provider",
    baseUrl: "Base URL",
    apiKey: "API Key",
    conductor: "Conductor Model",
    language: "Language",
    langOptions: ["English", "中文"],
  },
  zh: {
    title: "KC Agent 配置",
    noConfig: "未找到配置。请先运行 'kc-beta onboard'。",
    menu: "配置类别",
    choose: "选择类别（q 退出）",
    categories: ["大模型服务商 & API 密钥", "模型分层", "VLM 视觉模型分层", "Worker LLM 服务商", "质量阈值", "语言"],
    saved: "已保存。",
    back: "← 返回菜单",
    enterKeep: "回车保留当前值",
    enterDefault: "回车使用默认值",
    currentValue: "当前",
    provider: "服务商",
    baseUrl: "接口地址",
    apiKey: "API 密钥",
    conductor: "主模型",
    language: "语言",
    langOptions: ["English", "中文"],
  },
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); } catch { /* ignore */ }
  }
  return null;
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

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

function maskKey(key) {
  if (!key || key.length < 10) return key || "";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

/**
 * Category 1: LLM Provider & API Key
 */
async function editProvider(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[0]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);

  // Show current
  const currentProvider = getProviderById(config.provider);
  console.log(`  ${DIM}${t.currentValue}: ${config.provider} (${currentProvider?.name || "unknown"})${RESET}`);
  console.log();

  // Provider selection
  const providers = getProviders();
  const labels = getProviderLabels(config.language || "en");
  console.log(`  ${CYAN}${t.provider}:${RESET}`);
  for (let i = 0; i < labels.length; i++) {
    const marker = providers[i].id === config.provider ? ` ${GREEN}(${t.currentValue})${RESET}` : "";
    console.log(`    ${i + 1}. ${labels[i].label}${marker}`);
  }
  const currentIdx = providers.findIndex((p) => p.id === config.provider);
  const providerChoice = await ask(rl, `  ${GRAY}>${RESET} ${t.choose.split(" (")[0]}`, String(currentIdx + 1 || 1));
  const provIdx = parseInt(providerChoice, 10) - 1;
  const provider = providers[Math.max(0, Math.min(provIdx, providers.length - 1))];
  config.provider = provider.id;
  config.auth_type = provider.authType;
  config.api_format = provider.apiFormat;
  console.log();

  // Base URL
  if (provider.id === "custom") {
    config.base_url = await ask(rl, `  ${CYAN}${t.baseUrl}${RESET}`, config.base_url || "");
  } else if (provider.supportsCodingPlanKey) {
    // Providers with coding plan support — ask which key type
    const keyTypeLabel = config.language === "zh" ? "密钥类型" : "Key Type";
    const opt1 = config.language === "zh" ? "API Key（按量付费）" : "API Key (pay-per-use)";
    const opt2 = config.language === "zh" ? "Coding Plan Key（包年包月）" : "Coding Plan Key (subscription)";
    console.log(`  ${CYAN}${keyTypeLabel}:${RESET}`);
    const isCodingPlan = config.base_url === provider.codingPlanUrl;
    console.log(`    1. ${opt1}${!isCodingPlan ? ` ${GREEN}(${t.currentValue})${RESET}` : ""}`);
    console.log(`    2. ${opt2}${isCodingPlan ? ` ${GREEN}(${t.currentValue})${RESET}` : ""}`);
    const keyTypeDefault = isCodingPlan ? "2" : "1";
    const keyTypeChoice = await ask(rl, `  ${GRAY}>${RESET}`, keyTypeDefault);
    config.base_url = keyTypeChoice === "2" ? provider.codingPlanUrl : provider.baseUrl;
    console.log(`  ${CYAN}${t.baseUrl}${RESET}: ${DIM}${config.base_url}${RESET}`);
  } else {
    // Keep existing base_url if it matches this provider, otherwise use default
    const defaultUrl = provider.baseUrl;
    console.log(`  ${CYAN}${t.baseUrl}${RESET}: ${DIM}${defaultUrl}${RESET}`);
    config.base_url = defaultUrl;
  }
  console.log();

  // API Key
  const masked = maskKey(config.api_key);
  const keyPrompt = masked
    ? `  ${CYAN}${t.apiKey}${RESET} ${DIM}(${masked})${RESET}`
    : `  ${CYAN}${t.apiKey}${RESET}`;
  const newKey = await ask(rl, keyPrompt, "", masked ? t.enterKeep : "");
  if (newKey) config.api_key = newKey;

  // Conductor model
  console.log();
  const defaultModel = provider.defaultModel || config.conductor_model || "";
  config.conductor_model = await ask(rl, `  ${CYAN}${t.conductor}${RESET}`, config.conductor_model || defaultModel, t.enterKeep);
  console.log();
}

/**
 * Category 2: Model Tiers
 */
async function editTiers(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[1]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
  console.log();

  const tiers = config.tiers || {};
  const provider = getProviderById(config.provider);
  const defaults = provider?.defaultTiers || {};

  for (const tier of ["tier1", "tier2", "tier3", "tier4"]) {
    const current = tiers[tier] || defaults[tier] || "";
    tiers[tier] = await ask(rl, `  ${CYAN}${tier.toUpperCase()}${RESET}`, current, t.enterKeep);
  }
  config.tiers = tiers;
  console.log();
}

/**
 * Category 3: VLM Tiers (Vision/OCR)
 */
async function editVlmTiers(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[2]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
  console.log();

  const vlmTiers = config.vlm_tiers || {};
  const provider = getProviderById(config.provider);
  const defaults = provider?.defaultVlm || {};

  for (const tier of ["tier1", "tier2", "tier3"]) {
    const current = vlmTiers[tier] || defaults[tier] || "";
    vlmTiers[tier] = await ask(rl, `  ${CYAN}${tier.toUpperCase()}${RESET}`, current, t.enterKeep);
  }
  config.vlm_tiers = vlmTiers;
  console.log();
}

/**
 * Category 4: Worker LLM Provider
 */
async function editWorkerProvider(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[3]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
  console.log();

  const currentWorker = config.worker_provider || "";
  const statusLabel = currentWorker
    ? `${currentWorker} (${getProviderById(currentWorker)?.name || "unknown"})`
    : config.language === "zh" ? "（与主服务商相同）" : "(same as conductor)";
  console.log(`  ${DIM}${t.currentValue}: ${statusLabel}${RESET}`);
  console.log();

  const sameLabel = config.language === "zh" ? "使用与主服务商相同配置？" : "Use same provider as conductor?";
  const sameChoice = await ask(rl, `  ${sameLabel}`, "Y", "Y/n");

  if (sameChoice.toLowerCase() === "n" || sameChoice.toLowerCase() === "no") {
    const providers = getProviders();
    const labels = getProviderLabels(config.language || "en");
    console.log();
    console.log(`  ${CYAN}${t.categories[3]}:${RESET}`);
    for (let i = 0; i < labels.length; i++) {
      const marker = providers[i].id === config.worker_provider ? ` ${GREEN}(${t.currentValue})${RESET}` : "";
      console.log(`    ${i + 1}. ${labels[i].label}${marker}`);
    }
    const wIdx = parseInt(await ask(rl, `  ${GRAY}>${RESET}`, "1"), 10) - 1;
    const wp = providers[Math.max(0, Math.min(wIdx, providers.length - 1))];
    config.worker_provider = wp.id;
    config.worker_auth_type = wp.authType;
    config.worker_api_format = wp.apiFormat;

    if (wp.id === "custom") {
      config.worker_base_url = await ask(rl, `  ${CYAN}Base URL${RESET}`, config.worker_base_url || "");
    } else {
      config.worker_base_url = wp.baseUrl;
    }

    // Worker API Key
    const masked = maskKey(config.worker_api_key);
    const keyPrompt = masked
      ? `  ${CYAN}API Key (Worker)${RESET} ${DIM}(${masked})${RESET}`
      : `  ${CYAN}API Key (Worker)${RESET}`;
    const newKey = await ask(rl, keyPrompt, "", masked ? t.enterKeep : "");
    if (newKey) config.worker_api_key = newKey;
  } else {
    // Clear worker-specific config (use conductor)
    config.worker_provider = "";
    config.worker_api_key = "";
    config.worker_base_url = "";
    config.worker_auth_type = "";
    config.worker_api_format = "";
  }
  console.log();
}

/**
 * Category 5: Quality Thresholds
 */
async function editThresholds(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[4]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
  console.log();

  config.accuracy_threshold = parseFloat(
    await ask(rl, `  ${CYAN}Accuracy threshold${RESET}`, String(config.accuracy_threshold ?? 0.9), t.enterKeep)
  );
  config.systemic_threshold = parseFloat(
    await ask(rl, `  ${CYAN}Systemic threshold${RESET}`, String(config.systemic_threshold ?? 0.10), t.enterKeep)
  );
  config.spot_check_rate = parseFloat(
    await ask(rl, `  ${CYAN}Spot-check rate${RESET}`, String(config.spot_check_rate ?? 0.10), t.enterKeep)
  );
  config.tier_tolerance = parseFloat(
    await ask(rl, `  ${CYAN}Tier downgrade tolerance${RESET}`, String(config.tier_tolerance ?? 0.05), t.enterKeep)
  );
  console.log();
}

/**
 * Category 4: Language
 */
async function editLanguage(rl, config, t) {
  console.log();
  console.log(`  ${BOLD}${t.categories[5]}${RESET}`);
  console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
  console.log();

  console.log(`  ${CYAN}${t.language}:${RESET}`);
  console.log(`    1. ${t.langOptions[0]}${config.language === "en" ? ` ${GREEN}(${t.currentValue})${RESET}` : ""}`);
  console.log(`    2. ${t.langOptions[1]}${config.language === "zh" ? ` ${GREEN}(${t.currentValue})${RESET}` : ""}`);
  const langDefault = config.language === "zh" ? "2" : "1";
  const langChoice = await ask(rl, `  ${GRAY}>${RESET}`, langDefault);
  config.language = langChoice === "2" ? "zh" : "en";
  console.log();
}

const CATEGORY_HANDLERS = [editProvider, editTiers, editVlmTiers, editWorkerProvider, editThresholds, editLanguage];

/**
 * Main config editor loop.
 */
export async function configEditor() {
  const config = loadConfig();
  if (!config) {
    console.log(`\n  ${RED}${L.en.noConfig}${RESET}\n`);
    process.exit(1);
  }

  const lang = config.language || "en";
  const t = L[lang];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  while (true) {
    console.log();
    console.log(`  ${BOLD}${t.title}${RESET}`);
    console.log(`  ${GRAY}${"─".repeat(35)}${RESET}`);
    console.log();
    for (let i = 0; i < t.categories.length; i++) {
      console.log(`    ${i + 1}. ${t.categories[i]}`);
    }
    console.log();

    const choice = await ask(rl, `  ${GRAY}>${RESET} ${t.choose}`, "");

    if (choice === "q" || choice === "Q" || choice === "") break;

    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < CATEGORY_HANDLERS.length) {
      await CATEGORY_HANDLERS[idx](rl, config, t);
      saveConfig(config);
      console.log(`  ${GREEN}✓${RESET} ${t.saved}`);
    }
  }

  rl.close();
  console.log();
}
