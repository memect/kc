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
import { MemeOverlay } from "./meme.js"; // F6

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
  const [showMeme, setShowMeme] = useState(false); // F6
  const [spinnerStatus, setSpinnerStatus] = useState(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(config.kcContextLimit || 200000);
  // v0.8.1 P8-A: marathon-mode indicator for StatusBar.
  const [marathonActive, setMarathonActive] = useState(false);
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
    // v0.7.0 H6: dismiss welcome banner once any real message lands.
    // The banner state was initialized true and never set false — the
    // banner stayed on every frame for the entire session, eating
    // permanent screen real estate. Conditionally clear on first
    // user/agent/tool-result message; system-only messages don't
    // dismiss (they're often just the banner-side info itself).
    if (msg && msg.role !== "system") setShowWelcome(false);
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
            // v0.8.1 P8-A: refresh marathon indicator. If the driver
            // self-terminated (max_wallclock / finalization_settled),
            // engine clears marathonDriver on next decideNext loop;
            // we sync the TUI state here.
            setMarathonActive(engineRef.current.isMarathonActive());
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
            // H4: Refresh the CTX indicator after every tool_result. Without
            // this, contextTokens only updates on turn_complete, which never
            // fires in long tool-heavy sessions — we observed 908 events with
            // zero turn_complete in session 6304673afaa0, CTX stuck at 0/131k
            // for 30+ minutes. getContextStats() is a cheap pure calc over
            // the history array; safe to call on every tool call.
            updateContextStats();
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
      setQueueSize(queueRef.current.length); // F2
      runTurn(next);
    } else {
      setQueueSize(0); // F2
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
            "  /tools               List all registered tools and which phase gates them\n" +
            "  /parallelism [N]     Show or set parallel ralph-loop worker count (1-8)\n" +
            "  /clear               Clear conversation history (keep workspace)\n" +
            "  /compact             Summarize older messages to reduce context\n" +
            "  /sessions            List all sessions\n" +
            "  /resume <name>       Resume a previous session\n" +
            "  /rename <name>       Rename current session\n" +
            "  /marathon <goal>     Activate marathon mode (chains turns automatically)\n" +
            "  /marathon off        Deactivate marathon (return to interactive)\n" +
            "  /marathon status     Show marathon driver state\n" +
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

      case "/meme":
        // F6: easter egg. Not in /help.
        setShowMeme(true);
        return true;

      case "/tools": {
        // F5: list all registered tools + which phase gates them. Reads
        // from the live toolRegistry so what you see is what the agent
        // currently has available. Also names the distill-only tools
        // explicitly so users understand why some tools "come and go"
        // as phases advance.
        const reg = engineRef.current.toolRegistry;
        const names = reg?.names?.() || [];
        const core = engineRef.current._buildTools?.core?.map((t) => t?.name).filter(Boolean) || [];
        const distill = engineRef.current._buildTools?.distill?.map((t) => t?.name).filter(Boolean) || [];
        const phase = engineRef.current.currentPhase.toUpperCase();
        const lines = [
          `Tools registered for phase ${phase}: ${names.length}`,
          "",
          `Core (always available, ${core.length}):`,
          ...core.map((n) => `  • ${n}${names.includes(n) ? "" : " [not currently registered]"}`),
        ];
        if (distill.length > 0) {
          lines.push("", `Distill-only (DISTILLATION / PRODUCTION_QC / FINALIZATION, ${distill.length}):`);
          for (const n of distill) {
            lines.push(`  • ${n}${names.includes(n) ? "" : " [gated out of this phase]"}`);
          }
        }
        lines.push("", "Tools are not separately installable — they ship with the KC release. To see what each tool does, invoke it or ask the agent.");
        addMessage({ role: "system", content: lines.join("\n") });
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
          // v0.6.3.1: also surface pending input files. The welcome banner
          // tells the user "run /schedule for details" when input/ has
          // unseen files, but the no-jobs branch used to ignore those —
          // user got a dead-end "no jobs" reply with the files invisible.
          const pending = sched.pendingInputCount();
          const tail = sched.tailLog(8);
          let body = "No scheduled ingestion jobs. Ask KC to set one up via the schedule_fetch tool.";
          if (pending > 0) body += `\n\nPending in input/: ${pending} file(s) (drop into workspace input/ to be picked up).`;
          if (tail) body += `\n\nlogs/ingest.log (last 8):\n${tail}`;
          addMessage({ role: "system", content: body });
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
        // v0.7.0 H7: top-level .catch on the IIFE — the inner try/catch
        // handles the compact() failure path; this tail .catch silences
        // any secondary rejection from the catch handler or finally
        // block (e.g., addMessage throw). Without it, those would be
        // UnhandledPromiseRejection in strict-mode Node.
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
            // F8: Spinner-race fix. If a queued task is about to kick off
            // via runTurn(next), DO NOT clear the streaming/spinner state
            // here — runTurn's own entry sets streamingRef=true + spinner
            // immediately, but there's a brief React-render window between
            // our `setStreaming(false)` and its `setStreaming(true)` where
            // the TUI paints "no spinner, no streaming" for 1-2 frames.
            // Over long sessions that looked like a dead TUI when a user
            // watched the moment /compact auto-chained to the next task.
            // Order now: IF next task is queued, let runTurn(next) set all
            // streaming state in one atomic render; we just reset the ref
            // flags to avoid the input-is-locked issue. Otherwise do the
            // full clear (idle-TUI case).
            const hasQueuedWork = queueRef.current.length > 0;
            streamingRef.current = false;
            if (!hasQueuedWork) {
              setStreaming(false);
              setSpinnerStatus(null);
            }
            if (hasQueuedWork) {
              const next = queueRef.current.shift();
              runTurn(next);
            }
          }
        })().catch(() => { /* H7 defensive tail */ });
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
          // v0.7.0 H8: top-level .catch on the IIFE so a throw inside
          // addMessage()/setMessages() (e.g., during the catch handler
          // itself, or in Ink reconciler) doesn't surface as an
          // UnhandledPromiseRejection that crashes Node strict-mode.
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
              // v0.7.0 F2: re-populate TaskBoard state from the resumed
              // engine's TaskManager. Without this, the TUI showed an
              // empty task list after /resume even when tasks.json on
              // disk had pending work. The setTaskList path mirrors what
              // the per-event tasks_progress handler does for live
              // sessions.
              try {
                const tasks = resumed.taskManager.getAllTasks();
                setTaskList(tasks);
                setTaskProgress(resumed.taskManager.progress);
              } catch { /* taskManager unavailable on very old session-state */ }
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
          })().catch(() => { /* defended above; tail catch silences any
            secondary rejection from the catch handler itself */ });
        }
        return true;

      case "/marathon": {
        // v0.8.1 P8-A: inline marathon mode. `/marathon <goal>` activates;
        // `/marathon off` deactivates; `/marathon status` shows snapshot.
        const sub = arg.split(/\s+/)[0]?.toLowerCase();
        if (sub === "off" || sub === "stop") {
          const final = engineRef.current.exitMarathonMode("user_off");
          setMarathonActive(false);
          if (final) {
            addMessage({
              role: "system",
              content: `Marathon mode OFF.\n  decisions: ${final.decisionCount}\n  runtime: ${Math.round(final.runtimeMs / 1000)}s\n  last phase: ${final.currentPhase}`,
            });
          } else {
            addMessage({ role: "system", content: "Marathon was not active." });
          }
          return true;
        }
        if (sub === "status") {
          if (!engineRef.current.isMarathonActive()) {
            addMessage({ role: "system", content: "Marathon mode is OFF." });
            return true;
          }
          const s = engineRef.current.marathonDriver.getStatus();
          const lines = [
            `Marathon mode ON`,
            `  goal: ${s.goal.slice(0, 100)}${s.goal.length > 100 ? "..." : ""}`,
            `  language: ${s.language}`,
            `  started: ${s.startedAt}  (${Math.round(s.runtimeMs / 60000)} min ago)`,
            `  current_phase: ${s.currentPhase}`,
            `  turns this phase: ${s.turnsThisPhase}`,
            `  total decisions: ${s.decisionCount}`,
          ];
          if (s.recentDecisions?.length) {
            lines.push(`  recent decisions:`);
            for (const d of s.recentDecisions.slice(-3)) {
              lines.push(`    ${d.ts.slice(11, 19)} [${d.template}] ${d.reason}`);
            }
          }
          addMessage({ role: "system", content: lines.join("\n") });
          return true;
        }
        // `/marathon <goal>` — activate
        if (!arg) {
          addMessage({
            role: "system",
            content:
              "Usage:\n" +
              "  /marathon <goal description>   Activate marathon mode with the given goal\n" +
              "  /marathon off                  Deactivate (return to interactive)\n" +
              "  /marathon status               Show current driver state\n\n" +
              "Marathon mode chains turns automatically using templated continuation prompts.\n" +
              "F5 strict one-phase-per-prompt is bypassed while active. /resume after a crash\n" +
              "does NOT auto-restore marathon — re-type /marathon to re-engage.",
          });
          return true;
        }
        try {
          const status = engineRef.current.enterMarathonMode(arg);
          setMarathonActive(true);
          addMessage({
            role: "system",
            content:
              `🏃 Marathon mode ON.\n` +
              `  goal: ${arg.slice(0, 200)}${arg.length > 200 ? "..." : ""}\n` +
              `  language: ${status.language}\n` +
              `  stop conditions: ${Math.round(status.maxWallclockMs / 3600000)}h wall-clock OR 5 turns settled in finalization\n\n` +
              `Next turn will use the marathon initial prompt. Type /marathon off to disengage.`,
          });
          // Immediately trigger a turn with the initial prompt
          const initialPrompt = engineRef.current.marathonDriver.getInitialPrompt();
          // Hand the initial prompt to the same runTurn path as a user message
          runTurn(initialPrompt);
        } catch (e) {
          addMessage({ role: "system", content: `Marathon activation failed: ${e.message}` });
        }
        return true;
      }

      case "/exit":
      case "/quit":
        // Save state + stop diagnostics before exit
        try { engineRef.current.saveState(); } catch { /* ignore */ }
        try { engineRef.current.stop(); } catch { /* ignore */ }
        exit();
        // v0.6.3.1: force-exit after a brief grace window. Ink's exit()
        // unmounts the TUI but in-flight LLM streams / subagent fetches
        // / unflushed appendFileSync handles can keep the Node event loop
        // alive indefinitely on long sessions. The 500ms gives saveState
        // and any synchronous flushes time to complete; after that we
        // hard-exit so the user's terminal returns to the shell promptly.
        setTimeout(() => process.exit(0), 500).unref();
        return true;

      default:
        return false;
    }
  }, [addMessage, config, exit, updateContextStats]);

  const [queueSize, setQueueSize] = useState(0); // F2: count for TUI indicator

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
      setQueueSize(queueRef.current.length); // F2
      addMessage({
        role: "system",
        content: `⏳ Queued (${queueRef.current.length} waiting). Will be sent to KC on next turn boundary.`,
      });
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

  // F6: /meme overlay short-circuits the rest of the UI until dismissed.
  // Its own useInput handler owns ESC / Enter while it's up.
  if (showMeme) {
    return h(MemeOverlay, { onDismiss: () => setShowMeme(false) });
  }

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
    // F2: Input stays active during streaming. Submissions while the
    // agent is busy get queued (handleSubmit checks streamingRef) and
    // flushed at the next natural turn boundary. Matches Claude Code's
    // type-ahead behavior.
    h(InputPrompt, {
      value: inputValue,
      onChange: setInputValue,
      onSubmit: handleSubmit,
      isActive: true,
      placeholderRight: queueSize > 0 ? `(${queueSize} queued)` : null,
    }),
    h(HRule),
    h(StatusBar, { sessionId, phase, contextTokens, contextLimit, marathonActive }),
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
  //
  // v0.6.3.1: handler must terminate. Pre-fix it only saved + returned, which
  // overrides Node's default SIGINT behavior — the process kept running with
  // active LLM streams / subagent fetches keeping the event loop alive, and
  // mashing ^C did nothing visible. Now: first ^C saves and tries clean exit
  // after 500ms; second ^C hard-kills with no further saves.
  let interruptCount = 0;
  const saveOnExit = () => {
    interruptCount++;
    if (interruptCount >= 2) {
      // Second interrupt — user wants out NOW
      process.stderr.write("\nForce-exiting (second interrupt).\n");
      process.exit(130); // 128 + SIGINT
    }
    try { engine.saveState(); } catch { /* ignore */ }
    try { engine.stop(); } catch { /* ignore */ }
    process.stderr.write("\nReceived interrupt — saving state, then exiting in 500ms (press again to force).\n");
    setTimeout(() => process.exit(130), 500).unref();
  };
  process.on("SIGINT", saveOnExit);
  process.on("SIGTERM", saveOnExit);
  // v0.8.1 P8-B: SIGHUP coverage. E2E #11 found macOS sends signals to
  // descendant processes when a Terminal.app window closes or quits;
  // nohup masks SIGHUP but not SIGTERM, and we already cover SIGTERM.
  // Adding SIGHUP makes the kc-beta process robust against terminal
  // teardown even if it's not nohup'd. Without this, a closed terminal
  // can leave KC half-shut-down (events.jsonl flushed, but no
  // marathon_detach event, no clean session-state save).
  process.on("SIGHUP", saveOnExit);

  const instance = render(h(App, { engine, config }));
  await instance.waitUntilExit();
}
