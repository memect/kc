/**
 * Base class for all pipeline components.
 * Each pipeline hard-codes one meta-meta skill's methodology as structural code.
 */
export class Pipeline {
  /** Return context injected into the system prompt before each LLM call. */
  describeState() { throw new Error("Not implemented"); }

  /** Called after each tool execution. Returns PipelineEvent or null. */
  onToolResult(toolName, toolInput, result) { throw new Error("Not implemented"); }

  /** Whether all requirements for leaving this phase are satisfied. */
  exitCriteriaMet() { throw new Error("Not implemented"); }

  /** Serialize milestone state for persistence. Override in subclasses. */
  exportState() { return {}; }

  /** Restore milestone state from persisted data. Override in subclasses. */
  importState(_data) { /* no-op by default */ }

  /**
   * v0.6.3: Phase-misfit nudge. Called after each tool execution. If the tool
   * call looks like work that belongs to a different phase, return a short
   * hint string. Engine appends it as a `<system-reminder>` tag on the tool
   * result, so the agent sees the mismatch on its next turn and can self-
   * check whether to call phase_advance.
   *
   * Default: no hint. Phase-specific pipelines override with patterns they
   * recognize as out-of-phase (e.g., BOOTSTRAP shouldn't write to
   * rule_skills/, RULE_EXTRACTION shouldn't run workflows on production samples).
   *
   * Keep hints terse — they consume context budget every misfit. State the
   * mismatch + suggest the right phase + remind about phase_advance.
   *
   * @param {string} toolName
   * @param {object} toolInput
   * @param {object} result - ToolResult-like { content, isError }
   * @returns {string|null}
   */
  phaseMisfitHint(_toolName, _toolInput, _result) { return null; }
}
