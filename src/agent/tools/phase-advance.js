import { BaseTool, ToolResult } from "./base.js";
import { Phase } from "../pipelines/index.js";

const VALID_PHASES = new Set(Object.values(Phase));

/**
 * Advance the current phase to a target phase. Used when the user instructs
 * KC to skip ahead, or when KC judges criteria are met but auto-detect
 * doesn't see them. Most transitions happen automatically (exit criteria,
 * task completion); this tool is the explicit-user-request path.
 *
 * Linear order is enforced by default — only forward-by-one is allowed.
 * Pass force=true to skip phases or regress (e.g., when the user explicitly
 * asks). Description kept short to minimize system-prompt budget cost.
 */
export class PhaseAdvanceTool extends BaseTool {
  constructor(advanceFn) {
    super();
    this._advance = advanceFn;
  }

  get name() { return "phase_advance"; }

  get description() {
    return "Advance phase. Forward-by-one only unless force=true (use sparingly, e.g. when user asks to skip).";
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
        force: {
          type: "boolean",
          description: "Allow non-adjacent or backward transitions. Default false.",
        },
      },
      required: ["to"],
    };
  }

  async execute(input) {
    const to = input.to;
    if (!VALID_PHASES.has(to)) return new ToolResult(`Unknown phase: ${to}`, true);
    const advanced = this._advance(to, input.reason || "agent request", { force: !!input.force });
    if (!advanced) {
      // Either already in target phase, or non-adjacent without force
      return new ToolResult(
        `Did not advance to ${to}. Either you're already there, or the transition is non-adjacent (set force:true to override).`,
        false,
      );
    }
    return new ToolResult(`Advanced to ${to}${input.force ? " (forced)" : ""}`);
  }
}
