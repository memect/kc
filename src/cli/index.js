import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { loadSettings } from "../config.js";
import { LLMClient } from "../agent/llm-client.js";
import { AgentEngine } from "../agent/engine.js";
import { Workspace } from "../agent/workspace.js";
import { ConversationHistory } from "../agent/history.js";
import {
  WelcomeBanner,
  StatusBar,
  CookingSpinner,
  ToolBlock,
  TaskDashboard,
  HRule,
  InputPrompt,
} from "./components.js";

const h = React.createElement;

/**
 * Main KC Agent CLI App using Ink (React for terminals).
 */
function App({ engine, config }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [currentTool, setCurrentTool] = useState(null);
  const [sessionId, setSessionId] = useState(engine.workspace.sessionId);
  const [phase, setPhase] = useState(engine.currentPhase);
  const [showWelcome, setShowWelcome] = useState(true);
  const [spinnerStatus, setSpinnerStatus] = useState(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(config.kcContextLimit || 200000);
  const [taskList, setTaskList] = useState([]);
  const [taskProgress, setTaskProgress] = useState(null);

  const engineRef = useRef(engine);
  const streamingRef = useRef(false);
  const queueRef = useRef([]);

  // Update context stats
  const updateContextStats = useCallback(() => {
    try {
      const stats = engineRef.current.getContextStats();
      setContextTokens(stats.totalTokens);
      setContextLimit(stats.limit);
    } catch { /* ignore */ }
  }, []);

  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const runTurn = useCallback(async (text) => {
    streamingRef.current = true;
    setStreaming(true);
    setStreamingText("");
    setCurrentTool(null);
    setSpinnerStatus("Thinking...");

    let accumulated = "";

    try {
      for await (const event of engineRef.current.runTaskLoop(text)) {
        switch (event.type) {
          case "text_delta":
            accumulated += event.text ?? "";
            setStreamingText(accumulated);
            setSpinnerStatus("Thinking...");
            break;

          case "turn_complete":
            if (accumulated) {
              addMessage({ role: "agent", content: accumulated });
            }
            accumulated = "";
            setStreamingText("");
            setCurrentTool(null);
            setSpinnerStatus(null);
            updateContextStats();
            break;

          case "tool_start":
            // Flush any accumulated text before tool
            if (accumulated) {
              addMessage({ role: "agent", content: accumulated });
              accumulated = "";
              setStreamingText("");
            }
            setCurrentTool({ name: event.name, input: event.input, output: null, isError: false, isRunning: true });
            setSpinnerStatus(`Running ${event.name}...`);
            break;

          case "tool_result":
            // Add completed tool to messages
            addMessage({
              role: "tool",
              toolName: event.name,
              toolInput: currentTool?.input ?? event.input,
              toolOutput: event.output,
              toolIsError: event.isError,
            });
            setCurrentTool(null);
            setSpinnerStatus("Analyzing results...");
            break;

          case "pipeline_event": {
            const nextPhase = event.data?.nextPhase ?? event.data?.next_phase ?? "";
            if (nextPhase) setPhase(nextPhase);
            addMessage({ role: "system", content: `[Pipeline] ${event.data?.message ?? ""}` });
            break;
          }

          case "task_progress": {
            const tp = event.data;
            setTaskList(engineRef.current.taskManager.getAllTasks());
            setTaskProgress(tp.progress);
            if (tp.status === "in_progress") {
              setSpinnerStatus(`Task: ${tp.title}`);
            }
            break;
          }

          case "error":
            addMessage({ role: "system", content: `Error: ${event.message ?? "Unknown error"}` });
            break;
        }
      }
    } catch (err) {
      addMessage({ role: "system", content: `Error: ${err.message}` });
    }

    streamingRef.current = false;
    setStreaming(false);
    setSpinnerStatus(null);
    updateContextStats();

    // Process queue
    if (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      runTurn(next);
    }
  }, [addMessage, updateContextStats]);

  const handleSlashCommand = useCallback((text) => {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    switch (cmd) {
      case "/help":
        addMessage({
          role: "system",
          content:
            "Commands:\n" +
            "  /help                Show this help\n" +
            "  /status              Show session info, model, phase, workspace\n" +
            "  /tasks               Show task progress\n" +
            "  /clear               Clear conversation history (keep workspace)\n" +
            "  /compact             Summarize older messages to reduce context\n" +
            "  /sessions            List all sessions\n" +
            "  /resume <name>       Resume a previous session\n" +
            "  /rename <name>       Rename current session\n" +
            "  /exit                Quit",
        });
        return true;

      case "/status": {
        const stats = engineRef.current.getContextStats();
        addMessage({
          role: "system",
          content:
            `Session:   ${engineRef.current.workspace.sessionId}\n` +
            `Phase:     ${engineRef.current.currentPhase.toUpperCase()}\n` +
            `Model:     ${config.kcModel}\n` +
            `Provider:  ${config.provider || "unknown"}\n` +
            `LLM URL:   ${config.llmBaseUrl}\n` +
            `Project:   ${engineRef.current.workspace.projectDir || "(none)"}\n` +
            `Workspace: ${engineRef.current.workspace.cwd}\n` +
            `Tools:     ${engineRef.current.toolRegistry.size} registered\n` +
            `History:   ${engineRef.current.history.messages.length} messages\n` +
            `Context:   ~${stats.totalTokens} tokens (${stats.percentage}% of ${stats.limit})`,
        });
        return true;
      }

      case "/tasks":
        addMessage({
          role: "system",
          content: engineRef.current.taskManager.formatForDisplay(),
        });
        return true;

      case "/clear":
        engineRef.current.history = new ConversationHistory(engineRef.current.workspace.cwd);
        setMessages([]);
        addMessage({ role: "system", content: "Conversation cleared. Workspace and pipeline state preserved." });
        updateContextStats();
        return true;

      case "/compact": {
        addMessage({ role: "system", content: "Compacting conversation history..." });
        // Run compact asynchronously
        (async () => {
          try {
            const result = await engineRef.current.compact();
            if (result) {
              addMessage({
                role: "system",
                content: `Compacted: removed ${result.removedCount} messages, kept ${result.retainedCount}. Summary: ~${result.summaryTokens} tokens.`,
              });
            } else {
              addMessage({ role: "system", content: "Nothing to compact (conversation is short enough)." });
            }
            updateContextStats();
          } catch (err) {
            addMessage({ role: "system", content: `Compact failed: ${err.message}` });
          }
        })();
        return true;
      }

      case "/rename":
        if (!arg) {
          addMessage({ role: "system", content: "Usage: /rename <new_name>" });
        } else {
          try {
            const newId = engineRef.current.workspace.rename(arg);
            setSessionId(newId);
            addMessage({ role: "system", content: `Session renamed to: ${newId}` });
          } catch (err) {
            addMessage({ role: "system", content: `Rename failed: ${err.message}` });
          }
        }
        return true;

      case "/sessions": {
        const sessions = Workspace.listSessions(config.kcWorkspaceRoot);
        if (sessions.length === 0) {
          addMessage({ role: "system", content: "No sessions found." });
        } else {
          const lines = sessions.map((s) => {
            const marker = s.id === engineRef.current.workspace.sessionId ? " ← current" : "";
            return `  ${s.id}${marker}`;
          });
          addMessage({ role: "system", content: "Sessions:\n" + lines.join("\n") });
        }
        return true;
      }

      case "/resume":
        if (!arg) {
          const sessions = Workspace.listSessions(config.kcWorkspaceRoot);
          if (sessions.length === 0) {
            addMessage({ role: "system", content: "No sessions found." });
          } else {
            const lines = sessions.map((s) => {
              const marker = s.id === engineRef.current.workspace.sessionId ? " ← current" : "";
              return `  ${s.id}${marker}`;
            });
            addMessage({ role: "system", content: "Sessions:\n" + lines.join("\n") + "\n\nUsage: /resume <name>" });
          }
        } else {
          // Resume a previous session
          (async () => {
            try {
              const client = new LLMClient({
                apiKey: config.llmApiKey,
                baseUrl: config.llmBaseUrl,
                authType: config.authType,
                apiFormat: config.apiFormat,
              });
              const resumed = await AgentEngine.resume({ client, config, sessionId: arg });
              engineRef.current = resumed;
              setSessionId(resumed.workspace.sessionId);
              setPhase(resumed.currentPhase);
              setMessages([]);
              addMessage({
                role: "system",
                content:
                  `Resumed session: ${arg}\n` +
                  `Phase: ${resumed.currentPhase.toUpperCase()}\n` +
                  `History: ${resumed.history.messages.length} messages restored`,
              });
              updateContextStats();
            } catch (err) {
              addMessage({ role: "system", content: `Resume failed: ${err.message}` });
            }
          })();
        }
        return true;

      case "/exit":
      case "/quit":
        // Save state before exit
        try { engineRef.current.saveState(); } catch { /* ignore */ }
        exit();
        return true;

      default:
        return false;
    }
  }, [addMessage, config, exit, updateContextStats]);

  const handleSubmit = useCallback((text) => {
    const trimmed = text.trim();
    setInputValue("");
    if (!trimmed) return;

    addMessage({ role: "user", content: trimmed });

    if (trimmed.startsWith("/")) {
      const handled = handleSlashCommand(trimmed);
      if (handled) return;
    }

    if (streamingRef.current) {
      queueRef.current.push(trimmed);
    } else {
      runTurn(trimmed);
    }
  }, [addMessage, handleSlashCommand, runTurn]);

  // Handle Ctrl+C and Ctrl+D
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (streamingRef.current) {
        queueRef.current.length = 0;
        addMessage({ role: "system", content: "[Queue cleared]" });
      } else {
        try { engineRef.current.saveState(); } catch { /* ignore */ }
        exit();
      }
    }
    if (key.ctrl && input === "d") {
      try { engineRef.current.saveState(); } catch { /* ignore */ }
      exit();
    }
  });

  return h(Box, { flexDirection: "column" },
    // Welcome banner
    showWelcome ? h(WelcomeBanner, { projectDir: config.projectDir }) : null,

    // Task dashboard (ralph-loop)
    taskList.length > 0 ? h(TaskDashboard, { tasks: taskList, progress: taskProgress }) : null,

    // Message history
    ...messages.map((msg, i) => {
      if (msg.role === "user") {
        return h(Box, { key: `msg-${i}` },
          h(Text, { dimColor: true }, "❯ "),
          h(Text, null, msg.content),
        );
      }
      if (msg.role === "agent") {
        return h(Box, { key: `msg-${i}` },
          h(Text, null, msg.content),
        );
      }
      if (msg.role === "tool") {
        return h(ToolBlock, {
          key: `msg-${i}`,
          name: msg.toolName,
          input: msg.toolInput,
          output: msg.toolOutput,
          isError: msg.toolIsError,
          isRunning: false,
        });
      }
      if (msg.role === "system") {
        return h(Box, { key: `msg-${i}` },
          h(Text, { dimColor: true }, msg.content),
        );
      }
      return null;
    }),

    // Currently streaming text
    streamingText ? h(Box, { key: "streaming" },
      h(Text, null, streamingText),
    ) : null,

    // Currently running tool
    currentTool ? h(ToolBlock, {
      key: "current-tool",
      name: currentTool.name,
      input: currentTool.input,
      output: null,
      isError: false,
      isRunning: true,
    }) : null,

    // Activity indicator while KC is working
    streaming
      ? h(CookingSpinner, { status: spinnerStatus })
      : null,

    // Separator + Input
    h(HRule),
    h(InputPrompt, {
      value: inputValue,
      onChange: setInputValue,
      onSubmit: handleSubmit,
      isActive: !streaming,
    }),
    h(HRule),
    h(StatusBar, { sessionId, phase, contextTokens, contextLimit }),
  );
}

