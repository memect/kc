/**
 * v0.7.0 G (#91): native document parser dispatcher.
 *
 * Centralizes the "given a file path, give me text" operation across
 * formats KC handles. Strategy stack:
 *
 *   .pdf         → pdfjs-dist (already a hard dep)
 *   .docx        → mammoth                (npm dep, dynamic-imported)
 *   .doc         → word-extractor          (npm dep, dynamic-imported)
 *   .txt / .md   → fs.readFileSync UTF-8 (with GBK fallback for CJK)
 *   anything     → plaintext-utf8 best-effort, then LibreOffice fallback
 *
 * `mammoth` and `word-extractor` are dynamic-imported so the module
 * degrades gracefully when they're not installed: missing dep → fall
 * through to plaintext / LibreOffice. Lets KC ship without forcing
 * users to run `npm install` post-upgrade if they don't touch
 * DOCX/DOC content.
 *
 * The standalone PDF tool `tools/document-parse.js` (which has its
 * own VLM/OCR escalation logic for image-PDFs) keeps its richer
 * pipeline; this module is for the lower-friction "just give me
 * text" path that document-chunk uses.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @returns {Promise<{text: string, via: string, ok: boolean, error?: string}>}
 */
export async function extractText(filePath) {
  const suffix = path.extname(filePath).toLowerCase();

  if (suffix === ".pdf") {
    const text = await _tryPdfjs(filePath);
    if (text !== null) return { text, via: "pdfjs", ok: true };
  }

  if (suffix === ".docx") {
    const text = await _tryMammoth(filePath);
    if (text !== null) return { text, via: "mammoth", ok: true };
  }

  if (suffix === ".doc") {
    const text = await _tryWordExtractor(filePath);
    if (text !== null) return { text, via: "word-extractor", ok: true };
  }

  if (suffix === ".txt" || suffix === ".md" || suffix === ".csv" || suffix === ".json") {
    const text = _tryPlaintext(filePath);
    if (text !== null) return { text, via: "plaintext", ok: true };
  }

  // Generic fallbacks for anything we couldn't parse natively (or where
  // the native lib isn't installed): plaintext first, then LibreOffice
  // CLI as a last resort.
  const plain = _tryPlaintext(filePath);
  if (plain !== null) return { text: plain, via: "plaintext_fallback", ok: true };

  const lo = _tryLibreOffice(filePath);
  if (lo !== null) return { text: lo, via: "libreoffice_fallback", ok: true };

  return {
    text: "",
    via: "none",
    ok: false,
    error: `no parser available for ${suffix || "(no extension)"}`,
  };
}

// --- internals ---

async function _tryPdfjs(filePath) {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => it.str || "").join(" "));
    }
    return parts.join("\n");
  } catch {
    return null;
  }
}

async function _tryMammoth(filePath) {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  } catch {
    return null; // mammoth not installed OR file unreadable
  }
}

async function _tryWordExtractor(filePath) {
  try {
    const { default: WordExtractor } = await import("word-extractor");
    const extractor = new WordExtractor();
    const doc = await extractor.extract(filePath);
    return doc.getBody() || "";
  } catch {
    return null;
  }
}

function _tryPlaintext(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // Heuristic: if the buffer parses as UTF-8 cleanly (no replacement
    // characters), use it. Otherwise try GBK for CJK corpora.
    const utf8 = buf.toString("utf-8");
    if (!utf8.includes("�")) return utf8;
    // GBK fallback (only commonly relevant on Chinese corpora)
    try {
      // Node has TextDecoder("gbk") via ICU on most builds
      const gbk = new TextDecoder("gbk", { fatal: false }).decode(buf);
      if (gbk && !gbk.includes("�")) return gbk;
    } catch { /* GBK not supported on this Node build */ }
    // Last resort: return UTF-8 with replacement characters; caller
    // can decide whether to use it.
    return utf8;
  } catch {
    return null;
  }
}

function _tryLibreOffice(filePath) {
  // soffice/libreoffice CLI fallback. Best-effort; returns null on any
  // failure so caller falls back to "no parser available."
  const lo = _findLibreOffice();
  if (!lo) return null;
  try {
    const outDir = path.join(path.dirname(filePath), ".kc-lo-out");
    fs.mkdirSync(outDir, { recursive: true });
    const r = spawnSync(
      lo,
      ["--headless", "--convert-to", "txt", "--outdir", outDir, filePath],
      { timeout: 60_000 },
    );
    if (r.status !== 0) return null;
    const stem = path.basename(filePath, path.extname(filePath));
    const out = path.join(outDir, stem + ".txt");
    if (!fs.existsSync(out)) return null;
    const text = fs.readFileSync(out, "utf-8");
    // Best-effort cleanup of the conversion output
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    return text;
  } catch {
    return null;
  }
}

function _findLibreOffice() {
  // Use which/where heuristic — synchronous, fine at extract-time.
  const candidates = ["soffice", "libreoffice"];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["--version"], { timeout: 5_000 });
      if (r.status === 0) return cmd;
    } catch { /* not on PATH */ }
  }
  return null;
}
