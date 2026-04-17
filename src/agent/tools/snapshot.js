import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Create a named snapshot of the current workspace state.
 * A snapshot is a git tag (`snap/<slug>`) plus a manifest at
 * snapshots/<slug>/snapshot.json. Used for release bundles (Block 8) or
 * before risky operations.
 *
 * Auto-commits any pending changes before tagging so the snapshot is always
 * a valid commit. If git isn't available, the manifest is still written but
 * no tag is created.
 */
export class SnapshotTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "snapshot"; }

  get description() {
    return (
      "Create a named snapshot of the current workspace state (git tag + manifest). " +
      "Use to freeze a moment for a release bundle or before a risky operation. " +
      "Auto-commits any pending changes before tagging."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        label: {
          type: "string",
          description: "Human-readable label, e.g. 'release-v1' or 'before-skill-rewrite'.",
        },
        notes: {
          type: "string",
          description: "Optional description recorded in the snapshot manifest.",
        },
      },
      required: ["label"],
    };
  }

  async execute(input) {
    const label = (input.label || "").trim();
    if (!label) return new ToolResult("label required", true);
    const notes = input.notes || "";

    const slug = label.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) return new ToolResult("label produced empty slug", true);

    let commitSha = null;
    let tagName = null;

    if (this._workspace.gitAvailable) {
      // Auto-commit any pending changes (so the snapshot is reproducible)
      spawnSync("git", ["add", "-A"], { cwd: this._workspace.cwd, stdio: "ignore" });
      spawnSync("git", ["commit", "-m", `snapshot: ${label}`, "--allow-empty"], {
        cwd: this._workspace.cwd, stdio: "ignore",
      });

      tagName = `snap/${slug}`;
      // Force the tag in case the same label is re-used
      spawnSync("git", ["tag", "-f", tagName], { cwd: this._workspace.cwd, stdio: "ignore" });

      const r = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: this._workspace.cwd, encoding: "utf-8",
      });
      if (r.status === 0) commitSha = r.stdout.trim();
    }

    const snapDirRel = path.join("snapshots", slug);
    const snapDirAbs = this._workspace.resolvePath(snapDirRel);
    fs.mkdirSync(snapDirAbs, { recursive: true });
    const manifestRel = path.join(snapDirRel, "snapshot.json");
    const manifestAbs = this._workspace.resolvePath(manifestRel);
    const manifest = {
      label,
      slug,
      tag: tagName,
      commit: commitSha,
      created_at: new Date().toISOString(),
      notes: notes || null,
    };
    fs.writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2), "utf-8");
    this._workspace.autoCommit(manifestRel, "snapshot");

    const lines = [
      `Snapshot '${label}' created.`,
      tagName ? `  tag: ${tagName}` : "  tag: (skipped — git unavailable)",
      commitSha ? `  commit: ${commitSha}` : "",
      `  manifest: ${manifestRel}`,
    ].filter(Boolean);
    return new ToolResult(lines.join("\n"));
  }
}
