import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

const REQUIRED_DIRS = ["rules", "samples", "input", "output", "logs", "workflows", "rule_skills"];

const DEFAULT_ENV = `# === KC Agent Project Configuration ===

# Language: en | zh
LANGUAGE=en

# === Worker LLM API (SiliconFlow) ===
SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1

# === Worker LLM Tiers (highest capability to lowest) ===
TIER1=Pro/zai-org/GLM-5, Pro/moonshotai/Kimi-K2.5
TIER2=Pro/deepseek-ai/DeepSeek-V3.2, Pro/MiniMaxAI/MiniMax-M2.5, Qwen/Qwen3.5-397B-A17B
TIER3=Qwen/Qwen3.5-122B-A10B
TIER4=Qwen/Qwen3.5-35B-A3B

# === OCR Model Tiers ===
OCR_MODEL_TIER1=zai-org/GLM-4.6V

# === Quality Thresholds ===
SKILL_ACCURACY=0.9
WORKFLOW_ACCURACY=0.9
MONITOR_FREQUENCY=mid

# === Evolution Control ===
MAX_ITERATIONS=20
`;

export class ProjectInitializer extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.workspaceCreated = false;
    this.configReady = false;
    this.hasRegulations = false;
    this.hasSamples = false;
    this._setupWorkspace();
  }

  _setupWorkspace() {
    for (const d of REQUIRED_DIRS) {
      fs.mkdirSync(path.join(this._workspace.cwd, d), { recursive: true });
    }

    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) {
      let envContent = DEFAULT_ENV;
      const gc = this._loadGlobalConfig();
      if (gc.api_key) envContent = envContent.replace("SILICONFLOW_API_KEY=", `SILICONFLOW_API_KEY=${gc.api_key}`);
      if (gc.base_url) envContent = envContent.replace("SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1", `SILICONFLOW_BASE_URL=${gc.base_url}`);
      if (gc.accuracy_threshold) {
        envContent = envContent.replace("SKILL_ACCURACY=0.9", `SKILL_ACCURACY=${gc.accuracy_threshold}`);
        envContent = envContent.replace("WORKFLOW_ACCURACY=0.9", `WORKFLOW_ACCURACY=${gc.accuracy_threshold}`);
      }
      const tiers = gc.tiers || {};
      for (const tk of ["tier1", "tier2", "tier3", "tier4"]) {
        if (tiers[tk]) {
          const tag = tk.toUpperCase();
          envContent = envContent.split("\n").map((l) => l.startsWith(`${tag}=`) ? `${tag}=${tiers[tk]}` : l).join("\n");
        }
      }
      fs.writeFileSync(envPath, envContent, "utf-8");
    }

    const manifestPath = path.join(this._workspace.cwd, "versions.json");
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, JSON.stringify({ version: "0.1.0", entries: [] }, null, 2), "utf-8");
    }

    this.workspaceCreated = true;
    this._checkRegulations();
    this._checkSamples();
    this._checkConfig();
  }

  _checkRegulations() {
    const dir = path.join(this._workspace.cwd, "rules");
    if (!fs.existsSync(dir)) { this.hasRegulations = false; return; }
    this.hasRegulations = fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile());
  }

  _checkSamples() {
    const dir = path.join(this._workspace.cwd, "samples");
    if (!fs.existsSync(dir)) { this.hasSamples = false; return; }
    this.hasSamples = fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile());
  }

  _checkConfig() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("SILICONFLOW_API_KEY=") && line.split("=")[1].trim()) {
          this.configReady = true; return;
        }
      }
    }
    const gc = this._loadGlobalConfig();
    this.configReady = !!gc.api_key;
  }

  _loadGlobalConfig() {
    const p = path.join(os.homedir(), ".kc_agent", "config.json");
    if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* skip */ } }
    return {};
  }

  describeState() {
    const completed = [], pending = [];
    if (this.workspaceCreated) completed.push("Workspace structure created"); else pending.push("Create workspace structure");
    if (this.configReady) completed.push("Configuration ready (API keys set)"); else pending.push("Configure .env (API key needed)");
    if (this.hasRegulations) completed.push("Regulation documents available in rules/"); else pending.push("Regulation documents needed in rules/");
    if (this.hasSamples) completed.push("Sample documents available in samples/"); else pending.push("Sample documents needed in samples/");

    const parts = ["## Current Phase: BOOTSTRAP"];
    if (completed.length) parts.push("### Completed\n" + completed.map((c) => `- [x] ${c}`).join("\n"));
    if (pending.length) parts.push("### Pending\n" + pending.map((p) => `- [ ] ${p}`).join("\n"));

    if (this.exitCriteriaMet()) {
      parts.push("### Ready\nAll bootstrap requirements met. Proceed to EXTRACTION phase.");
    } else {
      parts.push(
        "### What to do now\nTalk to the developer user about their verification scenario:\n" +
        "- What documents do they verify?\n- What regulations apply?\n" +
        "- Ask them to provide regulation documents (save to rules/) and sample documents (save to samples/)."
      );
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();

    if (toolName === "workspace_file") {
      const op = toolInput.operation || "";
      const p = toolInput.path || "";
      if (op === "write") {
        if (p.startsWith("rules/")) this.hasRegulations = true;
        else if (p.startsWith("samples/")) this.hasSamples = true;
        else if (p === ".env") this._checkConfig();
      } else if (op === "list") {
        this._checkRegulations();
        this._checkSamples();
      }
    }

    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Bootstrap complete. Ready for EXTRACTION.", nextPhase: Phase.EXTRACTION });
    }
    return null;
  }

  exitCriteriaMet() {
    return this.workspaceCreated && this.configReady && this.hasRegulations && this.hasSamples;
  }
}
