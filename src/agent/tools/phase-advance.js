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
   * @param {() => string[]} [getRunningSubagentsFn] - v0.6.2 J1: returns the
   *   list of running subagent task_ids. When non-empty, phase_advance
   *   refuses unless `acknowledge_stale_subagents: true` is set in input
   *   (or `force: true`). Forces the agent to confront live work that
   *   started in the prior phase before declaring the phase done.
   */
  constructor(advanceFn, getCurrentPhaseFn, getRunningSubagentsFn) {
    super();
    this._advance = advanceFn;
    this._getCurrentPhase = getCurrentPhaseFn || (() => null);
    this._getRunningSubagents = getRunningSubagentsFn || (() => []);
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
        acknowledge_stale_subagents: {
          type: "boolean",
          description:
            "Set to true after using agent_tool(operation=list|poll|kill) to confirm you've handled any subagents still running from the prior phase. Required when subagents are live; otherwise advance is refused (use force:true to bypass entirely).",
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

    // v0.6.2 J1: stale-subagents acknowledgement gate. Refuses advance if
    // any subagent is still running and the agent hasn't explicitly
    // acknowledged. force:true bypasses (matches existing escape pattern).
    const running = this._getRunningSubagents();
    if (running.length > 0 && !input.acknowledge_stale_subagents && !input.force) {
      return new ToolResult(
        `Refusing to advance from ${beforePhase || "?"} to ${to}: ${running.length} subagent(s) still running from prior phase: ${running.join(", ")}. ` +
        `Run agent_tool(operation="list") to see status, then either ` +
        `agent_tool(operation="wait"|"kill") on each, OR pass acknowledge_stale_subagents:true ` +
        `to advance while leaving them running (use only if they're legitimate background work).`,
        true,
      );
    }

    const advanced = this._advance(to, input.reason || "agent request", { force: !!input.force });
    if (advanced) {
      // Log the ack so post-mortems can find phase advances that proceeded
      // with live subagents
      if (running.length > 0 && input.acknowledge_stale_subagents) {
        return new ToolResult(
          `Advanced${beforePhase ? ` from ${beforePhase}` : ""} to ${to}${input.force ? " (forced)" : ""} — ` +
          `acknowledged ${running.length} running subagent(s): ${running.join(", ")}.`,
        );
      }
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
