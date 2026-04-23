import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BaseTool, ToolResult } from "./base.js";

// Mirrors VALID_ID in scheduler.js — alphanumeric + _- only, max 64 chars.
// Sub-agent ids are used as path components under sub_agents/, so anything
// permitting `..` or `/` is a path-traversal risk.
const VALID_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function _newAutoTaskId() {
  return `task_${crypto.randomUUID().slice(0, 8)}`;
}

const VALID_OPERATIONS = new Set(["spawn", "wait", "poll", "list", "kill"]);

/**
 * Spawn + manage sub-agents.
 *
 * Operations (B8 expansion, 2026-04-23):
 *   spawn — (default) start a new sub-agent. Fire-and-forget; status is
 *     written to sub_agents/<taskId>/status.txt. Returns the taskId
 *     immediately so callers can use wait/poll/kill later.
 *   wait — block until the sub-agent finishes (status.txt != "running")
 *     or timeout. Lets the parent confirm completion before acting on
 *     the output, rather than re-spawning a duplicate because it missed
 *     a status.txt flip (the classic Bug 9 pattern).
 *   poll — non-blocking status read. Cheap visibility.
 *   list — enumerate all sub-agents under sub_agents/ with their status,
 *     age, and running/complete flag. Makes recursive fan-out visible:
 *     a parent can see its child spawned 8 grandchildren without
 *     inferring it from scattered task_ids.
 *   kill — abort a running sub-agent via AbortController. Cooperative:
 *     the abort takes effect between LLM events, not mid-token. Does
 *     NOT SIGKILL sandbox_exec grandchildren — those exit on their own
 *     timeout. Subagent status.txt flips to "killed".
 *
 * Created for session 6304673afaa0's runaway scenario: 8 subagents
 * concurrently rewriting catalog.json with no way for the main agent
 * to stop them.
 */
