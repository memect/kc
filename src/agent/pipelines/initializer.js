import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Phase, PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { deriveBootstrapMilestones } from "./_milestone-derive.js";

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
    // v0.7.0 A1: route workspace check through filesystem-derived helper.
    // Helper walks recursively (catches E2E #5 GLM's samples/samples/
    // nested layout that the previous top-level-only check missed) and
    // counts files at any depth. Project-dir fallback kept for the
    // "user has samples but hasn't ingested them yet" path.
    const m = deriveBootstrapMilestones(this._workspace);
    if (m.hasSamples) { this.hasSamples = true; return; }

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

  /**
   * F1b: Worker LLM health snapshot. Static check only — inspect whether
   * TIER1-4 and OCR_MODEL_TIER1 are populated in .env. Does NOT make
   * network calls — a live ping would be invasive for bootstrap (slow,
   * charges money, and the worker LLM isn't actually used until
   * DISTILLATION). Surfacing the config state is enough for bootstrap.
   * The agent can then decide to validate via worker_llm_call later if
   * warranted. Returns null when no .env exists yet.
   */
  _workerConfigSnapshot() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) return null;
    const tiers = { TIER1: "", TIER2: "", TIER3: "", TIER4: "", OCR_MODEL_TIER1: "" };
    try {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        for (const k of Object.keys(tiers)) {
          if (line.startsWith(`${k}=`)) {
            tiers[k] = line.slice(k.length + 1).trim();
          }
        }
      }
    } catch { return null; }
    return tiers;
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

    // F1b: surface worker-LLM tier status as part of bootstrap state so
    // the agent can flag missing tiers to the developer user upfront,
    // rather than hitting "worker LLM unreachable" hours later during
    // DISTILLATION. Static inspection only — no network calls.
    const workerConfig = this._workerConfigSnapshot();
    if (workerConfig) {
      const tierLines = [];
      for (const [k, v] of Object.entries(workerConfig)) {
        if (v) tierLines.push(`- ${k}: ${v}`);
        else tierLines.push(`- ${k}: ⚠️ (empty — set before DISTILLATION, or worker_llm_call tools will fail)`);
      }
      parts.push("### Worker LLM tiers (.env snapshot)\n" + tierLines.join("\n") +
        "\n\nThese drive `worker_llm_call`, `workflow_run`, `document_parse` OCR, etc. Empty tiers don't block bootstrap — but DISTILLATION requires at least TIER1 to be live. Discuss with the developer user if any are missing.");
    }

    if (this.exitCriteriaMet()) {
      parts.push("### Exit\nBootstrap requirements met. Proceed to RULE_EXTRACTION.");
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
      return new PipelineEvent({ type: "phase_ready", message: "Bootstrap complete. Ready for RULE_EXTRACTION.", nextPhase: Phase.EXTRACTION });
    }
    return null;
  }

  exitCriteriaMet() {
    return this.workspaceCreated && this.configReady && this.hasRegulations && this.hasSamples;
  }

  /**
   * v0.6.3 (#74): nudge the agent when it does work that belongs to a later
   * phase. Bootstrap is setup — reading rules/samples, configuring keys,
   * orienting. Writing skill code, running workflows, or spawning extraction
   * subagents from BOOTSTRAP means the milestones get tagged "bootstrap"
   * instead of the right phase, breaking later exit-criteria checks.
   */
  phaseMisfitHint(toolName, toolInput, result) {
    if (result?.isError) return null;
    const exitText = this.exitCriteriaMet()
      ? "Bootstrap exit criteria are MET — call phase_advance(to=\"rule_extraction\") now to record this work under the right phase."
      : "Bootstrap exit criteria NOT yet met (see describeState). Either complete bootstrap setup first, or use force:true on phase_advance if you've decided to skip ahead.";

    if (toolName === "workspace_file" && toolInput?.operation === "write") {
      const p = toolInput.path || "";
      if (p.startsWith("rule_skills/")) {
        return `Writing under rule_skills/ is SKILL_AUTHORING-phase work, but engine is in BOOTSTRAP. ${exitText}`;
      }
      if (p.startsWith("workflows/")) {
        return `Writing under workflows/ is DISTILLATION-phase work, but engine is in BOOTSTRAP. ${exitText}`;
      }
      if (p.startsWith("output/results/")) {
        return `Writing under output/results/ is PRODUCTION_QC-phase work, but engine is in BOOTSTRAP. ${exitText}`;
      }
    }

    if (toolName === "workflow_run") {
      return `workflow_run is SKILL_TESTING/PRODUCTION_QC-phase work, but engine is in BOOTSTRAP. Workflow results recorded now will be milestone-tagged "bootstrap" and won't count toward later exit criteria. ${exitText}`;
    }

    // v0.6.3.1 patch: rule_catalog is the most direct signature of
    // RULE_EXTRACTION work. Creating/updating rules from BOOTSTRAP means the
    // rule_extraction pipeline's milestone tracker stays at zero (its
    // onToolResult only fires when engine.currentPhase matches), so the
    // exit gate will refuse later. Caught Tencent hy3-preview after it
    // created 22 rules silently in the wrong phase. Same risk for any
    // model that skips sample-inventory and jumps to rule decomposition.
    if (toolName === "rule_catalog" &&
        ["create", "update", "delete"].includes(toolInput?.operation)) {
      return `rule_catalog ${toolInput.operation} is RULE_EXTRACTION-phase work, but engine is in BOOTSTRAP. Rules created now WILL be persisted in rules/catalog.json (the tool writes regardless of phase), but the rule_extraction pipeline's milestone tracker won't pick them up until you're in that phase, and the v0.6.3 exit gate will refuse to advance from BOOTSTRAP unless its own criteria are met. ${exitText}`;
    }

    if (toolName === "agent_tool" && toolInput?.operation === "spawn") {
      const taskId = (toolInput.task_id || "").toLowerCase();
      // Heuristic: task_ids hinting at extraction/skill/workflow work are
      // out-of-phase from bootstrap. Doc-parsing or setup-shaped task names
      // are fine.
      if (/extract|rule|skill|workflow|verify|qc|distill/.test(taskId)) {
        return `Spawning subagent "${toolInput.task_id}" looks like ${this._guessSubagentPhase(taskId).toUpperCase()}-phase work, but engine is in BOOTSTRAP. Milestones the subagent emits will be tagged "bootstrap", causing the target phase's exit criteria to start at zero later. ${exitText}`;
      }
    }

    return null;
  }

  _guessSubagentPhase(taskId) {
    if (/extract|rule/.test(taskId)) return "rule_extraction";
    if (/skill/.test(taskId)) return "skill_authoring";
    if (/workflow|distill/.test(taskId)) return "distillation";
    if (/verify|qc/.test(taskId)) return "production_qc";
    return "later";
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
