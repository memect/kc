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
}
