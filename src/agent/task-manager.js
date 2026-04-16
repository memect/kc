import fs from "node:fs";
import path from "node:path";

/**
 * Manages a per-session task list for ralph-loop style autonomous execution.
 * Tasks are generated from KC's rule catalog — each rule becomes a task.
 * Persisted to workspace/tasks.json.
 */
export class TaskManager {
  /**
   * @param {string} workspacePath - Session workspace directory
   */
  constructor(workspacePath) {
    this._path = path.join(workspacePath, "tasks.json");
    this._tasks = [];
    this._load();
  }

  // --- Task CRUD ---

  /**
   * Add a task to the list.
   * @param {{ id: string, title: string, phase: string, ruleId?: string }} task
   */
  addTask({ id, title, phase, ruleId }) {
    // Don't add duplicates
    if (this._tasks.find((t) => t.id === id)) return;
    this._tasks.push({
      id,
      title,
      phase,
      ruleId: ruleId || null,
      status: "pending",
      summary: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    this.save();
  }

  /**
   * Update a task's status and optional summary.
   * @param {string} id
   * @param {{ status?: string, summary?: string }} updates
   */
  updateTask(id, { status, summary } = {}) {
    const task = this._tasks.find((t) => t.id === id);
    if (!task) return;
    if (status) {
      task.status = status;
      if (status === "completed" || status === "failed") {
        task.completedAt = new Date().toISOString();
      }
    }
    if (summary !== undefined) task.summary = summary;
    this.save();
  }

  /**
   * Get the next pending task.
   * @returns {object|null}
   */
  getNextPending() {
    return this._tasks.find((t) => t.status === "pending") || null;
  }

  /**
   * Get all tasks.
   * @returns {Array}
   */
  getAllTasks() {
    return [...this._tasks];
  }

  /**
   * Check if there are any tasks at all.
   */
  get hasTasks() {
    return this._tasks.length > 0;
  }

  // --- Bulk creation from rule catalog ---

  /**
   * Create one task per rule for a given phase.
   * Reads rules from the provided array (typically from rules/catalog.json).
   * @param {Array<{id: string, title?: string, description?: string}>} rules
   * @param {string} phase - The phase these tasks belong to
   */
  createRuleTasks(rules, phase) {
    for (const rule of rules) {
      const ruleId = rule.id || rule.rule_id;
      const title = rule.title || rule.description || ruleId;
      this.addTask({
        id: `${ruleId}-${phase}`,
        title: `${title}`,
        phase,
        ruleId,
      });
    }
  }

  // --- Progress ---

  /**
   * @returns {{ total: number, completed: number, inProgress: number, pending: number, failed: number }}
   */
  get progress() {
    const total = this._tasks.length;
    const completed = this._tasks.filter((t) => t.status === "completed").length;
    const inProgress = this._tasks.filter((t) => t.status === "in_progress").length;
    const failed = this._tasks.filter((t) => t.status === "failed").length;
    const pending = this._tasks.filter((t) => t.status === "pending").length;
    return { total, completed, inProgress, pending, failed };
  }

  /**
   * Format task list for injection into system prompt context.
   * Compact checklist — not conversation history.
   * @returns {string}
   */
  describeForContext() {
    if (this._tasks.length === 0) return "";

    const { total, completed, inProgress } = this.progress;
    const current = this._tasks.find((t) => t.status === "in_progress");
    const currentPhase = current?.phase || this._tasks.find((t) => t.status === "pending")?.phase || "";

    const lines = [
      `## Task Progress`,
      `${completed}/${total} completed${currentPhase ? ` | Phase: ${currentPhase}` : ""}${current ? ` | Current: ${current.ruleId} — ${current.title}` : ""}`,
      "",
    ];

    for (const t of this._tasks) {
      const mark = t.status === "completed" ? "[x]"
        : t.status === "in_progress" ? "[>]"
        : t.status === "failed" ? "[!]"
        : "[ ]";
      const arrow = t.status === "in_progress" ? " <-- current" : "";
      lines.push(`- ${mark} ${t.ruleId || t.id}: ${t.title}${arrow}`);
    }

    return lines.join("\n");
  }

  /**
   * Format for /tasks slash command (more detailed than context injection).
   * @returns {string}
   */
  formatForDisplay() {
    if (this._tasks.length === 0) return "No tasks. Tasks are created when rules are extracted.";

    const { total, completed, pending, failed } = this.progress;
    const lines = [
      `Tasks: ${completed}/${total} completed${failed ? `, ${failed} failed` : ""}, ${pending} pending`,
      "",
    ];

    for (const t of this._tasks) {
      const icon = t.status === "completed" ? "✓"
        : t.status === "in_progress" ? "▸"
        : t.status === "failed" ? "✗"
        : "·";
      lines.push(`  ${icon} ${t.ruleId || t.id}  ${t.title}  (${t.status})`);
    }

    return lines.join("\n");
  }

  // --- Persistence ---

  save() {
    fs.writeFileSync(this._path, JSON.stringify(this._tasks, null, 2), "utf-8");
  }

  _load() {
    if (fs.existsSync(this._path)) {
      try {
        this._tasks = JSON.parse(fs.readFileSync(this._path, "utf-8"));
      } catch {
        this._tasks = [];
      }
    }
  }
}
