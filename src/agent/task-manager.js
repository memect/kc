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

  /** Re-point at a new tasks.json. Used by `engine.renameSession()` (Bug 3). */
  _setWorkspacePath(newWorkspacePath) {
    this._path = path.join(newWorkspacePath, "tasks.json");
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
   * Get the next pending task (read-only). For serial-mode callers.
   * Parallel workers MUST use claimNextPending() to avoid racing.
   * @returns {object|null}
   */
  getNextPending() {
    return this._tasks.find((t) => t.status === "pending") || null;
  }

  /**
   * B2: Atomically claim the next pending task — flips status to
   * "in_progress" and records the worker. Single-threaded JavaScript
   * means this is race-free WITHOUT a filesystem lock as long as neither
   * the find nor the status mutation awaits, because the event loop
   * won't interleave another worker's call between them. If we ever
   * move TaskManager to share state across processes (unlikely; each
   * session has its own file), wrap with workspace.withFileLock.
   *
   * @param {string} [workerLabel] - optional identifier for the claimer,
   *   stored on the task for debugging + the TUI taskboard.
   * @returns {object|null} The claimed task, or null if none pending.
   */
  claimNextPending(workerLabel) {
    const task = this._tasks.find((t) => t.status === "pending");
    if (!task) return null;
    task.status = "in_progress";
    task.startedAt = new Date().toISOString();
    if (workerLabel) task.worker = String(workerLabel);
    this.save();
    return task;
  }

  /**
   * B2: Mark a previously-claimed task as done. Pass an optional
   * summary for the taskboard / display. Worker label is cleared since
   * the task has left in_progress state.
   */
  markDone(id, summary) {
    const task = this._tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    if (summary !== undefined) task.summary = summary;
    delete task.worker;
    this.save();
  }

  /**
   * B2: Mark a claimed task as failed. Preserves the worker label so
   * post-mortems can trace which slot crashed.
   */
  markFailed(id, errorMessage) {
    const task = this._tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = "failed";
    task.completedAt = new Date().toISOString();
    if (errorMessage) task.summary = String(errorMessage).slice(0, 500);
    this.save();
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
   * Phases where the engine auto-creates one-task-per-rule on phase entry.
   *
   * v0.7.0 B2: empty by default. Agent owns TaskBoard decisions per the
   * work-decomposition meta-meta skill — engine no longer assumes per-rule
   * granularity is right. The agent reads the rule list from describeState
   * and calls TaskCreate with whatever shape (single, grouped, range,
   * non-rule) makes sense for the corpus.
   *
   * Override `KC_AGENT_OWNS_TASKBOARD=0` to restore v0.6.x behavior
   * (engine auto-populates per-rule for skill_authoring + skill_testing).
   * The override is a staged-rollout safety valve, not a long-lived
   * config — slated for removal in v0.8.0 after E2E #6 validates the
   * agent-owned default.
   */
  static PER_RULE_PHASES = (process.env.KC_AGENT_OWNS_TASKBOARD === "0")
    ? new Set(["skill_authoring", "skill_testing"])
    : new Set();

  /**
   * Create one task per rule for a given phase — but only if the phase's unit
   * of work is actually a rule. For other phases this is a no-op, and any
   * per-regulation tasks are created separately at session init.
   *
   * @param {Array<{id: string, title?: string, description?: string}>} rules
   * @param {string} phase - The phase these tasks belong to
   */
  createRuleTasks(rules, phase) {
    if (!TaskManager.PER_RULE_PHASES.has(phase)) return;
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
   * v0.6.1 A2: Phase-scoped task count. Used by SkillAuthoringPipeline's
   * exitCriteriaMet to gate phase advance on TaskManager parity, not just
   * filename-regex coverage. Pass a status to filter; omit for total.
   *
   * @param {string} phase - Phase name (e.g., "skill_authoring")
   * @param {string|null} [status] - Optional status filter ("completed", "pending", etc.)
   * @returns {number}
   */
  countByPhase(phase, status = null) {
    return this._tasks.filter(
      (t) => t.phase === phase && (status == null || t.status === status),
    ).length;
  }

  /**
   * v0.7.0 A5: Reconcile per-rule tasks against disk artifacts.
   *
   * Background: E2E #5 DS audit found tasks.json showing 70/70 completed
   * while only ~56 dirs / 36 with check_*.py existed on disk. The agent
   * called markDone() optimistically but the artifacts didn't materialize
   * (or were deleted later). The engine's phase gate trusted the count.
   *
   * Reconcile walks every "completed" task in PER_RULE_PHASES and checks
   * whether the expected disk artifacts exist via a caller-supplied
   * `expectsFn(task) -> boolean` predicate. Tasks whose artifacts are
   * missing are flipped back to `pending` with a `reconcile_failed`
   * note so the agent can re-do the work, and the gate can refuse
   * advance if the per-rule artifact set is incomplete.
   *
   * Called from engine `_advancePhase` before `exitCriteriaMet()`.
   *
   * @param {(task: object) => boolean} expectsFn
   * @returns {{ reconciled: number, flippedBack: string[] }}
   *   Number of tasks inspected, plus the IDs of tasks flipped back to
   *   pending. Caller logs to events.jsonl.
   */
  reconcileAgainstDisk(expectsFn) {
    let reconciled = 0;
    const flippedBack = [];
    if (typeof expectsFn !== "function") return { reconciled, flippedBack };
    for (const task of this._tasks) {
      if (task.status !== "completed") continue;
      if (!TaskManager.PER_RULE_PHASES.has(task.phase)) continue;
      reconciled++;
      let ok = false;
      try { ok = !!expectsFn(task); }
      catch { ok = false; }
      if (!ok) {
        task.status = "pending";
        task.reconcile_failed = true;
        task.summary = (task.summary ? task.summary + " | " : "") +
          "v0.7.0 A5: artifacts missing on disk → flipped back to pending";
        flippedBack.push(task.id);
      }
    }
    if (flippedBack.length > 0) this.save();
    return { reconciled, flippedBack };
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
