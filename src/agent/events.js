/**
 * A single event emitted by the agent engine during a turn.
 * The CLI renders these directly — no serialization needed.
 */
export class AgentEvent {
  /**
   * @param {object} opts
   * @param {string} opts.type - Event type: text_delta, turn_complete, tool_start, tool_result, error, pipeline_event, phase_update, session_info, system_message, history_load
   * @param {string} [opts.text] - Text content (text_delta)
   * @param {string} [opts.name] - Tool name (tool_start, tool_result)
   * @param {object} [opts.input] - Tool input (tool_start)
   * @param {string} [opts.output] - Tool output (tool_result)
   * @param {boolean} [opts.isError] - Whether tool errored (tool_result)
   * @param {string} [opts.message] - Message (error, system_message)
   * @param {object} [opts.data] - Generic payload (pipeline_event)
   */
  constructor({ type, text, name, input, output, isError, message, data }) {
    this.type = type;
    this.text = text ?? null;
    this.name = name ?? null;
    this.input = input ?? null;
    this.output = output ?? null;
    this.isError = isError ?? false;
    this.message = message ?? null;
    this.data = data ?? {};
  }
}
