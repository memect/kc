import { BaseTool, ToolResult } from "./base.js";

/**
 * v0.7.5: load a methodology skill's body into the agent's conversation
 * history as a tool result. Pairs with the always-loaded body injection
 * in SkillLoader.formatForContext — that handles the 1-2 architecturally-
 * required skills per phase; consult_skill handles the rest on demand.
 *
 * Validation:
 * - Skill name must be in the current phase's available set (per
 *   template/skills/phase_skills.yaml).
 * - Already-always-loaded skills return a hint pointing the agent at the
 *   system prompt (don't double-load).
 * - Missing bodies return an error result.
 *
 * Emits `skill_invoked` event with proper skill name on success — replaces
 * the older path-matching regex at engine.js:1297-1313 that produced
 * "(unknown)" spam from rule_skills/<id>/SKILL.md writes.
 */
export class ConsultSkillTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {import('../skill-loader.js').SkillLoader} skillLoader
   * @param {() => string} getCurrentPhase — returns the engine's current phase
   * @param {import('../event-log.js').EventLog} [eventLog] — for skill_invoked emission
   */
  constructor(workspace, skillLoader, getCurrentPhase, eventLog) {
    super();
    this._workspace = workspace;
    this._skillLoader = skillLoader;
    this._getCurrentPhase = getCurrentPhase;
    this._eventLog = eventLog;
  }

  get name() { return "consult_skill"; }

  get description() {
    return (
      "Load the full body of a methodology skill into your context for the " +
      "current turn. Use when the description tease in the system prompt's " +
      "'Available Methodology Skills' section isn't enough detail to proceed. " +
      "The body lands in your conversation history; subsequent turns can " +
      "reference it via context, or you can re-consult if it ages out. " +
      "Skills already in the 'Loaded Into Your Context' section don't need " +
      "consulting — they're already in your prompt."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name as listed in the system prompt (e.g., 'work-decomposition', 'evolution-loop').",
        },
      },
      required: ["name"],
    };
  }

  async execute(input) {
    const name = (input?.name || "").trim();
    if (!name) return new ToolResult("name required (e.g. consult_skill({name: 'work-decomposition'}))", true);

    // v0.8 P0-A: defensive null-check. v0.7.5 shipped with an init-order bug
    // where ConsultSkillTool received undefined skillLoader and threw
    // "Cannot read properties of undefined (reading 'getPhaseSkillSet')"
    // on every invocation (资管 audit § 9.1, 5/5 failure rate). The init-order
    // fix is in engine.js:238; this guard prevents an uncaught exception if
    // the bug recurs from any future constructor reorder.
    if (!this._skillLoader || typeof this._skillLoader.getPhaseSkillSet !== "function") {
      return new ToolResult(
        "consult_skill is misconfigured: skillLoader unavailable. This is an engine-side bug — " +
        "surface to the developer user. The agent should fall back to reading skill bodies " +
        "directly from <workspace>/skills/<name>/SKILL.md or the system prompt's always-loaded section.",
        true,
      );
    }

    const phase = this._getCurrentPhase ? this._getCurrentPhase() : null;
    const { alwaysLoaded, available } = this._skillLoader.getPhaseSkillSet(phase);

    const alwaysSet = new Set(alwaysLoaded);
    const availableSet = new Set(available);

    if (alwaysSet.has(name)) {
      return new ToolResult(
        `Skill '${name}' is already always-loaded in your system prompt for phase '${phase}'. ` +
        `Re-read the system prompt's 'Methodology Skills — Loaded Into Your Context' section ` +
        `— the body is there. No separate consult needed.`,
      );
    }

    if (!availableSet.has(name)) {
      const sorted = [...availableSet].sort();
      return new ToolResult(
        `Skill '${name}' is not available in phase '${phase}'. ` +
        `Available for this phase: ${sorted.join(", ")}. ` +
        `If you genuinely need this skill, either advance/retreat to a phase ` +
        `where it's available, or check the spelling.`,
        true,
      );
    }

    const body = this._skillLoader.loadSkillBody(name);
    if (!body) {
      return new ToolResult(
        `Skill '${name}' is declared available for phase '${phase}' but its body could not be loaded. ` +
        `This is an engine/template inconsistency — surface to the developer user.`,
        true,
      );
    }

    // Emit skill_invoked event with the real skill name (replaces the
    // old path-matching regex that produced "(unknown)" spam).
    try {
      this._eventLog?.append?.("skill_invoked", {
        skill: name,
        via_tool: "consult_skill",
        phase,
      });
    } catch { /* event logging is best-effort */ }

    return new ToolResult(body);
  }
}
