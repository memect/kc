import { spawn } from "node:child_process";
import { BaseTool, ToolResult } from "./base.js";

const MAX_OUTPUT = 10_000;

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

    try {
      const { output, code } = await this._run(command, effectiveCwd);
      let result = output;
      if (result.length > MAX_OUTPUT) {
        result = result.slice(0, MAX_OUTPUT) + "\n[truncated]";
      }
      if (code !== 0) {
        result += `\n[exit code: ${code}]`;
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
