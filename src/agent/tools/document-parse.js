import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const MAX_OUTPUT = 50_000;
const MIN_CHARS_PER_PAGE = 50;

/**
 * Parse documents through a hard-coded escalation chain.
 * Level 1: pdfjs-dist (free, local) — text extraction
 * Level 2: MineRU API (if configured) — for scanned/complex documents
 * Level 3: OCR models via SiliconFlow — fallback via vision models
 */
export class DocumentParseTool extends BaseTool {
  constructor(workspace, { mineruApiUrl, mineruApiKey, llmApiKey, llmBaseUrl, ocrModel } = {}) {
    super();
    this._workspace = workspace;
    this._mineruApiUrl = mineruApiUrl || "";
    this._mineruApiKey = mineruApiKey || "";
    this._vlmApiKey = llmApiKey || "";
    this._vlmBaseUrl = (llmBaseUrl || "").replace(/\/+$/, "");
    this._ocrModel = ocrModel || "";
  }

  get name() { return "document_parse"; }

  get description() {
    return (
      "Parse a document (PDF, DOCX, TXT) and extract its text content. " +
      "Internally uses an escalation chain: text extraction → API parser → OCR models. " +
      "Starts cheap, escalates if needed. Use force_method to skip the chain."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the document" },
        pages: { type: "string", description: "Page range to extract, e.g. '1-5', '3', '10-20'. Omit for all pages." },
        force_method: {
          type: "string",
          enum: ["pdfjs", "vlm", "mineru", "ocr"],
          description: "Force a specific parsing method, skipping the escalation chain.",
        },
        scope: {
          type: "string",
          enum: ["workspace", "project"],
          description: "Which directory to find the file in. 'workspace' (default) or 'project' (user's project folder).",
        },
      },
      required: ["path"],
    };
  }

  async execute(input) {
    const pathStr = input.path || "";
    const pages = input.pages;
    const force = input.force_method;
    const scope = input.scope || "workspace";

    if (!pathStr) return new ToolResult("No path provided", true);
    if (scope === "project" && !this._workspace.projectDir) {
      return new ToolResult("No project directory available", true);
    }

    let resolved;
    try {
      resolved = scope === "project"
        ? this._workspace.resolveProjectPath(pathStr)
        : this._workspace.resolvePath(pathStr);
    }
    catch (e) { return new ToolResult(e.message, true); }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new ToolResult(`File not found: ${pathStr}`, true);
    }

    const pageRange = this._parsePageRange(pages);

    // Plain text files — read directly
    const ext = path.extname(resolved).toLowerCase();
    if ([".txt", ".md", ".csv", ".json", ".env"].includes(ext)) {
      let text = fs.readFileSync(resolved, "utf-8");
      if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + "\n[truncated]";
      return new ToolResult(`[Parsed via text read]\n\n${text}`);
    }

    if (force) return this._runMethod(force, resolved, pageRange);

    // Escalation chain
    // Level 1: pdfjs-dist (free, local text extraction)
    let result = await this._tryPdfjs(resolved, pageRange);
    if (result && this._qualityOk(result)) {
      return new ToolResult(this._formatOutput(result, "pdfjs", resolved));
    }

    // Level 2: Provider VLM (vision model via API — more convenient than local OCR)
    if (this._vlmApiKey && this._ocrModel) {
      result = await this._tryVlm(resolved, pageRange);
      if (result && this._qualityOk(result)) {
        return new ToolResult(this._formatOutput(result, "vlm", resolved));
      }
    }

    // Level 3: MineRU API (optional fallback)
    if (this._mineruApiUrl) {
      result = await this._tryMineru(resolved, pageRange);
      if (result && this._qualityOk(result)) {
        return new ToolResult(this._formatOutput(result, "mineru", resolved));
      }
    }

    if (result) return new ToolResult(this._formatOutput(result, "pdfjs (low quality)", resolved));

    return new ToolResult(
      `Could not extract text from ${pathStr}. Configure OCR models in .env for image-based documents.`,
      true,
    );
  }

  async _runMethod(method, filePath, pageRange) {
    let result;
    if (method === "pdfjs") result = await this._tryPdfjs(filePath, pageRange);
    else if (method === "mineru") result = await this._tryMineru(filePath, pageRange);
    else if (method === "ocr" || method === "vlm") result = await this._tryVlm(filePath, pageRange);
    else return new ToolResult(`Unknown method: ${method}`, true);

    if (result) return new ToolResult(this._formatOutput(result, method, filePath));
    return new ToolResult(`Method '${method}' failed for this document`, true);
  }

  async _tryPdfjs(filePath, pageRange) {
    try {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const data = new Uint8Array(fs.readFileSync(filePath));
      const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

      const start = pageRange ? pageRange[0] : 0;
      const end = pageRange ? pageRange[1] : doc.numPages - 1;
      const pages = [];

      for (let i = Math.max(0, start); i <= Math.min(end, doc.numPages - 1); i++) {
        const page = await doc.getPage(i + 1); // 1-indexed
        const content = await page.getTextContent();
        const text = content.items.map((item) => item.str).join(" ");
        if (text.trim()) {
          pages.push(`--- Page ${i + 1} ---\n${text.trim()}`);
        }
      }

      return pages.length > 0 ? pages.join("\n\n") : "";
    } catch (e) {
      return null;
    }
  }

  async _tryMineru(filePath, pageRange) {
    // TODO: Implement MineRU API call when available
    return null;
  }

  async _tryVlm(filePath, pageRange) {
    // Send page images to a VLM provider for OCR/interpretation.
    // Renders PDF pages to PNG via pdfjs canvas, then sends base64 to VLM API.
    if (!this._vlmApiKey || !this._ocrModel || !this._vlmBaseUrl) return null;

    try {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const data = new Uint8Array(fs.readFileSync(filePath));
      const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

      const start = pageRange ? pageRange[0] : 0;
      const end = pageRange ? pageRange[1] : doc.numPages - 1;
      const pages = [];

      for (let i = Math.max(0, start); i <= Math.min(end, doc.numPages - 1); i++) {
        const page = await doc.getPage(i + 1);
        const viewport = page.getViewport({ scale: 2.0 }); // Higher res for OCR

        // Use OffscreenCanvas or node-canvas if available, otherwise skip
        let imageBase64;
        try {
          // In Node.js, pdfjs can render to a canvas-like object
          // We'll use the simpler approach: convert page to image via the API
          const { createCanvas } = await import("canvas").catch(() => ({ createCanvas: null }));
          if (!createCanvas) {
            // No canvas available — fall back to sending raw text content hint + page number
            pages.push(`--- Page ${i + 1} (VLM) ---`);
            continue;
          }
          const canvas = createCanvas(viewport.width, viewport.height);
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport }).promise;
          imageBase64 = canvas.toBuffer("image/png").toString("base64");
        } catch {
          continue;
        }

        if (!imageBase64) continue;

        // Call VLM API with the page image
        const baseUrl = this._vlmBaseUrl.replace(/\/+$/, "");
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._vlmApiKey}`,
          },
          body: JSON.stringify({
            model: this._ocrModel,
            messages: [
              { role: "system", content: "Extract all text from this document page. Preserve structure: headings, paragraphs, tables (as markdown), lists. Output clean text only." },
              { role: "user", content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
                { type: "text", text: "Extract all text from this page." },
              ]},
            ],
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(60000),
        });

        if (resp.ok) {
          const result = await resp.json();
          const text = result.choices?.[0]?.message?.content || "";
          if (text.trim()) {
            pages.push(`--- Page ${i + 1} ---\n${text.trim()}`);
          }
        }
      }

      return pages.length > 0 ? pages.join("\n\n") : null;
    } catch {
      return null;
    }
  }

  _qualityOk(text) {
    if (!text || !text.trim()) return false;
    const pages = (text.match(/--- Page \d+ ---/g) || []).length || 1;
    const charsPerPage = text.length / pages;
    if (charsPerPage < MIN_CHARS_PER_PAGE) return false;
    const replacementRatio = (text.match(/\uFFFD/g) || []).length / Math.max(text.length, 1);
    if (replacementRatio > 0.1) return false;
    return true;
  }

  _formatOutput(text, method, filePath) {
    if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + "\n[truncated]";
    return `[Parsed via ${method}]\n\n${text}`;
  }

  _parsePageRange(pages) {
    if (!pages) return null;
    pages = pages.trim();
    if (pages.includes("-")) {
      const parts = pages.split("-", 2);
      try { return [parseInt(parts[0]) - 1, parseInt(parts[1]) - 1]; }
      catch { return null; }
    }
    try {
      const p = parseInt(pages) - 1;
      return [p, p];
    } catch { return null; }
  }
}
