import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BaseTool, ToolResult } from "./base.js";
import { buildBundleTree, BundleTree } from "../bundle-tree.js";

const CACHE_SUBDIR = path.join("cache", "bundles");

/**
 * Build a BundleTree (onion-peeler chunk tree with a keyword index) from
 * a list of files. Caches the result under
 *   <workspace>/cache/bundles/<sha256-of-bundle>.json
 * keyed by the combined content hash, so re-chunking the same bundle is
 * free.
 *
 * The bundle tree is the foundation for:
 *   - `bundle_search` — cheap keyword RAG over the tree's leaves
 *   - `document_classify` — reads each file's head to classify the bundle
 *   - Group D skill_authoring context auto-attach (reads chunks by id)
 *
 * PDFs are extracted with per-page resolution via pdfjs (already a KC
 * dependency). Other formats go in as single-page blocks, which still
 * benefits from the chunker's header-based splitting.
 */
export class DocumentChunkTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "document_chunk"; }

  get description() {
    return (
      "Build a searchable BundleTree from a list of regulation / reference documents. " +
      "Produces a hierarchical chunk tree (max ~2000 tokens per leaf) with a " +
      "keyword index for RAG. Result is cached by content hash — repeated calls " +
      "on the same bundle are free. Use bundle_search afterward to look up evidence by keyword."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Paths to input files (PDFs, .md, .txt). Relative to the chosen scope.",
        },
        scope: {
          type: "string",
          enum: ["workspace", "project"],
          description: "Which directory to resolve paths against. Default 'workspace'.",
        },
        max_tokens_per_chunk: {
          type: "integer",
          description: "Max tokens per leaf chunk. Default 2000 (≈5000 chars CJK).",
        },
        force_refresh: {
          type: "boolean",
          description: "Ignore cache and re-chunk. Default false.",
        },
      },
      required: ["paths"],
    };
  }

  async execute(input) {
    const paths = Array.isArray(input.paths) ? input.paths : [];
    const scope = input.scope || "workspace";
    const maxTokens = Number.isFinite(input.max_tokens_per_chunk)
      ? input.max_tokens_per_chunk : 2000;
    const forceRefresh = input.force_refresh === true;

    if (paths.length === 0) return new ToolResult("No paths provided", true);
    if (scope === "project" && !this._workspace.projectDir) {
      return new ToolResult("No project directory available", true);
    }

    // Resolve + stat every path up front so cache key is based on actual files
    const resolved = [];
    for (const p of paths) {
      let abs;
      try {
        abs = scope === "project"
          ? this._workspace.resolveProjectPath(p)
          : this._workspace.resolvePath(p);
      } catch (e) { return new ToolResult(`Path error (${p}): ${e.message}`, true); }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new ToolResult(`File not found: ${p}`, true);
      }
      resolved.push({ requested: p, abs });
    }

    const cacheKey = this._hashBundle(resolved, maxTokens);
    const cacheDir = path.join(this._workspace.cwd, CACHE_SUBDIR);
    const cachePath = path.join(cacheDir, `${cacheKey}.json`);

    if (!forceRefresh && fs.existsSync(cachePath)) {
      try {
        const tree = BundleTree.fromJSON(JSON.parse(fs.readFileSync(cachePath, "utf-8")));
        return new ToolResult(this._summarize(tree, cachePath, /*cached*/ true));
      } catch {
        // Fall through to rebuild; corrupt cache is self-healing.
      }
    }

    // Parse each file into { source_file, total_pages, blocks: [{page, markdown}] }
    const parsedFiles = [];
    for (const { requested, abs } of resolved) {
      try {
        parsedFiles.push(await this._parseOne(requested, abs));
      } catch (e) {
        parsedFiles.push({
          source_file: path.basename(abs),
          total_pages: 0,
          blocks: [],
          parse_error: `${e.name || "Error"}: ${e.message}`,
        });
      }
    }

    const tree = buildBundleTree(parsedFiles, { maxTokensPerChunk: maxTokens });

    // Write cache
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(tree.toJSON()), "utf-8");
    } catch {
      // Cache write failure is non-fatal; the tree is still valid in memory
      // for this turn. Next turn will just re-chunk.
    }

    return new ToolResult(this._summarize(tree, cachePath, /*cached*/ false));
  }

  /**
   * Produce a concise summary output. Full tree is on disk; we show the
   * outline + leaf stats so the agent knows what's inside without dumping
   * every chunk into the LLM turn.
   */
  _summarize(tree, cachePath, cached) {
    const files = tree.files();
    const leaves = tree.allLeaves();
    const totalTokens = leaves.reduce((n, ch) => n + (ch.tokens || 0), 0);
    const rel = path.relative(this._workspace.cwd, cachePath) || cachePath;
    const lines = [
      `${cached ? "Reused cached" : "Built new"} BundleTree → ${rel}`,
      `Files: ${files.length} · Leaves: ${leaves.length} · ~${totalTokens} tokens indexed`,
      `Keyword index: ${Object.keys(tree.keyword_index).length} tokens`,
      "",
      "Outline:",
      tree.outline(4),
      "",
      `Next step: use \`bundle_search\` with keywords to look up evidence by chunk_id.`,
      `Cache key: ${path.basename(cachePath)}`,
    ];
    return lines.join("\n");
  }

  _hashBundle(resolved, maxTokens) {
    const h = crypto.createHash("sha256");
    h.update(`max_tokens:${maxTokens}\n`);
    for (const { abs } of resolved) {
      try {
        const stat = fs.statSync(abs);
        h.update(`${abs}|${stat.size}|${stat.mtimeMs}\n`);
      } catch { h.update(`${abs}|?|?\n`); }
    }
    return h.digest("hex").slice(0, 16);
  }

  async _parseOne(requestedRelPath, absPath) {
    const baseName = path.basename(absPath);
    const suffix = path.extname(absPath).toLowerCase();

    if (suffix === ".pdf") {
      const blocks = await this._parsePdfPages(absPath);
      return {
        source_file: baseName,
        total_pages: blocks.length || 1,
        blocks: blocks.length > 0 ? blocks : [{ page: 1, markdown: "" }],
      };
    }

    if (suffix === ".md" || suffix === ".txt") {
      const txt = fs.readFileSync(absPath, "utf-8");
      return {
        source_file: baseName,
        total_pages: 1,
        blocks: [{ page: 1, markdown: txt }],
      };
    }

    // For other formats (.docx, .xlsx, etc): read as UTF-8 best-effort.
    // Upstream agent should call document_parse first and then document_chunk
    // on the parsed output directly — current MVP keeps the tool surface small.
    try {
      const txt = fs.readFileSync(absPath, "utf-8");
      return {
        source_file: baseName,
        total_pages: 1,
        blocks: [{ page: 1, markdown: txt }],
      };
    } catch {
      return {
        source_file: baseName, total_pages: 0, blocks: [],
        parse_error: `Unsupported format '${suffix}'. Run document_parse first and use its output, or stick to .pdf / .md / .txt.`,
      };
    }
  }

  async _parsePdfPages(absPath) {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(fs.readFileSync(absPath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const blocks = [];
    try {
      for (let i = 0; i < doc.numPages; i++) {
        let pageText = "";
        try {
          const page = await doc.getPage(i + 1);
          const content = await page.getTextContent();
          // Preserve line breaks reasonably well: group items by rough y-coord.
          let lastY = null;
          const out = [];
          for (const item of content.items) {
            const y = item.transform?.[5];
            if (lastY !== null && Math.abs(y - lastY) > 2) out.push("\n");
            else if (out.length > 0 && !out[out.length - 1].endsWith(" "))
              out.push(" ");
            out.push(item.str || "");
            lastY = y;
          }
          pageText = out.join("").replace(/\s+\n/g, "\n").trim();
        } catch { pageText = ""; }
        blocks.push({ page: i + 1, markdown: pageText });
      }
    } finally {
      try { await doc.destroy?.(); } catch { /* ignore */ }
    }
    return blocks;
  }
}