export async function main({ languageOverride } = {}) {
  const config = loadSettings();

  // Capture user's project directory (CWD at launch)
  config.projectDir = process.cwd();

  // Session-only language override (does NOT persist to config)
  if (languageOverride) {
    config.language = languageOverride;
  }

  if (!config.llmApiKey) {
    console.error("Error: No API key configured. Run 'kc-beta onboard' first.");
    process.exit(1);
  }

  // Warn if all worker LLM tiers are blank
  const allTiersBlank = !config.tier1 && !config.tier2 && !config.tier3 && !config.tier4;
  if (allTiersBlank) {
    const msg = config.language === "zh"
      ? "  ⚠ 所有 Worker LLM 分层为空。DISTILL 模式将不可用。运行 'kc-beta config' 或 'kc-beta onboard' 配置模型分层。"
      : "  ⚠ All worker LLM tiers are blank. DISTILL mode will not work. Run 'kc-beta config' or 'kc-beta onboard' to configure model tiers.";
    console.log(`\x1b[33m${msg}\x1b[0m\n`);
  }

  const client = new LLMClient({
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    authType: config.authType,
    apiFormat: config.apiFormat,
  });

  const engine = new AgentEngine({ client, config });

  // Save state on process exit
  const saveOnExit = () => { try { engine.saveState(); } catch { /* ignore */ } };
  process.on("SIGINT", saveOnExit);
  process.on("SIGTERM", saveOnExit);

  const instance = render(h(App, { engine, config }));
  await instance.waitUntilExit();
}
