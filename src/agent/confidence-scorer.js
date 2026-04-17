import fs from "node:fs";
import path from "node:path";

const DEFAULT_PRIORS = {
  regex: 0.95,
  python: 0.90,
  llm: 0.75,
  ocr: 0.65,
  fallback: 0.50,
};

/**
 * Structural component: composite confidence scoring for verification results.
 *
 * Formula: confidence = method_prior x source_presence x historical_accuracy x (1 - corner_case_proximity)
 */
export class ConfidenceScorer {
  /**
   * @param {string} workspacePath
   * @param {import('./corner-case-registry.js').CornerCaseRegistry} [cornerCases]
   */
  constructor(workspacePath, cornerCases) {
    this._workspace = workspacePath;
    this._cornerCases = cornerCases || null;
    this._priors = { ...DEFAULT_PRIORS };
    /** @type {Record<string, number>} rule_id → accuracy */
    this._historical = {};
    this._calibrationPath = path.join(workspacePath, "confidence_calibration.json");
    this._loadConfig();
    this._loadCalibration();
  }

  /** Re-point at a new workspace. Used by `engine.renameSession()` (Bug 3). */
  _setWorkspacePath(newWorkspacePath) {
    this._workspace = newWorkspacePath;
    this._calibrationPath = path.join(newWorkspacePath, "confidence_calibration.json");
    // Re-load priors from the new workspace's .env (in case it was edited externally)
    this._loadConfig();
  }

  _loadConfig() {
    const envPath = path.join(this._workspace, ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      if (line.startsWith("CONFIDENCE_PRIORS=")) {
        try {
          const custom = JSON.parse(line.split("=")[1].trim());
          if (typeof custom === "object") Object.assign(this._priors, custom);
        } catch { /* ignore */ }
      }
    }
  }

  _loadCalibration() {
    if (!fs.existsSync(this._calibrationPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._calibrationPath, "utf-8"));
      this._historical = data.historical_accuracy || {};
    } catch { /* ignore */ }
  }

  /**
   * Compute composite confidence score (0.0 - 1.0).
   * @param {object} opts
   * @param {string} opts.ruleId
   * @param {string} opts.extractedValue
   * @param {string} [opts.sourceText]
   * @param {string} [opts.extractionMethod]
   * @param {string} [opts.documentName]
   * @returns {number}
   */
  score({ ruleId, extractedValue, sourceText = "", extractionMethod = "llm", documentName = "" }) {
    const methodPrior = this._priors[extractionMethod] ?? this._priors.fallback;

    let sourcePresence = 1.0;
    if (sourceText && extractedValue) {
      sourcePresence = sourceText.includes(extractedValue) ? 1.0 : 0.7;
    }

    const historical = this._historical[ruleId] ?? 0.8;

    let cornerProximity = 0.0;
    if (this._cornerCases && documentName) {
      const matches = this._cornerCases.match(documentName, ruleId);
      if (matches.length > 0) {
        cornerProximity = Math.min(0.3, 0.1 * matches.length);
      }
    }

    const confidence = methodPrior * sourcePresence * historical * (1.0 - cornerProximity);
    return Math.round(Math.max(0.0, Math.min(1.0, confidence)) * 1000) / 1000;
  }

  /**
   * Auto-calibrate after QC cycle.
   * @param {Record<string, {predicted_avg?: number, actual_accuracy?: number}>} qcResults
   */
  calibrate(qcResults) {
    for (const [ruleId, data] of Object.entries(qcResults)) {
      const actual = data.actual_accuracy;
      if (actual != null) {
        const old = this._historical[ruleId] ?? 0.8;
        this._historical[ruleId] = Math.round((0.7 * actual + 0.3 * old) * 1000) / 1000;
      }
    }
    this._saveCalibration();
  }

  _saveCalibration() {
    fs.writeFileSync(
      this._calibrationPath,
      JSON.stringify({ historical_accuracy: this._historical }, null, 2),
      "utf-8",
    );
  }

  /**
   * Classify confidence into low/medium/high band.
   * @param {number} confidence
   * @returns {string}
   */
  getBand(confidence) {
    if (confidence >= 0.8) return "high";
    if (confidence >= 0.5) return "medium";
    return "low";
  }
}
