import fs from "node:fs";
import path from "node:path";

const VERSIONED_DIRS = new Set(["workflows", "rule_skills", "rules"]);
const VERSIONED_EXTS = new Set([".py", ".json", ".md", ".txt"]);

/**
 * Structural component: every write to versioned directories gets tracked.
 * - Immutable version copies tracked in manifest
 * - Manifest at versions.json: tracks lineage, timestamps, change reasons
 * - Trace ID generation: {timestamp}_{rule_id}_{version}
 * Cannot be bypassed — hooks into WorkspaceFileTool.
 */
export class VersionManager {
  /**
   * @param {string} workspacePath
   */
  constructor(workspacePath) {
    this._workspace = workspacePath;
    this._manifestPath = path.join(workspacePath, "versions.json");
    this._manifest = this._loadManifest();
  }

  _loadManifest() {
    if (fs.existsSync(this._manifestPath)) {
      try {
        return JSON.parse(fs.readFileSync(this._manifestPath, "utf-8"));
      } catch {
        // fall through
      }
    }
    return { version: "0.1.0", entries: [] };
  }

  _saveManifest() {
    fs.writeFileSync(
      this._manifestPath,
      JSON.stringify(this._manifest, null, 2),
      "utf-8",
    );
  }

  /**
   * Check if a path falls within versioned directories.
   * @param {string} relPath
   * @returns {boolean}
   */
  shouldVersion(relPath) {
    const parts = relPath.split(path.sep);
    if (parts.length === 0) return false;
    const topDir = parts[0];
    const ext = path.extname(relPath);
    return VERSIONED_DIRS.has(topDir) && VERSIONED_EXTS.has(ext);
  }

  /**
   * Called on file write. Returns trace ID if versioned, null otherwise.
   * @param {string} relPath
   * @param {string} content
   * @returns {string|null}
   */
  onWrite(relPath, content) {
    if (!this.shouldVersion(relPath)) return null;

    const version = this._nextVersion(relPath);
    const now = new Date().toISOString().replace(/[-:T]/g, (m) =>
      m === "T" ? "_" : ""
    ).slice(0, 15);

    // Extract rule_id from path if possible (e.g., rule_skills/R001/SKILL.md → R001)
    const parts = relPath.split(path.sep);
    const ruleId = parts.length > 1 ? parts[1] : "global";

    const traceId = `${now}_${ruleId}_v${version}`;

    const entry = {
      file: relPath,
      version,
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      rule_id: ruleId,
      size_chars: content.length,
    };

    this._manifest.entries.push(entry);
    this._saveManifest();

    return traceId;
  }

  _nextVersion(relPath) {
    const existing = this._manifest.entries
      .filter((e) => e.file === relPath)
      .map((e) => e.version);
    return Math.max(0, ...existing) + 1;
  }

  /**
   * Get all version entries for a file.
   * @param {string} relPath
   * @returns {Array<object>}
   */
  getVersions(relPath) {
    return this._manifest.entries.filter((e) => e.file === relPath);
  }

  /**
   * Get the most recent version entry for a file.
   * @param {string} relPath
   * @returns {object|null}
   */
  latestVersion(relPath) {
    const versions = this.getVersions(relPath);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  /**
   * Generate a standalone trace ID for results, QC records, etc.
   * @param {string} ruleId
   * @param {string} [label]
   * @returns {string}
   */
  generateTraceId(ruleId, label = "") {
    const now = new Date().toISOString().replace(/[-:T]/g, (m) =>
      m === "T" ? "_" : ""
    ).slice(0, 15);
    const suffix = label ? `_${label}` : "";
    return `${now}_${ruleId}${suffix}`;
  }
}
