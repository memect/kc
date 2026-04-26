/**
 * v0.6.2 I1: Shared workflow-result normalizer + ERROR classifier.
 *
 * E2E #4 produced 1,150 ERROR verdicts out of 6,930 (16.6%) and
 * verdict_stats keys leaked Python dataclass repr() strings like
 * "VerificationResult(rule_id='R049', verdict='NOT_APPLICABLE', ...)".
 * The agent's batch aggregator was using repr(result) as a dict key
 * because the workflow's Python output was a dataclass instance, not
 * a dict.
 *
 * This module fixes the boundary: anything that comes out of a
 * workflow_run tool gets normalized to a strict dict shape before being
 * persisted or returned to the agent. Repr-strings get parsed back into
 * structured fields. ERRORs get classified into typed buckets so we can
 * tell "import failed" from "extraction returned wrong shape" without
 * reading 1,150 stack traces.
 */

/**
 * The required shape every workflow result must satisfy. Unknown extra
 * keys are preserved.
 */
export const REQUIRED_KEYS = ["rule_id", "verdict"];

/**
 * Canonical verdict values. Anything outside this set is allowed (the
 * worker LLM may extend) but generates a `nonstandard_verdict` warning
 * in the result's `_warnings` array.
 */
export const STANDARD_VERDICTS = new Set([
  "PASS", "FAIL", "NOT_APPLICABLE", "SUPPLEMENT_NEEDED", "ERROR", "UNKNOWN",
]);

/**
 * Recognized error_type values used by classifyError(). Add to this set
 * when adding a new pattern below.
 */
export const ERROR_TYPES = [
  "import_error",
  "attribute_error",
  "keyword_not_found",
  "sample_unparseable",
  "schema_violation",
  "syntax_error",
  "timeout",
  "permission_error",
  "unknown",
];

/**
 * Detect whether a string looks like a Python dataclass repr —
 * `ClassName(field=value, field=value)`. Used both as a top-level
 * detector and recursively inside dict keys.
 */
const REPR_PATTERN = /^([A-Za-z_]\w*)\((.*)\)$/s;

/**
 * Parse a Python-repr string into { class_name, fields: { ... } }.
 * Field values are kept as strings (we don't try to re-type them — the
 * downstream consumer can JSON.parse if needed). Returns null if the
 * input doesn't look like a repr.
 *
 * Example:
 *   parsePyRepr("VerificationResult(rule_id='R049', verdict='NOT_APPLICABLE')")
 *   → { class_name: 'VerificationResult', fields: { rule_id: "'R049'", verdict: "'NOT_APPLICABLE'" } }
 */
export function parsePyRepr(s) {
  if (typeof s !== "string") return null;
  const m = s.match(REPR_PATTERN);
  if (!m) return null;
  const className = m[1];
  const body = m[2];
  // Tokenize on top-level commas (ignore commas inside brackets/quotes)
  const fields = {};
  let depth = 0;
  let inQuote = null;
  let buf = "";
  let key = null;
  const flush = () => {
    if (!buf.trim()) return;
    if (key == null) {
      // No `=` seen — entry was positional, skip
      buf = "";
      return;
    }
    fields[key] = buf.trim();
    key = null;
    buf = "";
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuote) {
      buf += c;
      if (c === inQuote && body[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (c === "'" || c === '"') { inQuote = c; buf += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "=" && depth === 0 && key == null) {
      key = buf.trim();
      buf = "";
      continue;
    }
    if (c === "," && depth === 0) { flush(); continue; }
    buf += c;
  }
  flush();
  return { class_name: className, fields };
}

/**
 * Recursively replace any dict key that looks like a Python repr with
 * a structured object. Also handles arrays. Mutates in place but also
 * returns the input for chaining.
 */
export function normalizeReprKeys(obj) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => { obj[i] = normalizeReprKeys(v); });
    return obj;
  }
  if (obj && typeof obj === "object") {
    const newObj = {};
    for (const [k, v] of Object.entries(obj)) {
      const parsed = parsePyRepr(k);
      if (parsed) {
        // Merge under a class-name bucket. Multiple repr keys for the
        // same class collapse to a counter (because verdict_stats just
        // wanted distinct buckets).
        const bucket = newObj[parsed.class_name] || (newObj[parsed.class_name] = []);
        bucket.push({ fields: parsed.fields, count: typeof v === "number" ? v : 1 });
      } else {
        newObj[k] = normalizeReprKeys(v);
      }
    }
    return newObj;
  }
  return obj;
}

