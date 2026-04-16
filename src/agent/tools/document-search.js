import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const MAX_RESULTS = 20;
const CONTEXT_CHARS = 200;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".py", ".csv", ".env", ".log", ".js"]);

/**
 * Full-text search across documents in the workspace.
 * Searches text files and parsed document outputs. Returns passages
 * with source coordinates (file, line number).
 */
export class DocumentSearchTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "document_search"; }

  get description() {
    return (
      "Search for text across documents. " +
      "scope='workspace' (default) searches KC's workspace. " +
      "scope='project' searches the user's project directory. " +
      "Returns matching passages with file path and context. Supports plain text and regex queries."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (plain text or regex pattern)" },
        path: { type: "string", description: "Subdirectory to search in (default: entire scope root)" },
        max_results: { type: "integer", description: `Maximum results to return (default: ${MAX_RESULTS})` },
        regex: { type: "boolean", description: "Treat query as regex pattern (default: false)" },
        scope: {
          type: "string",
          enum: ["workspace", "project"],
          description: "Which directory to search. 'workspace' (default) or 'project'.",
        },
      },
      required: ["query"],
    };
  }

  async execute(input) {
    const query = input.query || "";
    const searchPath = input.path || ".";
    const maxResults = input.max_results || MAX_RESULTS;
    const useRegex = input.regex || false;
    const scope = input.scope || "workspace";

    if (!query) return new ToolResult("No query provided", true);
    if (scope === "project" && !this._workspace.projectDir) {
      return new ToolResult("No project directory available", true);
    }

    let searchDir;
    try {
      searchDir = scope === "project"
        ? this._workspace.resolveProjectPath(searchPath)
        : this._workspace.resolvePath(searchPath);
    }
    catch (e) { return new ToolResult(e.message, true); }

    if (!fs.existsSync(searchDir) || !fs.statSync(searchDir).isDirectory()) {
      return new ToolResult(`Not a directory: ${searchPath}`, true);
    }

    let pattern;
    try {
      pattern = useRegex ? new RegExp(query, "gi") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch (e) {
      return new ToolResult(`Invalid regex: ${e.message}`, true);
    }

    const baseDir = scope === "project" ? this._workspace.projectDir : this._workspace.cwd;
    const results = [];
    this._searchDir(searchDir, pattern, results, maxResults, baseDir);

    if (results.length === 0) return new ToolResult(`No matches found for: ${query}`);

    const lines = [];
    for (const r of results) {
      lines.push(`--- ${r.file}:${r.line} ---`);
      lines.push(r.context);
      lines.push("");
    }
    return new ToolResult(`Found ${results.length} match(es):\n\n${lines.join("\n")}`);
  }

  _searchDir(dir, pattern, results, maxResults, baseDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
        this._searchDir(fullPath, pattern, results, maxResults, baseDir);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        let content;
        try { content = fs.readFileSync(fullPath, "utf-8"); }
        catch { continue; }

        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(content)) !== null) {
          const start = Math.max(0, match.index - CONTEXT_CHARS);
          const end = Math.min(content.length, match.index + match[0].length + CONTEXT_CHARS);
          const context = content.slice(start, end).trim();
          const lineNum = content.slice(0, match.index).split("\n").length;
          const relPath = path.relative(baseDir, fullPath);

          results.push({ file: relPath, line: lineNum, match: match[0], context });
          if (results.length >= maxResults) break;
        }
      }
    }
  }
}
