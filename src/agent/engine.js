import fs from "node:fs";
import path from "node:path";
import { AgentEvent } from "./events.js";
import {
  deriveSkillAuthoringMilestones,
  deriveSkillTestingMilestones,
} from "./pipelines/_milestone-derive.js";
import { ContextAssembler } from "./context.js";
import { ConversationHistory } from "./history.js";
import { findSafeSplitPoint } from "./message-utils.js";
import { Workspace } from "./workspace.js";
import { normalizeRuleCatalog } from "./rule-catalog-normalize.js";
import { VersionManager } from "./version-manager.js";
import { CornerCaseRegistry } from "./corner-case-registry.js";
import { ConfidenceScorer } from "./confidence-scorer.js";
import { ToolRegistry } from "./tools/registry.js";
import { SandboxExecTool } from "./tools/sandbox-exec.js";
import { WorkspaceFileTool } from "./tools/workspace-file.js";
import { CopyToWorkspaceTool } from "./tools/copy-to-workspace.js";
import { SnapshotTool } from "./tools/snapshot.js";
import { ArchiveFileTool } from "./tools/archive-file.js";
import { ScheduleFetchTool } from "./tools/schedule-fetch.js";
import { ReleaseTool } from "./tools/release.js";
import { PhaseAdvanceTool } from "./tools/phase-advance.js";
import { DocumentParseTool } from "./tools/document-parse.js";
import { DocumentSearchTool } from "./tools/document-search.js";
import { DocumentChunkTool } from "./tools/document-chunk.js";
import { BundleSearchTool } from "./tools/bundle-search.js";
import { DocumentClassifyTool } from "./tools/document-classify.js";
import { WorkerLLMCallTool } from "./tools/worker-llm-call.js";
import { WorkflowRunTool } from "./tools/workflow-run.js";
import { RuleCatalogTool } from "./tools/rule-catalog.js";
import { QCSampleTool } from "./tools/qc-sample.js";
import { DashboardRenderTool } from "./tools/dashboard-render.js";
import { EvolutionCycleTool } from "./tools/evolution-cycle.js";
import { TierDowngradeTool } from "./tools/tier-downgrade.js";
import { AgentTool } from "./tools/agent-tool.js";
import { WebSearchTool } from "./tools/web-search.js";
import { SkillLoader } from "./skill-loader.js";
import { TaskManager } from "./task-manager.js";
import { Scheduler } from "./scheduler.js";
import { Phase } from "./pipelines/index.js";
import { ProjectInitializer } from "./pipelines/initializer.js";
import { RuleExtractionPipeline } from "./pipelines/extraction.js";
import { SkillAuthoringPipeline } from "./pipelines/skill-authoring.js";
import { SkillTestingPipeline } from "./pipelines/skill-testing.js";
import { DistillationEngine as DistillationPipeline } from "./pipelines/distillation.js";
import { ProductionQCPipeline } from "./pipelines/production-qc.js";
import { FinalizationPipeline } from "./pipelines/finalization.js";
import { EventLog } from "./event-log.js";
import { ContextWindow } from "./context-window.js";
import { SessionState } from "./session-state.js";
import { estimateTokens, estimateMessagesTokens } from "./token-counter.js";

// Default max output tokens for the conductor LLM. SOTA models (GLM-5,
// Claude Sonnet 4) handle this comfortably. Override via KC_MAX_TOKENS env
// or kc_max_tokens in the global config.
const DEFAULT_KC_MAX_TOKENS = 65536;

/**
 * v0.6.3.1: Tolerant JSON parse for streamed tool-call arguments. When LLMs
 * (esp. SiliconFlow GLM-5.1 in E2E #5) hit max_tokens mid-arguments, the
 * stream returns truncated JSON missing N closing braces or quotes. Strict
 * parse fails; old code silently dropped to {} which masked the actual issue.
 *
 * Strategy:
 *   1. Try strict JSON.parse (fast path, most calls).
 *   2. On failure, attempt to balance braces by appending up to BRACE_BUDGET
 *      `}` characters. Cheap; recovers the common single-brace-truncation case.
 *   3. If still failing, return error so caller surfaces it to the agent.
 *
 * Returns { ok: true, value, recovered? } | { ok: false, error }.
 */
