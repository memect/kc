// v0.8.1 P8-A — marathon driver as inline state machine.
//
// v0.8.0 shipped this as a separate-process driver (bin/kc-marathon.js)
// that tailed events.jsonl + wrote prompts to .kc_marathon/inbox.jsonl.
// E2E #11 audits found both drivers died silently within 10 min when
// the terminal closed or laptop slept (SIGHUP/SIGTERM unhandled). The
// engine survived both deaths because it lives in a different process.
//
// v0.8.1 redesign per user proposal (2026-05-15):
//   - Single process: driver runs inline as part of the engine
//   - Activated via `/marathon <goal>` slash command in kc-beta TUI
//   - Engine calls decideNext(state) after each turn_complete to get
//     the next continuation prompt (or null if marathon should end)
//   - No filesystem IPC (no inbox, no active marker, no state.json)
//   - State persists via engine's existing session-state.json
//
// The state machine logic from v0.8.0 is preserved verbatim — only
// the I/O wrapper changes. Templates (renderPrompt) unchanged.

import { renderPrompt } from "./prompts.js";

const DEFAULT_STUCK_AFTER_MS = 30 * 60 * 1000;        // 30 min
const DEFAULT_MAX_WALLCLOCK_MS = 12 * 60 * 60 * 1000; // 12 h

export class MarathonDriver {
  /**
   * @param {object} opts
   * @param {string} opts.goal — the marathon goal-description prompt
   * @param {string} [opts.language] — "en" or "zh"
   * @param {number} [opts.maxWallclockMs] — stop after this much wall time
   * @param {number} [opts.stuckAfterMs] — emit unstick prompt after idle
   */
  constructor(opts = {}) {
    if (!opts.goal || typeof opts.goal !== "string") {
      throw new Error("MarathonDriver requires a non-empty `goal` string");
    }
    this.goal = opts.goal;
    this.language = opts.language === "zh" ? "zh" : "en";
    this.maxWallclockMs = opts.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS;
    this.stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;

    this.startedAt = Date.now();
    this.lastDecisionAt = 0;
    this.decisionCount = 0;
    this.currentPhase = "bootstrap";
    this.lastMilestones = {};
    this.turnsThisPhase = 0;
    this.lastEventTs = Date.now();
    this.initialDelivered = false;
    this.stopped = false;
    this.stopReason = null;

    // Decision history (kept in-memory; surfaced in /marathon status).
    // Bounded to last 100 to cap memory.
    this.decisions = [];
  }

  /**
   * Engine calls this once BEFORE the initial turn after /marathon was
   * typed. Returns the goal-description prompt to feed into runTurn.
   */
  getInitialPrompt() {
    const out = renderPrompt(
      "initial",
      this._stateSnapshot(),
      this.language,
    );
    this._recordDecision("initial", "marathon kickoff", out);
    this.initialDelivered = true;
    return out;
  }

  /**
   * Engine calls decideNext(state) after each turn_complete event.
   * Returns { prompt, template, reason } if marathon should continue,
   * or null if a stop condition is met (engine will exit marathon mode).
   *
   * @param {object} state — engine snapshot:
   *   {currentPhase, milestones, phaseChanged, errorSeen, turnsThisPhase}
   */
  decideNext(state = {}) {
    if (this.stopped) return null;

    // Update tracked state from engine
    if (state.currentPhase && state.currentPhase !== this.currentPhase) {
      this.currentPhase = state.currentPhase;
      this.turnsThisPhase = 0;
    }
    if (state.milestones) this.lastMilestones = state.milestones;
    if (typeof state.turnsThisPhase === "number") {
      this.turnsThisPhase = state.turnsThisPhase;
    } else {
      this.turnsThisPhase += 1;
    }
    this.lastEventTs = Date.now();

    // Stop conditions
    if (this._shouldStop()) {
      this.stopped = true;
      // Emit one final "stop" prompt so the agent has a chance to wrap up.
      const out = renderPrompt("stop", this._stateSnapshot(), this.language);
      this._recordDecision("stop", this.stopReason, out);
      return { prompt: out, template: "stop", reason: this.stopReason };
    }

    let template = "continue_phase";
    let reason = "turn_complete in same phase";

    if (state.errorSeen) {
      template = "unstick";
      reason = "engine emitted error event";
    } else if (state.phaseChanged) {
      if (this.currentPhase === "finalization") {
        template = "finalize";
        reason = "reached finalization";
      } else {
        template = "continue_phase";
        reason = `entered ${this.currentPhase}`;
      }
    } else {
      const idleMs = Date.now() - this.lastEventTs;
      if (idleMs > this.stuckAfterMs) {
        template = "unstick";
        reason = `idle for ${Math.round(idleMs / 60000)} min`;
      }
    }

    const out = renderPrompt(template, this._stateSnapshot(), this.language);
    this._recordDecision(template, reason, out);
    return { prompt: out, template, reason };
  }

  /** User-invoked manual stop (e.g., `/marathon off`). */
  stop(reason = "user_off") {
    this.stopped = true;
    this.stopReason = reason;
    this._recordDecision("manual_stop", reason, "");
  }

  /** Snapshot for /marathon status command + audit. */
  getStatus() {
    return {
      active: !this.stopped,
      goal: this.goal,
      language: this.language,
      startedAt: new Date(this.startedAt).toISOString(),
      runtimeMs: Date.now() - this.startedAt,
      currentPhase: this.currentPhase,
      turnsThisPhase: this.turnsThisPhase,
      decisionCount: this.decisionCount,
      lastDecisionAt: this.lastDecisionAt ? new Date(this.lastDecisionAt).toISOString() : null,
      stopReason: this.stopReason,
      maxWallclockMs: this.maxWallclockMs,
      stuckAfterMs: this.stuckAfterMs,
      recentDecisions: this.decisions.slice(-5),
    };
  }

  /** Serialize for session-state.json persistence (NOT used for auto-resume per user-locked decision; included for audit visibility only). */
  toJSON() {
    return {
      goal: this.goal,
      language: this.language,
      maxWallclockMs: this.maxWallclockMs,
      stuckAfterMs: this.stuckAfterMs,
      startedAt: this.startedAt,
      currentPhase: this.currentPhase,
      turnsThisPhase: this.turnsThisPhase,
      decisionCount: this.decisionCount,
      initialDelivered: this.initialDelivered,
      stopped: this.stopped,
      stopReason: this.stopReason,
      // Note: decisions array not persisted (memory-only)
    };
  }

  // ─── internals ──────────────────────────────────────────────────

  _stateSnapshot() {
    return {
      goal: this.goal,
      currentPhase: this.currentPhase,
      milestones: this.lastMilestones,
      idleSec: Math.round((Date.now() - this.lastEventTs) / 1000),
      lastEventType: this._lastEventType || null,
    };
  }

  _shouldStop() {
    if (this.stopped) return true;
    if (Date.now() - this.startedAt > this.maxWallclockMs) {
      this.stopReason = "max_wallclock";
      return true;
    }
    if (
      this.currentPhase === "finalization" &&
      this.turnsThisPhase >= 5
    ) {
      this.stopReason = "finalization_settled";
      return true;
    }
    return false;
  }

  _recordDecision(template, reason, prompt) {
    this.decisionCount += 1;
    this.lastDecisionAt = Date.now();
    this.decisions.push({
      ts: new Date().toISOString(),
      template,
      reason,
      currentPhase: this.currentPhase,
      promptPreview: (prompt || "").slice(0, 200),
    });
    if (this.decisions.length > 100) this.decisions.shift();
  }
}
