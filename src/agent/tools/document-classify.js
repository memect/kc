import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";
import { BundleTree } from "../bundle-tree.js";
import { LLMClient } from "../llm-client.js";

const CACHE_SUBDIR = path.join("cache", "bundles");

// Keep in sync with applicable_product_types / report_types arrays the
// extraction pipeline uses when writing rules/catalog.json.
const PRODUCT_TYPES = [
  "公募产品", "私募产品", "现金管理类",
  "理财产品", "信托计划", "保险资管产品",
];
const REPORT_TYPES = ["季报", "中报", "年报"];

const CLASSIFIER_SYSTEM = [
  "你是资管产品文档分类助理。用户提供一份文档包（一至多份文件，来自同一只",
  "资管产品 / 合同 / 公司），你需要判断：",
  "1. 产品类型（product_type）— 只能从以下取值中选一个：",
  `   ${PRODUCT_TYPES.join(", ")}`,
  "   若无法确定，填空字符串 \"\"。现金管理类优先于公募/私募（它是独立披露类别）。",
  "2. 报告类型（report_type）— 只能从以下取值中选一个：",
  `   ${REPORT_TYPES.join(", ")}`,
  "   若文档是定期公告/定期报告但未明确周期，按季报处理。若无法确定，填 \"\"。",
  "3. confidence — \"高\"/\"中\"/\"低\"",
  "4. reasoning — 一句话说明判断依据，≤60 字",
  "",
  "严格按 JSON 输出，不要包裹代码块：",
  "{\"product_type\":\"...\",\"report_type\":\"...\",\"confidence\":\"...\",\"reasoning\":\"...\"}",
].join("\n");

// Balanced-brace scan with string-awareness, for parsing LLM JSON even when
// extra prose surrounds it. Mirrors classifier.py's `_parse_classifier_response`.
const SMART_QUOTE_REPAIR = new Map([
  ["\u201c", '"'], ["\u201d", '"'],
  ["\u2018", "'"], ["\u2019", "'"],
  ["\uff02", '"'], ["\uff1a", ":"], ["\uff0c", ","],
]);

function repairSmartQuotes(s) {
  return s.replace(/[\u201c\u201d\u2018\u2019\uff02\uff1a\uff0c]/g,
    (c) => SMART_QUOTE_REPAIR.get(c) || c);
}

