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
 */
export class SandboxExecTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {number} [timeout=30]
   */
  constructor(workspace, timeout = 30) {
    super();
    this._workspace = workspace;
    this._timeout = timeout;
  }

  get name() { return "sandbox_exec"; }

  get description() {
    return (
      "Execute a shell command. " +
      "cwd='workspace' (default) runs in KC's workspace. " +
      "cwd='project' runs in the user's project directory. " +
      "Pipes, redirects, and chained commands (&&) are supported."
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

    const effectiveCwd = (cwdScope === "project" && this._workspace.projectDir)
      ? this._workspace.projectDir
      : this._workspace.cwd;

    // H6: warn before the command runs when it touches shared files. The
    // warning becomes part of the tool result so the LLM sees it on every
    // subsequent call and self-corrects toward workspace_file / rule_catalog.
    const sharedHits = detectSharedFileWrites(command);

    try {
      const { output, code } = await this._run(command, effectiveCwd);
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
      return new ToolResult(result, code !== 0);
    } catch (err) {
      if (err.message === "timeout") {
        return new ToolResult(`Command timed out after ${this._timeout}s`, true);
      }
      return new ToolResult(`Execution error: ${err.message}`, true);
    }
  }

  /**
   * @param {string} command
   * @returns {Promise<{output: string, code: number}>}
   */
  _run(command, cwd) {
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
      }, this._timeout * 1000);

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
