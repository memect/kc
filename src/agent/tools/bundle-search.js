import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";
import { BundleTree } from "../bundle-tree.js";

const CACHE_SUBDIR = path.join("cache", "bundles");

/**
 * Keyword RAG over a cached BundleTree. Requires a prior `document_chunk`
 * call to have built a cached tree; this tool reads that cache and runs
 * BundleTree.search() against it.
 *
 * Bigram (CJK 2-grams) + English word tokens. No embedding models, no
 * vector DB — cheap and deterministic. Good enough for the
 * regulation-to-rule retrieval pattern (rules have distinct technical
 * vocabulary).
 */
export class BundleSearchTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "bundle_search"; }

  get description() {
    return (
      "Search a cached BundleTree by keywords (CJK bigrams + English words). " +
      "Returns the top-ranked chunks so you can pull evidence for a rule or " +
      "answer a question about the bundle. Call `document_chunk` first to " +
      "build the tree. If cache_key is omitted, uses the most recently " +
      "built bundle in the workspace."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Keywords or phrases to search for. CJK + English both supported.",
        },
        limit: {
          type: "integer",
          description: "Max results to return. Default 8.",
        },
        cache_key: {
          type: "string",
          description:
            "BundleTree cache file name (e.g. 'a1b2c3d4e5f6.json'). Omit to use the most recently built bundle.",
        },
        include_content: {
          type: "boolean",
          description: "Include full chunk content in output (default false — only IDs and snippets).",
        },
      },
      required: ["keywords"],
    };
  }

  async execute(input) {
    const keywords = Array.isArray(input.keywords) ? input.keywords : [];
    const limit = Number.isFinite(input.limit) ? input.limit : 8;
    const includeContent = input.include_content === true;
    const cacheKey = input.cache_key || "";

    if (keywords.length === 0) return new ToolResult("No keywords provided", true);

    const cacheDir = path.join(this._workspace.cwd, CACHE_SUBDIR);
    if (!fs.existsSync(cacheDir)) {
      return new ToolResult(
        "No bundle cache found. Call `document_chunk` first to build one.",
        true,
      );
    }

    let cachePath;
    if (cacheKey) {
      cachePath = path.join(cacheDir, cacheKey.endsWith(".json") ? cacheKey : `${cacheKey}.json`);
      if (!fs.existsSync(cachePath)) {
        return new ToolResult(`BundleTree cache not found: ${cacheKey}`, true);
      }
    } else {
      cachePath = this._findMostRecentCache(cacheDir);
      if (!cachePath) {
        return new ToolResult(
          "No bundle cache found. Call `document_chunk` first to build one.",
          true,
        );
      }
    }

    let tree;
    try {
      tree = BundleTree.fromJSON(JSON.parse(fs.readFileSync(cachePath, "utf-8")));
    } catch (e) {
      return new ToolResult(`Corrupt bundle cache (${path.basename(cachePath)}): ${e.message}`, true);
    }

    const hits = tree.search(keywords, limit);
    if (hits.length === 0) {
      return new ToolResult(
        `No matches for ${JSON.stringify(keywords)} in ${path.basename(cachePath)}.`,
      );
    }

    const lines = [
      `Found ${hits.length} chunk(s) matching ${JSON.stringify(keywords)} · source: ${path.basename(cachePath)}`,
      "",
    ];
    for (const ch of hits) {
      const headerPath = (ch.header_path || []).join(" / ");
      lines.push(
        `[${ch.chunk_id}] ${ch.title}  ·  ${ch.source_file} p.${ch.page_range[0]}-${ch.page_range[1]}  ·  ${ch.tokens || 0}tok`,
      );
      if (headerPath) lines.push(`  path: ${headerPath}`);
      if (includeContent) {
        lines.push("  ─");
        lines.push((ch.content || "").split("\n").map((l) => `  ${l}`).join("\n"));
      } else {
        const snippet = (ch.content || "").replace(/\s+/g, " ").slice(0, 160);
        if (snippet) lines.push(`  ${snippet}${(ch.content || "").length > 160 ? "…" : ""}`);
      }
      lines.push("");
    }
    return new ToolResult(lines.join("\n"));
  }

  _findMostRecentCache(cacheDir) {
    let entries;
    try { entries = fs.readdirSync(cacheDir); }
    catch { return null; }
    const candidates = entries
      .filter((n) => n.endsWith(".json") && !n.endsWith(".classification.json"))
      .map((n) => {
        const full = path.join(cacheDir, n);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.full || null;
  }
}
