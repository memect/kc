/**
 * Onion-peeler chunker with virtual-root multi-file bundle support.
 *
 * Ported from archive/pr_verify_app/backend/shared/chunker.py. The Python
 * version is battle-tested across E2E #3 and the AMC verification app's
 * ~378-task run; this is a faithful Node translation kept close to the
 * original so future AMC-side fixes port cleanly.
 *
 * Shape:
 *
 *   root (bundle)
 *     ├── file: foo.pdf
 *     │     ├── §1 重要提示
 *     │     ├── §2 产品概况
 *     │     │     └── 2.1 名称...
 *     │     └── §3 财务指标
 *     └── file: bar.xlsx
 *           └── (single leaf — non-paged doc)
 *
 * - Each leaf carries `pageRange: [start, end]` in the source file.
 * - Leaves are bounded by `maxTokensPerChunk` (default 2000 ≈ 5000 chars CJK).
 * - A CJK-bigram + English-word keyword index maps tokens → chunkIds for
 *   O(1) RAG lookup without embedding models.
 * - Output is JSON-serializable for disk caching.
 */

// ------------------ Constants ------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;
const TOKEN_CHARS = 2.5; // CJK-heavy rough estimate; matches Python side

// Chinese + English tokenizers for the keyword index.
const CJK_CHUNK_RE = /[\u4e00-\u9fff]{2,}/g;
const EN_WORD_RE = /[A-Za-z][A-Za-z0-9_-]{2,}/g;

export function estimateTokens(text) {
  if (!text) return 1;
  return Math.max(1, Math.floor(text.length / TOKEN_CHARS));
}

// ------------------ BundleTree ------------------

/**
 * A chunk is a plain JS object with the shape:
 *   {
 *     chunk_id, kind, title,
 *     header_path: [],
 *     source_file, page_range: [start, end],
 *     children: [chunkId], content, tokens
 *   }
 * Kept as a plain object (not a class) so JSON (de)serialization is trivial.
 */

export class BundleTree {
  constructor({ rootId, chunks, keywordIndex, leavesOrder }) {
    this.root_id = rootId;
    this.chunks = chunks;
    this.keyword_index = keywordIndex;
    this.leaves_order = leavesOrder;
  }

  toJSON() {
    return {
      root_id: this.root_id,
      chunks: this.chunks,
      keyword_index: this.keyword_index,
      leaves_order: this.leaves_order,
    };
  }

  static fromJSON(obj) {
    return new BundleTree({
      rootId: obj.root_id,
      chunks: obj.chunks,
      keywordIndex: obj.keyword_index,
      leavesOrder: obj.leaves_order,
    });
  }

  // --- Query API (mirrors chunker.py BundleTree) ---

  get(chunkId) {
    return this.chunks[chunkId] || null;
  }

  /**
   * Compact textual outline — handed to the agent so it can pick which chunks
   * to fetch. One line per node, indented by depth.
   */
  outline(maxDepth = 3) {
    const lines = [];
    const walk = (cid, depth) => {
      const ch = this.chunks[cid];
      if (!ch || depth > maxDepth) return;
      const prefix = "  ".repeat(depth);
      let label;
      if (ch.kind === "root") label = "📦 bundle";
      else if (ch.kind === "file") label = `📄 ${ch.source_file || ch.title || ""}`;
      else if (ch.kind === "section") label = `§ ${ch.title}`;
      else if (ch.kind === "leaf") label = `• ${ch.title} [${ch.chunk_id}]`;
      else label = ch.title || "";

      const pr = ch.page_range || [1, 1];
      const loc = ch.kind === "leaf" && pr[0] > 1 ? ` (p.${pr[0]})` : "";
      if (ch.kind === "leaf") {
        lines.push(`${prefix}${label}${loc} · ${ch.tokens || 0} tokens`);
      } else {
        lines.push(`${prefix}${label}`);
      }
      for (const childId of ch.children || []) walk(childId, depth + 1);
    };
    walk(this.root_id, 0);
    return lines.join("\n");
  }

