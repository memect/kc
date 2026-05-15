/**
 * Regression test for v0.8 P1-B — workspace .env overlay.
 *
 * Background:
 * 资管 v0.7.5 set OCR_MODEL_TIER1=zai-org/GLM-4.6V in workspace .env,
 * but document_parse error messages quoted Qwen/Qwen3-VL-235B-A22B-Instruct
 * (the gc default in ~/.kc_agent/config.json's vlm_tiers.tier1). Root
 * cause: cli/index.js calls loadSettings() with no workspace path, so the
 * workspace .env is never loaded. v0.7.4 G1b's OCR_MODEL_TIER1 → VLM_TIER1
 * alias landed at the config layer but never reached runtime.
 *
 * v0.8 P1-B fix: engine.js calls _overlayWorkspaceEnv() after the workspace
 * is constructed; reads workspace .env; for each VLM_TIER / OCR_MODEL_TIER /
 * TIER / LANGUAGE field, overlays onto config IF the .env value differs from
 * the gc fallback and IF process.env doesn't already win.
 *
 * Run: `node tests/workspace-env-overlay.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnvFile } from "../src/config.js";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// The overlay logic is on AgentEngine, but exercising it requires the full
// engine construction stack. We test the overlay logic by inlining the
// same algorithm here against a controlled .env. This is a regression
// pin: any change to _overlayWorkspaceEnv must keep the contract the
// algorithm below describes.
function simulateOverlay(initialConfig, envObj, penvOverrides = {}) {
  const config = { ...initialConfig };
  const overlays = [
    { configKey: "vlmTier1", envKey: ["VLM_TIER1", "OCR_MODEL_TIER1"] },
    { configKey: "vlmTier2", envKey: ["VLM_TIER2", "OCR_MODEL_TIER2"] },
    { configKey: "vlmTier3", envKey: ["VLM_TIER3", "OCR_MODEL_TIER3"] },
    { configKey: "tier1", envKey: ["TIER1"] },
    { configKey: "tier2", envKey: ["TIER2"] },
    { configKey: "tier3", envKey: ["TIER3"] },
    { configKey: "tier4", envKey: ["TIER4"] },
    { configKey: "language", envKey: ["LANGUAGE"] },
  ];
  const applied = [];
  for (const { configKey, envKey } of overlays) {
    let wsValue = "";
    for (const k of envKey) {
      if (envObj[k]) { wsValue = envObj[k]; break; }
    }
    if (!wsValue) continue;
    const penvWon = envKey.some((k) => penvOverrides[k] && penvOverrides[k] !== wsValue);
    if (penvWon) continue;
    if (config[configKey] !== wsValue) {
      applied.push({ key: configKey, from: config[configKey] || "(empty)", to: wsValue });
      config[configKey] = wsValue;
    }
  }
  return { config, applied };
}

console.log("\nCase 1: 资管-style — OCR_MODEL_TIER1 overrides gc default");
{
  const gcDefault = { vlmTier1: "Qwen/Qwen3-VL-235B-A22B-Instruct" };
  const envObj = { OCR_MODEL_TIER1: "zai-org/GLM-4.6V" };
  const { config, applied } = simulateOverlay(gcDefault, envObj);
  assert(config.vlmTier1 === "zai-org/GLM-4.6V", "workspace .env wins over gc default");
  assert(applied.length === 1, "overlay records the change");
  assert(applied[0].from === "Qwen/Qwen3-VL-235B-A22B-Instruct", "from preserves gc value");
  assert(applied[0].to === "zai-org/GLM-4.6V", "to has workspace value");
}

console.log("\nCase 2: VLM_TIER1 wins over OCR_MODEL_TIER1 (both in .env)");
{
  const envObj = { VLM_TIER1: "model-A", OCR_MODEL_TIER1: "model-B" };
  const { config } = simulateOverlay({}, envObj);
  assert(config.vlmTier1 === "model-A", "VLM_TIER1 takes precedence");
}

console.log("\nCase 3: process.env wins over workspace .env");
{
  const envObj = { VLM_TIER1: "model-from-env-file" };
  const penv = { VLM_TIER1: "model-from-penv" };
  const startConfig = { vlmTier1: "model-from-penv" }; // simulating loadSettings already saw penv
  const { config, applied } = simulateOverlay(startConfig, envObj, penv);
  assert(config.vlmTier1 === "model-from-penv", "penv value preserved");
  assert(applied.length === 0, "no overlay change recorded");
}

console.log("\nCase 4: empty workspace .env is a no-op");
{
  const startConfig = { vlmTier1: "gc-default" };
  const { config, applied } = simulateOverlay(startConfig, {});
  assert(config.vlmTier1 === "gc-default", "no change when .env empty");
  assert(applied.length === 0, "no overlay change recorded");
}

console.log("\nCase 5: TIER1..4 + LANGUAGE all overlay correctly");
{
  const envObj = {
    TIER1: "Pro/zai-org/GLM-5.1",
    TIER2: "Pro/deepseek-ai/DeepSeek-V3.2",
    TIER3: "Qwen/Qwen3.5-122B-A10B",
    TIER4: "Qwen/Qwen3.5-35B-A3B",
    LANGUAGE: "en",
  };
  const startConfig = { tier1: "", tier2: "", tier3: "", tier4: "", language: "zh" };
  const { config } = simulateOverlay(startConfig, envObj);
  assert(config.tier1 === "Pro/zai-org/GLM-5.1", "tier1 overlaid");
  assert(config.tier4 === "Qwen/Qwen3.5-35B-A3B", "tier4 overlaid");
  assert(config.language === "en", "language overlaid (zh → en)");
}

console.log("\nCase 6: loadEnvFile parses 资管-style .env correctly");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-env-test-"));
  fs.writeFileSync(path.join(tmpDir, ".env"), [
    "# === KC Agent Project Configuration ===",
    "LANGUAGE=en",
    "LLM_API_KEY=sk-test",
    "TIER1=Pro/zai-org/GLM-5.1, Pro/moonshotai/Kimi-K2.5",
    "OCR_MODEL_TIER1=zai-org/GLM-4.6V",
    'WORKER_PROVIDER="quoted-value"',
    "",
  ].join("\n"));
  const env = loadEnvFile(path.join(tmpDir, ".env"));
  assert(env.LANGUAGE === "en", "LANGUAGE parsed");
  assert(env.OCR_MODEL_TIER1 === "zai-org/GLM-4.6V", "OCR_MODEL_TIER1 parsed");
  assert(env.WORKER_PROVIDER === "quoted-value", "quoted value strips quotes");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\nv0.8.1 P9-B: DocumentParseTool live-reads ocrModel via getOcrModel callback");
{
  const { DocumentParseTool } = await import("../src/agent/tools/document-parse.js");
  // Mutable holder that simulates engine.config.vlmTier1 changing over time
  const cfg = { vlmTier1: "Qwen/Qwen3-VL-235B-A22B-Instruct" };
  const tool = new DocumentParseTool({}, {
    llmApiKey: "fake",
    llmBaseUrl: "https://example.com/v1",
    ocrModel: cfg.vlmTier1, // static fallback (legacy capture)
    getOcrModel: () => cfg.vlmTier1, // live-read
  });

  // Initial: matches the gc default
  assert(tool._ocrModel === "Qwen/Qwen3-VL-235B-A22B-Instruct", "initial value matches static + live");

  // Simulate workspace_env_overlay updating engine.config.vlmTier1 AFTER tool construction
  cfg.vlmTier1 = "zai-org/GLM-4.6V";
  assert(tool._ocrModel === "zai-org/GLM-4.6V", "live-read picks up post-construction overlay");

  // Simulate getOcrModel returning empty → fall back to static
  cfg.vlmTier1 = "";
  assert(tool._ocrModel === "Qwen/Qwen3-VL-235B-A22B-Instruct", "falls back to static when live returns empty");

  // Simulate getOcrModel throwing → fall back to static
  const throwingTool = new DocumentParseTool({}, {
    ocrModel: "static-default",
    getOcrModel: () => { throw new Error("config not ready"); },
  });
  assert(throwingTool._ocrModel === "static-default", "throwing getOcrModel falls back to static");
}

console.log("\nv0.8.1 P9-B: legacy constructor without getOcrModel still works");
{
  const { DocumentParseTool } = await import("../src/agent/tools/document-parse.js");
  const tool = new DocumentParseTool({}, { ocrModel: "legacy-model" });
  assert(tool._ocrModel === "legacy-model", "static-only path still returns the value");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
