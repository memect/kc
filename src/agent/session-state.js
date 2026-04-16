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
   */
  constructor(workspacePath) {
    this._path = path.join(workspacePath, "session-state.json");
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

    fs.writeFileSync(this._path, JSON.stringify(state, null, 2), "utf-8");
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
