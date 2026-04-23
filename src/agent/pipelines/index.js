/**
 * Pipeline phases — sequential workflow of the KC Agent methodology.
 *
 * v0.6.0 E1: FINALIZATION added as the 7th phase. It's a cleanup /
 * deliverable-packaging phase that runs after PRODUCTION_QC has
 * established the system is operating correctly: reorganize
 * rule_skills/ into a canonical layout, write README + coverage
 * report, snapshot a final dashboard, archive stale retry outputs.
 * Short phase, a handful of tasks, driven by a finalization skill.
 */
export const Phase = Object.freeze({
  BOOTSTRAP: "bootstrap",
  EXTRACTION: "extraction",
  SKILL_AUTHORING: "skill_authoring",
  SKILL_TESTING: "skill_testing",
  DISTILLATION: "distillation",
  PRODUCTION_QC: "production_qc",
  FINALIZATION: "finalization",
});

/**
 * Emitted by pipelines when a milestone or phase transition occurs.
 */
export class PipelineEvent {
  constructor({ type, message = "", nextPhase = null, data = {} }) {
    this.type = type;       // "milestone", "phase_ready", "error"
    this.message = message;
    this.nextPhase = nextPhase;
    this.data = data;
  }
}
