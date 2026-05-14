// v0.8 P4 — marathon driver state machine.
//
// Architecture: separate process from KC engine. Driver tails the
// workspace's events.jsonl, makes deterministic decisions about the
// next prompt, and writes prompts to <workspace>/.kc_marathon/inbox.jsonl.
// The engine has a corresponding watcher (src/agent/marathon-input.js)
// that treats each inbox line as a synthetic user prompt.
//
// State machine inputs:
//   - phase transitions (engine emits phase_transition)
//   - turn boundaries (engine emits turn_complete)
//   - errors (engine emits error)
//   - idle time (no events for N seconds)
//
// Decisions:
//   - initial → send goal-description prompt to inbox
//   - turn_complete + phase_milestones met → send advance_phase nudge
//   - turn_complete + still in same phase → send continue_phase nudge
//   - idle > stuck_after → send unstick prompt
//   - phase == finalization + milestones met → send finalize prompt
//   - stop condition → send stop prompt, exit
//
// All decisions emit a `marathon_decision` event to the driver's own
// log at ~/.kc_agent/marathons/<session_id>/decisions.jsonl.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderPrompt } from "./prompts.js";

const DEFAULT_POLL_MS = 5000;          // 5s between event-tail polls
const DEFAULT_STUCK_AFTER_MS = 30 * 60 * 1000;  // 30 min
const DEFAULT_MAX_WALLCLOCK_MS = 12 * 60 * 60 * 1000;  // 12 h

export class MarathonDriver {
  /**
   * @param {object} opts
   * @param {string} opts.workspaceCwd — absolute path to the workspace dir
   * @param {string} opts.sessionId — session identifier (used for state path)
   * @param {string} opts.goal — the marathon goal-description prompt
   * @param {string} [opts.language] — "en" or "zh"
   * @param {number} [opts.maxWallclockMs] — stop after this much wall time
   * @param {number} [opts.stuckAfterMs] — send unstick prompt after idle
   * @param {number} [opts.pollMs] — poll cadence
   * @param {function} [opts.log] — log line emitter (default console.log)
   */
  constructor(opts) {
    if (!opts.workspaceCwd || !opts.sessionId || !opts.goal) {
      throw new Error("MarathonDriver requires workspaceCwd, sessionId, goal");
    }
    this.workspaceCwd = opts.workspaceCwd;
    this.sessionId = opts.sessionId;
    this.goal = opts.goal;
    this.language = opts.language || "en";
    this.maxWallclockMs = opts.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS;
    this.stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.log = opts.log || ((line) => console.log(`[marathon] ${line}`));

    this.eventsPath = path.join(this.workspaceCwd, "logs", "events.jsonl");
    this.inboxPath = path.join(this.workspaceCwd, ".kc_marathon", "inbox.jsonl");
    this.activeMarker = path.join(this.workspaceCwd, ".kc_marathon", "active");
    this.statePath = path.join(os.homedir(), ".kc_agent", "marathons", this.sessionId, "state.json");
    this.decisionsPath = path.join(os.homedir(), ".kc_agent", "marathons", this.sessionId, "decisions.jsonl");

    this.startedAt = 0;
    this.lastEventReadOffset = 0;
    this.lastEventTs = 0;
    this.currentPhase = "bootstrap";
    this.lastMilestones = {};
    this.turnsThisPhase = 0;
    this.initialSent = false;
    this.stopReason = null;
    this._stopped = false;
  }

  /** Ensure marathon directories + active marker exist. */
  _setup() {
    fs.mkdirSync(path.dirname(this.inboxPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.mkdirSync(path.dirname(this.decisionsPath), { recursive: true });
    fs.writeFileSync(this.activeMarker, JSON.stringify({
      session_id: this.sessionId,
      started_at: new Date().toISOString(),
      goal: this.goal,
    }, null, 2));
    this.startedAt = Date.now();
    this.lastEventTs = Date.now();
  }

  /** Tear down marker + write final state. */
  _teardown() {
    try { fs.unlinkSync(this.activeMarker); } catch { /* ok */ }
    this._writeState();
  }

  /** Persist driver state for restart-from-disk. */
  _writeState() {
    const state = {
      session_id: this.sessionId,
      goal: this.goal,
      started_at: new Date(this.startedAt).toISOString(),
      stopped_at: this._stopped ? new Date().toISOString() : null,
      stop_reason: this.stopReason,
      current_phase: this.currentPhase,
      last_event_offset: this.lastEventReadOffset,
      turns_this_phase: this.turnsThisPhase,
      initial_sent: this.initialSent,
    };
    try { fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2)); }
    catch (e) { this.log(`state write failed: ${e.message}`); }
  }

  /** Emit a marathon_decision to the driver's own log + KC's events.jsonl. */
  _emitDecision(template, prompt, reason) {
    const record = {
      ts: new Date().toISOString(),
      template,
      reason,
      current_phase: this.currentPhase,
      prompt_preview: prompt.slice(0, 200),
    };
    try { fs.appendFileSync(this.decisionsPath, JSON.stringify(record) + "\n"); } catch { /* ok */ }
    // Also append to KC's events.jsonl so e2e-audit can correlate.
    try {
      fs.appendFileSync(this.eventsPath, JSON.stringify({
        ts: record.ts,
        type: "marathon_decision",
        data: record,
      }) + "\n");
    } catch { /* ok */ }
  }