  /**
   * Score leaves by how many of the keywords hit them (index + substring
   * fallback for multi-word phrases). Return up to `limit` ranked results.
   */
  search(keywords, limit = 8) {
    if (!Array.isArray(keywords) || keywords.length === 0) return [];
    const kws = keywords
      .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
      .filter(Boolean);
    if (kws.length === 0) return [];

    const scores = new Map();
    for (const kw of kws) {
      const hits = this.keyword_index[kw] || [];
      for (const cid of hits) {
        scores.set(cid, (scores.get(cid) || 0) + 1);
      }
    }

    // Substring fallback for keywords not in the index (e.g. multi-word phrases).
    const indexed = new Set(Object.keys(this.keyword_index));
    const unindexed = kws.filter((k) => !indexed.has(k));
    if (unindexed.length > 0) {
      for (const cid of this.leaves_order) {
        const ch = this.chunks[cid];
        if (!ch) continue;
        const hay = ((ch.content || "") + "\n" + (ch.header_path || []).join("/"))
          .toLowerCase();
        for (const kw of unindexed) {
          if (hay.includes(kw)) {
            scores.set(cid, (scores.get(cid) || 0) + 1);
          }
        }
      }
    }

    // Rank: higher score first, then document order.
    const positionOf = new Map(this.leaves_order.map((cid, i) => [cid, i]));
    const ranked = Array.from(scores.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const pa = positionOf.get(a[0]) ?? Infinity;
      const pb = positionOf.get(b[0]) ?? Infinity;
      return pa - pb;
    });

    return ranked.slice(0, limit).map(([cid]) => this.chunks[cid]);
  }

  allLeaves() {
    return this.leaves_order.map((cid) => this.chunks[cid]).filter(Boolean);
  }

  /** Direct children of the synthetic root (one entry per input file). */
  files() {
    const root = this.chunks[this.root_id];
    if (!root) return [];
    return (root.children || []).map((cid) => this.chunks[cid]).filter(Boolean);
  }
}

// ------------------ Builder ------------------

/**
 * Build a BundleTree from parsed files.
 *
 * @param {Array<{source_file: string, total_pages: number, blocks: Array<{page: number, markdown: string}>, parse_error?: string}>} parsedFiles
 * @param {{ maxTokensPerChunk?: number }} [opts]
 * @returns {BundleTree}
 */
export function buildBundleTree(parsedFiles, { maxTokensPerChunk = 2000 } = {}) {
  const chunks = {};
  const leavesOrder = [];

  const add = (ch) => {
    chunks[ch.chunk_id] = ch;
    if (ch.kind === "leaf") leavesOrder.push(ch.chunk_id);
    return ch.chunk_id;
  };

  // Root
  const rootId = "bundle_root";
  add({
    chunk_id: rootId, kind: "root", title: "文档包（Bundle）",
    header_path: [], source_file: "", page_range: [1, 1], children: [],
    content: "", tokens: 0,
  });

  parsedFiles.forEach((pf, pfIdx) => {
    // Parse-error placeholder leaf
    if ((!pf.blocks || pf.blocks.length === 0) && pf.parse_error) {
      const errId = `file${String(pfIdx).padStart(2, "0")}_error`;
      add({
        chunk_id: errId, kind: "leaf",
        title: `${pf.source_file} (解析失败)`,
        source_file: pf.source_file, page_range: [1, 1],
        content: `[parse error] ${pf.parse_error}`,
        tokens: estimateTokens(pf.parse_error || ""),
        header_path: [`${pf.source_file} (解析失败)`],
        children: [],
      });
      chunks[rootId].children.push(errId);
      return;
    }

    // File node
    const fileChunkId = `file${String(pfIdx).padStart(2, "0")}`;
    add({
      chunk_id: fileChunkId, kind: "file", title: pf.source_file,
      source_file: pf.source_file,
      page_range: [1, pf.total_pages || 1],
      header_path: [], content: "", tokens: 0, children: [],
    });
    chunks[rootId].children.push(fileChunkId);

    // Per-file section tree
    const sectionsRoot = parseFileIntoSections(pf);
    emitSections({
      parentChunkId: fileChunkId,
      node: sectionsRoot,
      pf,
      chunks,
      leavesOrder,
      maxTokens: maxTokensPerChunk,
      counter: { n: 0 },
      filePrefix: fileChunkId,
      headerAncestry: [],
    });
  });

  const keywordIndex = buildKeywordIndex(chunks, leavesOrder);

  return new BundleTree({
    rootId,
    chunks,
    keywordIndex,
    leavesOrder,
  });
}

// ------------------ Per-file section tree ------------------

/**
 * Internal section node used during tree construction. Not serialized.
 *
 * @typedef {{
 *   header: string,
 *   level: number,
 *   body: string,
 *   page_range: [number, number],
 *   children: SectionNode[],
 * }} SectionNode
 */

