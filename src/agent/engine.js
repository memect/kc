import fs from "node:fs";
import path from "node:path";
import { AgentEvent } from "./events.js";
import { ContextAssembler } from "./context.js";
import { ConversationHistory } from "./history.js";
import { Workspace } from "./workspace.js";
import { VersionManager } from "./version-manager.js";
import { CornerCaseRegistry } from "./corner-case-registry.js";
import { ConfidenceScorer } from "./confidence-scorer.js";
import { ToolRegistry } from "./tools/registry.js";
import { SandboxExecTool } from "./tools/sandbox-exec.js";
import { WorkspaceFileTool } from "./tools/workspace-file.js";
import { DocumentParseTool } from "./tools/document-parse.js";
import { DocumentSearchTool } from "./tools/document-search.js";
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
import { Phase } from "./pipelines/index.js";
import { ProjectInitializer } from "./pipelines/initializer.js";
import { RuleExtractionPipeline } from "./pipelines/extraction.js";
import { SkillAuthoringPipeline } from "./pipelines/skill-authoring.js";
import { SkillTestingPipeline } from "./pipelines/skill-testing.js";
import { DistillationEngine as DistillationPipeline } from "./pipelines/distillation.js";
import { ProductionQCPipeline } from "./pipelines/production-qc.js";
import { EventLog } from "./event-log.js";
import { ContextWindow } from "./context-window.js";
import { SessionState } from "./session-state.js";
import { estimateTokens, estimateMessagesTokens } from "./token-counter.js";