  /** Write a prompt to KC's inbox. Engine watcher will pick it up. */
  _sendPrompt(template, reason) {
    const state = {
      goal: this.goal,
      currentPhase: this.currentPhase,
      milestones: this.lastMilestones,
      idleSec: Math.round((Date.now() - this.lastEventTs) / 1000),
      lastEventType: this._lastEventType || null,
    };
    const prompt = renderPrompt(template, state, this.language);
    const entry = {
      ts: new Date().toISOString(),
      source: "marathon",
      template,
      content: prompt,
    };
    try {
      fs.appendFileSync(this.inboxPath, JSON.stringify(entry) + "\n");
      this._emitDecision(template, prompt, reason);
      this.log(`sent prompt (${template}, ${reason}) to inbox`);
    } catch (e) {
      this.log(`inbox write failed: ${e.message}`);
    }
  }

  /** Tail new lines from events.jsonl since last read offset. */
  _readNewEvents() {
    if (!fs.existsSync(this.eventsPath)) return [];
    const stat = fs.statSync(this.eventsPath);
    if (stat.size <= this.lastEventReadOffset) return [];
    let buf;
    try {
      const fd = fs.openSync(this.eventsPath, "r");
      const len = stat.size - this.lastEventReadOffset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.lastEventReadOffset);
      fs.closeSync(fd);
    } catch { return []; }
    this.lastEventReadOffset = stat.size;
    return buf.toString("utf-8").split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  /** Decide next action based on the latest engine events. */
  _processEvents(events) {
    if (events.length === 0) return null;
    let lastTurnComplete = false;
    let phaseChanged = false;
    let errorSeen = false;

    for (const e of events) {
      this._lastEventType = e.type;
      this.lastEventTs = Date.now();
      if (e.type === "phase_transition") {
        const next = e.data?.to;
        if (next && next !== this.currentPhase) {
          this.log(`phase transition: ${this.currentPhase} → ${next}`);
          this.currentPhase = next;
          this.turnsThisPhase = 0;
          phaseChanged = true;
        }
      } else if (e.type === "turn_complete") {
        lastTurnComplete = true;
        this.turnsThisPhase += 1;
      } else if (e.type === "derived_milestones") {
        this.lastMilestones = e.data?.milestones || this.lastMilestones;
      } else if (e.type === "error") {
        errorSeen = true;
      }
    }
    return { lastTurnComplete, phaseChanged, errorSeen };
  }

  /** Check stop conditions; set this.stopReason if hit. */
  _checkStopConditions() {
    if (Date.now() - this.startedAt > this.maxWallclockMs) {
      this.stopReason = "max_wallclock";
      return true;
    }
    if (this.currentPhase === "finalization" && this.turnsThisPhase >= 5 && this._lastEventType === "turn_complete") {
      this.stopReason = "finalization_settled";
      return true;
    }
    return false;
  }

  /** One driver tick. Returns true if the driver should keep running. */
  async tick() {
    if (this._stopped) return false;

    const events = this._readNewEvents();
    const decision = this._processEvents(events);

    // Send initial prompt once on first tick after setup
    if (!this.initialSent) {
      this._sendPrompt("initial", "marathon kickoff");
      this.initialSent = true;
      this._writeState();
      return true;
    }

    if (this._checkStopConditions()) {
      this._sendPrompt("stop", this.stopReason);
      this._stopped = true;
      this._writeState();
      return false;
    }

    if (decision?.errorSeen) {
      this._sendPrompt("unstick", "engine emitted error event");
      return true;
    }

    if (decision?.phaseChanged) {
      if (this.currentPhase === "finalization") {
        this._sendPrompt("finalize", "reached finalization");
      } else {
        this._sendPrompt("continue_phase", `entered ${this.currentPhase}`);
      }
      return true;
    }

    if (decision?.lastTurnComplete) {
      // Send continue prompt every turn boundary while in same phase.
      this._sendPrompt("continue_phase", "turn_complete in same phase");
      return true;
    }

    // Idle detection
    const idleMs = Date.now() - this.lastEventTs;
    if (idleMs > this.stuckAfterMs) {
      this._sendPrompt("unstick", `idle for ${Math.round(idleMs / 60000)} min`);
      this.lastEventTs = Date.now(); // reset to avoid spamming
      return true;
    }

    return true;
  }

  /** Run until stop condition or external interrupt. */
  async run() {
    this._setup();
    this.log(`marathon started (workspace=${this.workspaceCwd}, session=${this.sessionId})`);

    process.on("SIGINT", () => {
      this.log("SIGINT — saving state + exiting");
      this.stopReason = "sigint";
      this._stopped = true;
      this._teardown();
      process.exit(130);
    });

    while (await this.tick()) {
      await new Promise((r) => setTimeout(r, this.pollMs));
    }

    this.log(`marathon stopped: ${this.stopReason}`);
    this._teardown();
  }
}
