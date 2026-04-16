/**
 * Pipeline phases — sequential workflow of the KC Agent methodology.
 */
export const Phase = Object.freeze({
  BOOTSTRAP: "bootstrap",
  EXTRACTION: "extraction",
  SKILL_AUTHORING: "skill_authoring",
  SKILL_TESTING: "skill_testing",
  DISTILLATION: "distillation",
  PRODUCTION_QC: "production_qc",
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