export class AgentTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {(opts: {sessionId: string, subagentScope: string, initialPhase: string, abortSignal?: AbortSignal}) => import('../engine.js').AgentEngine} engineFactory
   * @param {() => string} getCurrentPhase  Callback returning the parent's current phase (so sub-agents get phase-appropriate tools)
   */
  constructor(workspace, engineFactory, getCurrentPhase = () => "bootstrap") {
    super();
    this._workspace = workspace;
    this._engineFactory = engineFactory;
    this._getCurrentPhase = getCurrentPhase;
    // Map<taskId, { promise, abortController, startedAt }>
    this._runningTasks = new Map();
  }

  get name() { return "agent_tool"; }
  get description() {
    return (
      "Spawn + manage sub-agents. operation=spawn (default) starts one; " +
      "wait/poll checks status; list enumerates all; kill aborts a runaway. " +
      "Sub-agents own non-overlapping units of work — per-rule or per-document. " +
      "Their persistence (history, events, state) lives under sub_agents/<taskId>/; " +
      "workspace artifacts (rules/, skills/, workflows/) are shared. Give the " +
      "sub-agent a complete self-contained brief — it has no conversation context. " +
      "Before re-spawning a task with a familiar id, use poll to check the existing " +
      "one's status — prevents duplicate work."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["spawn", "wait", "poll", "list", "kill"],
          description: "spawn (default) | wait | poll | list | kill",
        },
        task_description: {
          type: "string",
          description: "(spawn) Complete task description for the sub-agent. Be specific — it has no conversation context.",
        },
        task_id: {
          type: "string",
          description: "(spawn: optional, auto-generated if invalid) | (wait/poll/kill: required) alphanumeric + _- only, max 64 chars.",
        },
        timeout_ms: {
          type: "integer",
          description: "(wait) Max time to wait in milliseconds. Default 30000 (30s).",
        },
      },
    };
  }

  async execute(input) {
    const op = (input.operation || "spawn").toLowerCase();
    if (!VALID_OPERATIONS.has(op)) {
      return new ToolResult(
        `Unknown operation '${op}'. Valid: spawn, wait, poll, list, kill.`,
        true,
      );
    }
    if (op === "spawn") return this._spawn(input);
    if (op === "list") return this._list();
    if (op === "poll") return this._poll(input.task_id);
    if (op === "wait") return this._wait(input.task_id, input.timeout_ms);
    if (op === "kill") return this._kill(input.task_id);
    return new ToolResult(`Not implemented: ${op}`, true);
  }

  // ---- spawn ----

  /**
   * H3: Dispatch-completeness linter. When the task_description starts by
   * declaring it covers N items — "从以下核心法规中" / "法规1...法规2..."
   * or "items 1 through 5" — check whether the body actually lists that
   * many distinct items. Doesn't block spawn; prepends a warning to the
   * tool result so the composing LLM sees the discrepancy on the next
   * turn and can self-correct.
   *
   * Motivated by session 6304673afaa0: main agent wrote a brief titled
   * "从以下核心法规中提取" (plural) but only listed 法规1. Reg 02 was
   * silently dropped — no automation caught it until the rules were
   * already half-extracted.
   */
  _lintBriefCompleteness(taskDesc) {
    const issues = [];
    // Chinese enumerated: 法规1、法规2... / 文件1、文件2... / 任务1... etc
    const zhEnumMatches = Array.from(taskDesc.matchAll(/(?:法规|文件|任务|步骤|规则组|项目)(\d+)/g))
      .map((m) => parseInt(m[1], 10))
      .filter((n) => Number.isFinite(n));
    if (zhEnumMatches.length > 0) {
      const maxN = Math.max(...zhEnumMatches);
      const uniqueN = new Set(zhEnumMatches).size;
      if (maxN > uniqueN) {
        issues.push(
          `Brief references items up to ${maxN} but only ${uniqueN} distinct item numbers appear — ` +
          `possible dropped item (e.g. saying "法规1, 法规3" without listing 法规2).`,
        );
      }
    }
    // English enumerated: "item 1", "step 2" etc, or bullet list mismatch
    const enEnumMatches = Array.from(taskDesc.matchAll(/\b(?:item|step|task|regulation|file)\s+(\d+)/gi))
      .map((m) => parseInt(m[1], 10))
      .filter((n) => Number.isFinite(n));
    if (enEnumMatches.length > 0) {
      const maxN = Math.max(...enEnumMatches);
      const uniqueN = new Set(enEnumMatches).size;
      if (maxN > uniqueN) {
        issues.push(
          `Brief references items up to ${maxN} but only ${uniqueN} distinct item numbers appear — ` +
          `possible dropped item.`,
        );
      }
    }
    return issues;
  }

  async _spawn(input) {
    const taskDesc = input.task_description || "";
    const requestedId = (input.task_id || "").trim();
    const taskId = requestedId && VALID_TASK_ID.test(requestedId)
      ? requestedId
      : _newAutoTaskId();
    const labelOverridden = requestedId && taskId !== requestedId;

    if (!taskDesc) return new ToolResult("No task_description provided", true);

    // B8: reject re-spawn of an id that's currently alive. Prevents Bug 9
    // double-dispatch when the caller didn't poll first. Caller can kill
    // the existing one explicitly if they want to replace it.
    if (this._runningTasks.has(taskId)) {
      return new ToolResult(
        `Sub-agent '${taskId}' is still running. Use poll to check status, wait to block for completion, or kill to abort before re-spawning.`,
        true,
      );
    }

    const taskDir = path.join(this._workspace.cwd, "sub_agents", taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), taskDesc, "utf-8");
    fs.writeFileSync(path.join(taskDir, "status.txt"), "running", "utf-8");
    if (labelOverridden) {
      fs.writeFileSync(path.join(taskDir, "requested_id.txt"), requestedId, "utf-8");
    }

    const abortController = new AbortController();

    let childEngine;
    try {
      childEngine = this._engineFactory({
        sessionId: this._workspace.sessionId,
        subagentScope: taskId,
        initialPhase: this._getCurrentPhase(),
        abortSignal: abortController.signal, // forward-compatible; engine may use or ignore
      });
    } catch (e) {
      fs.writeFileSync(path.join(taskDir, "status.txt"), `failed: ${e.message}`, "utf-8");
      return new ToolResult(`Failed to create sub-agent: ${e.message}`, true);
    }

    const startedAt = Date.now();
    const taskPromise = (async () => {
      const resultEvents = [];
      try {
        for await (const event of childEngine.runTurn(taskDesc)) {
          if (abortController.signal.aborted) {
            // B8: cooperative kill check on each yielded event. Effective
            // on next event boundary; previous event was allowed to complete
            // so partial work is preserved.
            fs.writeFileSync(path.join(taskDir, "status.txt"), "killed", "utf-8");
            try {
              fs.writeFileSync(
                path.join(taskDir, "result.json"),
                JSON.stringify(resultEvents, null, 2),
                "utf-8",
              );
            } catch { /* best-effort */ }
            return;
          }
          resultEvents.push({
            type: event.type,
            text: event.text,
            name: event.name,
            output: event.output,
          });
        }

        fs.writeFileSync(
          path.join(taskDir, "result.json"),
          JSON.stringify(resultEvents, null, 2),
          "utf-8",
        );
        const textParts = resultEvents.filter((e) => e.type === "text_delta").map((e) => e.text || "");
        fs.writeFileSync(path.join(taskDir, "output.md"), textParts.join(""), "utf-8");
        fs.writeFileSync(path.join(taskDir, "status.txt"), "completed", "utf-8");
      } catch (e) {
        const status = abortController.signal.aborted ? "killed" : `failed: ${e.message}`;
        try { fs.writeFileSync(path.join(taskDir, "status.txt"), status, "utf-8"); } catch { /* ignore */ }
      } finally {
        // Clean up any lingering background work the child started.
        try { childEngine.stop?.(); } catch { /* ignore */ }
      }
    })();

    this._runningTasks.set(taskId, { promise: taskPromise, abortController, startedAt });
    taskPromise.catch(() => {}).finally(() => this._runningTasks.delete(taskId));

    // H3: linter runs on the brief we just saved. Non-blocking; warning
    // surfaces in the tool result so the LLM sees it.
    const lintWarnings = this._lintBriefCompleteness(taskDesc);

    const result = {
      task_id: taskId,
      requested_id: labelOverridden ? requestedId : undefined,
      status: "running",
      output_dir: `sub_agents/${taskId}/`,
      message: labelOverridden
        ? `Sub-agent started under sanitized id '${taskId}' (your '${requestedId}' wasn't a valid path component). Use operation=poll with task_id=${taskId} to check progress.`
        : `Sub-agent '${taskId}' started. Use operation=poll to check progress, operation=wait to block for completion, operation=kill to abort.`,
    };
    if (lintWarnings.length > 0) {
      result.brief_lint_warnings = lintWarnings;
    }
    return new ToolResult(JSON.stringify(result, null, 2));
  }

  // ---- poll ----

  _poll(taskId) {
    const id = (taskId || "").trim();
    if (!id) return new ToolResult("task_id required for poll", true);
    const info = this._readStatus(id);
    if (!info) return new ToolResult(`No sub-agent dir for task_id '${id}'`, true);
    return new ToolResult(JSON.stringify(info, null, 2));
  }

  // ---- wait ----

  async _wait(taskId, timeoutMs) {
    const id = (taskId || "").trim();
    if (!id) return new ToolResult("task_id required for wait", true);
    const entry = this._runningTasks.get(id);
    const budget = Math.max(1000, Math.min(10 * 60_000, Number(timeoutMs) || 30_000));

    if (entry) {
      const timeoutP = new Promise((resolve) => setTimeout(() => resolve("timeout"), budget));
      const result = await Promise.race([entry.promise.then(() => "done", () => "done"), timeoutP]);
      if (result === "timeout") {
        const info = this._readStatus(id);
        return new ToolResult(
          `Timeout after ${budget}ms waiting for '${id}'. Current status: ${info?.status || "unknown"}. Task still running — poll again or kill.`,
          false,
        );
      }
    }

    const info = this._readStatus(id);
    if (!info) return new ToolResult(`No sub-agent dir for task_id '${id}'`, true);
    return new ToolResult(JSON.stringify(info, null, 2));
  }

  // ---- kill ----

  _kill(taskId) {
    const id = (taskId || "").trim();
    if (!id) return new ToolResult("task_id required for kill", true);
    const entry = this._runningTasks.get(id);
    if (!entry) {
      const info = this._readStatus(id);
      if (info && info.status === "running") {
        // Dir says running but not in _runningTasks — orphan from a previous
        // process. Mark the file as killed so downstream readers see the
        // truth. Nothing to abort at the JS level.
        try { fs.writeFileSync(path.join(this._workspace.cwd, "sub_agents", id, "status.txt"), "killed", "utf-8"); } catch { /* ignore */ }
        return new ToolResult(`No in-process handle for '${id}'; marked status.txt as killed (was orphan from a prior process).`);
      }
      return new ToolResult(`No running sub-agent with task_id '${id}' (already completed or never spawned).`, true);
    }
    entry.abortController.abort();
    return new ToolResult(
      `Kill signal sent to '${id}'. Cooperative abort — takes effect on the next event boundary. Poll or wait to confirm.`,
    );
  }

  // ---- list ----

  _list() {
    const baseDir = path.join(this._workspace.cwd, "sub_agents");
    if (!fs.existsSync(baseDir)) {
      return new ToolResult("No sub-agents have been spawned yet.");
    }
    let entries;
    try { entries = fs.readdirSync(baseDir); }
    catch { return new ToolResult("sub_agents/ not readable", true); }

    const rows = [];
    for (const name of entries.sort()) {
      const info = this._readStatus(name);
      if (!info) continue;
      const inProcess = this._runningTasks.has(name);
      rows.push({
        task_id: name,
        status: info.status,
        in_process_handle: inProcess, // true → kill will abort; false → orphan
        started_ago_s: info.age_s,
        last_activity_s: info.idle_s,
      });
    }
    if (rows.length === 0) return new ToolResult("No sub-agents found.");

    const active = rows.filter((r) => r.status === "running").length;
    const summary = `${rows.length} sub-agent(s) (${active} running)`;
    return new ToolResult(`${summary}\n\n${JSON.stringify(rows, null, 2)}`);
  }

  // ---- helpers ----

  _readStatus(taskId) {
    const dir = path.join(this._workspace.cwd, "sub_agents", taskId);
    if (!fs.existsSync(dir)) return null;
    const statusPath = path.join(dir, "status.txt");
    let status = "unknown";
    let mtimeMs = 0;
    let ageSec = 0;
    let idleSec = 0;
    try {
      if (fs.existsSync(statusPath)) {
        status = fs.readFileSync(statusPath, "utf-8").trim();
        mtimeMs = fs.statSync(statusPath).mtimeMs;
      }
    } catch { /* ignore */ }
    try {
      const dirStat = fs.statSync(dir);
      ageSec = Math.round((Date.now() - dirStat.ctimeMs) / 1000);
      idleSec = mtimeMs ? Math.round((Date.now() - mtimeMs) / 1000) : ageSec;
    } catch { /* ignore */ }
    return { task_id: taskId, status, age_s: ageSec, idle_s: idleSec, dir: `sub_agents/${taskId}/` };
  }

  /**
   * B8: List currently-running sub-agents. Called by engine's phase-advance
   * path to emit a `stale_subagents` pipeline event — the main agent's next
   * turn sees the list and decides whether to kill each. Soft signal, not
   * an automated kill, because phase_advance can fire from _maybeAutoAdvance
   * unexpectedly and coupling the lifecycle would amplify blast radius.
   */
  getRunningTaskIds() {
    return Array.from(this._runningTasks.keys());
  }
}
