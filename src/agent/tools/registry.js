import { ToolResult } from "./base.js";

/**
 * Manages tool registration and dispatch.
 * Tools register themselves; the engine loop discovers them via schemasOpenai()
 * and dispatches to execute() when the LLM invokes a tool.
 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, import('./base.js').BaseTool>} */
    this._tools = new Map();
  }

  /**
   * Register a tool instance.
   * @param {import('./base.js').BaseTool} tool
   */
  register(tool) {
    this._tools.set(tool.name, tool);
  }

  /**
   * Return tool schemas in OpenAI function-calling format.
   * @returns {Array<object>}
   */
  schemasOpenai() {
    return Array.from(this._tools.values()).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /**
   * Execute a tool by name.
   * @param {string} name
   * @param {object} input
   * @returns {Promise<ToolResult>}
   */
  async execute(name, input) {
    const tool = this._tools.get(name);
    if (!tool) {
      return new ToolResult(`Unknown tool: ${name}`, true);
    }
    return tool.execute(input);
  }

  /** @returns {number} Number of registered tools */
  get size() {
    return this._tools.size;
  }

  /** F5: tool names currently registered. */
  names() {
    return Array.from(this._tools.keys()).sort();
  }

  /** F5: lookup a specific tool — used by diagnostics/UI. */
  get(name) {
    return this._tools.get(name);
  }
}
