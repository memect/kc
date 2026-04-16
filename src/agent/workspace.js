import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Per-session workspace directory with path traversal protection.
 * Each agent session gets its own directory under the workspace root.
 * All file operations by tools must go through resolvePath().
 */
export class Workspace {
  /**
   * @param {string} root - Workspace root directory
   * @param {string} [sessionId] - Session identifier (auto-generated if omitted)
   * @param {string} [projectDir] - User's project directory (CWD at launch)
   */
  constructor(root, sessionId, projectDir) {
    this.root = path.resolve(root);
    this.sessionId = sessionId || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.path = path.resolve(this.root, this.sessionId);
    this.projectDir = projectDir ? path.resolve(projectDir) : null;
    fs.mkdirSync(this.path, { recursive: true });
  }

  /** @returns {string} Current workspace directory */
  get cwd() {
    return this.path;
  }

  /**
   * Resolve a user-supplied relative path against the workspace.
   * Rejects absolute paths and any path that escapes the workspace via .. or symlinks.
   * @param {string} userPath
   * @returns {string}
   */
  resolvePath(userPath) {
    if (path.isAbsolute(userPath)) {
      throw new Error(`Absolute paths not allowed: ${userPath}`);
    }
    const resolved = path.resolve(this.path, userPath);
    const base = path.resolve(this.path);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Path escapes workspace: ${userPath}`);
    }
    return resolved;
  }

  /**
   * Resolve a user-supplied relative path against the project directory.
   * Same traversal protection as resolvePath() but for the project folder.
   * @param {string} userPath
   * @returns {string}
   */
  resolveProjectPath(userPath) {
    if (!this.projectDir) {
      throw new Error("No project directory available");
    }
    if (path.isAbsolute(userPath)) {
      throw new Error(`Absolute paths not allowed: ${userPath}`);
    }
    const resolved = path.resolve(this.projectDir, userPath);
    const base = path.resolve(this.projectDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Path escapes project directory: ${userPath}`);
    }
    return resolved;
  }

  /**
   * Rename the workspace folder. Returns the new sessionId.
   * @param {string} newName
   * @returns {string}
   */
  rename(newName) {
    newName = newName.trim().replace(/ /g, "_").replace(/\//g, "_");
    if (!newName) throw new Error("Name cannot be empty");
    const newPath = path.join(this.root, newName);
    if (fs.existsSync(newPath) && path.resolve(newPath) !== path.resolve(this.path)) {
      throw new Error(`Session '${newName}' already exists`);
    }
    if (path.resolve(newPath) !== path.resolve(this.path)) {
      fs.renameSync(this.path, newPath);
      this.path = path.resolve(newPath);
      this.sessionId = newName;
    }
    return this.sessionId;
  }

  /**
   * List all workspace sessions with names.
   * @param {string} root
   * @returns {Array<{id: string}>}
   */
  static listSessions(root) {
    root = path.resolve(root);
    if (!fs.existsSync(root)) return [];
    const sessions = [];
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        sessions.push({ id: entry.name });
      }
    }
    return sessions;
  }
}
