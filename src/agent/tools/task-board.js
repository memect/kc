import { BaseTool, ToolResult } from "./base.js";

const TASKS_REL = "tasks.json";

/**
 * v0.7.3 — TaskCreate / TaskUpdate / TaskComplete tools.
 *
 * Completes the v0.7.0 "agent owns TaskBoard" design. The engine no longer
 * auto-populates per-rule tasks on phase entry (PER_RULE_PHASES is empty by
 * default — see task-manager.js); the agent reads the rule list via
 * describeState, picks a decomposition (single / grouped / range / non-rule),
 * and calls these tools to populate tasks.json. The Ralph loop in
 * AgentEngine._runTaskLoopSerial then walks pending tasks one at a time.
 *
 * Skill teaching for these tools lives in
 * template/skills/{en,zh}/meta-meta/work-decomposition/SKILL.md.
 *
 * tasks.json is a shared-coordination path (workspace.js
 * SHARED_COORDINATION_PATHS) — every write goes through
 * withSharedLockIfApplicable so two writers (main + subagent) serialize.
 */

export class TaskCreateTool extends BaseTool {
  constructor(workspace, taskManager) {
    super();
    this._workspace = workspace;
    this._taskManager = taskManager;
  }

  get name() { return "TaskCreate"; }

  get description() {
    return (
      "Add a task to the session task board. Tasks gate the Ralph loop — " +
      "after the current turn ends, the engine pulls the next pending task " +
      "and runs it. Use one task per unit of work you want to iterate on " +
      "(per-rule, per-group, per-document — your decomposition). " +
      "Call this on phase entry after reading describeState."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique task ID within this session (e.g. 'R001-skill_authoring' or 'group-trust-1').",
        },
        title: {
          type: "string",
          description: "Short human-readable title for the task.",
        },
        phase: {
          type: "string",
          description: "Phase this task belongs to (e.g. 'skill_authoring', 'skill_testing', 'distillation').",
        },
        ruleId: {
          type: "string",
          description: "Optional rule_id if this is a per-rule task. Omit for grouped or non-rule tasks.",
        },
      },
      required: ["id", "title", "phase"],
    };
  }

  async execute(input) {
    const id = input.id || "";
    const title = input.title || "";
    const phase = input.phase || "";
    const ruleId = input.ruleId || null;

    if (!id) return new ToolResult("id required", true);
    if (!title) return new ToolResult("title required", true);
    if (!phase) return new ToolResult("phase required", true);

    return await this._workspace.withSharedLockIfApplicable(TASKS_REL, () => {
      const before = this._taskManager.getAllTasks().some((t) => t.id === id);
      this._taskManager.addTask({ id, title, phase, ruleId });
      if (before) {
        return new ToolResult(`Task ${id} already existed (no-op).`);
      }
      const p = this._taskManager.progress;
      return new ToolResult(
        `Task ${id} created. Board: ${p.pending} pending, ${p.inProgress} in_progress, ${p.completed} completed.`,
      );
    });
  }
}

export class TaskUpdateTool extends BaseTool {
  constructor(workspace, taskManager) {
    super();
    this._workspace = workspace;
    this._taskManager = taskManager;
  }

  get name() { return "TaskUpdate"; }

  get description() {
    return (
      "Update a task's status and optional summary. Status: 'pending', " +
      "'in_progress', 'completed', or 'failed'. Use TaskComplete instead " +
      "for the common case of marking a task done with a summary."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID to update." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
          description: "New status for the task.",
        },
        summary: {
          type: "string",
          description: "Optional short summary (e.g. why the task failed, what was produced).",
        },
      },
      required: ["id"],
    };
  }

  async execute(input) {
    const id = input.id || "";
    const status = input.status;
    const summary = input.summary;

    if (!id) return new ToolResult("id required", true);

    return await this._workspace.withSharedLockIfApplicable(TASKS_REL, () => {
      const exists = this._taskManager.getAllTasks().some((t) => t.id === id);
      if (!exists) return new ToolResult(`Task ${id} not found.`, true);
      this._taskManager.updateTask(id, { status, summary });
      const p = this._taskManager.progress;
      return new ToolResult(
        `Task ${id} updated${status ? ` to ${status}` : ""}. ` +
        `Board: ${p.pending} pending, ${p.inProgress} in_progress, ${p.completed} completed, ${p.failed} failed.`,
      );
    });
  }
}

export class TaskCompleteTool extends BaseTool {
  constructor(workspace, taskManager) {
    super();
    this._workspace = workspace;
    this._taskManager = taskManager;
  }

  get name() { return "TaskComplete"; }

  get description() {
    return (
      "Mark a task as completed with an optional summary. Sugar for " +
      "TaskUpdate({id, status: 'completed', summary}). The Ralph loop " +
      "advances to the next pending task after this returns."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID to complete." },
        summary: {
          type: "string",
          description: "Optional short summary of what was produced.",
        },
      },
      required: ["id"],
    };
  }

  async execute(input) {
    const id = input.id || "";
    const summary = input.summary;

    if (!id) return new ToolResult("id required", true);

    return await this._workspace.withSharedLockIfApplicable(TASKS_REL, () => {
      const exists = this._taskManager.getAllTasks().some((t) => t.id === id);
      if (!exists) return new ToolResult(`Task ${id} not found.`, true);
      this._taskManager.markDone(id, summary);
      const p = this._taskManager.progress;
      return new ToolResult(
        `Task ${id} completed. Board: ${p.pending} pending, ${p.inProgress} in_progress, ${p.completed} completed.`,
      );
    });
  }
}