/**
 * Classify an ERROR result by inferring `error_type` from the raw_output
 * stack trace or message. Returns one of ERROR_TYPES.
 *
 * Conservative — when in doubt, return "unknown" rather than guess wrong.
 */
export function classifyError(rawOutput) {
  if (!rawOutput || typeof rawOutput !== "string") return "unknown";
  const s = rawOutput;
  if (/ModuleNotFoundError|ImportError|No module named/i.test(s)) return "import_error";
  if (/AttributeError/i.test(s)) return "attribute_error";
  if (/SyntaxError|invalid syntax|unexpected character/i.test(s)) return "syntax_error";
  if (/PermissionError|permission denied/i.test(s)) return "permission_error";
  if (/timed out|timeout|Timeout/i.test(s)) return "timeout";
  // sample parse failures usually mention pdfjs / docx / json
  if (/pdfjs|docx|json\.decoder|JSONDecodeError|UnicodeDecodeError/i.test(s)) return "sample_unparseable";
  // schema violations from our own normalizer would have a hint
  if (/schema_violation|missing required key/i.test(s)) return "schema_violation";
  // Common keyword-not-found signal: the workflow returned no match
  if (/no match|not found|未找到|关键词未匹配/i.test(s)) return "keyword_not_found";
  return "unknown";
}

/**
 * Normalize a parsed workflow-output object to the canonical dict shape.
 * - Ensures `rule_id` and `verdict` are present.
 * - Strips repr-string keys (delegates to normalizeReprKeys).
 * - If verdict is "ERROR" or the parse fell back to raw_output, attaches
 *   `error_type` from classifyError().
 * - Records issues in `_warnings: string[]` so the consumer (and the
 *   agent reading the tool result) can see them.
 *
 * Inputs:
 *   parsed      — what JSON.parse yielded (may already be a dict, or be
 *                 the raw_output fallback object)
 *   ruleId      — what the caller knows the rule_id should be
 *   rawOutput   — the original stdout (used for ERROR classification)
 *
 * Returns the normalized result. Always returns a dict with `rule_id`
 * and `verdict`. Never throws.
 */
export function normalizeWorkflowResult(parsed, ruleId, rawOutput) {
  const warnings = [];
  let result;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    result = { ...parsed };
  } else if (typeof parsed === "string") {
    // Parsed yielded a string — could be a repr at top level
    const repr = parsePyRepr(parsed);
    if (repr) {
      // Strip Python's surrounding quote chars from string values so
      // STANDARD_VERDICTS comparisons work and downstream code doesn't
      // see "'PASS'" instead of "PASS". Conservative: only unwrap when
      // the entire value is wrapped in matching ' or " quotes.
      const stripped = {};
      for (const [k, v] of Object.entries(repr.fields)) {
        if (typeof v === "string" && /^(['"]).*\1$/s.test(v) && v.length >= 2) {
          stripped[k] = v.slice(1, -1);
        } else {
          stripped[k] = v;
        }
      }
      result = stripped;
      result._source_class = repr.class_name;
      warnings.push("toplevel_repr_string");
    } else {
      result = { raw_output: parsed.slice(0, 5000) };
      warnings.push("toplevel_string");
    }
  } else {
    result = { raw_output: String(parsed ?? "").slice(0, 5000) };
    warnings.push("toplevel_nonobject");
  }

  // Recursively normalize repr keys in nested dicts (verdict_stats, etc.)
  normalizeReprKeys(result);

  // rule_id: prefer the caller-supplied value (it's authoritative)
  if (ruleId) result.rule_id = ruleId;
  else if (typeof result.rule_id !== "string") {
    result.rule_id = "unknown";
    warnings.push("missing_rule_id");
  }

  // verdict: ensure present and canonical-or-warn
  if (typeof result.verdict !== "string" || result.verdict === "") {
    // If the workflow fell into raw_output fallback, mark as ERROR
    if (result.raw_output) {
      result.verdict = "ERROR";
    } else {
      result.verdict = "UNKNOWN";
      warnings.push("missing_verdict");
    }
  } else if (!STANDARD_VERDICTS.has(result.verdict)) {
    warnings.push("nonstandard_verdict");
  }

  // ERROR classification
  if (result.verdict === "ERROR") {
    const trace = rawOutput || result.raw_output || result.error || "";
    result.error_type = classifyError(trace);
  }

  if (warnings.length > 0) {
    result._warnings = (result._warnings || []).concat(warnings);
  }

  return result;
}
