/**
 * Trace ID utility.
 *
 * As of v0.4.0 (Block 11), real version history is kept by git
 * (per-session repo, auto-committed by Workspace.autoCommit). This module
 * is now just a stable place for trace ID generation, used by tools that
 * need to cross-reference a write or a result with the event log.
 *
 * The legacy versions.json manifest in pre-v0.4.0 workspaces is left
 * untouched — nothing reads it any more, but old data is preserved.
 */

/**
 * Generate a trace ID like "20260417_114203_R001_workflow_result".
 * @param {string} ruleId
 * @param {string} [label]
 * @returns {string}
 */
export function generateTraceId(ruleId, label = "") {
  const now = new Date().toISOString().replace(/[-:T]/g, (m) =>
    m === "T" ? "_" : ""
  ).slice(0, 15);
  const suffix = label ? `_${label}` : "";
  return `${now}_${ruleId}${suffix}`;
}

/**
 * Back-compat shell. The class is retained so existing constructors
 * that take a VersionManager don't break, but it carries no state.
 */
export class VersionManager {
  constructor(_workspacePath) {
    // No-op. Workspace path is no longer needed.
  }

  generateTraceId(ruleId, label = "") {
    return generateTraceId(ruleId, label);
  }
}
