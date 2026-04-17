import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_MD_TEMPLATE = path.resolve(__dirname, "../../../template/AGENT.md");

const REQUIRED_DIRS = ["rules", "samples", "input", "output", "logs", "workflows", "rule_skills"];

const DEFAULT_ENV = `# === KC Agent Project Configuration ===

# Language: en | zh
LANGUAGE=en

# === LLM API ===
LLM_API_KEY=
LLM_BASE_URL=https://api.siliconflow.cn/v1

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
      if (gc.api_key) envContent = envContent.replace("LLM_API_KEY=", `LLM_API_KEY=${gc.api_key}`);
      if (gc.base_url) envContent = envContent.replace("LLM_BASE_URL=https://api.siliconflow.cn/v1", `LLM_BASE_URL=${gc.base_url}`);
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

    // AGENT.md — per-project context (agent can modify). Auto-commit so
    // git captures the seed.
    const agentMdPath = path.join(this._workspace.cwd, "AGENT.md");
    if (!fs.existsSync(agentMdPath) && fs.existsSync(AGENT_MD_TEMPLATE)) {
      fs.copyFileSync(AGENT_MD_TEMPLATE, agentMdPath);
      this._workspace.autoCommit?.("AGENT.md", "seed");
    }

    this.workspaceCreated = true;
    this._checkRegulations();
    this._checkSamples();
    this._checkConfig();
  }

  _checkRegulations() {
    // Check workspace rules/
    const dir = path.join(this._workspace.cwd, "rules");
    if (fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile())) {
      this.hasRegulations = true; return;
    }
    // Check project dir rules/ (case-insensitive)
    if (this._workspace.projectDir) {
      for (const name of ["rules", "Rules", "RULES", "regulations", "Regulations"]) {
        const pdir = path.join(this._workspace.projectDir, name);
        if (fs.existsSync(pdir) && fs.statSync(pdir).isDirectory() &&
            fs.readdirSync(pdir, { withFileTypes: true }).some((e) => e.isFile())) {
          this.hasRegulations = true; return;
        }
      }
    }
    this.hasRegulations = false;
  }

  _checkSamples() {
    // Check workspace samples/
    const dir = path.join(this._workspace.cwd, "samples");
    if (fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile())) {
      this.hasSamples = true; return;
    }
    // Check project dir samples/ (case-insensitive)
    if (this._workspace.projectDir) {
      for (const name of ["samples", "Samples", "SAMPLES", "sample", "Sample"]) {
        const pdir = path.join(this._workspace.projectDir, name);
        if (fs.existsSync(pdir) && fs.statSync(pdir).isDirectory() &&
            fs.readdirSync(pdir, { withFileTypes: true }).some((e) => e.isFile())) {
          this.hasSamples = true; return;
        }
      }
    }
    this.hasSamples = false;
  }

  _checkConfig() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if ((line.startsWith("LLM_API_KEY=") || line.startsWith("SILICONFLOW_API_KEY=")) && line.split("=")[1].trim()) {
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
    if (this.workspaceCreated) completed.push("Workspace structure created"); else pending.push("Workspace structure");
    if (this.configReady) completed.push("API keys configured"); else pending.push("API keys (check .env)");
    if (this.hasRegulations) completed.push("Regulation documents found"); else pending.push("Regulation documents (add to rules/ in workspace or project dir)");
    if (this.hasSamples) completed.push("Sample documents found"); else pending.push("Sample documents (add to samples/ in workspace or project dir)");

    const parts = ["## Phase: BOOTSTRAP\nSet up the workspace and understand the developer user's verification scenario. Bundled methodology skills are available in the workspace skills/ directory."];
    if (this._workspace.projectDir) {
      parts.push(`**Project directory:** ${this._workspace.projectDir}\nUse scope="project" to read files from the user's project folder.`);
    }
    if (completed.length) parts.push("### Done\n" + completed.map((c) => `- [x] ${c}`).join("\n"));
    if (pending.length) parts.push("### Needed\n" + pending.map((p) => `- [ ] ${p}`).join("\n"));

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nBootstrap requirements met. Proceed to EXTRACTION.");
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasReady = this.exitCriteriaMet();

    if (toolName === "workspace_file") {
      const op = toolInput.operation || "";
      const p = toolInput.path || "";
      const scope = toolInput.scope || "workspace";
      if (op === "write" && scope === "workspace") {
        if (p.startsWith("rules/")) this.hasRegulations = true;
        else if (p.startsWith("samples/")) this.hasSamples = true;
        else if (p === ".env") this._checkConfig();
      } else if (op === "list" || op === "read") {
        // Re-check after any list/read — project dir files may satisfy criteria
        this._checkRegulations();
        this._checkSamples();
      }
    } else if (toolName === "document_parse") {
      // Parsing a document from project dir counts as having files
      this._checkRegulations();
      this._checkSamples();
    }

    if (!wasReady && this.exitCriteriaMet()) {
      return new PipelineEvent({ type: "phase_ready", message: "Bootstrap complete. Ready for EXTRACTION.", nextPhase: Phase.EXTRACTION });
    }
    return null;
  }

  exitCriteriaMet() {
    return this.workspaceCreated && this.configReady && this.hasRegulations && this.hasSamples;
  }

  exportState() {
    return {
      workspaceCreated: this.workspaceCreated,
      configReady: this.configReady,
      hasRegulations: this.hasRegulations,
      hasSamples: this.hasSamples,
    };
  }

  importState(data) {
    if (data.workspaceCreated) this.workspaceCreated = true;
    if (data.configReady) this.configReady = true;
    if (data.hasRegulations) this.hasRegulations = true;
    if (data.hasSamples) this.hasSamples = true;
  }
}
