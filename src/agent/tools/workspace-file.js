import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const MAX_READ = 50_000;

/**
 * Read, write, or list files in the workspace or project directory.
 * All paths are resolved relative to the chosen scope with
 * traversal protection. Workspace writes are auto-committed by Workspace.autoCommit
 * (skips gitignored paths and silently no-ops if git is unavailable).
 *
 * The second `versionManager` arg is retained for back-compat with the engine
 * constructor but is no longer required for any logic.
 */
export class WorkspaceFileTool extends BaseTool {
  /**
   * @param {import('../workspace.js').Workspace} workspace
   * @param {import('../version-manager.js').VersionManager} [_versionManager] - unused, kept for back-compat
   */
  constructor(workspace, _versionManager) {
    super();
    this._workspace = workspace;
  }

  get name() { return "workspace_file"; }

  get description() {
    return (
      "Read, write, or list files. " +
      "scope='workspace' (default): KC's working directory for rules, skills, workflows, results. " +
      "scope='project': the user's project folder where KC was launched — source regulations and samples live here. " +
      "Operations: read (returns file content), write (creates/overwrites a file), list (shows directory contents)."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "list"],
          description: "The file operation to perform",
        },
        path: {
          type: "string",
          description: "Relative path within the chosen scope. Defaults to '.' for list.",
        },
        content: {
          type: "string",
          description: "File content to write (required for write operation)",
        },
        scope: {
          type: "string",
          enum: ["workspace", "project"],
          description: "Which directory to operate in. 'workspace' (default) = KC's workspace. 'project' = user's project directory.",
        },
      },
      required: ["operation"],
    };
  }

  _resolveForScope(filePath, scope) {
    if (scope === "project") {
      return this._workspace.resolveProjectPath(filePath);
    }
    return this._workspace.resolvePath(filePath);
  }

  _baseForScope(scope) {
    if (scope === "project") {
      return this._workspace.projectDir;
    }
    return this._workspace.cwd;
  }

  async execute(input) {
    const op = input.operation || "";
    const filePath = input.path || ".";
    const content = input.content || "";
    const scope = input.scope || "workspace";

    if (scope === "project" && !this._workspace.projectDir) {
      return new ToolResult("No project directory available. KC was launched without a project context.", true);
    }

    try {
      if (op === "read") return this._read(filePath, scope);
      if (op === "write") return this._write(filePath, content, scope);
      if (op === "list") return this._list(filePath, scope);
      return new ToolResult(`Unknown operation: ${op}`, true);
    } catch (err) {
      return new ToolResult(`File error: ${err.message}`, true);
    }
  }

  _read(filePath, scope) {
    const resolved = this._resolveForScope(filePath, scope);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new ToolResult(`File not found: ${filePath}`, true);
    }
    let text = fs.readFileSync(resolved, { encoding: "utf-8" });
    if (text.length > MAX_READ) {
      text = text.slice(0, MAX_READ) + "\n[truncated]";
    }
    return new ToolResult(text);
  }

  _write(filePath, content, scope) {
    if (!filePath || filePath === ".") {
      return new ToolResult("Path required for write operation", true);
    }
    const resolved = this._resolveForScope(filePath, scope);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    // v0.7.0 Group M (#84 remainder): on case-insensitive filesystems
    // (macOS/Windows defaults), warn when the target's basename collides
    // with an existing sibling differing only in case. Write proceeds
    // — agents may legitimately overwrite — but the agent gets visible
    // signal so it doesn't end up confused like E2E #5 GLM ("SKILL.md
    // disappeared" when the inode was shared with skill.md). Workspace-
    // scope only; project-dir scope is the user's territory.
    let collisionNote = "";
    if (
      scope === "workspace" &&
      this._workspace.fsCaseSensitive === false
    ) {
      try {
        const parent = path.dirname(resolved);
        const targetBase = path.basename(resolved);
        const targetLower = targetBase.toLowerCase();
        const siblings = fs.readdirSync(parent);
        const collision = siblings.find(
          (s) => s !== targetBase && s.toLowerCase() === targetLower,
        );
        if (collision) {
          collisionNote =
            ` ⚠ case-collision: case-insensitive filesystem already has '${collision}'` +
            ` at this path; both names resolve to the same inode. Pick one canonical case` +
            ` (lowercase preferred for skill files) and use it consistently — otherwise` +
            ` archive_file / Read on either name affects the other.`;
        }
      } catch { /* readdirSync may fail on a fresh dir; that's fine, no collision possible */ }
    }

    fs.writeFileSync(resolved, content, "utf-8");

    // Auto-commit to git for workspace writes (silently no-ops if gitignored or git unavailable)
    let traceId = null;
    if (scope === "workspace") {
      traceId = this._workspace.autoCommit(filePath, "update");
    }

    const label = scope === "project" ? `[project] ${filePath}` : filePath;
    let msg = `Wrote ${content.length} chars to ${label}`;
    if (traceId) msg += ` [trace: ${traceId}]`;
    if (collisionNote) msg += collisionNote;
    return new ToolResult(msg);
  }

  _list(filePath, scope) {
    const resolved = this._resolveForScope(filePath, scope);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return new ToolResult(`Not a directory: ${filePath}`, true);
    }
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    if (entries.length === 0) {
      return new ToolResult("(empty directory)");
    }
    const base = this._baseForScope(scope);
    const lines = entries.map((e) => {
      const rel = path.relative(base, path.join(resolved, e.name));
      const marker = e.isDirectory() ? "[dir] " : "      ";
      return `${marker}${rel}`;
    });
    return new ToolResult(lines.join("\n"));
  }
}
