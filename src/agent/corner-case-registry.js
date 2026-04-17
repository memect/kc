import fs from "node:fs";
import path from "node:path";

/**
 * Structural component: first-class data structure for edge cases.
 * Corner cases (<10% failure rate) are stored here instead of patching
 * main workflows. The EvolutionController routes failures here automatically.
 * Persists to workspace/corner_cases.json.
 */
export class CornerCaseRegistry {
  /**
   * @param {string} workspacePath
   */
  constructor(workspacePath) {
    this._path = path.join(workspacePath, "corner_cases.json");
    /** @type {Array<CornerCase>} */
    this._cases = [];
    this._load();
  }

  /** Re-point at a new workspace. Used by `engine.renameSession()` (Bug 3). */
  _setWorkspacePath(newWorkspacePath) {
    this._path = path.join(newWorkspacePath, "corner_cases.json");
  }

  _load() {
    if (!fs.existsSync(this._path)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._path, "utf-8"));
      this._cases = data.map((e) => ({
        id: e.id,
        ruleId: e.rule_id || e.ruleId,
        detectionPattern: e.detection_pattern || e.detectionPattern || "",
        resolution: e.resolution || "",
        affectedDocuments: e.affected_documents || e.affectedDocuments || [],
        discoveryDate: e.discovery_date || e.discoveryDate || new Date().toISOString(),
        status: e.status || "active",
      }));
    } catch {
      this._cases = [];
    }
  }

  _save() {
    const data = this._cases.map((c) => ({
      id: c.id,
      rule_id: c.ruleId,
      detection_pattern: c.detectionPattern,
      resolution: c.resolution,
      affected_documents: c.affectedDocuments,
      discovery_date: c.discoveryDate,
      status: c.status,
    }));
    fs.writeFileSync(this._path, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Add or update a corner case. Deduplicates by id.
   * @param {CornerCase} cornerCase
   */
  add(cornerCase) {
    if (!cornerCase.discoveryDate) {
      cornerCase.discoveryDate = new Date().toISOString();
    }
    const idx = this._cases.findIndex((c) => c.id === cornerCase.id);
    if (idx >= 0) {
      this._cases[idx] = cornerCase;
    } else {
      this._cases.push(cornerCase);
    }
    this._save();
  }

  /**
   * @param {string} caseId
   * @returns {CornerCase|null}
   */
  get(caseId) {
    return this._cases.find((c) => c.id === caseId) || null;
  }

  /**
   * @param {string} ruleId
   * @returns {Array<CornerCase>}
   */
  getByRule(ruleId) {
    return this._cases.filter((c) => c.ruleId === ruleId && c.status === "active");
  }

  allActive() {
    return this._cases.filter((c) => c.status === "active");
  }

  count() {
    return this._cases.length;
  }

  /**
   * Check if a document matches any known corner case patterns for a rule.
   * @param {string} documentName
   * @param {string} ruleId
   * @returns {Array<CornerCase>}
   */
  match(documentName, ruleId) {
    const matches = [];
    for (const c of this.getByRule(ruleId)) {
      if (c.detectionPattern && documentName.toLowerCase().includes(c.detectionPattern.toLowerCase())) {
        matches.push(c);
      }
    }
    return matches;
  }
}

/**
 * @typedef {object} CornerCase
 * @property {string} id
 * @property {string} ruleId
 * @property {string} detectionPattern
 * @property {string} resolution
 * @property {string[]} affectedDocuments
 * @property {string} discoveryDate
 * @property {string} status - active | resolved | obsolete
 */
