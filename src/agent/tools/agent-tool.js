import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Spawn a sub-agent for parallel work.
 * Creates a child AgentEngine sharing the workspace filesystem
 * but with independent conversation history.
 * Results arrive via workspace files.
 */
export class AgentTool extends BaseTool {
  constructor(workspace, engineFactory) {
    super();
    this._workspace = workspace;
    this._engineFactory = engineFactory;
    this._runningTasks = new Map();
  }

  get name() { return "agent_tool"; }
  get description() {
    return (
      "Spawn a sub-agent for an independent task. Give it a complete, " +
      "self-contained task description. The sub-agent works in the same " +
      "workspace and writes results to files. Use this for parallel rule " +
      "processing, batch testing, or any work that can run independently."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        task_description: {
          type: "string",
          description: "Complete task description for the sub-agent. Be specific — it has no conversation context.",
        },
        task_id: { type: "string", description: "Optional task identifier (auto-generated if omitted)" },
      },
      required: ["task_description"],
    };
  }

  async execute(input) {
    const taskDesc = input.task_description || "";
    const taskId = input.task_id || `task_${crypto.randomUUID().slice(0, 8)}`;

    if (!taskDesc) return new ToolResult("No task_description provided", true);

    // Create sub-agent output directory
    const taskDir = path.join(this._workspace.cwd, "sub_agents", taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), taskDesc, "utf-8");

    // Create child engine sharing the same workspace
    let childEngine;
    try {
      childEngine = this._engineFactory(this._workspace.sessionId);
    } catch (e) {
      return new ToolResult(`Failed to create sub-agent: ${e.message}`, true);
    }

    // Run the sub-agent asynchronously (fire and forget)
    const taskPromise = (async () => {
      const resultEvents = [];
      try {
        for await (const event of childEngine.runTurn(taskDesc)) {
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
        fs.writeFileSync(path.join(taskDir, "status.txt"), `failed: ${e.message}`, "utf-8");
      }
    })();

    this._runningTasks.set(taskId, taskPromise);
    taskPromise.catch(() => {}).finally(() => this._runningTasks.delete(taskId));

    return new ToolResult(JSON.stringify({
      task_id: taskId,
      status: "started",
      output_dir: `sub_agents/${taskId}/`,
      message: `Sub-agent started. Check sub_agents/${taskId}/status.txt for completion, output.md for text.`,
    }, null, 2));
  }
}
