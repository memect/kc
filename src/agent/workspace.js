import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateTraceId } from "./version-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GITIGNORE_TEMPLATE = path.resolve(__dirname, "../../template/workspace.gitignore");

/**
 * Per-session workspace directory with path traversal protection.
 * Each agent session gets its own directory under the workspace root.
 * All file operations by tools must go through resolvePath().
 *
 * As of v0.4.0 (Block 11): the workspace is also a git repo. Writes to
 * non-gitignored paths are auto-committed via autoCommit() so KC has a
 * real version history of its outputs.
 */
export class Workspace {
  /**
   * @param {string} root - Workspace root directory
   * @param {string} [sessionId] - Session identifier (auto-generated if omitted)
   * @param {string} [projectDir] - User's project directory (CWD at launch)
   * @param {object} [opts]
   * @param {boolean} [opts.gitAutoCommit=true] - If false, skip git init / auto-commit
   */
  constructor(root, sessionId, projectDir, opts = {}) {
    this.root = path.resolve(root);
    this.sessionId = sessionId || crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.path = path.resolve(this.root, this.sessionId);
    this.projectDir = projectDir ? path.resolve(projectDir) : null;
    this._currentPhase = "bootstrap";
    fs.mkdirSync(this.path, { recursive: true });

    this._gitAutoCommitEnabled = opts.gitAutoCommit !== false;
    this._gitAvailable = this._gitAutoCommitEnabled && Workspace.isGitInstalled();
    if (this._gitAvailable) this._initGitRepo();
  }

  /** @returns {string} Current workspace directory */
  get cwd() {
    return this.path;
  }

  /** @returns {boolean} Whether auto-commit is wired up for this session */
  get gitAvailable() {
    return this._gitAvailable;
  }

  /** Update the current phase (used in auto-commit messages). */
  setPhase(phase) {
    if (phase) this._currentPhase = phase;
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
   * Auto-commit a workspace write. Silently no-ops if the path is gitignored,
   * if there's nothing to commit, or if git isn't available. Returns the trace
   * ID generated for this write (always returned, even if no commit happened,
   * so callers can cross-reference with the event log).
   *
   * @param {string} relPath - workspace-relative path that was just written
   * @param {string} [opLabel="update"] - short verb for the commit message
   * @returns {string} trace id
   */
  autoCommit(relPath, opLabel = "update") {
    const ruleId = this._extractRuleId(relPath);
    const traceId = generateTraceId(ruleId, opLabel);

    if (!this._gitAvailable) return traceId;

    try {
      const r = spawnSync("git", ["add", "--", relPath], {
        cwd: this.path,
        stdio: "ignore",
      });
      if (r.status !== 0) return traceId; // gitignored or other add error — skip commit
      const msg = `[${this._currentPhase}] ${opLabel} ${relPath} [trace:${traceId}]`;
      spawnSync("git", ["commit", "-m", msg, "--allow-empty-message"], {
        cwd: this.path,
        stdio: "ignore",
      });
      // Status doesn't matter — "nothing to commit" is fine.
    } catch {
      // Never let a git failure break a workspace write.
    }
    return traceId;
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

  /** Probe whether the `git` executable is on PATH. Cached per process. */
  static isGitInstalled() {
    if (Workspace._gitProbeCache !== undefined) return Workspace._gitProbeCache;
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      Workspace._gitProbeCache = true;
    } catch {
      Workspace._gitProbeCache = false;
    }
    return Workspace._gitProbeCache;
  }

  // --- private helpers ---

  _initGitRepo() {
    const gitDir = path.join(this.path, ".git");
    const gitignorePath = path.join(this.path, ".gitignore");
    const isFresh = !fs.existsSync(gitDir);

    if (isFresh) {
      try {
        spawnSync("git", ["init", "--initial-branch=main"], { cwd: this.path, stdio: "ignore" });
        // --initial-branch isn't supported on older git; fall back silently
        if (!fs.existsSync(gitDir)) {
          spawnSync("git", ["init"], { cwd: this.path, stdio: "ignore" });
        }
        // Local identity so commits don't depend on user's global config
        spawnSync("git", ["config", "user.name", "kc-agent"], { cwd: this.path, stdio: "ignore" });
        spawnSync("git", ["config", "user.email", "agent@kc.local"], { cwd: this.path, stdio: "ignore" });
      } catch {
        this._gitAvailable = false;
        return;
      }
    }

    // Always ensure .gitignore is present (template may have evolved)
    if (!fs.existsSync(gitignorePath) && fs.existsSync(GITIGNORE_TEMPLATE)) {
      fs.copyFileSync(GITIGNORE_TEMPLATE, gitignorePath);
    }

    if (isFresh) {
      // Initial commit — captures whatever's already in the dir (for migrated workspaces)
      spawnSync("git", ["add", "-A"], { cwd: this.path, stdio: "ignore" });
      const msg = fs.existsSync(path.join(this.path, "AGENT.md"))
        ? `Migrated session ${this.sessionId} to git-tracked workspace`
        : `Initialized session ${this.sessionId}`;
      spawnSync("git", ["commit", "--allow-empty", "-m", msg], { cwd: this.path, stdio: "ignore" });
    }
  }

  /** Extract rule ID from a path like rule_skills/R001/SKILL.md → "R001". */
  _extractRuleId(relPath) {
    const parts = relPath.split(path.sep);
    if (parts.length >= 2 && /^R\d+/i.test(parts[1])) return parts[1];
    return "global";
  }
}
