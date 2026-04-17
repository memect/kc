import { BaseTool, ToolResult } from "./base.js";
import { Phase } from "../pipelines/index.js";

const VALID_PHASES = new Set(Object.values(Phase));

/**
 * Advance the current phase to a target phase. Used when the user instructs
 * KC to skip ahead, or when KC judges criteria are met but auto-detect
 * doesn't see them. Most transitions happen automatically (exit criteria,
 * task completion); this tool is the explicit-user-request path.
 *
 * Description kept very short to minimize system-prompt budget cost — KC
 * already knows the phase model from `bootstrap-workspace` and other skills.
 */
export class PhaseAdvanceTool extends BaseTool {
  constructor(advanceFn) {
    super();
    this._advance = advanceFn;
  }

  get name() { return "phase_advance"; }

  get description() {
    return "Advance to a different pipeline phase. Use only when user requests it or auto-detect misses.";
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: Array.from(VALID_PHASES),
          description: "Target phase",
        },
        reason: { type: "string", description: "Why" },
      },
      required: ["to"],
    };
  }

  async execute(input) {
    const to = input.to;
    if (!VALID_PHASES.has(to)) return new ToolResult(`Unknown phase: ${to}`, true);
    const advanced = this._advance(to, input.reason || "agent request");
    if (!advanced) return new ToolResult(`Already in ${to}`, false);
    return new ToolResult(`Advanced to ${to}`);
  }
}
