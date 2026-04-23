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
  /**
   * @param {(to: string, reason: string, opts: {force?: boolean}) => boolean} advanceFn
   * @param {() => string} getCurrentPhaseFn - H1: lets the tool read the
   *   engine's phase BEFORE the call, so it can distinguish "already there"
   *   (silent no-op, informational) from "non-adjacent refusal" (actionable).
   *   Before H1 both cases returned the same confusing "Either you're already
   *   there, or transition is non-adjacent" message.
   */
  constructor(advanceFn, getCurrentPhaseFn) {
    super();
    this._advance = advanceFn;
    this._getCurrentPhase = getCurrentPhaseFn || (() => null);
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

    const beforePhase = this._getCurrentPhase();
    // H1: short-circuit the "already in target" case with an informational
    // message — the agent was trying to advance correctly, engine just
    // auto-advanced ahead of it (common when _maybeAutoAdvance fires on a
    // criteria flip). Treat as success, not refusal.
    if (beforePhase && beforePhase === to) {
      return new ToolResult(
        `Already in phase ${to} (engine auto-advanced earlier via criteria flip or prior explicit call). Proceed with phase-appropriate work.`,
      );
    }

    const advanced = this._advance(to, input.reason || "agent request", { force: !!input.force });
    if (advanced) {
      return new ToolResult(`Advanced${beforePhase ? ` from ${beforePhase}` : ""} to ${to}${input.force ? " (forced)" : ""}`);
    }

    // Truly refused — non-adjacent transition without force, or terminal-phase
    // forward attempt. Give the actionable hint.
    return new ToolResult(
      `Did not advance to ${to}. Transition is non-adjacent${beforePhase ? ` (currently in ${beforePhase})` : ""} — set force:true to override, or advance to the immediate-next phase first.`,
      false,
    );
  }
}
