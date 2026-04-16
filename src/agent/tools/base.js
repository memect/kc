/**
 * Result of a tool execution.
 */
export class ToolResult {
  /**
   * @param {string} content - Output text
   * @param {boolean} [isError] - Whether the tool errored
   */
  constructor(content, isError = false) {
    this.content = content;
    this.isError = isError;
  }
}

/**
 * Abstract base class for all KC Agent tools.
 * Subclass this to add a new tool. Register it with ToolRegistry.
 */
export class BaseTool {
  /** @returns {string} Tool name */
  get name() { throw new Error("Not implemented"); }

  /** @returns {string} Tool description */
  get description() { throw new Error("Not implemented"); }

  /** @returns {object} JSON Schema for tool input */
  get inputSchema() { throw new Error("Not implemented"); }

  /**
   * Execute the tool with the given input.
   * @param {object} input
   * @returns {Promise<ToolResult>}
   */
  async execute(input) { throw new Error("Not implemented"); }
}
