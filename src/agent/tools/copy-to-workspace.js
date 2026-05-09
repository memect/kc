import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const MANIFEST_REL = "refs/manifest.json";
const GITIGNORE_REL = ".gitignore";

/**
 * Copy a specific file from the user's project directory into the workspace
 * (refs/) for KC to work on as a local copy. Default behavior remains:
 * read project files in place via scope="project". Use this only when KC
 * genuinely needs a working copy with provenance recorded.
 *
 * Files larger than `largeRefThresholdMB` (default 10 MB) are written but
 * added to .gitignore so they don't bloat git history.
 */
export class CopyToWorkspaceTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {object} [opts]
   * @param {number} [opts.largeRefThresholdMB=10]
   */
  constructor(workspace, { largeRefThresholdMB = 10 } = {}) {
    super();
    this._workspace = workspace;
    this._largeMB = largeRefThresholdMB;
  }

  get name() { return "copy_to_workspace"; }

  get description() {
    return (
      "Copy a file from the user's project directory into the workspace (refs/) " +
      "as a local working copy with provenance recorded. " +
      "Default behavior is to read project files in place via scope='project'; " +
      "only use this tool when you genuinely need a workspace-local copy " +
      "(e.g. to modify it, or to feed a workflow that requires the file inside the workspace). " +
      "Files larger than the configured threshold are written but excluded from git history."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Relative path within the project directory (e.g. 'samples/foo.pdf').",
        },
        target_name: {
          type: "string",
          description: "Optional file name under refs/. Defaults to the source basename.",
        },
        reason: {
          type: "string",
          description: "Optional reason for the copy, recorded in refs/manifest.json for provenance.",
        },
      },
      required: ["source_path"],
    };
  }

  async execute(input) {
    const sourcePath = input.source_path || "";
    const reason = input.reason || "";
    if (!sourcePath) return new ToolResult("source_path required", true);
    if (!this._workspace.projectDir) {
      return new ToolResult("No project directory available — KC was launched without a project context.", true);
    }

    let resolvedSource;
    try {
      resolvedSource = this._workspace.resolveProjectPath(sourcePath);
    } catch (e) {
      return new ToolResult(e.message, true);
    }

    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
      return new ToolResult(`Source file not found: ${sourcePath}`, true);
    }

    const targetName = (input.target_name || path.basename(resolvedSource)).replace(/[/\\]/g, "_");
    const targetRel = path.join("refs", targetName);
    const targetAbs = this._workspace.resolvePath(targetRel);

    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.copyFileSync(resolvedSource, targetAbs);

    const stat = fs.statSync(targetAbs);
    const sizeMB = stat.size / (1024 * 1024);
    const isLarge = sizeMB > this._largeMB;

    if (isLarge) {
      this._appendGitignore(`refs/${targetName}`);
    }

    await this._appendManifest({
      target: targetRel,
      source: sourcePath,
      size: stat.size,
      copied_at: new Date().toISOString(),
      large_excluded_from_git: isLarge,
      reason: reason || null,
    });

    // Auto-commit refs/manifest.json (and the file itself, if small enough to track)
    const traceId = this._workspace.autoCommit(MANIFEST_REL, "manifest");
    if (!isLarge) this._workspace.autoCommit(targetRel, "copy");

    return new ToolResult(
      `Copied ${sourcePath} → ${targetRel} (${stat.size} bytes${isLarge ? ", excluded from git (large)" : ""}). ` +
      `Provenance recorded${traceId ? ` [trace:${traceId}]` : ""}.`
    );
  }

  async _appendManifest(entry) {
    // v0.7.3: refs/manifest.json is a shared coordination path — wrap the
    // whole read-modify-write under the workspace lock so two parallel
    // copy_to_workspace calls (main agent + subagent) don't lose entries.
    return await this._workspace.withSharedLockIfApplicable(MANIFEST_REL, () => {
      const manifestAbs = this._workspace.resolvePath(MANIFEST_REL);
      fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
      let entries = [];
      if (fs.existsSync(manifestAbs)) {
        try { entries = JSON.parse(fs.readFileSync(manifestAbs, "utf-8")); }
        catch { entries = []; }
      }
      if (!Array.isArray(entries)) entries = [];
      entries.push(entry);
      fs.writeFileSync(manifestAbs, JSON.stringify(entries, null, 2), "utf-8");
    });
  }

  _appendGitignore(line) {
    const giPath = this._workspace.resolvePath(GITIGNORE_REL);
    let body = "";
    if (fs.existsSync(giPath)) body = fs.readFileSync(giPath, "utf-8");
    const lines = body.split("\n").map((l) => l.trim());
    if (lines.includes(line.trim())) return;
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += line + "\n";
    fs.writeFileSync(giPath, body, "utf-8");
    this._workspace.autoCommit(GITIGNORE_REL, "gitignore");
  }
}
