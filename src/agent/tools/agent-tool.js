import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Spawn a sub-agent for parallel work.
 * Creates a child AgentEngine that shares workspace files (rules/, rule_skills/,
 * workflows/, etc.) but isolates its own persistence under
 * `sub_agents/<taskId>/` — its own conversation history, event log, and
 * session-state. Sub-agents inherit the parent's phase so they get the right
 * tools registered. Results arrive via files written under sub_agents/<taskId>/.
 */
export class AgentTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {(opts: {sessionId: string, subagentScope: string, initialPhase: string}) => import('../engine.js').AgentEngine} engineFactory
   * @param {() => string} getCurrentPhase  Callback returning the parent's current phase (so sub-agents get phase-appropriate tools)
   */
  constructor(workspace, engineFactory, getCurrentPhase = () => "bootstrap") {
    super();
    this._workspace = workspace;
    this._engineFactory = engineFactory;
    this._getCurrentPhase = getCurrentPhase;
    this._runningTasks = new Map();
  }

  get name() { return "agent_tool"; }
  get description() {
    return (
      "Spawn a sub-agent for an independent task. The sub-agent must own a " +
      "non-overlapping unit of work — typically per-rule or per-document — " +
      "so multiple sub-agents don't have to coordinate through shared mutable " +
      "files. Do NOT build a lock mechanism inside the sub-agent's task body; " +
      "concurrent peers + locks bottleneck and fail. The sub-agent's own " +
      "persistence (history, event log, session-state) lives under " +
      "sub_agents/<taskId>/; workspace artifacts (rules/, skills/, workflows/) " +
      "are shared. Give the sub-agent a complete, self-contained task " +
      "description — it has no conversation context."
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

    // Create child engine. Critical: pass subagentScope + initialPhase so the
    // child's persistence is isolated to sub_agents/<taskId>/ AND it has the
    // same tools registered as the parent (Bug 2 fix).
    let childEngine;
    try {
      childEngine = this._engineFactory({
        sessionId: this._workspace.sessionId,
        subagentScope: taskId,
        initialPhase: this._getCurrentPhase(),
      });
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