const BRACE_RECOVERY_BUDGET = 4;
function parseToolArgsTolerant(raw) {
  if (typeof raw !== "string") return { ok: false, error: "arguments not a string" };
  if (raw === "") return { ok: true, value: {} };
  // Fast path
  try { return { ok: true, value: JSON.parse(raw) }; } catch (e0) {
    // Recovery: balance braces by appending up to BRACE_RECOVERY_BUDGET `}`
    const opens = (raw.match(/\{/g) || []).length;
    const closes = (raw.match(/\}/g) || []).length;
    const needed = opens - closes;
    if (needed > 0 && needed <= BRACE_RECOVERY_BUDGET) {
      const padded = raw + "}".repeat(needed);
      try { return { ok: true, value: JSON.parse(padded), recovered: needed }; } catch (_) { /* fall through */ }
    }
    // Last-ditch: try closing an open string then balancing braces.
    // Truncation can land mid-string-value: ..."description": "abc<EOF>
    const quotes = (raw.match(/"/g) || []).length;
    if (quotes % 2 === 1) {
      const candidate = raw + '"' + "}".repeat(Math.max(1, needed));
      try { return { ok: true, value: JSON.parse(candidate), recovered: candidate.length - raw.length }; } catch (_) { /* fall through */ }
    }
    return { ok: false, error: e0.message || "JSON parse failed" };
  }
}

// Phases where worker LLM tools are available (DISTILL mode).
// E1: FINALIZATION inherits worker-LLM access so one-last-pass validation
// runs + dashboard_render + workflow_run stay usable during packaging.
const DISTILL_PHASES = new Set([Phase.DISTILLATION, Phase.PRODUCTION_QC, Phase.FINALIZATION]);

// Linear phase order — used by auto-advance (Bug 4). Last phase has no successor.
// Exported so the TUI's /phase slash command (src/cli/index.js) can call
// _advancePhase with the right successor without re-declaring the map.
export const NEXT_PHASE = {
  [Phase.BOOTSTRAP]: Phase.EXTRACTION,
  [Phase.EXTRACTION]: Phase.SKILL_AUTHORING,
  [Phase.SKILL_AUTHORING]: Phase.SKILL_TESTING,
  [Phase.SKILL_TESTING]: Phase.DISTILLATION,
  [Phase.DISTILLATION]: Phase.PRODUCTION_QC,
  [Phase.PRODUCTION_QC]: Phase.FINALIZATION, // E1: new 7th phase
};

// v0.6.2 J2: explicit linear order so `_advancePhase` can detect rollback
// direction (target index < current index → rollback). Mirrors NEXT_PHASE
// but ordered, plus FINALIZATION at the end as the terminal phase.
export const PHASE_ORDER = [
  Phase.BOOTSTRAP,
  Phase.EXTRACTION,
  Phase.SKILL_AUTHORING,
  Phase.SKILL_TESTING,
  Phase.DISTILLATION,
  Phase.PRODUCTION_QC,
  Phase.FINALIZATION,
];

/**
 * The KC Agent conversation engine.
 *
 * Core loop: user message -> context assembly -> LLM API (streaming) ->
 * tool execution (if any) -> repeat until no tool calls -> turn complete.
 *
 * Tools are phase-gated: worker LLM tools only available in DISTILL mode.
 */
export class AgentEngine {
  /**
   * @param {object} opts
   * @param {import('./llm-client.js').LLMClient} opts.client
   * @param {object} opts.config - Settings from loadSettings()
   * @param {string} [opts.sessionId]
   * @param {string} [opts.subagentScope] - When set, persistence is isolated to
   *   sub_agents/<scope>/ inside the workspace. Used by `agent_tool` to spawn
   *   children that share workspace files but don't trash parent's history /
   *   tasks / session-state. (Bug 2)
   * @param {string} [opts.initialPhase] - When set, the engine starts in this phase
   *   instead of BOOTSTRAP. Used by sub-agents to inherit parent's phase so they
   *   get the right tools registered. (Bug 2)
   */
  constructor({ client, config, sessionId, subagentScope, initialPhase }) {
    this.client = client;
    this.config = config;
    this.context = new ContextAssembler();
    this._isSubagent = !!subagentScope;
    this._subagentScope = subagentScope || null;

    // Workspace + structural components
    this.workspace = new Workspace(
      config.kcWorkspaceRoot,
      sessionId,
      config.projectDir,
      { gitAutoCommit: config.gitAutoCommit !== false },
    );

    // For sub-agents, persistence (history/events/state) lives under
    // sub_agents/<scope>/ instead of the workspace root. Workspace files
    // (rules/, rule_skills/, workflows/) stay shared.
    let conversationDir, logDir, statePath;
    if (this._isSubagent) {
      // Defense-in-depth: even though agent_tool sanitizes task_id against
      // VALID_TASK_ID, an attacker reaching engine construction through
      // another path (e.g. future callers) must not escape the workspace.
      const scopeRoot = path.resolve(this.workspace.cwd, "sub_agents", subagentScope);
      const wsRoot = path.resolve(this.workspace.cwd);
      if (scopeRoot !== wsRoot && !scopeRoot.startsWith(wsRoot + path.sep)) {
        throw new Error(`sub-agent scope escapes workspace: ${subagentScope}`);
      }
      // Also reject the scopeRoot being the workspace root itself, since that
      // would defeat isolation.
      if (scopeRoot === wsRoot || scopeRoot === path.resolve(wsRoot, "sub_agents")) {
        throw new Error(`sub-agent scope must be a unique subfolder, got: ${subagentScope}`);
      }
      fs.mkdirSync(scopeRoot, { recursive: true });
      conversationDir = path.join(scopeRoot, "conversation");
      logDir = path.join(scopeRoot, "logs");
      statePath = path.join(scopeRoot, "session-state.json");
    }

    const initialPhaseValue = initialPhase || Phase.BOOTSTRAP;
    this.workspace.setPhase(initialPhaseValue);
    this.history = new ConversationHistory(this.workspace.cwd, {
      conversationDir,
      maxMessageTokens: this.config.maxMessageTokens,
    });
    this.versionManager = new VersionManager(this.workspace.cwd);
    this.cornerCases = new CornerCaseRegistry(this.workspace.cwd);
    this.confidence = new ConfidenceScorer(this.workspace.cwd, this.cornerCases);

    // Event log (append-only JSONL, source of truth)
    this.eventLog = new EventLog(this.workspace.cwd, { logDir });

    // Context windowing
    this.contextWindow = new ContextWindow({
      contextLimit: config.kcContextLimit || 200000,
      reserveForResponse: config.kcMaxTokens || DEFAULT_KC_MAX_TOKENS,
    });

    // Session state persistence
    this.sessionState = new SessionState(this.workspace.cwd, { statePath, workspace: this.workspace });

    // Task manager (ralph-loop) — sub-agents don't queue further sub-tasks,
    // so they don't get a TaskManager.
    this.taskManager = this._isSubagent ? null : new TaskManager(this.workspace.cwd);

    // Build all tool instances (but register phase-appropriate ones)
    this._buildTools = this._createAllTools();
    this._phaseSummaries = [];

    // Pipeline system (meta-meta skills as code)
    this.currentPhase = initialPhaseValue;
    this.pipelines = {
      [Phase.BOOTSTRAP]: new ProjectInitializer(this.workspace),
      [Phase.EXTRACTION]: new RuleExtractionPipeline(this.workspace),
      [Phase.SKILL_AUTHORING]: new SkillAuthoringPipeline(this.workspace, this.taskManager),
      [Phase.SKILL_TESTING]: new SkillTestingPipeline(this.workspace),
      [Phase.DISTILLATION]: new DistillationPipeline(this.workspace),
      [Phase.PRODUCTION_QC]: new ProductionQCPipeline(this.workspace),
      [Phase.FINALIZATION]: new FinalizationPipeline(this.workspace), // E1
    };

    // Skill discovery (Claude Code pattern: index in context, full content on demand)
    this._skillLoader = new SkillLoader(config.language);

    // Register tools for initial phase
    this.toolRegistry = new ToolRegistry();
    this._registerToolsForPhase(this.currentPhase);

    // Edge-trigger state for _maybeAutoAdvance. Initialize to false for every
    // phase so the first real false→true flip inside onToolResult triggers an
    // advance — even when the user launches from a pre-populated workspace
    // whose exit criteria already happen to be met at boot.
    // resume() re-primes this from the restored pipeline state (see ~L566),
    // which is the correct behaviour there: resumed sessions that were already
    // past this phase shouldn't re-fire.
    this._lastReady = Object.fromEntries(
      Object.keys(this.pipelines).map((p) => [p, false]),
    );

    // B0.1: Heap sampler. Parent engines only — sub-agents share a process
    // with the parent and would double-log. Writes a single JSONL line
    // per minute to <workspace>/logs/heap.jsonl with the numbers needed
    // to diagnose RSS creep (heapUsed/heapTotal/external/rss/arrayBuffers,
    // plus active task count and history length). Always on, ~60 bytes
    // per minute to disk.
    this._heapSamplerStop = this._isSubagent ? null : this._startHeapSampler();
  }

  /**
   * Start sampling process.memoryUsage() every 60 s into logs/heap.jsonl.
   * Returns a stop fn. Timer is .unref()'d so it never keeps the process
   * alive by itself. Failures are silently suppressed — this is a
   * diagnostic, not a correctness feature.
   */
  _startHeapSampler() {
    const logDir = path.join(this.workspace.cwd, "logs");
    const logPath = path.join(logDir, "heap.jsonl");
    const sample = () => {
      try {
        const mem = process.memoryUsage();
        const row = {
          t: new Date().toISOString(),
          seq: this.eventLog?.currentSeq ?? 0,
          phase: this.currentPhase,
          rssMB: Math.round(mem.rss / 1024 / 1024),
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          externalMB: Math.round((mem.external || 0) / 1024 / 1024),
          arrayBuffersMB: Math.round((mem.arrayBuffers || 0) / 1024 / 1024),
          historyLen: this.history?.messages?.length ?? 0,
          tasksPending: this.taskManager?.progress?.pending ?? 0,
          tasksInProgress: this.taskManager?.progress?.inProgress ?? 0,
          // v0.6.2 K1: per-component breakdown so heap-analyze.js can
          // attribute growth (history vs subagents vs event log vs cache).
          // All values in MB. Failures inside _sampleComponents are caught
          // and the row gets `componentsErr` instead.
          components: this._sampleComponents(),
        };
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify(row) + "\n", "utf-8");
      } catch { /* never fatal */ }
    };
    // Record one sample at startup so we have a baseline even on short runs.
    sample();
    const timer = setInterval(sample, 60_000);
    timer.unref?.();
    return () => {
      try {
        clearInterval(timer);
        sample(); // one final sample on shutdown
      } catch { /* ignore */ }
    };
  }

  /**
   * v0.6.2 K1: per-component heap accounting. Each value is in MB,
   * rounded. The whole function is wrapped in a single try/catch by the
   * caller; failures are silently dropped to keep the sampler diagnostic
   * (never load-bearing).
   *
   * Components measured (by source):
   *  - history: in-memory `this.history.messages` content sizes (sum of
   *    JSON-stringified content)
   *  - eventLog: disk size of `logs/events.jsonl`
   *  - toolResults: disk size of `logs/tool_results/` (offloaded tool
   *    output, summed top-level files only — the dir is one level deep)
   *  - subagents: disk size of `sub_agents/` (one level — each subagent
   *    has its own directory tree but we just want the order of magnitude)
   *  - bundleCache: disk size of `cache/bundles/`
   */
  _sampleComponents() {
    const out = { historyMB: 0, eventLogMB: 0, toolResultsMB: 0, subagentsMB: 0, bundleCacheMB: 0 };
    const cwd = this.workspace?.cwd;
    if (!cwd) return out;
    // history: walk messages, sum content string lengths (UTF-16 → bytes
    // approx 2× length; we conservatively count length itself since most
    // content is ASCII-heavy JSON tool output)
    try {
      const msgs = this.history?.messages || [];
      let bytes = 0;
      for (const m of msgs) {
        const c = m?.content;
        if (typeof c === "string") bytes += c.length;
        else if (Array.isArray(c)) {
          for (const part of c) {
            if (typeof part === "string") bytes += part.length;
            else if (part?.text) bytes += String(part.text).length;
            else if (part?.content) bytes += String(part.content).length;
            else if (part?.input) bytes += JSON.stringify(part.input).length;
          }
        } else if (c && typeof c === "object") {
          bytes += JSON.stringify(c).length;
        }
      }
      out.historyMB = Math.round(bytes / 1024 / 1024);
    } catch { /* skip */ }
    // events.jsonl — single file size
    try {
      const p = path.join(cwd, "logs", "events.jsonl");
      out.eventLogMB = Math.round(fs.statSync(p).size / 1024 / 1024);
    } catch { /* skip */ }
    // logs/tool_results/ — sum file sizes one level deep (it's flat)
    try {
      const dir = path.join(cwd, "logs", "tool_results");
      let total = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) {
          try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* skip */ }
        }
      }
      out.toolResultsMB = Math.round(total / 1024 / 1024);
    } catch { /* skip */ }
    // sub_agents/ — sum top-level entries (each is a dir, statSync returns
    // dir-block size, not contents — that's fine for an order-of-magnitude
    // signal; recursive walk would be too expensive for the sampler)
    try {
      const dir = path.join(cwd, "sub_agents");
      let total = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* skip */ }
      }
      out.subagentsMB = Math.round(total / 1024 / 1024);
    } catch { /* skip */ }
    // cache/bundles/
    try {
      const dir = path.join(cwd, "cache", "bundles");
      let total = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) {
          try { total += fs.statSync(path.join(dir, e.name)).size; } catch { /* skip */ }
        }
      }
      out.bundleCacheMB = Math.round(total / 1024 / 1024);
    } catch { /* skip */ }
    return out;
  }

  /** Stop background diagnostics. Call on graceful shutdown. */
  stop() {
    try { this._heapSamplerStop?.(); } catch { /* ignore */ }
    this._heapSamplerStop = null;
  }

  /**
   * Create all tool instances. Separated from registration so we can
   * re-register per phase without recreating.
   */
  _createAllTools() {
    // Worker LLM uses separate config if set, otherwise falls back to conductor
    const workerApiKey = this.config.effectiveWorkerApiKey();
    const workerBaseUrl = this.config.effectiveWorkerBaseUrl();
    const workerAuthType = this.config.effectiveWorkerAuthType();

    const workerLlm = new WorkerLLMCallTool(this.workspace, {
      apiKey: workerApiKey,
      baseUrl: workerBaseUrl,
      authType: workerAuthType,
    });

    // OCR/VLM uses worker config (VLM is a type of worker LLM)
    const vlmModel = this.config.vlmTier1 || "";

    return {
      // Always available (BUILD + DISTILL)
      core: [
        new SandboxExecTool(this.workspace, this.config.kcExecTimeout),
        new WorkspaceFileTool(this.workspace, this.versionManager),
        new CopyToWorkspaceTool(this.workspace, {
          largeRefThresholdMB: this.config.largeRefThresholdMB ?? 10,
        }),
        new SnapshotTool(this.workspace),
        new ArchiveFileTool(this.workspace),
        new ScheduleFetchTool(this.workspace),
        new ReleaseTool(this.workspace, { kcVersion: "0.5.2" }),
        new PhaseAdvanceTool(
          (to, reason, opts) => this._advancePhase(to, reason, opts),
          () => this.currentPhase, // H1: tool reads phase BEFORE its own call
          // v0.6.2 J1: surface running subagents so the tool can refuse
          // advance until the agent explicitly acknowledges them.
          () => {
            try {
              const agentTool = this._buildTools?.core?.find((t) => t?.name === "agent_tool");
              return agentTool?.getRunningTaskIds?.() || [];
            } catch { return []; }
          },
        ),
        new DocumentParseTool(this.workspace, {
          mineruApiUrl: this.config.mineruApiUrl,
          mineruApiKey: this.config.mineruApiKey,
          llmApiKey: workerApiKey,
          llmBaseUrl: workerBaseUrl,
          ocrModel: vlmModel,
        }),
        new DocumentSearchTool(this.workspace),
        // Group C — chunker/RAG infrastructure ported from AMC app. Core
        // tools (not phase-gated): useful from BOOTSTRAP through FINALIZATION
        // for any doc-heavy project, not just rule extraction.
        new DocumentChunkTool(this.workspace),
        new BundleSearchTool(this.workspace),
        new DocumentClassifyTool(this.workspace, this.config),
        new RuleCatalogTool(this.workspace),
        new EvolutionCycleTool(this.workspace, this.cornerCases),
        new DashboardRenderTool(this.workspace),
        new AgentTool(
          this.workspace,
          ({ sessionId, subagentScope, initialPhase }) => new AgentEngine({
            client: this.client, config: this.config,
            sessionId, subagentScope, initialPhase,
          }),
          () => this.currentPhase,
        ),
        new WebSearchTool(this.config.tavilyApiKey),
      ],
      // Distillation+ only (DISTILL mode)
      distill: [
        workerLlm,
        new WorkflowRunTool(this.workspace, this.versionManager, this.confidence, {
          // v0.6.1 A6: hook engine-emitted milestones so phase gates see workflow runs
          recordMilestone: (phase, key, value) => this._recordMilestone(phase, key, value),
          getCurrentPhase: () => this.currentPhase,
        }),
        new TierDowngradeTool(this.workspace, workerLlm),
        new QCSampleTool(this.workspace),
      ],
    };
  }

  /**
   * Register tools appropriate for the given phase.
   * BUILD phases get core tools only.
   * DISTILL phases get core + worker LLM tools.
   */
  _registerToolsForPhase(phase) {
    this.toolRegistry = new ToolRegistry();
    for (const tool of this._buildTools.core) {
      this.toolRegistry.register(tool);
    }
    if (DISTILL_PHASES.has(phase)) {
      for (const tool of this._buildTools.distill) {
        this.toolRegistry.register(tool);
      }
    }
  }

  /**
   * Read AGENT.md from workspace (per-project context).
   * Returns content string or empty string if not found.
   */
  _readAgentMd() {
    const agentMdPath = path.join(this.workspace.cwd, "AGENT.md");
    try {
      if (fs.existsSync(agentMdPath)) {
        return fs.readFileSync(agentMdPath, "utf-8");
      }
    } catch { /* ignore */ }
    return "";
  }

  /**
   * v0.7.0 B3: Read rules/PATTERNS.md (project memory) for surfacing in
   * the system prompt. Only loaded for phases where the agent owns
   * decomposition decisions (skill_authoring + skill_testing — the two
   * phases the work-decomposition skill operates in). Capped at ~5 KB
   * so it stays trivial token-wise; if the file is larger, we truncate
   * to the first 5 KB and append a "...truncated" marker so the agent
   * knows to prune.
   */
  _readProjectMemory() {
    if (!["skill_authoring", "skill_testing"].includes(this.currentPhase)) return null;
    const p = path.join(this.workspace.cwd, "rules", "PATTERNS.md");
    try {
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, "utf-8");
      const CAP = 5 * 1024;
      if (raw.length <= CAP) return raw;
      return raw.slice(0, CAP) + "\n\n…truncated at 5 KB — prune the least-actionable entries (work-decomposition skill: Sizing).";
    } catch { return null; }
  }

  /**
   * Build the workspace/project directory state string for the system prompt.
   */
  _buildWorkspaceState() {
    const lines = [
      `## Directory Layout`,
      `**KC Workspace:** ${this.workspace.cwd}`,
      `  Use scope="workspace" (default). Write all working files here (rules, skills, workflows, results, logs).`,
    ];
    if (this.workspace.projectDir) {
      lines.push(
        `**Project Directory:** ${this.workspace.projectDir}`,
        `  Use scope="project" to read/write files in the user's project folder.`,
        `  This is where the user's source regulations, samples, and reference documents are.`,
        ``,
        `Read source documents from the project directory. Write KC outputs to the workspace.`,
        `Write user-facing exports (reports, results) to the project directory when the user asks.`,
      );
    }

    // Task progress (ralph-loop) — skipped for sub-agents (no taskManager)
    if (this.taskManager) {
      const taskContext = this.taskManager.describeForContext();
      if (taskContext) lines.push("", taskContext);
    }

    return lines.join("\n");
  }

  /**
   * Get current context usage statistics.
   * @returns {{ totalTokens: number, limit: number, percentage: number }}
   */
  getContextStats() {
    const systemPrompt = this.context.build({
      agentMd: this._readAgentMd(),
      skillIndex: this._skillLoader.formatForContext(this.currentPhase),
      pipelineState: this.pipelines[this.currentPhase]?.describeState?.() || null,
      workspaceState: this._buildWorkspaceState(),
      projectMemory: this._readProjectMemory(),
    });
    const systemTokens = estimateTokens(systemPrompt);
    const messageTokens = estimateMessagesTokens(this.history.messages);
    const totalTokens = systemTokens + messageTokens;
    const limit = this.config.kcContextLimit || 200000;
    return {
      totalTokens,
      limit,
      percentage: Math.round((totalTokens / limit) * 100),
    };
  }

  /**
   * Run the windowing check immediately after a tool result appends to
   * history. Called from runTurn() so that a large tool result can't sit in
   * history past the threshold until the next LLM-loop iteration, where a
   * stream-abort could then trap the context in a bloated state.
   *
   * Safe to call frequently — contextWindow.window() fast-paths when under
   * the trigger fraction.
   */
  _maybeWindowAfterToolResult() {
    if (!this.contextWindow) return;
    const windowed = this.contextWindow.window(this.history.messages, this._phaseSummaries);
    if (windowed.wasWindowed) {
      // `messages` is a getter-only property on ConversationHistory; write the
      // backing field and persist (same pattern as compact()).
      this.history._messages = windowed.messages;
      this.history._save();
      this.eventLog.append("context_windowed", {
        removed: windowed.removedCount,
        trigger: "post_tool_result",
      });
    }

    // Heap-pressure diagnostic. The TUI has its own virtualization + tool-
    // output truncation (Bug 3 fixes), so Ink itself should never OOM. If we
    // still see high heap usage, something else is leaking.
    //
    // A9: Original design logged once per pressure-crossing (edge-triggered),
    // which went silent for 17h during E2E #3 while RSS climbed to 3.8GB.
    // Now: still edge-trigger on entry (noisy otherwise), but ALSO re-emit
    // every 15min while we're still above the threshold, so an operator
    // watching logs after hour 4 still sees the signal. Drops to silent on
    // recovery below 0.60.
    try {
      const mem = process.memoryUsage();
      const frac = mem.heapUsed / (mem.heapTotal || 1);
      const now = Date.now();
      const REPRESS_INTERVAL_MS = 15 * 60 * 1000;
      if (frac > 0.80) {
        const firstCrossing = !this._memPressureLogged;
        const dueForRepress = this._memPressureLastEmittedAt &&
          (now - this._memPressureLastEmittedAt) >= REPRESS_INTERVAL_MS;
        if (firstCrossing || dueForRepress) {
          this._memPressureLogged = true;
          this._memPressureLastEmittedAt = now;
          this.eventLog.append("memory_pressure", {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            historyLength: this.history.messages.length,
            kind: firstCrossing ? "crossing" : "sustained",
          });
        }
      } else if (frac < 0.60 && this._memPressureLogged) {
        this._memPressureLogged = false;  // re-arm for next crossing
        this._memPressureLastEmittedAt = null;
      }
    } catch { /* process.memoryUsage failures are non-fatal */ }
  }

  /**
   * Pre-flight hard ceiling (Bug 1). After windowing, if the message
   * array's total token count still exceeds the model's input budget,
   * drop oldest user-bounded blocks until under budget.
   *
   * Drops in BLOCK units — a block is `user(N) + everything until the
   * next user`. This guarantees the head after a drop is always either a
   * user message or empty, satisfying Anthropic's "first message must use
   * the user role" requirement and OpenAI's tool-call adjacency rules.
   *
   * Treats the compaction summary pair (user with `[Previous conversation
   * summary]` or `[Context Summary` marker, followed by assistant ack) as
   * sticky — it represents prior LLM-summarized work and should outlive
   * any normal turn.
   */
  _enforceTokenBudget(messages) {
    const limit = this.config.kcContextLimit || 200000;
    const reserve = this.config.kcMaxTokens || DEFAULT_KC_MAX_TOKENS;
    const budget = limit - reserve;
    let totalTokens = estimateMessagesTokens(messages);
    if (totalTokens <= budget) return messages;

    // Sticky region: system + (optional summary user + ack assistant)
    let stickyEnd = messages[0]?.role === "system" ? 1 : 0;
    const sumMarkers = ["[Previous conversation summary]", "[Context Summary"];
    const hasSummaryAt = (i) =>
      messages[i]?.role === "user" &&
      typeof messages[i].content === "string" &&
      sumMarkers.some((m) => messages[i].content.startsWith(m));
    if (hasSummaryAt(stickyEnd)) {
      stickyEnd++;
      if (messages[stickyEnd]?.role === "assistant") stickyEnd++;
    }

    let droppedCount = 0;
    let droppedTokens = 0;

    // Drop user-bounded blocks. A block starts at messages[stickyEnd]
    // (expected to be a user message in normal flow) and runs up to (not
    // including) the next user message — or to the end of array.
    while (totalTokens > budget && messages.length > stickyEnd) {
      const blockStart = stickyEnd;
      let blockEnd = blockStart + 1;
      while (blockEnd < messages.length && messages[blockEnd].role !== "user") blockEnd++;
      // If this block goes to end-of-array, there's no following user to anchor
      // the head — dropping it would leave just [system, (summary)?]. Stop and
      // let the LLM call attempt; the API will surface a clear error if even
      // sticky alone is over budget.
      if (blockEnd === messages.length) break;
      const removed = messages.splice(blockStart, blockEnd - blockStart);
      droppedCount += removed.length;
      droppedTokens += removed.reduce((a, m) => a + estimateTokens(JSON.stringify(m)), 0);
      totalTokens = estimateMessagesTokens(messages);
    }

    // Defensive postcondition: head after sticky must be a user message or
    // the array must end at sticky. Block-drop should make this trivially true,
    // but if the input was malformed (e.g., already started with a non-user),
    // clean up here so we never send an Anthropic-invalid sequence.
    while (messages.length > stickyEnd && messages[stickyEnd].role !== "user") {
      messages.splice(stickyEnd, 1);
      droppedCount++;
    }

    if (droppedCount > 0) {
      this.eventLog.append("context_truncated", {
        droppedCount,
        droppedTokens,
        finalTokens: totalTokens,
        budget,
      });
    }
    return messages;
  }

  /**
   * Compact conversation history by summarizing older messages via LLM.
   * Keeps the most recent messages intact. (Bug 1: now chunked — never sends
   * a single oversized prompt to the summarizer LLM.)
   * @param {object} [opts]
   * @param {number} [opts.recentCount=20] - Number of recent messages to keep
   * @returns {Promise<{removedCount: number, retainedCount: number, summaryTokens: number}|null>}
   */
  async compact({ recentCount = 20 } = {}) {
    if (this.history.messages.length <= recentCount) return null;

    // v0.6.3.1: tool-pair atomicity. Naive slice(-recentCount) can land on
    // a tool message (whose assistant_with_tool_calls is in the older batch
    // about to be summarized) OR put the split between an assistant with
    // tool_calls and its tool results. Either creates an orphan that
    // DeepSeek's strict API rejects with 400. Walk the split point forward
    // until BOTH (recent[0] isn't tool) AND (older[-1] isn't
    // assistant_with_tool_calls).
    const desiredSplit = this.history.messages.length - recentCount;
    const splitPoint = findSafeSplitPoint(this.history.messages, desiredSplit);
    const olderMessages = this.history.messages.slice(0, splitPoint);
    const recentMessages = this.history.messages.slice(splitPoint);
    if (olderMessages.length === 0) return null; // nothing safely summarizable

    const CHUNK_BUDGET = 30000; // tokens per summarization request
    const chunks = this._chunkMessages(olderMessages, CHUNK_BUDGET);

    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const partial = await this._summarizeChunk(chunk, i, chunks.length);
      partials.push(partial);
    }

    const summary = partials.length === 1
      ? partials[0]
      : "## Compacted history (multi-part)\n\n" + partials.map((p, i) => `### Part ${i + 1}\n${p}`).join("\n\n");

    // Replace history
    this.history._messages = [
      { role: "user", content: `[Previous conversation summary]\n${summary}` },
      { role: "assistant", content: "Understood. I have the context from the summary above. Continuing from where we left off." },
      ...recentMessages,
    ];
    this.history._save();

    // Log compaction event
    this.eventLog.append("compact", {
      removedCount: olderMessages.length,
      retainedCount: recentMessages.length,
      chunkCount: chunks.length,
      summary,
    });

    return {
      removedCount: olderMessages.length,
      retainedCount: recentMessages.length,
      summaryTokens: estimateTokens(summary),
    };
  }

  /**
   * Split a flat message list into chunks where each chunk's serialized JSON
   * fits within tokenBudget. Chunks are turn-aligned where possible (a single
   * user→assistant→tool sequence won't be split mid-turn unless that single
   * turn alone exceeds the budget; in that case it gets its own oversized
   * chunk and the LLM call may fail → mechanical fallback fires).
   */
  _chunkMessages(messages, tokenBudget) {
    const chunks = [];
    let current = [];
    let currentTokens = 0;
    for (const msg of messages) {
      const mTokens = estimateTokens(JSON.stringify(msg));
      if (current.length > 0 && currentTokens + mTokens > tokenBudget) {
        chunks.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(msg);
      currentTokens += mTokens;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  /**
   * Summarize one chunk via the conductor LLM. On failure (incl. context-length
   * errors that the chunked split should usually prevent), fall back to a
   * mechanical summary so we always produce *something*.
   */
  async _summarizeChunk(chunk, idx, total) {
    const partLabel = total > 1 ? ` (part ${idx + 1}/${total})` : "";
    try {
      const resp = await this.client.chat({
        model: this.config.kcModel,
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Produce a concise summary of the following conversation excerpt. " +
              "Focus on: decisions made, files created or modified, current state of work, key findings, " +
              "unresolved questions. Be specific about file paths, rule IDs, and results. Keep under 1500 tokens.",
          },
          {
            role: "user",
            content: `Summarize this conversation excerpt${partLabel}:\n\n${JSON.stringify(chunk)}`,
          },
        ],
        maxTokens: 1800,
      });
      const text = resp.choices?.[0]?.message?.content;
      if (text) return text;
    } catch {
      // fall through to mechanical
    }
    return this._mechanicalSummary(chunk, partLabel);
  }

  _mechanicalSummary(chunk, partLabel) {
    const lines = [`Mechanical summary${partLabel}:`];
    for (const msg of chunk) {
      if (msg.role === "user" && typeof msg.content === "string") {
        lines.push(`- User: ${msg.content.slice(0, 120).replace(/\s+/g, " ")}`);
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string" && msg.content) {
          lines.push(`- Assistant: ${msg.content.slice(0, 120).replace(/\s+/g, " ")}`);
        }
        for (const tc of msg.tool_calls || []) {
          lines.push(`- Tool call: ${tc.function?.name || "?"}`);
        }
      }
    }
    return lines.join("\n");
  }

  /**
   * Restore an engine from a persisted session.
   * @param {object} opts
   * @param {import('./llm-client.js').LLMClient} opts.client
   * @param {object} opts.config
   * @param {string} opts.sessionId
   * @returns {Promise<AgentEngine>}
   */
  static async resume({ client, config, sessionId }) {
    const engine = new AgentEngine({ client, config, sessionId });
    const state = engine.sessionState;

    if (state.exists) {
      const data = state.load();
      engine.currentPhase = data.currentPhase || Phase.BOOTSTRAP;
      engine._phaseSummaries = data.phaseSummaries || [];
      engine._registerToolsForPhase(engine.currentPhase);
      engine.workspace.setPhase(engine.currentPhase);

      // v0.6.3.1: detect whether prior turns of this session used reasoning
      // mode, so the field-consistency invariant continues across resume.
      // Without this, the first assistant turn after resume might lack
      // reasoning_content even though earlier turns have it, and DeepSeek's
      // strict-mode rejects with 400.
      try {
        const msgs = engine.history?.messages || [];
        engine._sessionUsesReasoning = msgs.some(
          (m) => m?.role === "assistant" && "reasoning_content" in m,
        );
        // One-shot migration: backfill empty reasoning_content on assistant
        // messages that are missing the field. Pre-v0.6.3.1 sessions could
        // accumulate "holes" (turns where the model skipped reasoning) that
        // poison the conversation for resume. A single empty string on each
        // hole is enough to satisfy DeepSeek's field-consistency rule.
        if (engine._sessionUsesReasoning) {
          let patched = 0;
          for (const m of msgs) {
            if (m?.role === "assistant" && !("reasoning_content" in m)) {
              m.reasoning_content = "";
              patched++;
            }
          }
          if (patched > 0) {
            engine.history._save?.();
            engine.eventLog.append("reasoning_content_backfilled", {
              count: patched,
              reason: "v0.6.3.1 migration on resume",
            });
          }
        }
      } catch { /* never let resume break on this */ }

      // Restore project directory from saved state
      if (data.projectDir) {
        if (fs.existsSync(data.projectDir)) {
          engine.workspace.projectDir = data.projectDir;
        }
        // If dir no longer exists, projectDir stays as whatever was passed at launch
      }

      // Restore pipeline milestones
      const milestones = data.pipelineMilestones || {};
      for (const [phase, mData] of Object.entries(milestones)) {
        if (engine.pipelines[phase]?.importState) {
          engine.pipelines[phase].importState(mData);
        }
      }

      // Re-prime _lastReady AFTER importState so it reflects the restored
      // pipeline milestones, not the empty defaults from constructor.
      // (Bug 5 fix — without this, resume reignites auto-advance.)
      for (const phase of Object.keys(engine.pipelines)) {
        try {
          engine._lastReady[phase] = !!engine.pipelines[phase].exitCriteriaMet?.();
        } catch {
          engine._lastReady[phase] = false;
        }
      }

      engine.eventLog.append("session_resume", {
        resumedPhase: engine.currentPhase,
        resumedFromSeq: data.lastEventSeq,
      });
    }

    return engine;
  }

  /**
   * Save current session state for future resume.
   */
  saveState() {
    this.sessionState.save(this);
  }

  /**
   * Rename the workspace folder and cascade the new path to every persistence
   * subsystem that captured `workspace.cwd` at construction time (Bug 3).
   * Without this cascade, subsystems keep writing to the OLD path even
   * though the directory has moved on disk — the user sees the renamed dir
   * "die" while the old dir keeps growing.
   *
   * Also regenerates Block 9 cron wrapper scripts which bake in absolute
   * paths to the workspace. Returns information for the TUI to surface
   * (incl. whether the user needs to re-install crontab lines).
   *
   * @param {string} newName
   * @returns {{ sessionId: string, oldCwd: string, newCwd: string,
   *             scheduleWrappersRegenerated: string[],
   *             scheduleWrappersSkipped: string[] }}
   */
  renameSession(newName) {
    const r = this.workspace.rename(newName);
    if (r.changed) {
      // Cascade to every subsystem that captured workspace.cwd
      this.history._setWorkspacePath?.(r.newCwd);
      this.eventLog._setWorkspacePath?.(r.newCwd);
      this.sessionState._setWorkspacePath?.(r.newCwd);
      this.taskManager?._setWorkspacePath?.(r.newCwd);
      this.confidence._setWorkspacePath?.(r.newCwd);
      this.cornerCases._setWorkspacePath?.(r.newCwd);
    }

    // Regenerate cron wrapper scripts — they bake absolute paths to WORKSPACE,
    // INPUT_DIR, LOG_FILE, so rename invalidates them. The Scheduler is
    // workspace-bound (created on demand inside the schedule_fetch tool), so
    // construct a fresh one against the renamed workspace.
    let scheduleResult = { regenerated: [], disabled: [], failed: [] };
    try {
      const sched = new Scheduler(this.workspace);
      scheduleResult = sched.regenerateAllWrappers();
    } catch {
      // Best effort — never let scheduler issues block the rename
    }

    return {
      sessionId: r.sessionId,
      oldCwd: r.oldCwd,
      newCwd: r.newCwd,
      scheduleWrappersRegenerated: scheduleResult.regenerated,
      scheduleWrappersDisabled: scheduleResult.disabled,
      scheduleWrappersFailed: scheduleResult.failed,
    };
  }

  /**
   * Run one conversation turn. Yields AgentEvent objects.
   * Loops: LLM call -> tool execution -> LLM call ... until no tool calls.
   * @param {string} userMessage
   * @yields {AgentEvent}
   */
  async *runTurn(userMessage) {
    this.history.addUser(userMessage);
    this.eventLog.append("user_message", { content: userMessage });

    // Pipeline state injection
    const pipeline = this.pipelines[this.currentPhase];
    const pipelineState = pipeline?.describeState?.() || null;

    const systemPrompt = this.context.build({
      agentMd: this._readAgentMd(),
      skillIndex: this._skillLoader.formatForContext(this.currentPhase),
      pipelineState,
      workspaceState: this._buildWorkspaceState(),
      projectMemory: this._readProjectMemory(),
    });
    const tools = this.toolRegistry.schemasOpenai();

    while (true) {
      // Apply context windowing before sending to LLM
      const windowed = this.contextWindow.window(this.history.messages, this._phaseSummaries);
      let messages = [{ role: "system", content: systemPrompt }, ...windowed.messages];

      if (windowed.wasWindowed) {
        this.eventLog.append("context_windowed", {
          removedCount: windowed.removedCount,
          totalBefore: this.history.messages.length,
        });
      }

      // Pre-flight hard ceiling (Bug 1 P0). Even after windowing, if the
      // request still exceeds the model's input budget (e.g., recent messages
      // alone are too big), drop the oldest non-system messages until under
      // budget. Better to lose some history than crash with HTTP 400.
      messages = this._enforceTokenBudget(messages);

      this.eventLog.append("llm_start", {
        model: this.config.kcModel,
        messageCount: messages.length,
      });

      try {
        let collectedText = "";
        // v0.6.3: hybrid reasoning models (GLM-5.1, DeepSeek v4, MiMo v2.5,
        // Qwen3, ...) stream `delta.reasoning_content` separately from
        // `delta.content`. DeepSeek's strict API requires this field to be
        // round-tripped on subsequent assistant messages or it rejects the
        // request with "reasoning_content in the thinking mode must be passed
        // back". Even providers that don't enforce this (SiliconFlow) still
        // benefit from preservation — without it, prior reasoning is wasted.
        let collectedReasoning = "";
        /** @type {Map<number, {id: string, name: string, arguments: string}>} */
        const toolCallsAcc = new Map();

        const stream = this.client.streamChat({
          model: this.config.kcModel,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: this.config.kcMaxTokens,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield new AgentEvent({ type: "text_delta", text: delta.content });
            collectedText += delta.content;
          }

          // v0.6.3: capture reasoning_content from the same delta. Emit a
          // separate event type so the TUI can optionally render thinking
          // (today it's silently consumed; round-trip is the priority fix).
          if (delta.reasoning_content) {
            yield new AgentEvent({ type: "reasoning_delta", text: delta.reasoning_content });
            collectedReasoning += delta.reasoning_content;
          }

          if (delta.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, { id: tcDelta.id || "", name: "", arguments: "" });
              }
              const acc = toolCallsAcc.get(idx);
              if (tcDelta.id) acc.id = tcDelta.id;
              if (tcDelta.function?.name) acc.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
            }
          }
        }

        // Log the complete assistant message (coalesced, not per-delta)
        const assistantMsg = { role: "assistant", content: collectedText || null };
        // v0.6.3: persist reasoning_content on the assistant message so it
        // round-trips on the next request. history.addRaw spreads the input,
        // preserving unknown fields; OpenAI body builder doesn't strip them.
        //
        // v0.6.3.1: DeepSeek's strict-mode rule is FIELD CONSISTENCY, not
        // field content — once any assistant turn in the conversation has
        // reasoning_content, every subsequent assistant turn must also have
        // it (empty string OK; missing the field rejects with 400). Hybrid
        // reasoning models sometimes skip reasoning on trivial follow-through
        // tool calls, leaving collectedReasoning="". Track at session level:
        // once we see ANY reasoning, keep setting the field (possibly empty)
        // for the rest of the session. Providers that don't use the field
        // ignore it silently.
        if (collectedReasoning) {
          assistantMsg.reasoning_content = collectedReasoning;
          this._sessionUsesReasoning = true;
        } else if (this._sessionUsesReasoning) {
          assistantMsg.reasoning_content = "";
        }
        if (toolCallsAcc.size > 0) {
          assistantMsg.tool_calls = Array.from(toolCallsAcc.values()).map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        this.history.addRaw(assistantMsg);
        this.eventLog.append("assistant_message", {
          content: collectedText || null,
          toolCalls: assistantMsg.tool_calls || [],
        });

        if (toolCallsAcc.size === 0) {
          // A3: Empty-response guard. If the LLM returned no content AND no
          // tool calls, count it. Two in a row almost always means the
          // provider is silently failing (context exceeded, rate-limit
          // corruption, auth expired) and continuing wastes tokens + time.
          // Reset on any non-empty turn. Reason-tagged so /status can
          // surface the running rate.
          if (!collectedText || !collectedText.trim()) {
            this._consecutiveEmptyResponses = (this._consecutiveEmptyResponses || 0) + 1;
            this._totalEmptyResponses = (this._totalEmptyResponses || 0) + 1;
            if (this._consecutiveEmptyResponses >= 2) {
              const message =
                `LLM returned empty response ${this._consecutiveEmptyResponses}× in a row — ` +
                `likely context-length exceeded or provider-side silent failure. ` +
                `Stopping this turn to prevent runaway API spend.`;
              this.eventLog.append("error", { message, kind: "empty_response_streak" });
              yield new AgentEvent({ type: "error", message });
              this._consecutiveEmptyResponses = 0; // reset so next /run isn't blocked
              return;
            }
          } else {
            this._consecutiveEmptyResponses = 0;
          }
          this._totalTurns = (this._totalTurns || 0) + 1;

          // Bug 4 trigger (1): re-check phase criteria at end of every turn —
          // KC may have advanced state via conversation alone, without any
          // tool that the pipeline narrowly watches.
          const advancedEv = this._maybeAutoAdvance();
          if (advancedEv) yield advancedEv;

          this.eventLog.append("turn_complete", {});
          this.saveState();
          yield new AgentEvent({ type: "turn_complete" });
          return;
        }

        // A3: A turn with tool_calls or content is not empty — reset streak.
        this._consecutiveEmptyResponses = 0;
        this._totalTurns = (this._totalTurns || 0) + 1;

        // Tool execution loop
        for (const tc of toolCallsAcc.values()) {
          // v0.6.3.1: tool-argument JSON parsing used to be `try { parse } catch {}`
          // — silently falling back to {} on any parse failure. E2E #5 GLM
          // session showed this firing 100+ times: SiliconFlow streaming
          // truncates GLM-5.1 tool_call arguments by ~1 closing brace
          // (likely max_tokens cutoff mid-args), the silent fallback shipped
          // {} to the tool, and the tool returned generic "(empty)" errors
          // which the agent kept retrying without understanding why.
          //
          // Fix: try strict parse, then attempt brace-balance recovery (cheap
          // — recovers from the common single-brace-truncation case), and if
          // that fails, surface a structured error to the agent so it can
          // see what it sent and self-correct.
          let inputData = null;
          let argParseError = null;
          if (tc.arguments) {
            const recovery = parseToolArgsTolerant(tc.arguments);
            if (recovery.ok) {
              inputData = recovery.value;
              if (recovery.recovered) {
                this.eventLog.append("tool_args_recovered", {
                  name: tc.name,
                  added_chars: recovery.recovered,
                  original_len: tc.arguments.length,
                });
              }
            } else {
              argParseError = recovery.error;
            }
          } else {
            inputData = {};
          }

          // If arguments were unparseable, skip execution and return a tool
          // result that tells the agent what went wrong. Engine's tool result
          // loop continues so the rest of the assistant's tool_calls in this
          // turn still execute.
          if (argParseError) {
            const preview = (tc.arguments || "").slice(0, 200);
            const errMsg =
              `Tool arguments were malformed JSON for ${tc.name}. ` +
              `Likely streaming truncation by the model (provider cut tokens mid-output). ` +
              `Parser error: ${argParseError}. ` +
              `First 200 chars of what was received: ${preview}${tc.arguments && tc.arguments.length > 200 ? "..." : ""}. ` +
              `Retry the call with shorter / simpler arguments — the model may have hit max_tokens partway through encoding.`;
            this.eventLog.append("tool_args_parse_failed", {
              name: tc.name,
              error: argParseError,
              raw_args_len: (tc.arguments || "").length,
              raw_preview: preview,
            });
            yield new AgentEvent({ type: "tool_start", name: tc.name, input: { _parse_error: argParseError } });
            yield new AgentEvent({ type: "tool_result", name: tc.name, output: errMsg, isError: true });
            this.history.addRaw({ role: "tool", tool_call_id: tc.id, content: errMsg });
            continue;
          }

          this.eventLog.append("tool_start", { name: tc.name, input: inputData });
          yield new AgentEvent({ type: "tool_start", name: tc.name, input: inputData });

          // A1: Capture phase BEFORE tool execution. Some tools — notably
          // phase_advance — mutate this.currentPhase via a callback without
          // yielding any AgentEvent, so the TUI's status bar never gets the
          // signal. We diff after execute() and emit a synthetic
          // pipeline_event so subscribers can sync.
          const beforePhase = this.currentPhase;
          const result = await this.toolRegistry.execute(tc.name, inputData);

          // Tool-call offloading: large outputs go to logs/tool_results/<traceId>.txt;
          // history holds head + tail with a pointer. Event log keeps the full output
          // (it's append-only and the source of truth).
          const offload = this._maybeOffload(tc.name, result);
          const historyContent = offload ? offload.digest : (result.content || "");

          this.eventLog.append("tool_result", {
            name: tc.name,
            output: result.content || "",
            isError: result.isError,
            traceId: offload?.traceId || null,
          });

          // D3a: trace skill invocations. When the agent reads a SKILL.md via
          // workspace_file (the canonical way KC "uses" a skill, since skills
          // are progressively-disclosed markdown), emit a skill_invoked event.
          // Makes "which skills did KC actually consult?" answerable in post-run
          // analysis — before this, skills were opaque to the event log.
          try {
            if (
              !result.isError &&
              (tc.name === "workspace_file" || tc.name === "sandbox_exec")
            ) {
              const p = String(inputData?.path || inputData?.command || "");
              const skillMatch = p.match(/(?:template\/)?skills\/[a-z-]+\/(?:meta-meta|meta|skill-creator)\/([a-zA-Z0-9_-]+)(?:\/SKILL\.md|\/)?|\bSKILL\.md\b/);
              if (skillMatch) {
                const skillName = skillMatch[1] || "(unknown)";
                this.eventLog.append("skill_invoked", {
                  skill: skillName,
                  via_tool: tc.name,
                  phase: this.currentPhase,
                });
              }
            }
          } catch { /* never let tracing break a tool call */ }
          yield new AgentEvent({
            type: "tool_result",
            name: tc.name,
            output: historyContent,
            isError: result.isError,
          });

          // v0.6.3 (#74): phase-misfit nudge. Ask the current pipeline whether
          // this tool call looks like work that belongs to a different phase.
          // If so, append a `<system-reminder>` tag to the tool result content
          // (same convention as task-tools and auto-memory reminders). The
          // agent sees this on its next turn and can self-check whether to
          // call phase_advance. Only fires for non-error results — failed
          // tool calls have their own error message and don't need the nudge.
          let nudgedContent = historyContent;
          try {
            const pipelineForPhase = this.pipelines?.[beforePhase];
            const hint = pipelineForPhase?.phaseMisfitHint?.(tc.name, inputData, result);
            if (hint && !result.isError) {
              nudgedContent = `${historyContent}\n\n<system-reminder>\nPhase-misfit detected: ${hint}\n</system-reminder>`;
              this.eventLog.append("phase_misfit_hint", {
                phase: beforePhase,
                tool: tc.name,
                hint,
              });
            }
          } catch { /* never let the nudge logic break the tool loop */ }

          this.history.addRaw({
            role: "tool",
            tool_call_id: tc.id,
            content: nudgedContent,
          });

          // Post-tool-result safety net: check for context pressure RIGHT NOW
          // rather than waiting for the next LLM-loop iteration. A large tool
          // result that tips history over the threshold used to sit there
          // until the next turn, and if the stream aborted in between the
          // user saw "CTX: 210% / stream terminated" with no recovery.
          this._maybeWindowAfterToolResult();

          // A1: If the tool mutated the phase (e.g. phase_advance), emit the
          // signal the TUI and pipelines need to re-sync state. Runs BEFORE
          // pipeline.onToolResult so the fresh phase is active if the pipeline
          // itself wants to react to the transition.
          if (this.currentPhase !== beforePhase) {
            yield new AgentEvent({
              type: "pipeline_event",
              data: {
                type: "phase_changed",
                from: beforePhase,
                nextPhase: this.currentPhase,
                reason: `via ${tc.name}`,
              },
            });
          }

          // Pipeline controller: update state and re-register tools on phase change
          if (pipeline?.onToolResult) {
            const pEvent = pipeline.onToolResult(tc.name, inputData, result);
            if (pEvent) {
              if (pEvent.type === "phase_ready" && pEvent.nextPhase) {
                this._advancePhase(pEvent.nextPhase, pEvent.message || "exit criteria met");
              }
              yield new AgentEvent({ type: "pipeline_event", data: pEvent });
            }
          }
        }

        // Bug 4 fix: re-check exit criteria after every tool-result loop, not
        // just from pipeline.onToolResult. The pipeline's describeState() (called
        // on every turn) already re-scans, so exitCriteriaMet() is accurate; we
        // just need to act on it eagerly.
        const ev = this._maybeAutoAdvance();
        if (ev) yield ev;

      } catch (err) {
        // A8: If the LLM client tagged the stream termination reason, pass
        // it through. Upstream log consumers + the TUI can then distinguish
        // "provider returned 429" from "socket died mid-token" from "SSE
        // buffer exploded" — today they're all just "Error: ...".
        const payload = { message: err.message };
        if (err.streamTermination) payload.kind = err.streamTermination;
        if (err.status) payload.status = err.status;
        this.eventLog.append("error", payload);
        yield new AgentEvent({ type: "error", message: err.message, ...payload });
        return;
      }
    }
  }

  /**
   * Centralized phase transition (Bug 4). All three triggers route through here:
   * (1) pipeline.onToolResult returning phase_ready
   * (2) post-turn auto-check via _maybeAutoAdvance
   * (3) explicit user request via the phase_advance tool
   *
   * Reachability: by default only forward-by-one transitions per NEXT_PHASE.
   * Set `force: true` to allow non-adjacent or backward transitions (e.g. user
   * explicitly requests a regression for testing). The refusal is logged.
   *
   * Idempotent — calling with the current phase is a no-op.
   */
  _advancePhase(nextPhase, reason = "", { force = false } = {}) {
    if (!nextPhase || nextPhase === this.currentPhase) return false;

    const expected = NEXT_PHASE[this.currentPhase];
    if (!force && nextPhase !== expected) {
      // v0.7.0 A3: event-log hint stays factual (records what the gate
      // saw) — the LLM-facing refusal text in phase-advance.js no longer
      // advertises force:true. Hint kept here for post-mortem audit.
      this.eventLog.append("phase_advance_refused", {
        from: this.currentPhase, to: nextPhase, reason,
        hint: expected ? `non-adjacent transition; immediate next phase is '${expected}'`
                       : `${this.currentPhase} is the terminal phase`,
      });
      return false;
    }

    // v0.7.0 A5: reconcile per-rule tasks against disk artifacts before
    // checking exit criteria. Catches the E2E #5 DS pattern (tasks.json
    // showed 70/70 done while only 56 dirs / 36 with check_*.py existed):
    // markDone() is fire-and-forget today, so the agent can claim
    // completion that didn't materialize. Reconcile flips back to
    // pending if the helper-derived ruleIdsCovered set doesn't include
    // the task's ruleId. A "force"d advance bypasses reconcile too —
    // the gate already gives the agent / user that escape.
    if (!force && this.taskManager && this.workspace) {
      try {
        const sa = deriveSkillAuthoringMilestones(this.workspace);
        const covered = new Set(sa.ruleIdsCovered);
        const tm = deriveSkillTestingMilestones(this.workspace);
        const tested = new Set(tm.skillsTested);
        const r = this.taskManager.reconcileAgainstDisk((task) => {
          if (task.phase === "skill_authoring") return covered.has(task.ruleId);
          if (task.phase === "skill_testing") return tested.has(task.ruleId);
          return true; // unknown phase — leave alone
        });
        if (r.flippedBack.length > 0) {
          this.eventLog.append("tasks_reconciled", {
            from_phase: this.currentPhase,
            target_phase: nextPhase,
            flipped_back: r.flippedBack,
            count: r.flippedBack.length,
            inspected: r.reconciled,
          });
        }
      } catch { /* never let reconcile break advance */ }
    }

    // v0.6.3: HARD-TRACKING GATE — refuse forward advance unless the source
    // phase's exit criteria are met by engine telemetry. v0.6.1 added the
    // engineCounts block to phase summaries (observation) but never wired
    // exitCriteriaMet() into the gate (enforcement). E2E #5 surfaced the
    // gap: MiMo advanced rule_extraction → skill_authoring with
    // rulesExtracted=0 in engine telemetry because rule_catalog had been
    // writing to a stranded post-rename path AND nothing checked the gate.
    //
    // Forward-only enforcement: rollbacks (_advancePhase from a later phase
    // to an earlier one with force:true) are an explicit escape, not a
    // criteria check — the rolled-from phase doesn't need to be "complete".
    // force:true also bypasses (matches existing escape pattern: user/agent
    // explicitly chose to skip).
    if (!force) {
      const fromIdx = PHASE_ORDER.indexOf(this.currentPhase);
      const toIdx = PHASE_ORDER.indexOf(nextPhase);
      const isForward = fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx;
      if (isForward) {
        const fromPipeline = this.pipelines?.[this.currentPhase];
        let criteriaMet = true;
        try { criteriaMet = !!fromPipeline?.exitCriteriaMet?.(); } catch { criteriaMet = true; }
        if (!criteriaMet) {
          const counts = this._buildEngineCountsBlock(this.currentPhase);
          this.eventLog.append("phase_advance_refused", {
            from: this.currentPhase, to: nextPhase, reason,
            hint: "exit criteria not met by engine telemetry",
            engineCounts: counts || null,
          });
          return false;
        }
      }
    }

    // v0.6.2 J2: detect rollback direction. PHASE_ORDER is a linear array
    // of all phases; if target index < current index, this is a rollback
    // (e.g., production_qc → skill_authoring after gates revealed gaps).
    const fromIdx = PHASE_ORDER.indexOf(this.currentPhase);
    const toIdx = PHASE_ORDER.indexOf(nextPhase);
    const direction = (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx)
      ? "rollback" : "forward";

    // v0.6.1 B1: build engine-appended hard-counts block + heuristic mismatch
    // detection so the LLM-narrated reason can be cross-checked against
    // ground-truth telemetry. Phase summaries become diagnostic, not just
    // narrative.
    const engineCounts = this._buildEngineCountsBlock(this.currentPhase);
    const mismatchPrefix = this._detectSummaryMismatch(reason, this.currentPhase) ? "⚠️ POSSIBLE MISMATCH: " : "";
    const directionTag = direction === "rollback" ? " [ROLLBACK]" : "";
    // v0.7.0 A2: forced is now `!!force` (honest), not the old
    // `force && nextPhase !== expected` which masked every adjacent-forward
    // force in the audit log. E2E #5 had 12/12 force-bypasses but the event
    // log read 0 forced because every transition was to the immediate next
    // phase. Truth in audit logs first; refinement (forward-vs-non-adjacent
    // distinction) lives in the `direction` field.
    const phaseSummary =
      `[${this.currentPhase.toUpperCase()} → ${nextPhase.toUpperCase()}]${directionTag}: ${mismatchPrefix}${reason}` +
      (force ? " (forced)" : "") +
      (engineCounts ? `\n  (engine) ${engineCounts}` : "");
    this._phaseSummaries.push(phaseSummary);
    this.eventLog.append("phase_transition", {
      from: this.currentPhase,
      to: nextPhase,
      reason,
      direction,
      engineCounts: engineCounts || null,
      possibleMismatch: !!mismatchPrefix,
      forced: !!force,
    });
    const fromPhase = this.currentPhase;
    this.currentPhase = nextPhase;
    this._registerToolsForPhase(this.currentPhase);
    this.workspace.setPhase(this.currentPhase);
    this._createTasksForPhase(this.currentPhase);

    // v0.6.2 J2: on rollback, reset the rolled-FROM phase's lastReady
    // edge-trigger so that if the agent revisits it and re-flips
    // exit-criteria true, _maybeAutoAdvance will fire correctly. Without
    // this, the auto-advance edge trigger stays latched true and the
    // moment the agent returns to fromPhase the engine immediately
    // bounces them back out — defeating the rollback.
    if (direction === "rollback" && this._lastReady) {
      this._lastReady[fromPhase] = false;
    }

    this.saveState();

    // B8: Soft signal — surface any sub-agents left running from the prior
    // phase so the main agent's next turn can decide whether to kill them.
    // NOT automated: phase_advance can fire from _maybeAutoAdvance on a
    // criteria-flip, and auto-killing would couple lifecycle with blast
    // radius. This just informs.
    try {
      const agentTool = this._buildTools?.core?.find((t) => t?.name === "agent_tool");
      const runningIds = agentTool?.getRunningTaskIds?.() || [];
      if (runningIds.length > 0) {
        this.eventLog.append("stale_subagents", {
          from_phase: fromPhase,
          to_phase: nextPhase,
          running_task_ids: runningIds,
          hint: "These sub-agents were dispatched during the prior phase. Consider operation=poll to check status, or operation=kill to abort if stale.",
        });
      }
    } catch { /* never let signal emission break phase advance */ }

    return true;
  }

  /**
   * v0.6.1 A6: Single chokepoint for engine-emitted milestone updates.
   * Tools call this on successful execution to bump pipeline counters that
   * the phase-gate hardening (A2-A5) depends on. Without engine emission,
   * gates fall back to filesystem scans which can miss work that didn't
   * follow canonical output paths (E2E #4: `unified_qc.py` wrote to
   * `output/results/`, production-qc only scanned `output/qc/`).
   *
   * The mutation routes through the pipeline's existing internal state, so
   * exportState/importState round-trips work unchanged and the gate sees a
   * unified view of (filesystem-scanned + engine-emitted) signals.
   *
   * Three modes inferred from value shape:
   *  - increment counter: pipeline[key] is number, value is number → add
   *  - set in dict-by-id:  pipeline[key] is object, value is { id, value? } → assign
   *  - dedupe-add to array: pipeline[key] is array, value is string → push if absent
   *
   * @param {string} phase - Pipeline name (e.g., "distillation")
   * @param {string} key - Field on the pipeline (e.g., "workflowsTested")
   * @param {*} value - Shape varies by target type (see modes above)
   * @returns {boolean} true if a write happened
   */
  _recordMilestone(phase, key, value) {
    const pipeline = this.pipelines?.[phase];
    if (!pipeline) return false;
    const target = pipeline[key];
    // increment counter
    if (typeof target === "number" && typeof value === "number") {
      pipeline[key] = target + value;
      return true;
    }
    // set on dict-by-id
    if (target && typeof target === "object" && !Array.isArray(target)
        && value && typeof value === "object" && "id" in value) {
      target[value.id] = "value" in value ? value.value : true;
      return true;
    }
    // dedupe-add to array
    if (Array.isArray(target) && typeof value === "string") {
      if (!target.includes(value)) target.push(value);
      return true;
    }
    return false;
  }

  /**
   * v0.6.1 B1: build a one-line "engine counts" block summarizing the
   * pipeline's ground-truth telemetry at the moment of phase advance.
   * Different phases surface different metrics; we keep this short so the
   * appended summary line stays readable.
   *
   * @param {string} fromPhase - The phase being LEFT (we summarize its work)
   * @returns {string} block text, or "" if pipeline has nothing to report
   */
  _buildEngineCountsBlock(fromPhase) {
    const pipeline = this.pipelines?.[fromPhase];
    if (!pipeline) return "";
    const parts = [];
    try {
      switch (fromPhase) {
        case "rule_extraction": {
          const total = pipeline._catalogRuleCount?.() ?? pipeline.rulesExtracted?.length ?? 0;
          parts.push(`rulesExtracted: ${pipeline.rulesExtracted?.length ?? 0}`);
          parts.push(`rulesWithChunkRefs: ${pipeline.rulesWithChunkRefs?.length ?? 0}/${total}`);
          parts.push(`rulesWithTests: ${pipeline.rulesWithTests?.length ?? 0}`);
          parts.push(`coverageAudited: ${pipeline.coverageAudited ? "yes" : "no"}`);
          break;
        }
        case "skill_authoring": {
          const totalRules = pipeline.totalRules?.length ?? 0;
          const covered = pipeline.ruleIdsCovered?.size ?? 0;
          parts.push(`rulesCovered: ${covered}/${totalRules}`);
          parts.push(`skillDirsAuthored: ${pipeline.skillsAuthored?.length ?? 0}`);
          if (this.taskManager) {
            const t = this.taskManager.countByPhase("skill_authoring");
            const d = this.taskManager.countByPhase("skill_authoring", "completed");
            const f = this.taskManager.countByPhase("skill_authoring", "failed");
            parts.push(`tasksCompleted: ${d}/${t}${f > 0 ? ` (+${f} failed)` : ""}`);
          }
          break;
        }
        case "skill_testing": {
          const total = pipeline.skillsToTest?.length ?? 0;
          const tested = Object.keys(pipeline.skillsTested || {}).length;
          const passing = pipeline.skillsPassing?.length ?? 0;
          parts.push(`skillsTested: ${tested}/${total}`);
          parts.push(`skillsPassing: ${passing}`);
          parts.push(`iterations: ${pipeline.iterationCount ?? 0}`);
          break;
        }
        case "distillation": {
          const total = pipeline.skillsToDistill?.length ?? 0;
          const created = Object.keys(pipeline.workflowsCreated || {}).length;
          const tested = Object.keys(pipeline.workflowsTested || {}).length;
          const passing = pipeline.workflowsPassing?.length ?? 0;
          parts.push(`workflowsCreated: ${created}/${total}`);
          parts.push(`workflowsTested: ${tested}/${total}`);
          parts.push(`workflowsPassing: ${passing}/${total}`);
          break;
        }
        case "production_qc": {
          parts.push(`batchesProcessed: ${pipeline.batchesProcessed ?? 0}`);
          parts.push(`documentsReviewed: ${pipeline.documentsReviewed ?? 0}`);
          parts.push(`monitoring: ${pipeline.monitoringPhase ?? "?"}`);
          break;
        }
        // bootstrap / finalization: no specific counters, fall through
      }
    } catch { /* never let summary build break phase advance */ }
    return parts.join(", ");
  }

  /**
   * v0.6.1 B1: heuristic mismatch detection. Conservative regex over the
   * LLM's free-form reason for percentages and counts, compared against
   * engine truth. INFORMATIONAL only — never blocks the transition. False
   * positives are acceptable (the warning is a hint to the human reviewer,
   * not a hard signal). False negatives are also acceptable (this catches
   * the loud, numerical claims; subtle ones still slip through).
   *
   * Returns true if the agent's reason mentions a count or percentage that
   * doesn't match engine state.
   */
  _detectSummaryMismatch(reason, fromPhase) {
    if (!reason || typeof reason !== "string") return false;
    const pipeline = this.pipelines?.[fromPhase];
    if (!pipeline) return false;
    try {
      // Match "N/M" fractions and standalone counts
      const fractionMatches = [...reason.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
      // Match "N rules / skills / workflows / tasks"
      const countMatches = [...reason.matchAll(/(\d+)\s*(rules?|skills?|workflows?|tasks?|条规则|个技能)/gi)];
      // Match accuracy claims like "95%", "0.95"
      const pctMatches = [...reason.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];

      // Phase-specific cross-checks (cheap conservative comparisons)
      if (fromPhase === "skill_authoring" && this.taskManager) {
        const completed = this.taskManager.countByPhase("skill_authoring", "completed");
        const total = this.taskManager.countByPhase("skill_authoring");
        for (const m of fractionMatches) {
          const claimedDone = parseInt(m[1], 10);
          const claimedTotal = parseInt(m[2], 10);
          if (claimedTotal === total && claimedDone > completed + 5) return true;
        }
      }
      if (fromPhase === "skill_testing") {
        const tested = Object.keys(pipeline.skillsTested || {}).length;
        const passing = pipeline.skillsPassing?.length ?? 0;
        for (const m of pctMatches) {
          const claimed = parseFloat(m[1]);
          // If claimed > 50% but engine sees 0 tested, that's suspicious
          if (claimed >= 50 && tested === 0 && passing === 0) return true;
        }
      }
      if (fromPhase === "production_qc") {
        const batches = pipeline.batchesProcessed ?? 0;
        // Any "complete" or large-count claim while batches==0 is suspicious
        if (batches === 0) {
          if (countMatches.some((m) => parseInt(m[1], 10) > 10)) return true;
          if (pctMatches.some((m) => parseFloat(m[1]) > 50)) return true;
        }
      }
    } catch { /* informational only — never block */ }
    return false;
  }

  /**
   * Bug 4 trigger (1) auto-detect, edge-triggered (Bug 5): only fires on a
   * fresh false → true flip in `exitCriteriaMet()`. Sessions resumed in an
   * already-met state do nothing; users iterating in a phase whose criteria
   * have been met for a while do nothing. Real new evidence is required.
   */
  _maybeAutoAdvance() {
    const phase = this.currentPhase;
    const pipeline = this.pipelines[phase];
    let nowReady = false;
    try { nowReady = !!pipeline?.exitCriteriaMet?.(); } catch { nowReady = false; }

    if (!nowReady) {
      this._lastReady[phase] = false;
      return null;
    }
    // Edge-trigger: nowReady && !wasReady
    if (this._lastReady[phase]) return null;
    this._lastReady[phase] = true;

    const next = NEXT_PHASE[phase];
    if (!next) return null;
    const advanced = this._advancePhase(next, "exit criteria flipped to met");
    if (!advanced) return null;
    return new AgentEvent({
      type: "pipeline_event",
      data: { type: "phase_ready", nextPhase: next, message: "exit criteria flipped to met" },
    });
  }

  /**
   * Tool-call offloading. If the tool's content exceeds the threshold,
   * write the full content to logs/tool_results/<traceId>.txt and return a
   * digest (head + tail) with a pointer. Otherwise return null (caller uses
   * full content).
   */
  _maybeOffload(toolName, result) {
    const content = result.content || "";
    if (!content) return null;
    const threshold = result.isError
      ? (this.config.toolOutputOffloadErrorTokens ?? 500)
      : (this.config.toolOutputOffloadTokens ?? 2000);
    const tokens = estimateTokens(content);
    if (tokens <= threshold) return null;

    const safeToolName = String(toolName || "tool").replace(/[^A-Za-z0-9_-]/g, "_");
    const traceId = this.versionManager.generateTraceId(safeToolName, "result");
    const offloadDir = path.join(this.workspace.cwd, "logs", "tool_results");
    try {
      fs.mkdirSync(offloadDir, { recursive: true });
      fs.writeFileSync(path.join(offloadDir, `${traceId}.txt`), content, "utf-8");
    } catch {
      // If we can't write the offload file, fall back to keeping full content in context.
      return null;
    }

    const HEAD = 800, TAIL = 800;
    const truncatedNote = `\n\n[…truncated, ${tokens} tokens; full at logs/tool_results/${traceId}.txt — read with workspace_file if needed…]\n\n`;
    const digest = content.length > HEAD + TAIL
      ? content.slice(0, HEAD) + truncatedNote + content.slice(-TAIL)
      : content + truncatedNote;
    return { traceId, digest };
  }

  /**
   * Create per-rule tasks when entering a new phase.
   * Reads the rule catalog and creates one task per rule for the given phase.
   *
   * D6: For skill_authoring / skill_testing, filter rules via the bundle
   * classification cache (`cache/bundles/<hash>.classification.json`,
   * written by document_classify). Rules whose `applicable_product_types`
   * or `report_types` don't overlap with the bundle's classification get
   * SKIPPED at task-creation time — we don't mutate catalog.json to mark
   * them not_applicable, we just keep them out of the task queue. The
   * finalization phase (Group E) will report them in the coverage
   * artifact as "not applicable to this bundle." Conservative default:
   * if no classification exists, include all rules (pre-B9 behavior).
   */
  _createTasksForPhase(phase) {
    if (!this.taskManager) return; // Sub-agents don't manage tasks
    const catalogPath = path.join(this.workspace.cwd, "rules", "catalog.json");
    if (!fs.existsSync(catalogPath)) return;

    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      let rules = normalizeRuleCatalog(catalog);
      if (rules.length === 0) return;

      // D6: applicability pre-filter (skill phases only — bootstrap/extraction
      // have no task creation here per A6).
      if (phase === "skill_authoring" || phase === "skill_testing") {
        const classification = this._loadBundleClassification();
        if (classification) {
          const before = rules.length;
          rules = rules.filter((r) => this._ruleAppliesToBundle(r, classification));
          if (rules.length < before) {
            this.eventLog.append("applicability_prefilter", {
              phase,
              classification: {
                product_type: classification.product_type,
                report_type: classification.report_type,
                source: classification.source,
              },
              rules_before: before,
              rules_after: rules.length,
              skipped: before - rules.length,
            });
          }
        }
      }
      this.taskManager.createRuleTasks(rules, phase);
    } catch { /* skip if catalog can't be read */ }
  }

  /**
   * D6: Load the most recent bundle classification cache, if one exists.
   * Written by the `document_classify` tool. Returns null if no cache or
   * unreadable — callers must treat null as "all rules apply."
   */
  _loadBundleClassification() {
    const cacheDir = path.join(this.workspace.cwd, "cache", "bundles");
    if (!fs.existsSync(cacheDir)) return null;
    let entries;
    try { entries = fs.readdirSync(cacheDir); }
    catch { return null; }
    const files = entries
      .filter((n) => n.endsWith(".classification.json"))
      .map((n) => {
        const p = path.join(cacheDir, n);
        try { return { path: p, mtime: fs.statSync(p).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    try { return JSON.parse(fs.readFileSync(files[0].path, "utf-8")); }
    catch { return null; }
  }

  /**
   * D6: Rule-applicability check mirroring the AMC app's `applies_to`.
   * Conservative: returns true when we don't have enough info to
   * confidently skip (missing fields on rule, or classification with
   * empty product/report).
   */
  _ruleAppliesToBundle(rule, classification) {
    const docProduct = classification?.product_type || "";
    const docReport = classification?.report_type || "";
    const ruleProducts = rule.applicable_product_types || rule.applicable_sections || [];
    const ruleReports = rule.report_types || [];

    const allProducts = ruleProducts.length === 0 ||
      ruleProducts.some((x) => x === "全部" || x === "all" || x === "");
    const allReports = ruleReports.length === 0 ||
      ruleReports.some((x) => x === "全部" || x === "all" || x === "");
    if (allProducts && allReports) return true;

    const productOk = allProducts || (
      docProduct && ruleProducts.some((rp) => rp.includes(docProduct) || docProduct.includes(rp))
    );
    const reportOk = allReports || (
      docReport && ruleReports.some((rr) => rr.includes(docReport) || docReport.includes(rr))
    );

    // Unknown classification → don't prefilter, let the agent judge.
    if (!docProduct && !docReport) return true;
    return productOk && reportOk;
  }

  /**
   * D1: Enrich a skill_authoring / skill_testing task prompt with the
   * rule's source context — reads `source_chunk_ids` back-refs from
   * catalog.json (populated by extraction) and fetches chunk text from
   * the most recent BundleTree cache. Falls back to the minimal prompt
   * when catalog / cache aren't available.
   *
   * Previously the task prompt was ONE line — "Continue with next task:
   * ${title}" — leaving the skill-author agent to re-read the rule and
   * re-find its evidence per task. Auto-attach saves the LLM turn
   * needed for document_search on every task, and ensures the author
   * sees the exact regulation text the extractor used to justify the
   * rule.
   *
   * @param {{id: string, title: string, ruleId?: string, phase: string}} task
   * @returns {string}
   */
  _buildEnrichedTaskPrompt(task) {
    const fallback = `Continue with next task: ${task.title}` +
      (task.ruleId ? ` (rule: ${task.ruleId})` : "");

    // Only enrich for rule-anchored phases
    if (task.phase !== "skill_authoring" && task.phase !== "skill_testing") {
      return fallback;
    }
    if (!task.ruleId) return fallback;

    // Find the rule in catalog.json
    const catalogPath = path.join(this.workspace.cwd, "rules", "catalog.json");
    if (!fs.existsSync(catalogPath)) return fallback;
    let rules;
    try {
      rules = normalizeRuleCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf-8")));
    } catch { return fallback; }
    const rule = rules.find((r) => r.id === task.ruleId);
    if (!rule) return fallback;

    // Assemble the enriched brief. Every section is optional — when a
    // back-ref or cache is missing, just skip that section rather than
    // failing back to the minimal prompt.
    const lines = [];
    lines.push(`# Task: ${task.title}`);
    lines.push("");
    lines.push(`## Rule ${rule.id}`);
    if (rule.source_ref) lines.push(`Source: ${rule.source_ref}`);
    if (rule.severity) lines.push(`Severity: ${rule.severity}`);
    if (rule.description) lines.push(`\n${rule.description}`);
    if (rule.falsifiability_statement) lines.push(`\n**Falsifiability**: ${rule.falsifiability_statement}`);
    if (rule.test_case_stub) lines.push(`**Test stub**: ${rule.test_case_stub}`);

    // D1: if rule has source_chunk_ids AND a BundleTree cache exists,
    // pull chunk text inline so the author doesn't need to call
    // bundle_search manually. Bounded to ~3000 tokens total to avoid
    // blowing the author's context budget.
    const chunkIds = Array.isArray(rule.source_chunk_ids) ? rule.source_chunk_ids : [];
    if (chunkIds.length > 0) {
      const chunks = this._loadChunksFromBundleCache(chunkIds);
      if (chunks.length > 0) {
        lines.push("");
        lines.push("## Source context");
        let totalChars = 0;
        const MAX_CHARS = 7500; // ~3000 CJK tokens
        for (const ch of chunks) {
          const header = `### ${ch.title || ch.chunk_id} · ${ch.source_file} p.${(ch.page_range || [1, 1]).join("-")}`;
          const body = (ch.content || "").trim();
          const block = `${header}\n${body}\n`;
          if (totalChars + block.length > MAX_CHARS) {
            lines.push(`\n[…${chunks.length - chunks.indexOf(ch)} more source chunks truncated; use bundle_search to retrieve them…]`);
            break;
          }
          lines.push("");
          lines.push(block);
          totalChars += block.length;
        }
      }
    }

    // Sibling rules (same source_ref prefix) — helps the author see the
    // surrounding catalog and avoid re-implementing cross-referenced logic.
    const siblings = this._findSiblingRuleIds(rule, rules);
    if (siblings.length > 0) {
      lines.push("");
      lines.push(`## Sibling rules (same regulation section)`);
      lines.push(siblings.map((id) => `- ${id}`).join("\n"));
    }

    lines.push("");
    lines.push("Write the skill to `rule_skills/<rule_id>/SKILL.md` + detect script. Prefer 1 rule = 1 skill dir (use `check_rNNN_rMMM.py` naming ONLY when rules share evidence and fail together).");

    return lines.join("\n");
  }

  /** D1: Load chunk text from the most recent BundleTree cache. */
  _loadChunksFromBundleCache(chunkIds) {
    const cacheDir = path.join(this.workspace.cwd, "cache", "bundles");
    if (!fs.existsSync(cacheDir)) return [];
    let entries;
    try { entries = fs.readdirSync(cacheDir); }
    catch { return []; }
    const candidates = entries
      .filter((n) => n.endsWith(".json") && !n.endsWith(".classification.json"))
      .map((n) => {
        const p = path.join(cacheDir, n);
        try { return { path: p, mtime: fs.statSync(p).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length === 0) return [];
    let tree;
    try { tree = JSON.parse(fs.readFileSync(candidates[0].path, "utf-8")); }
    catch { return []; }
    const out = [];
    for (const cid of chunkIds) {
      const ch = tree.chunks?.[cid];
      if (ch) out.push(ch);
    }
    return out;
  }

  /** D1: Rules that share the same regulation article (naive: source_ref prefix). */
  _findSiblingRuleIds(rule, allRules) {
    if (!rule.source_ref) return [];
    const prefix = rule.source_ref.split(/[第条款项]/)[0].trim();
    if (!prefix) return [];
    return allRules
      .filter((r) => r.id !== rule.id && (r.source_ref || "").startsWith(prefix))
      .slice(0, 8)
      .map((r) => r.id);
  }

  /**
   * Ralph-loop: run a turn, then auto-continue through pending tasks.
   * Compacts context aggressively between tasks to prevent context blowup.
   * If no tasks exist, behaves identically to runTurn().
   *
   * @param {string} userMessage
   * @param {{parallelism?: number}} [opts] — B1: optional parallel mode.
   *   N > 1 dispatches tasks through N concurrent subagents (using the
   *   agent_tool infrastructure from B8). Clamped to `effectiveParallelism`
   *   from config.js — which silently downgrades to 1 unless
   *   KC_PARALLELISM_VERIFIED=1 is set AND heap.jsonl shows flat RSS
   *   (B0.6 guard; prevents accidental $100+ runaway runs).
   * @yields {AgentEvent}
   */
  async *runTaskLoop(userMessage, opts = {}) {
    // Sub-agents don't run task loops — they execute one task and exit
    if (!this.taskManager) {
      yield* this.runTurn(userMessage);
      return;
    }

    // B1: resolve effective parallelism. Caller opts override config.
    const requested = Number.isFinite(opts.parallelism)
      ? Math.max(1, Math.min(8, opts.parallelism))
      : (this.config.effectiveParallelism?.() ?? 1);

    if (requested > 1) {
      yield* this._runTaskLoopParallel(userMessage, requested);
      return;
    }

    yield* this._runTaskLoopSerial(userMessage);
  }

  /** B1: original serial ralph-loop path — one task at a time, shared
   *  conversation history. Unchanged from pre-v0.6.0 behavior. */
  async *_runTaskLoopSerial(userMessage) {
    // Run the initial turn (user's request)
    yield* this.runTurn(userMessage);

    // Auto-continue through pending tasks
    while (this.taskManager.getNextPending()) {
      // Context safety: force compaction if above 70%, or light compaction if history is long
      const stats = this.getContextStats();
      if (stats.percentage > 70) {
        await this.compact();
      } else if (this.history.messages.length > 15) {
        await this.compact({ recentCount: 8 });
      }

      // B2: atomic claim — for serial we could use getNextPending, but
      // using claimNextPending gives us consistent state fields (worker
      // label, startedAt) whether in serial or parallel mode.
      const task = this.taskManager.claimNextPending("serial");
      if (!task) break;

      // Yield task progress event for TUI
      yield new AgentEvent({
        type: "task_progress",
        data: {
          taskId: task.id,
          title: task.title,
          ruleId: task.ruleId,
          status: "in_progress",
          progress: this.taskManager.progress,
        },
      });

      // D1: synthesize a task-focused prompt, enriched with rule source
      // context (rule NL + source_ref + chunk text + sibling ids) when
      // the catalog + BundleTree cache are available. Falls back to the
      // minimal "Continue with next task" line otherwise.
      const taskPrompt = this._buildEnrichedTaskPrompt(task);

      yield* this.runTurn(taskPrompt);

      this.taskManager.markDone(task.id);
      this.saveState();

      yield new AgentEvent({
        type: "task_progress",
        data: {
          taskId: task.id,
          title: task.title,
          status: "completed",
          progress: this.taskManager.progress,
        },
      });

      // Bug 4 trigger (2): auto-advance when all phase tasks are done AND
      // the pipeline's exit criteria are also met (Bug 5 fix — task state
      // alone is a ralph-loop convenience, not authoritative phase signal;
      // tasks could be marked skipped manually or by an editor).
      if (this._allCurrentPhaseTasksComplete()) {
        const pipeline = this.pipelines[this.currentPhase];
        let exitMet = false;
        try { exitMet = !!pipeline?.exitCriteriaMet?.(); } catch { exitMet = false; }
        if (exitMet) {
          const next = NEXT_PHASE[this.currentPhase];
          if (next) {
            const advanced = this._advancePhase(next, "all current-phase tasks completed + exit criteria met");
            if (advanced) {
              yield new AgentEvent({
                type: "pipeline_event",
                data: { type: "phase_ready", nextPhase: next, message: "all phase tasks done; exit criteria met" },
              });
            }
          }
        }
      }
    }
  }

  /**
   * B1: Parallel ralph-loop — N concurrent subagents each executing one
   * task at a time, claimed atomically from TaskManager.
   *
   * Implementation: leverages B8's agent_tool infrastructure. Each worker
   * slot is a sub-engine with its own heap-isolated history; workspace
   * writes are serialized through B9's file locks. The main engine acts
   * as dispatcher — it claims tasks and spawns subagents, then waits.
   *
   * Chosen over in-process history-forking because: (a) sub-engines are
   * already heap-isolated (good under B0's RSS-safety regime); (b)
   * kill authority from B8 applies uniformly; (c) no runTurn refactor
   * needed — the engine's conversation-state assumptions stay intact.
   * Trade-off: each task pays a cold-start cost (re-read AGENT.md,
   * skill index, pipeline state). For 100+ task sessions this is
   * amortized against the 2-4× wall-clock speedup.
   */
  async *_runTaskLoopParallel(userMessage, parallelism) {
    // Initial turn: main agent reads user request, creates tasks.
    yield* this.runTurn(userMessage);

    const agentTool = this._buildTools.core.find((t) => t?.name === "agent_tool");
    if (!agentTool) {
      // Shouldn't happen (agent_tool is core), but fall back safely.
      yield new AgentEvent({
        type: "error",
        message: "agent_tool not registered; parallel mode requires it. Falling back to serial.",
      });
      yield* this._runTaskLoopSerial("");
      return;
    }

    // Event queue so concurrent workers can yield progress through a
    // single async-generator consumer. push-style with a notifier.
    const eventQueue = [];
    let notify = null;
    const enq = (ev) => {
      eventQueue.push(ev);
      if (notify) { const n = notify; notify = null; n(); }
    };

    // In-flight: subagent task_id → { task, promise }
    const inFlight = new Map();

    const dispatch = async () => {
      while (inFlight.size < parallelism) {
        const task = this.taskManager.claimNextPending(`pool${inFlight.size}`);
        if (!task) return;

        const workerLabel = `pool${[...inFlight.keys()].length}`;
        const subId = `pool_${task.id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);

        // D1: build the enriched brief with source context. Parallel workers
        // are subagents — each with zero conversation history, so the brief
        // must carry everything they need. Even more important to have
        // source context inline vs. expecting them to call document_search.
        const enriched = this._buildEnrichedTaskPrompt(task);
        const brief =
          enriched +
          `\n\nNOTE (parallel worker): write outputs via workspace_file or ` +
          `rule_catalog — do NOT write to shared coordination files ` +
          `(rules/catalog.json, rules/manifest.json) via sandbox_exec; they're ` +
          `lock-protected and bypassing the lock will race with other workers.`;

        enq(new AgentEvent({
          type: "task_progress",
          data: {
            taskId: task.id, title: task.title, ruleId: task.ruleId,
            status: "in_progress", worker: workerLabel,
            progress: this.taskManager.progress,
          },
        }));

        // Spawn via the tool's public API. agent_tool writes status.txt,
        // abort controller, etc. We read _runningTasks to get a promise
        // handle we can await.
        const spawnRes = await agentTool.execute({
          operation: "spawn",
          task_description: brief,
          task_id: subId,
        });

        if (spawnRes.isError) {
          this.taskManager.markFailed(task.id, `spawn failed: ${spawnRes.content}`);
          enq(new AgentEvent({
            type: "task_progress",
            data: { taskId: task.id, status: "failed", worker: workerLabel },
          }));
          continue;
        }

        const entry = agentTool._runningTasks.get(subId);
        if (!entry) {
          // Sub-agent completed synchronously (no events) — mark done.
          this.taskManager.markDone(task.id);
          enq(new AgentEvent({
            type: "task_progress",
            data: { taskId: task.id, status: "completed", worker: workerLabel },
          }));
          continue;
        }

        // v0.7.0 H1: trackedPromise covers both fulfilled and rejected
        // paths (second arg). The .catch tail is belt-and-braces in case
        // the .then callbacks themselves throw — without it, a JSON
        // serialization throw inside the success-arm callback would
        // surface as UnhandledPromiseRejection and crash strict-mode
        // Node. We never want a worker error to take the engine down.
        const trackedPromise = entry.promise
          .then(
            () => ({ taskId: task.id, subId, ok: true }),
            (e) => ({ taskId: task.id, subId, ok: false, error: e?.message || String(e) }),
          )
          .catch((e) => ({ taskId: task.id, subId, ok: false, error: `tracked-promise threw: ${e?.message || String(e)}` }));
        inFlight.set(subId, { task, workerLabel, promise: trackedPromise });
      }
    };

    // Prime the pool
    await dispatch();

    // Drain events + replenish until queue is empty and all in-flight done.
    while (inFlight.size > 0 || eventQueue.length > 0) {
      // Drain all queued events first
      while (eventQueue.length > 0) yield eventQueue.shift();

      if (inFlight.size === 0) break;

      // Wait for either the next event OR a worker to complete.
      //
      // v0.7.0 C1 note: losers in Promise.race() keep their .then()
      // chains active and resolve into garbage objects. That's the
      // intended JS Promise behavior — rejections are still handled,
      // memory drops at GC. The audit was overstated; no actual hang
      // or leak. Each loop iteration rebuilds the race from current
      // inFlight.values() so stale promises from prior iterations
      // are naturally re-observed (they've already resolved by then).
      const workerCompletion = Promise.race([...inFlight.values()].map((v) => v.promise));
      const eventArrival = new Promise((resolve) => { notify = () => resolve("event"); });
      const winner = await Promise.race([
        workerCompletion.then((done) => ({ kind: "worker", done })),
        eventArrival.then(() => ({ kind: "event" })),
      ]);

      if (winner.kind === "worker") {
        const { taskId, subId, ok, error } = winner.done;
        const entry = inFlight.get(subId);
        inFlight.delete(subId);

        if (ok) {
          this.taskManager.markDone(taskId);
          enq(new AgentEvent({
            type: "task_progress",
            data: {
              taskId, status: "completed",
              worker: entry?.workerLabel,
              progress: this.taskManager.progress,
            },
          }));
        } else {
          this.taskManager.markFailed(taskId, error);
          enq(new AgentEvent({
            type: "task_progress",
            data: {
              taskId, status: "failed",
              worker: entry?.workerLabel,
              error,
              progress: this.taskManager.progress,
            },
          }));
        }

        // Refill the pool. If no pending tasks left, in-flight drains naturally.
        await dispatch();
      }
      // event winner: loop re-iterates and drains eventQueue
    }

    this.saveState();

    // After all workers done, check for phase auto-advance (same as serial path).
    if (this._allCurrentPhaseTasksComplete()) {
      const pipeline = this.pipelines[this.currentPhase];
      let exitMet = false;
      try { exitMet = !!pipeline?.exitCriteriaMet?.(); } catch { exitMet = false; }
      if (exitMet) {
        const next = NEXT_PHASE[this.currentPhase];
        if (next) {
          const advanced = this._advancePhase(next, "all parallel tasks completed + exit criteria met");
          if (advanced) {
            yield new AgentEvent({
              type: "pipeline_event",
              data: { type: "phase_ready", nextPhase: next, message: "all phase tasks done; exit criteria met" },
            });
          }
        }
      }
    }
  }

  /**
   * True when every task tagged with the current phase is in a terminal state
   * (completed | failed | skipped) and at least one such task exists. Used by
   * runTaskLoop's auto-advance trigger.
   */
  _allCurrentPhaseTasksComplete() {
    if (!this.taskManager) return false;
    const phase = this.currentPhase;
    const phaseTasks = this.taskManager.getAllTasks().filter((t) => t.phase === phase);
    if (phaseTasks.length === 0) return false;
    return phaseTasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "skipped");
  }
}