// Phases where worker LLM tools are available (DISTILL mode)
const DISTILL_PHASES = new Set([Phase.DISTILLATION, Phase.PRODUCTION_QC]);

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
   */
  constructor({ client, config, sessionId }) {
    this.client = client;
    this.config = config;
    this.context = new ContextAssembler();

    // Workspace + structural components
    this.workspace = new Workspace(config.kcWorkspaceRoot, sessionId, config.projectDir);
    this.history = new ConversationHistory(this.workspace.cwd);
    this.versionManager = new VersionManager(this.workspace.cwd);
    this.cornerCases = new CornerCaseRegistry(this.workspace.cwd);
    this.confidence = new ConfidenceScorer(this.workspace.cwd, this.cornerCases);

    // Event log (append-only JSONL, source of truth)
    this.eventLog = new EventLog(this.workspace.cwd);

    // Context windowing
    this.contextWindow = new ContextWindow({
      contextLimit: config.kcContextLimit || 200000,
      reserveForResponse: config.kcMaxTokens || 65536,
    });

    // Session state persistence
    this.sessionState = new SessionState(this.workspace.cwd);

    // Build all tool instances (but register phase-appropriate ones)
    this._buildTools = this._createAllTools();
    this._phaseSummaries = [];

    // Pipeline system (meta-meta skills as code)
    this.currentPhase = Phase.BOOTSTRAP;
    this.pipelines = {
      [Phase.BOOTSTRAP]: new ProjectInitializer(this.workspace),
      [Phase.EXTRACTION]: new RuleExtractionPipeline(this.workspace),
      [Phase.SKILL_AUTHORING]: new SkillAuthoringPipeline(this.workspace),
      [Phase.SKILL_TESTING]: new SkillTestingPipeline(this.workspace),
      [Phase.DISTILLATION]: new DistillationPipeline(this.workspace),
      [Phase.PRODUCTION_QC]: new ProductionQCPipeline(this.workspace),
    };

    // Skill discovery (Claude Code pattern: index in context, full content on demand)
    this._skillLoader = new SkillLoader(config.language);

    // Register tools for initial phase
    this.toolRegistry = new ToolRegistry();
    this._registerToolsForPhase(this.currentPhase);
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
        new DocumentParseTool(this.workspace, {
          mineruApiUrl: this.config.mineruApiUrl,
          mineruApiKey: this.config.mineruApiKey,
          llmApiKey: workerApiKey,
          llmBaseUrl: workerBaseUrl,
          ocrModel: vlmModel,
        }),
        new DocumentSearchTool(this.workspace),
        new RuleCatalogTool(this.workspace),
        new EvolutionCycleTool(this.workspace, this.cornerCases),
        new DashboardRenderTool(this.workspace),
        new AgentTool(this.workspace, (sid) => new AgentEngine({
          client: this.client, config: this.config, sessionId: sid,
        })),
        new WebSearchTool(this.config.tavilyApiKey),
      ],
      // Distillation+ only (DISTILL mode)
      distill: [
        workerLlm,
        new WorkflowRunTool(this.workspace, this.versionManager, this.confidence),
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
    return lines.join("\n");
  }

  /**
   * Get current context usage statistics.
   * @returns {{ totalTokens: number, limit: number, percentage: number }}
   */
  getContextStats() {
    const systemPrompt = this.context.build({
      agentMd: this._readAgentMd(),
      skillIndex: this._skillLoader.formatForContext(),
      pipelineState: this.pipelines[this.currentPhase]?.describeState?.() || null,
      workspaceState: this._buildWorkspaceState(),
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
   * Compact conversation history by summarizing older messages via LLM.
   * Keeps the most recent messages intact.
   * @param {object} [opts]
   * @param {number} [opts.recentCount=20] - Number of recent messages to keep
   * @returns {Promise<{removedCount: number, retainedCount: number, summaryTokens: number}|null>}
   */
  async compact({ recentCount = 20 } = {}) {
    if (this.history.messages.length <= recentCount) return null;

    const olderMessages = this.history.messages.slice(0, -recentCount);
    const recentMessages = this.history.messages.slice(-recentCount);

    let summary;
    try {
      const summaryResp = await this.client.chat({
        model: this.config.kcModel,
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Produce a concise summary of the following conversation. " +
              "Focus on: decisions made, files created or modified, current state of work, key findings, " +
              "unresolved questions. Be specific about file paths, rule IDs, and results. Keep under 2000 tokens.",
          },
          {
            role: "user",
            content: `Summarize this conversation:\n\n${JSON.stringify(olderMessages)}`,
          },
        ],
        maxTokens: 2048,
      });
      summary = summaryResp.choices?.[0]?.message?.content || null;
    } catch {
      // LLM summary failed — do mechanical fallback
      summary = null;
    }

    if (!summary) {
      // Mechanical fallback: extract tool names and outcomes
      const lines = ["Previous conversation summary (mechanical):"];
      for (const msg of olderMessages) {
        if (msg.role === "user") {
          lines.push(`- User: ${(msg.content || "").slice(0, 100)}`);
        } else if (msg.role === "assistant" && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            lines.push(`- Tool call: ${tc.function?.name}`);
          }
        }
      }
      summary = lines.join("\n");
    }

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
      summary,
    });

    return {
      removedCount: olderMessages.length,
      retainedCount: recentMessages.length,
      summaryTokens: estimateTokens(summary),
    };
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
      skillIndex: this._skillLoader.formatForContext(),
      pipelineState,
      workspaceState: this._buildWorkspaceState(),
    });
    const tools = this.toolRegistry.schemasOpenai();

    while (true) {
      // Apply context windowing before sending to LLM
      const windowed = this.contextWindow.window(this.history.messages, this._phaseSummaries);
      const messages = [{ role: "system", content: systemPrompt }, ...windowed.messages];

      if (windowed.wasWindowed) {
        this.eventLog.append("context_windowed", {
          removedCount: windowed.removedCount,
          totalBefore: this.history.messages.length,
        });
      }

      this.eventLog.append("llm_start", {
        model: this.config.kcModel,
        messageCount: messages.length,
      });

      try {
        let collectedText = "";
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
          this.eventLog.append("turn_complete", {});
          this.saveState();
          yield new AgentEvent({ type: "turn_complete" });
          return;
        }

        // Tool execution loop
        for (const tc of toolCallsAcc.values()) {
          let inputData = {};
          try {
            inputData = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch { /* ignore */ }

          this.eventLog.append("tool_start", { name: tc.name, input: inputData });
          yield new AgentEvent({ type: "tool_start", name: tc.name, input: inputData });

          const result = await this.toolRegistry.execute(tc.name, inputData);

          this.eventLog.append("tool_result", {
            name: tc.name,
            output: result.content?.slice(0, 5000) || "",
            isError: result.isError,
          });
          yield new AgentEvent({
            type: "tool_result",
            name: tc.name,
            output: result.content,
            isError: result.isError,
          });

          this.history.addRaw({
            role: "tool",
            tool_call_id: tc.id,
            content: result.content,
          });

          // Pipeline controller: update state and re-register tools on phase change
          if (pipeline?.onToolResult) {
            const pEvent = pipeline.onToolResult(tc.name, inputData, result);
            if (pEvent) {
              if (pEvent.type === "phase_ready" && pEvent.nextPhase) {
                const phaseSummary = `[${this.currentPhase.toUpperCase()} completed]: ${pEvent.message || ""}`;
                this._phaseSummaries.push(phaseSummary);
                this.eventLog.append("phase_transition", {
                  from: this.currentPhase,
                  to: pEvent.nextPhase,
                  summary: phaseSummary,
                });
                this.currentPhase = pEvent.nextPhase;
                this._registerToolsForPhase(this.currentPhase);
                this.saveState();
              }
              yield new AgentEvent({
                type: "pipeline_event",
                data: pEvent,
              });
            }
          }
        }

      } catch (err) {
        this.eventLog.append("error", { message: err.message });
        yield new AgentEvent({ type: "error", message: err.message });
        return;
      }
    }
  }
}