function parseFileIntoSections(pf) {
  // Concatenate blocks with page separators, tracking (start, end, page).
  const fullParts = [];
  const pageMap = []; // [start, end, page]
  let cum = 0;
  for (const b of pf.blocks) {
    const body = b.markdown || "";
    const start = cum;
    cum += body.length + 2; // + "\n\n"
    pageMap.push([start, cum, b.page]);
    fullParts.push(body);
  }
  const fullText = fullParts.join("\n\n");

  // All markdown headers
  const headers = []; // [start, end, level, title]
  HEADING_RE.lastIndex = 0;
  let m;
  while ((m = HEADING_RE.exec(fullText)) !== null) {
    headers.push([m.index, m.index + m[0].length, m[1].length, m[2].trim()]);
  }

  // Segments: (start, end, level, title)
  const segments = [];
  if (headers.length === 0) {
    segments.push([0, fullText.length, 1, ""]);
  } else {
    if (headers[0][0] > 0) segments.push([0, headers[0][0], 1, ""]);
    for (let i = 0; i < headers.length; i++) {
      const [, eHdr, lvl, title] = headers[i];
      const bodyStart = eHdr;
      const bodyEnd = i + 1 < headers.length ? headers[i + 1][0] : fullText.length;
      segments.push([bodyStart, bodyEnd, lvl, title]);
    }
  }

  const root = { header: "", level: 0, body: "", page_range: [1, 1], children: [] };
  const stack = [root];
  for (const [start, end, level, title] of segments) {
    const body = fullText.slice(start, end).trim();
    const pr = pageRange(start, end, pageMap);
    const node = { header: title, level, body, page_range: pr, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (stack.length === 0) stack.push(root);
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function pageRange(start, end, pageMap) {
  if (pageMap.length === 0) return [1, 1];
  let first = pageMap[pageMap.length - 1][2];
  let last = pageMap[0][2];
  for (const [s, e, p] of pageMap) {
    if (s <= start && start < e && p < first) first = p;
  }
  for (const [s, e, p] of pageMap) {
    if (s < end && end <= e && p > last) last = p;
    else if (s < end) last = Math.max(last, p);
  }
  first = Math.max(1, Math.min(first, last));
  return [first, last];
}

// ------------------ Emit chunks recursively ------------------

function subtreeTokens(node) {
  let n = estimateTokens(node.body);
  for (const c of node.children) n += subtreeTokens(c);
  return n;
}

function emitSections({
  parentChunkId, node, pf, chunks, leavesOrder,
  maxTokens, counter, filePrefix, headerAncestry,
}) {
  // Whole subtree fits → single leaf
  if (subtreeTokens(node) <= maxTokens && (node.body || node.children.length > 0)) {
    const bodyParts = [];
    if (node.header && node.level > 0) {
      bodyParts.push(`${"#".repeat(node.level)} ${node.header}`);
    }
    if (node.body.trim()) bodyParts.push(node.body.trim());

    const walkBody = (child) => {
      if (child.header && child.level > 0) {
        bodyParts.push(`${"#".repeat(child.level)} ${child.header}`);
      }
      if (child.body.trim()) bodyParts.push(child.body.trim());
      for (const c of child.children) walkBody(c);
    };
    for (const c of node.children) walkBody(c);

    // Union page range across entire subtree
    const pr = [node.page_range[0], node.page_range[1]];
    const unionPr = (nn) => {
      pr[0] = Math.min(pr[0], nn.page_range[0]);
      pr[1] = Math.max(pr[1], nn.page_range[1]);
      for (const c of nn.children) unionPr(c);
    };
    unionPr(node);

    counter.n += 1;
    const leafId = `${filePrefix}_c${String(counter.n).padStart(3, "0")}`;
    const title =
      node.header ||
      deriveTitle(bodyParts[0] || "") ||
      `段落 ${counter.n}`;
    const fullContent = bodyParts.join("\n\n").trim();
    const ch = {
      chunk_id: leafId, kind: "leaf", title,
      source_file: pf.source_file, page_range: pr,
      content: fullContent,
      tokens: estimateTokens(fullContent),
      header_path: [...headerAncestry, ...(node.header ? [node.header] : [])],
      children: [],
    };
    chunks[leafId] = ch;
    leavesOrder.push(leafId);
    chunks[parentChunkId].children.push(leafId);
    return;
  }

  // Too large → emit as section, recurse into children
  const myAncestry = [...headerAncestry, ...(node.header ? [node.header] : [])];

  // Own body → size-bounded leaves
  if (node.body.trim()) {
    for (const [splitBody, splitPr] of splitTextIntoSizedParts(
      node.body, node.page_range, maxTokens,
    )) {
      counter.n += 1;
      const leafId = `${filePrefix}_c${String(counter.n).padStart(3, "0")}`;
      const firstLineTitle = deriveTitle(splitBody) || node.header || `段落 ${counter.n}`;
      const prefixHeader =
        node.header && node.level > 0 ? `${"#".repeat(node.level)} ${node.header}\n\n` : "";
      const fullContent = (prefixHeader + splitBody).trim();
      const ch = {
        chunk_id: leafId, kind: "leaf",
        title: node.header || firstLineTitle,
        source_file: pf.source_file, page_range: splitPr,
        content: fullContent,
        tokens: estimateTokens(fullContent),
        header_path: myAncestry,
        children: [],
      };
      chunks[leafId] = ch;
      leavesOrder.push(leafId);
      chunks[parentChunkId].children.push(leafId);
    }
  }

  // Children → section container + recurse
  if (node.children.length > 0) {
    if (
      node.level > 0 &&
      (node.body.trim() || !sectionAlreadyEmitted(chunks, parentChunkId, node.header))
    ) {
      const sectionId = `${filePrefix}_s${String(Object.keys(chunks).length).padStart(4, "0")}`;
      chunks[sectionId] = {
        chunk_id: sectionId, kind: "section",
        title: node.header || "(无标题段)",
        source_file: pf.source_file,
        page_range: [node.page_range[0], node.page_range[1]],
        header_path: myAncestry,
        children: [], content: "", tokens: 0,
      };
      chunks[parentChunkId].children.push(sectionId);
      for (const child of node.children) {
        emitSections({
          parentChunkId: sectionId, node: child, pf, chunks, leavesOrder,
          maxTokens, counter, filePrefix, headerAncestry: myAncestry,
        });
      }
    } else {
      for (const child of node.children) {
        emitSections({
          parentChunkId, node: child, pf, chunks, leavesOrder,
          maxTokens, counter, filePrefix, headerAncestry: myAncestry,
        });
      }
    }
  }
}

function sectionAlreadyEmitted(chunks, parentId, header) {
  if (!header) return false;
  const parent = chunks[parentId];
  if (!parent) return false;
  for (const cid of parent.children || []) {
    const ch = chunks[cid];
    if (ch && ch.title === header && ch.kind === "section") return true;
  }
  return false;
}

function deriveTitle(text) {
  if (!text) return "";
  for (const line of text.split("\n")) {
    const stripped = line.trim().replace(/^#+/, "").trim();
    if (stripped) return stripped.slice(0, 60);
  }
  return "";
}

function splitTextIntoSizedParts(text, pageRangeArr, maxTokens) {
  if (estimateTokens(text) <= maxTokens) {
    return [[text, [pageRangeArr[0], pageRangeArr[1]]]];
  }
  const maxChars = Math.floor(maxTokens * TOKEN_CHARS);
  const parts = [];
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  let buf = [];
  let bufLen = 0;
  for (const p of paragraphs) {
    if (bufLen + p.length + 2 > maxChars && buf.length > 0) {
      parts.push([buf.join("\n\n"), [pageRangeArr[0], pageRangeArr[1]]]);
      buf = [];
      bufLen = 0;
    }
    buf.push(p);
    bufLen += p.length + 2;
  }
  if (buf.length > 0) {
    parts.push([buf.join("\n\n"), [pageRangeArr[0], pageRangeArr[1]]]);
  }

  // Hard-slice any paragraph that's still too big
  const final = [];
  for (const [chunk, pr] of parts) {
    if (estimateTokens(chunk) <= maxTokens) {
      final.push([chunk, pr]);
      continue;
    }
    for (let i = 0; i < chunk.length; i += maxChars) {
      final.push([chunk.slice(i, i + maxChars), pr]);
    }
  }
  return final;
}

// ------------------ Keyword index ------------------

/**
 * CJK + English tokenization. For CJK, use 2-character sliding windows so
 * "现金管理" matches "现金管理类"; for English, lowercase word tokens.
 */
export function tokenizeForIndex(text) {
  const out = new Set();
  if (!text) return out;
  const cjkMatches = text.match(CJK_CHUNK_RE) || [];
  for (const m of cjkMatches) {
    for (let i = 0; i < m.length - 1; i++) {
      out.add(m.slice(i, i + 2));
    }
  }
  const enMatches = text.match(EN_WORD_RE) || [];
  for (const m of enMatches) {
    out.add(m.toLowerCase());
  }
  return out;
}

function buildKeywordIndex(chunks, leavesOrder) {
  const idx = {};
  for (const cid of leavesOrder) {
    const ch = chunks[cid];
    if (!ch) continue;
    const hay = [
      ch.title || "",
      (ch.header_path || []).join("/"),
      (ch.content || "").slice(0, 2000),
    ].join(" ");
    const tokens = tokenizeForIndex(hay);
    for (const t of tokens) {
      if (!idx[t]) idx[t] = [];
      idx[t].push(cid);
    }
  }
  return idx;
}
