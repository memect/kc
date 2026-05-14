import { spawn } from "node:child_process";
import { BaseTool, ToolResult } from "./base.js";
import { SHARED_COORDINATION_PATHS } from "../workspace.js";

const MAX_OUTPUT = 10_000;

// H6: detect sandbox_exec commands that touch shared coordination files.
// Doesn't block — just prepends a warning to the tool result. In session
// 6304673afaa0 we observed 8+ subagents doing `cat catalog.json | python`
// and `json.dump()` to overwrite catalog.json directly, racing each other
// because sandbox_exec bypasses the workspace-file lock (B9). The warning
// nudges the LLM toward workspace_file / rule_catalog which ARE lock-safe.
function detectSharedFileWrites(command) {
  if (!command) return [];
  const hits = new Set();
  for (const shared of SHARED_COORDINATION_PATHS) {
    // Match both bare and quoted forms (e.g. rules/catalog.json or "rules/catalog.json")
    const re = new RegExp(shared.replace(/\//g, "\\/").replace(/\./g, "\\."));
    if (re.test(command)) hits.add(shared);
  }
  return Array.from(hits);
}

/**
 * Execute shell commands in the workspace directory.
 * Uses child_process.spawn so pipes, redirects, && all work.
 * Output (stdout + stderr combined) is capped at 10K chars.
 *
 * v0.8 P1-F timeout model:
 *   - Default: KC_EXEC_DEFAULT_TIMEOUT_MS (env) or 120000ms (2 min)
 *   - Hard cap: KC_EXEC_MAX_TIMEOUT_MS (env) or 600000ms (10 min)
 *   - Per-call `timeout_ms` overrides default, clamped to [1000, max]
 *   - Legacy `KC_EXEC_TIMEOUT` (seconds) still accepted as a deprecation
 *     alias for the default; emits a warning to stderr on first read.
 */
export class SandboxExecTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {object|number} [opts] — either a config object (new) OR
   *   a number meaning the legacy timeout-in-seconds (old). The number
   *   form is preserved for callers that haven't been updated yet.
   * @param {number} [opts.defaultTimeoutMs] — default 120000
   * @param {number} [opts.maxTimeoutMs] — default 600000
   */
  constructor(workspace, opts = {}) {
    super();
    this._workspace = workspace;

    // Legacy: opts is a bare number = seconds. Convert to ms.
    if (typeof opts === "number") {
      this._defaultTimeoutMs = opts * 1000;
      this._maxTimeoutMs = Math.max(this._defaultTimeoutMs, 600_000);
    } else {
      this._defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
      this._maxTimeoutMs = opts.maxTimeoutMs ?? 600_000;
    }
    // Floor: keep at least 1s. Cap: max can't be below default.
    this._defaultTimeoutMs = Math.max(1000, this._defaultTimeoutMs);
    this._maxTimeoutMs = Math.max(this._defaultTimeoutMs, this._maxTimeoutMs);
  }

  get name() { return "sandbox_exec"; }

  get description() {
    return (
      "Execute a shell command. " +
      "cwd='workspace' (default) runs in KC's workspace. " +
      "cwd='project' runs in the user's project directory. " +
      "Pipes, redirects, and chained commands (&&) are supported. " +
      "stdout + stderr combined are capped at 10,000 chars; longer output is truncated. " +
      "For reading individual files larger than ~10 KB (e.g. regulation documents), " +
      "prefer workspace_file (operation=read) which has a larger 50 KB cap. " +
      `Default timeout ${Math.round(this._defaultTimeoutMs / 1000)}s; pass timeout_ms ` +
      `to extend up to ${Math.round(this._maxTimeoutMs / 1000)}s for known-slow commands ` +
      `(LLM batch processing, document parsing, large regression runs).`
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (e.g. 'python script.py', 'ls -la')",
        },
        cwd: {
          type: "string",
          enum: ["workspace", "project"],
          description: "Working directory. 'workspace' (default) = KC's workspace. 'project' = user's project directory.",
        },
        timeout_ms: {
          type: "integer",
          description: `Optional per-call timeout in milliseconds. Default ${this._defaultTimeoutMs}ms; clamped to [1000, ${this._maxTimeoutMs}]. Pass for commands you expect to take longer than the default (LLM batches, parsing, regressions).`,
        },
      },
      required: ["command"],
    };
  }

  async execute(input) {
    const command = input.command || "";
    const cwdScope = input.cwd || "workspace";
    if (!command.trim()) {
      return new ToolResult("No command provided", true);
    }

    // v0.8 P1-F: per-call timeout clamping
    let effectiveTimeoutMs = this._defaultTimeoutMs;
    let clampedMessage = null;
    if (Number.isFinite(input.timeout_ms) && input.timeout_ms > 0) {
      const requested = Math.floor(input.timeout_ms);
      if (requested < 1000) {
        effectiveTimeoutMs = 1000;
        clampedMessage = `timeout_ms=${requested} below 1000ms floor; using 1000ms.`;
      } else if (requested > this._maxTimeoutMs) {
        effectiveTimeoutMs = this._maxTimeoutMs;
        clampedMessage = `timeout_ms=${requested} above ${this._maxTimeoutMs}ms ceiling; clamped to ${this._maxTimeoutMs}ms.`;
      } else {
        effectiveTimeoutMs = requested;
      }
    }

    const effectiveCwd = (cwdScope === "project" && this._workspace.projectDir)
      ? this._workspace.projectDir
      : this._workspace.cwd;

    // H6: warn before the command runs when it touches shared files. The
    // warning becomes part of the tool result so the LLM sees it on every
    // subsequent call and self-corrects toward workspace_file / rule_catalog.
    const sharedHits = detectSharedFileWrites(command);

    try {
      const { output, code } = await this._run(command, effectiveCwd, effectiveTimeoutMs);
      let result = output;
      if (result.length > MAX_OUTPUT) {
        result = result.slice(0, MAX_OUTPUT) + "\n[truncated]";
      }
      if (code !== 0) {
        result += `\n[exit code: ${code}]`;
      }
      if (sharedHits.length > 0) {
        const prefix =
          `⚠️  This command touches shared coordination file(s): ${sharedHits.join(", ")}.\n` +
          `   sandbox_exec writes bypass workspace file locking (B9).\n` +
          `   Under concurrent subagents this races — use workspace_file or rule_catalog instead.\n\n`;
        result = prefix + result;
      }
      if (clampedMessage) {
        result = `[note] ${clampedMessage}\n\n` + result;
      }
      return new ToolResult(result, code !== 0);
    } catch (err) {
      if (err.message === "timeout") {
        const seconds = Math.round(effectiveTimeoutMs / 1000);
        const hint = effectiveTimeoutMs < this._maxTimeoutMs
          ? ` Pass timeout_ms (up to ${this._maxTimeoutMs}) for known-slow commands.`
          : ` Already at max timeout (${this._maxTimeoutMs}ms); consider splitting the command into smaller batches or running it via a subagent.`;
        return new ToolResult(
          `Command timed out after ${seconds}s (${effectiveTimeoutMs}ms).${hint}`,
          true,
        );
      }
      return new ToolResult(`Execution error: ${err.message}`, true);
    }
  }

  /**
   * @param {string} command
   * @param {string} cwd
   * @param {number} timeoutMs
   * @returns {Promise<{output: string, code: number}>}
   */
  _run(command, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const proc = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });

      let output = "";
      proc.stdout.on("data", (d) => { output += d.toString(); });
      proc.stderr.on("data", (d) => { output += d.toString(); });

      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ output, code: code ?? 1 });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (err.name === "AbortError") {
          reject(new Error("timeout"));
        } else {
          reject(err);
        }
      });
    });
  }
}