function extractJsonObject(raw) {
  if (!raw) return null;
  let candidate = raw.trim();
  // Strip ```json fences if present
  const fence = candidate.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) candidate = fence[1].trim();

  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  const objStr = candidate.slice(start, end);
  // Try: raw → strip trailing commas → strip + repair smart quotes
  for (const attempt of [
    objStr,
    objStr.replace(/,\s*([}\]])/g, "$1"),
    repairSmartQuotes(objStr.replace(/,\s*([}\]])/g, "$1")),
  ]) {
    try {
      const obj = JSON.parse(attempt);
      if (obj && typeof obj === "object") return obj;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Classify a BundleTree's product/report type in one LLM call, with a
 * keyword-based fallback when the LLM is unreachable or returns unparseable
 * output. The classification is cached alongside the BundleTree under
 *   <workspace>/cache/bundles/<hash>.classification.json
 * so successive calls on the same bundle are free.
 *
 * Used by the Group D applicability pre-filter: rules whose
 * `applicable_product_types` / `report_types` don't overlap with the
 * bundle classification can be skipped without a skill_authoring turn.
 */
export class DocumentClassifyTool extends BaseTool {
  constructor(workspace, config) {
    super();
    this._workspace = workspace;
    this._config = config;
  }

  get name() { return "document_classify"; }

  get description() {
    return (
      "Classify a bundle's product type (公募/私募/现金管理类/...) and report type " +
      "(季报/中报/年报) via a one-shot worker-LLM call over each file's first " +
      "~5000 chars. Falls back to keyword matching on LLM failure. Requires a " +
      "prior `document_chunk` call. Result is cached per bundle."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        cache_key: {
          type: "string",
          description:
            "BundleTree cache file name. Omit to use the most recently built bundle.",
        },
        force_refresh: {
          type: "boolean",
          description: "Re-classify even if a cached classification exists.",
        },
      },
    };
  }

  async execute(input) {
    const cacheKey = input?.cache_key || "";
    const forceRefresh = input?.force_refresh === true;

    const cacheDir = path.join(this._workspace.cwd, CACHE_SUBDIR);
    if (!fs.existsSync(cacheDir)) {
      return new ToolResult(
        "No bundle cache found. Call `document_chunk` first.",
        true,
      );
    }

    let treePath;
    if (cacheKey) {
      treePath = path.join(cacheDir, cacheKey.endsWith(".json") ? cacheKey : `${cacheKey}.json`);
      if (!fs.existsSync(treePath)) {
        return new ToolResult(`BundleTree cache not found: ${cacheKey}`, true);
      }
    } else {
      treePath = this._findMostRecentCache(cacheDir);
      if (!treePath) return new ToolResult("No bundle cache found.", true);
    }

    const classificationPath = treePath.replace(/\.json$/, ".classification.json");
    if (!forceRefresh && fs.existsSync(classificationPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(classificationPath, "utf-8"));
        return new ToolResult(this._formatResult(cached, treePath, /*cached*/ true));
      } catch { /* fall through */ }
    }

    let tree;
    try {
      tree = BundleTree.fromJSON(JSON.parse(fs.readFileSync(treePath, "utf-8")));
    } catch (e) {
      return new ToolResult(`Corrupt bundle cache: ${e.message}`, true);
    }

    // Try LLM first; fall back to keyword matching
    const result = (await this._classifyLlm(tree)) || this._classifyKeyword(tree);

    // Persist
    try {
      fs.writeFileSync(classificationPath, JSON.stringify(result, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return new ToolResult(this._formatResult(result, treePath, /*cached*/ false));
  }

  async _classifyLlm(tree) {
    // Use conductor config for classification. The main-LLM config is always
    // available; the worker LLM tier is phase-gated (distill-only) and
    // classification runs during extraction, so we intentionally use the
    // conductor here even though the AMC Python version uses a worker call.
    const apiKey = this._config?.llmApiKey || "";
    const baseUrl = this._config?.llmBaseUrl || "";
    const model = this._config?.kcModel || "";
    if (!apiKey || !baseUrl || !model) return null;

    // Build prompt: each file's head (up to 5000 chars), concatenated
    const fileBlocks = [];
    const files = tree.files();
    for (const f of files) {
      const src = f.source_file || f.title || "(未命名文件)";
      let text = "";
      for (const cid of tree.leaves_order) {
        const ch = tree.chunks[cid];
        if (!ch || ch.source_file !== src) continue;
        text += (ch.content || "") + "\n\n";
        if (text.length >= 5000) break;
      }
      fileBlocks.push(`【文件名】${src}\n【前 5000 字预览】\n${text.slice(0, 5000).trim()}`);
    }
    const userMsg =
      `=== 文档包（共 ${fileBlocks.length} 份文件）===\n\n` +
      fileBlocks.join("\n\n---\n\n") +
      "\n\n按格式输出 JSON。";

    const client = new LLMClient({
      apiKey, baseUrl,
      authType: this._config?.authType || "bearer",
      apiFormat: this._config?.apiFormat || "openai",
    });
    let resp;
    try {
      resp = await client.chat({
        model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: userMsg },
        ],
        maxTokens: 400,
      });
    } catch {
      return null;
    }

    const content = resp?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    if (!parsed) return null;

    const product = String(parsed.product_type || "").trim();
    const report = String(parsed.report_type || "").trim();
    const confidence = String(parsed.confidence || "").trim() || "中";
    const reasoning = String(parsed.reasoning || "").trim().slice(0, 200);

    return {
      product_type: product,
      report_type: report,
      confidence,
      reasoning,
      source: "llm",
      model,
    };
  }

  _classifyKeyword(tree) {
    const out = {
      product_type: "",
      report_type: "",
      confidence: "低",
      reasoning: "关键字规则匹配（LLM 分类不可用时的兜底）",
      source: "keyword_fallback",
    };
    let head = "";
    for (const cid of tree.leaves_order.slice(0, 8)) {
      const ch = tree.chunks[cid];
      head += "\n" + (ch?.content || "");
      if (head.length > 6000) break;
    }
    if (head.includes("现金管理") || head.includes("摊余成本法")) {
      out.product_type = "现金管理类";
    } else if (head.includes("公募")) out.product_type = "公募产品";
    else if (head.includes("私募") || head.includes("合格投资者")) out.product_type = "私募产品";
    else if (head.includes("理财")) out.product_type = "理财产品";
    else if (head.includes("信托")) out.product_type = "信托计划";
    else if (head.includes("保险")) out.product_type = "保险资管产品";

    if (head.includes("年度报告") || head.includes("年报")) out.report_type = "年报";
    else if (head.includes("半年度") || head.includes("中报")) out.report_type = "中报";
    else if (head.includes("季度") || head.includes("季报") ||
             head.includes("第4 季度") || head.includes("第3 季度"))
      out.report_type = "季报";
    else if (head.includes("定期公告") || head.includes("定期报告"))
      out.report_type = "季报";

    return out;
  }

  _formatResult(cls, treePath, cached) {
    const rel = path.relative(this._workspace.cwd, treePath) || treePath;
    return [
      `${cached ? "Cached" : "Fresh"} classification · bundle ${path.basename(treePath)}`,
      `  product_type : ${cls.product_type || "(unknown)"}`,
      `  report_type  : ${cls.report_type || "(unknown)"}`,
      `  confidence   : ${cls.confidence || "?"}`,
      `  source       : ${cls.source}${cls.model ? ` · ${cls.model}` : ""}`,
      `  reasoning    : ${cls.reasoning || "(none)"}`,
      "",
      `Persisted to ${rel.replace(/\.json$/, ".classification.json")}.`,
    ].join("\n");
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
