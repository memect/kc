import fs from "node:fs";
import path from "node:path";

/**
 * Persists session state (phase, pipeline milestones, phase summaries)
 * to enable cross-session resume.
 *
 * Stored as: workspace/{sessionId}/session-state.json
 */
export class SessionState {
  /**
   * @param {string} workspacePath - Session workspace directory
   * @param {object} [opts]
   * @param {string} [opts.statePath] - Override absolute path (used for sub-agent isolation, Bug 2)
   * @param {Workspace} [opts.workspace] - v0.6.2 J3: optional workspace ref so
   *   save() can acquire a sync file lock on session-state.json. Without it
   *   (subagents, tests), save() falls back to lock-free writes — same
   *   behavior as pre-v0.6.2.
   */
  constructor(workspacePath, opts = {}) {
    this._path = opts.statePath || path.join(workspacePath, "session-state.json");
    this._workspace = opts.workspace || null;
  }

  /**
   * Re-point at a new state file. Used by `engine.renameSession()` (Bug 3).
   */
  _setWorkspacePath(newWorkspacePath, opts = {}) {
    this._path = opts.statePath || path.join(newWorkspacePath, "session-state.json");
  }

  /** Whether a session state file exists */
  get exists() {
    return fs.existsSync(this._path);
  }

  /**
   * Save engine state to disk.
   * @param {import('./engine.js').AgentEngine} engine
   */
  save(engine) {
    const state = {
      version: 1,
      sessionId: engine.workspace.sessionId,
      currentPhase: engine.currentPhase,
      projectDir: engine.workspace.projectDir || null,
      phaseSummaries: engine._phaseSummaries || [],
      lastEventSeq: engine.eventLog?.currentSeq || 0,
      createdAt: this._loadRaw()?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pipelineMilestones: this._extractMilestones(engine.pipelines),
    };

    // v0.6.2 J3: acquire sync file lock if workspace ref available.
    // session-state.json is in SHARED_COORDINATION_PATHS — concurrent
    // writers (parallel ralph-loop workers + main saveState ticks)
    // could otherwise interleave and corrupt the JSON.
    const write = () => {
      fs.writeFileSync(this._path, JSON.stringify(state, null, 2), "utf-8");
    };
    if (this._workspace?.withSyncFileLock) {
      this._workspace.withSyncFileLock("session-state.json", write);
    } else {
      write();
    }
  }

  /**
   * Load session state from disk.
   * @returns {object} The persisted state
   */
  load() {
    return this._loadRaw() || {};
  }

  /**
   * Read raw file contents.
   */
  _loadRaw() {
    if (!this.exists) return null;
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Serialize pipeline milestones for persistence.
   * @param {object} pipelines - Map of phase -> pipeline instance
   * @returns {object}
   */
  _extractMilestones(pipelines) {
    const milestones = {};
    for (const [phase, pipeline] of Object.entries(pipelines)) {
      if (pipeline?.exportState) {
        try {
          milestones[phase] = pipeline.exportState();
        } catch { /* skip if not implemented */ }
      }
    }
    return milestones;
  }
}
