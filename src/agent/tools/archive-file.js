import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Move a workspace file into an archived/ subdirectory next to it.
 * Use after a workflow consumes an input doc, or when an old result is no
 * longer the primary view. If the file is git-tracked, uses `git mv` so
 * history is preserved.
 *
 * Reverse moves (un-archive) are intentionally NOT exposed as a tool —
 * KC can use sandbox_exec with `mv` for the rare reverse case.
 */
export class ArchiveFileTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "archive_file"; }

  get description() {
    return (
      "Move a workspace file to an archived/ subdirectory next to it. " +
      "Use after a workflow consumes an input doc, or when an old result is no longer primary. " +
      "Preserves git history if the file is tracked."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path of the file to archive (e.g. 'input/doc.pdf').",
        },
        target_subdir: {
          type: "string",
          description: "Subdirectory name (default: 'archived'). Created next to the file's parent.",
        },
      },
      required: ["path"],
    };
  }

  async execute(input) {
    const relPath = input.path || "";
    const subdir = (input.target_subdir || "archived").replace(/[/\\]/g, "_");
    if (!relPath) return new ToolResult("path required", true);

    let resolved;
    try { resolved = this._workspace.resolvePath(relPath); }
    catch (e) { return new ToolResult(e.message, true); }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new ToolResult(`File not found: ${relPath}`, true);
    }

    const parentRel = path.dirname(relPath);
    const baseName = path.basename(relPath);
    const targetRel = path.join(parentRel, subdir, baseName);
    const targetAbs = this._workspace.resolvePath(targetRel);

    if (fs.existsSync(targetAbs)) {
      return new ToolResult(`Target already exists: ${targetRel}`, true);
    }

    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });

    // Try git mv first (preserves history). If it fails (file untracked or
    // git unavailable), fall back to plain rename.
    let usedGitMv = false;
    if (this._workspace.gitAvailable) {
      const r = spawnSync("git", ["mv", relPath, targetRel], {
        cwd: this._workspace.cwd, stdio: "ignore",
      });
      usedGitMv = r.status === 0;
    }
    if (!usedGitMv) {
      fs.renameSync(resolved, targetAbs);
    }

    // Auto-commit the move (no-op if both source and target are gitignored)
    const traceId = this._workspace.autoCommit(targetRel, "archive");

    return new ToolResult(
      `Archived ${relPath} → ${targetRel}` +
      (usedGitMv ? " (git history preserved)" : "") +
      (traceId && this._workspace.gitAvailable ? ` [trace:${traceId}]` : "")
    );
  }
}
