// v0.8 P4 — engine-side marathon input watcher.
//
// When kc-marathon (separate process) is driving the workspace, it
// writes continuation prompts to <workspace>/.kc_marathon/inbox.jsonl.
// This module gives the engine a way to poll that inbox and consume
// pending prompts as if they were synthetic user prompts.
//
// Engine integration: AgentEngine constructor instantiates a
// MarathonInputWatcher. Inside the task loop, before each new
// `runTurn`, the engine calls watcher.takeNext() — if a prompt is
// pending, the engine runs that as the next user message and skips
// blocking on stdin.
//
// Activation: the watcher is active iff <workspace>/.kc_marathon/active
// exists. The driver creates this marker at startup + removes it on
// teardown. F5 strict-one-phase-per-prompt (v0.7.5 / P5) consults the
// same flag — when marathon-active, F5 disables.

import fs from "node:fs";
import path from "node:path";

export class MarathonInputWatcher {
  /**
   * @param {string} workspaceCwd — absolute path to the workspace
   */
  constructor(workspaceCwd) {
    this.workspaceCwd = workspaceCwd;
    this.inboxPath = path.join(workspaceCwd, ".kc_marathon", "inbox.jsonl");
    this.activeMarker = path.join(workspaceCwd, ".kc_marathon", "active");
    this.readOffset = 0;
    this.pending = [];
  }

  /** Is the marathon driver currently active for this workspace? */
  isActive() {
    try { return fs.statSync(this.activeMarker).isFile(); }
    catch { return false; }
  }

  /** Read any new inbox lines and append to the pending queue. */
  _drainInbox() {
    if (!fs.existsSync(this.inboxPath)) return;
    let stat;
    try { stat = fs.statSync(this.inboxPath); } catch { return; }
    if (stat.size <= this.readOffset) return;
    let buf;
    try {
      const fd = fs.openSync(this.inboxPath, "r");
      const len = stat.size - this.readOffset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.readOffset);
      fs.closeSync(fd);
    } catch { return; }
    this.readOffset = stat.size;
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.content) this.pending.push(entry);
      } catch { /* skip malformed */ }
    }
  }

  /**
   * Take the next pending prompt (drain inbox first). Returns the
   * prompt content string, or null if nothing pending.
   *
   * Each prompt is consumed once; the engine should treat it as a
   * synthetic user message and run a turn with it.
   */
  takeNext() {
    this._drainInbox();
    if (!this.pending.length) return null;
    const next = this.pending.shift();
    return next.content || null;
  }

  /** Inspect queue depth without consuming. Useful for status. */
  pendingCount() {
    this._drainInbox();
    return this.pending.length;
  }
}
