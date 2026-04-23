import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { loadSettings } from "../config.js";
import { LLMClient } from "../agent/llm-client.js";
import { AgentEngine, NEXT_PHASE } from "../agent/engine.js";
import { Workspace } from "../agent/workspace.js";
import { ConversationHistory } from "../agent/history.js";
import { Scheduler } from "../agent/scheduler.js";
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

// Only the last N messages stay in the Ink render tree. Older messages
// remain in React state (so /compact can summarize them) but aren't
// diffed on every keystroke — this is what keeps long sessions responsive
// and prevents the 4 GB heap OOM observed in the v0.5.3 E2E test.
// Full conversation is persisted to logs/events.jsonl on every event,
// so dropping from render is purely visual.
const VISIBLE_WINDOW = 50;

// How many recent messages render their ToolBlock with full preview.
// Older ToolBlocks show header only. Both still persist full output to disk.
const RECENT_TOOL_WINDOW = 10;

// B0.3: Hard cap on the React `messages` array. Without this, the array
// grows forever (setMessages((prev) => [...prev, msg]) via addMessage) —
// the VISIBLE_WINDOW virtualization hides old entries from render but
// they still sit in state. Over a 17 h session with 2-4 messages per
// turn, that's 1000s of entries holding tool-result digest strings and
// pipeline messages. /compact resets messages to a 1-item summary, so
// this cap is really a safety net between compacts. On cap hit, drop
// oldest non-system entries (system messages carry session-level
// context — pipeline transitions, errors — that users want retained).
const MAX_RETAINED_MESSAGES = 500;

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
    setMessages((prev) => {
      if (prev.length < MAX_RETAINED_MESSAGES) return [...prev, msg];
      // Cap hit: drop the oldest non-system entry. If everything is system
      // (unlikely but possible), fall back to dropping the very oldest.
      const dropIdx = prev.findIndex((m) => m.role !== "system");
      const next = dropIdx >= 0
        ? [...prev.slice(0, dropIdx), ...prev.slice(dropIdx + 1), msg]
        : [...prev.slice(1), msg];
      return next;
    });
  }, []);

  const runTurn = useCallback(async (text) => {
    streamingRef.current = true;
    setStreaming(true);
    setStreamingText("");
    setCurrentTool(null);
    setSpinnerStatus("Thinking...");

    let accumulated = "";

    try {
      for await (const event of engineRef.current.runTaskLoop(text, {
        parallelism: config.effectiveParallelism?.() ?? 1,
      })) {
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
            "  /phase [sub]         advance | status | <name> — manual phase override\n" +
            "  /schedule            Show scheduled ingestion jobs and recent log lines\n" +
            "  /parallelism [N]     Show or set parallel ralph-loop worker count (1-8)\n" +
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
        const par = config.effectiveParallelism?.() ?? 1;
        const parLine = par > 1
          ? `${par} (verified)`
          : `${config.parallelismRequested || 1} requested` +
            (config.parallelismRequested > 1 && !config.parallelismVerified
              ? ` — clamped to 1 (KC_PARALLELISM_VERIFIED not set; run heap baseline first)`
              : "");
        addMessage({
          role: "system",
          content:
            `Session:     ${engineRef.current.workspace.sessionId}\n` +
            `Phase:       ${engineRef.current.currentPhase.toUpperCase()}\n` +
            `Model:       ${config.kcModel}\n` +
            `Provider:    ${config.provider || "unknown"}\n` +
            `LLM URL:     ${config.llmBaseUrl}\n` +
            `Project:     ${engineRef.current.workspace.projectDir || "(none)"}\n` +
            `Workspace:   ${engineRef.current.workspace.cwd}\n` +
            `Tools:       ${engineRef.current.toolRegistry.size} registered\n` +
            `History:     ${engineRef.current.history.messages.length} messages\n` +
            `Context:     ~${stats.totalTokens} tokens (${stats.percentage}% of ${stats.limit})\n` +
            `Parallelism: ${parLine}`,
        });
        return true;
      }

      case "/parallelism": {
        // B3: set parallelism at runtime. Respects the B0.6 guard —
        // takes effect only if KC_PARALLELISM_VERIFIED is already set.
        const n = parseInt(arg, 10);
        if (!Number.isFinite(n) || n < 1) {
          addMessage({
            role: "system",
            content:
              `Usage: /parallelism <N> (1-8)\n` +
              `Current: requested=${config.parallelismRequested || 1}, ` +
              `effective=${config.effectiveParallelism?.() ?? 1}. ` +
              (config.parallelismVerified
                ? "Verified — new value takes effect next /run."
                : "Unverified — clamped to 1. Set KC_PARALLELISM_VERIFIED=1 after a clean 2h heap-baseline run."),
          });
          return true;
        }
        const clamped = Math.min(Math.max(n, 1), 8);
        config.parallelismRequested = clamped;
        addMessage({
          role: "system",
          content:
            `Parallelism requested=${clamped}. ` +
            (config.parallelismVerified
              ? `Effective=${config.effectiveParallelism()} (verified).`
              : `Effective=1 (verified flag not set — see /status).`),
        });
        return true;
      }

      case "/tasks":
        addMessage({
          role: "system",
          content: engineRef.current.taskManager.formatForDisplay(),
        });
        return true;

      case "/phase": {
        // User-driven phase override. Useful when auto-advance fails to fire
        // or when debugging. Subcommands:
        //   /phase                 → current phase (alias: /phase status)
        //   /phase advance | next  → move to NEXT_PHASE[current]
        //   /phase <name>          → force-jump to any phase (forward or back)
        const engine = engineRef.current;
        const sub = (parts[1] || "").toLowerCase();

        if (!sub || sub === "status") {
          const next = NEXT_PHASE[engine.currentPhase];
          addMessage({
            role: "system",
            content:
              `Current phase: ${engine.currentPhase.toUpperCase()}` +
              (next ? `  (next auto: ${next})` : "  (final phase)"),
          });
          return true;
        }

        if (sub === "advance" || sub === "next") {
          const next = NEXT_PHASE[engine.currentPhase];
          if (!next) {
            addMessage({ role: "system", content: `Already in final phase (${engine.currentPhase}).` });
            return true;
          }
          const ok = engine._advancePhase(next, "manual /phase advance");
          if (ok) setPhase(engine.currentPhase);
          addMessage({
            role: "system",
            content: ok
              ? `→ phase advanced to ${next.toUpperCase()}.`
              : `Failed to advance from ${engine.currentPhase}.`,
          });
          updateContextStats();
          return true;
        }

        // /phase <name> — force-jump. Uses {force:true} to allow backward jumps.
        // Whitelist against known phases first so an unknown name doesn't
        // silently corrupt engine state (_advancePhase with {force:true}
        // would otherwise accept any string and mutate currentPhase).
        const validPhases = Object.keys(engine.pipelines);
        if (!validPhases.includes(sub)) {
          addMessage({
            role: "system",
            content: `Unknown phase: ${sub}. Valid: ${validPhases.join(", ")}`,
          });
          return true;
        }
        if (sub === engine.currentPhase) {
          addMessage({ role: "system", content: `Already in phase ${sub.toUpperCase()}.` });
          return true;
        }
        const ok = engine._advancePhase(sub, "manual /phase <name>", { force: true });
        if (ok) setPhase(engine.currentPhase);
        addMessage({
          role: "system",
          content: ok
            ? `→ phase set to ${sub.toUpperCase()}.`
            : `Failed to set phase to ${sub}.`,
        });
        updateContextStats();
        return true;
      }

      case "/schedule": {
        const sched = new Scheduler(engineRef.current.workspace);
        const jobs = sched.list();
        if (jobs.length === 0) {
          addMessage({ role: "system", content: "No scheduled ingestion jobs. Ask KC to set one up via the schedule_fetch tool." });
        } else {
          const lines = jobs.map((j) => {
            const status = j.enabled ? "✓ enabled" : "· disabled";
            const hint = j.cron_hint ? `   cron: ${j.cron_hint}` : "   cron: (not set)";
            return `  ${status}  ${j.id}\n${hint}\n   cmd:  ${j.command}`;
          });
          const tail = sched.tailLog(8);
          const pending = sched.pendingInputCount();
          addMessage({
            role: "system",
            content:
              `Scheduled jobs:\n${lines.join("\n\n")}\n\n` +
              `Pending in input/: ${pending} file(s)` +
              (tail ? `\n\nlogs/ingest.log (last 8):\n${tail}` : ""),
          });
        }
        return true;
      }

      case "/clear":
        engineRef.current.history = new ConversationHistory(engineRef.current.workspace.cwd);
        setMessages([]);
        addMessage({ role: "system", content: "Conversation cleared. Workspace and pipeline state preserved." });
        updateContextStats();
        return true;

      case "/compact": {
        addMessage({ role: "system", content: "Compacting conversation history..." });
        // Gate the prompt while compact() is in flight. Without this,
        // InputPrompt stays active (isActive: !streaming) and a concurrent
        // user submission routes into runTurn → history.addUser(...), which
        // appends to _messages AFTER compact()'s pre-await snapshot. When
        // compact resolves it overwrites _messages with [summary, ack,
        // ...recentMessages] and silently drops the concurrent turn.
        streamingRef.current = true;
        setStreaming(true);
        setSpinnerStatus("Compacting...");
        (async () => {
          try {
            const result = await engineRef.current.compact();
            if (result) {
              // Claude Code pattern: after successful compact, clear the
              // visible TUI messages and start fresh with a single summary
              // line. The underlying engine.history already contains the
              // compact-summary message pair; the TUI doesn't need to keep
              // showing the pre-compact history (it's on disk in
              // logs/events.jsonl anyway) and clearing it immediately frees
              // Ink render-tree memory — fixing the lag that builds up over
              // long sessions.
              setMessages([{
                role: "system",
                content: `✓ 上下文已压缩：合并了 ${result.removedCount} 条早期消息（摘要约 ${result.summaryTokens} tokens，保留最近 ${result.retainedCount} 条）`,
              }]);
            } else {
              addMessage({ role: "system", content: "Nothing to compact (conversation is short enough)." });
            }
            updateContextStats();
          } catch (err) {
            addMessage({ role: "system", content: `Compact failed: ${err.message}` });
          } finally {
            streamingRef.current = false;
            setStreaming(false);
            setSpinnerStatus(null);
            if (queueRef.current.length > 0) {
              const next = queueRef.current.shift();
              runTurn(next);
            }
          }
        })();
        return true;
      }

      case "/rename":
        if (!arg) {
          addMessage({ role: "system", content: "Usage: /rename <new_name>" });
        } else {
          try {
            const r = engineRef.current.renameSession(arg);
            setSessionId(r.sessionId);
            const lines = [`Session renamed to: ${r.sessionId}`];
            if (r.scheduleWrappersRegenerated.length > 0) {
              lines.push(
                `${r.scheduleWrappersRegenerated.length} cron wrapper script(s) regenerated.`,
                `If you'd installed crontab lines for the OLD path, re-install via 'schedule_fetch print_crontab'.`,
              );
            }
            if (r.scheduleWrappersFailed && r.scheduleWrappersFailed.length > 0) {
              const ids = r.scheduleWrappersFailed.map((f) => f.id).join(", ");
              lines.push(
                `⚠ ${r.scheduleWrappersFailed.length} wrapper script(s) failed to regenerate (${ids}). Check workspace/scripts/ingest/ and disk space.`,
              );
            }
            addMessage({ role: "system", content: lines.join("\n") });
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
        // Save state + stop diagnostics before exit
        try { engineRef.current.saveState(); } catch { /* ignore */ }
        try { engineRef.current.stop(); } catch { /* ignore */ }
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
        try { engineRef.current.stop(); } catch { /* ignore */ }
        exit();
      }
    }
    if (key.ctrl && input === "d") {
      try { engineRef.current.saveState(); } catch { /* ignore */ }
      try { engineRef.current.stop(); } catch { /* ignore */ }
      exit();
    }
  });

  return h(Box, { flexDirection: "column" },
    // Welcome banner
    showWelcome ? h(WelcomeBanner, {
      projectDir: config.projectDir,
      pendingInputCount: (() => {
        try { return new Scheduler(engineRef.current.workspace).pendingInputCount(); }
        catch { return 0; }
      })(),
    }) : null,

    // Task dashboard (ralph-loop)
    taskList.length > 0 ? h(TaskDashboard, { tasks: taskList, progress: taskProgress }) : null,

    // Message history (virtualized — only last VISIBLE_WINDOW render).
    // Hidden-count hint for earlier messages, so users know the full
    // history still exists (on disk) even though the TUI is slim.
    messages.length > VISIBLE_WINDOW ? h(Box, { key: "hidden-hint" },
      h(Text, { dimColor: true },
        `— 前 ${messages.length - VISIBLE_WINDOW} 条消息已折叠，完整记录在 logs/events.jsonl —`),
    ) : null,
    ...messages.slice(-VISIBLE_WINDOW).map((msg, i, arr) => {
      // Global index (for stable React keys) vs visible index (for isRecent).
      const globalIdx = messages.length - arr.length + i;
      const visibleIdx = arr.length - 1 - i;  // 0 = most recent
      if (msg.role === "user") {
        return h(Box, { key: `msg-${globalIdx}` },
          h(Text, { dimColor: true }, "❯ "),
          h(Text, null, msg.content),
        );
      }
      if (msg.role === "agent") {
        return h(Box, { key: `msg-${globalIdx}` },
          h(Text, null, msg.content),
        );
      }
      if (msg.role === "tool") {
        return h(ToolBlock, {
          key: `msg-${globalIdx}`,
          name: msg.toolName,
          input: msg.toolInput,
          output: msg.toolOutput,
          isError: msg.toolIsError,
          isRunning: false,
          isRecent: visibleIdx < RECENT_TOOL_WINDOW,
        });
      }
      if (msg.role === "system") {
        return h(Box, { key: `msg-${globalIdx}` },
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

  // Warn if git is missing — Block 11 file system relies on git for version history.
  if (config.gitAutoCommit !== false && !Workspace.isGitInstalled()) {
    const msg = config.language === "zh"
      ? "  ⚠ 未检测到 git。本会话将不记录版本历史。安装 git 以启用自动提交。"
      : "  ⚠ git not found — version history disabled this session. Install git to enable auto-commit.";
    console.log(`\x1b[33m${msg}\x1b[0m\n`);
  }

  const client = new LLMClient({
    apiKey: config.llmApiKey,
    baseUrl: config.llmBaseUrl,
    authType: config.authType,
    apiFormat: config.apiFormat,
  });

  const engine = new AgentEngine({ client, config });

  // Save state on process exit + stop background diagnostics (B0.1 heap
  // sampler). saveState is idempotent; stop() is safe to call twice.
  const saveOnExit = () => {
    try { engine.saveState(); } catch { /* ignore */ }
    try { engine.stop(); } catch { /* ignore */ }
  };
  process.on("SIGINT", saveOnExit);
  process.on("SIGTERM", saveOnExit);

  const instance = render(h(App, { engine, config }));
  await instance.waitUntilExit();
}
