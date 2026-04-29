import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";
import { normalizeRuleCatalog } from "../rule-catalog-normalize.js";

const REQUIRED_FIELDS = new Set(["id", "source_ref", "description"]);
const RECOMMENDED_FIELDS = new Set(["falsifiability_statement", "test_case_stub", "applicable_sections"]);

// Field-name aliases — LLMs frequently produce `source` or 来源 instead of
// `source_ref`, `desc` instead of `description`. Rather than making 38+ failed
// calls before the model figures out the canonical names (as observed in the
// v0.5.3 E2E test), accept the common aliases and canonicalize on ingest.
const FIELD_ALIASES = {
  source: "source_ref",
  reference: "source_ref",
  ref: "source_ref",
  "来源": "source_ref",
  desc: "description",
  "描述": "description",
  rule_id: "id",
  ruleId: "id",
};

function normalizeRuleData(data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (out[alias] !== undefined && out[canonical] === undefined) {
      out[canonical] = out[alias];
    }
  }
  return out;
}

function missingFieldError(missing, data) {
  // Concrete, actionable error. The generic "Missing required fields: id,
  // source_ref, description" confused agents (they couldn't tell which field
  // they'd actually failed to provide). Point at the first missing field, name
  // what was supplied, and mention the aliases so the model can self-correct.
  const provided = Object.keys(data || {}).slice(0, 8).join(", ") || "(none)";
  const first = missing[0];
  const rest = missing.length > 1 ? ` (also missing: ${missing.slice(1).join(", ")})` : "";
  return (
    `Missing field '${first}' in data.${rest} ` +
    `Provided keys: {${provided}}. ` +
    `Accepted aliases: source/来源/reference → source_ref, desc/描述 → description, rule_id → id.`
  );
}

/**
 * CRUD on the rule registry with schema enforcement.
 * Enforces required fields (id, source_ref, description) on create/update.
 * Persists to rules/catalog.json.
 */
export class RuleCatalogTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    // v0.6.3: do NOT cache the absolute path here. engine.renameSession()
    // moves the workspace dir via fs.renameSync and updates this._workspace.cwd
    // via Workspace.rename(), but tool instances live in the registry and
    // never see the cascade — a cached _catalogPath would keep writing to the
    // pre-rename absolute path, mkdir-recreating the orphaned directory and
    // stranding all rule_catalog state. Resolve on every call instead.
  }

  /** Always read workspace.cwd at call time so /rename is followed. */
  get _catalogPath() {
    return path.join(this._workspace.cwd, "rules", "catalog.json");
  }

  get name() { return "rule_catalog"; }
  get description() {
    return (
      "CRUD on the rule registry. Operations: create, read, update, delete, list. " +
      "Enforces required fields (id, source_ref, description) on create/update. " +
      "Persists to rules/catalog.json."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["create", "read", "update", "delete", "list"], description: "Operation to perform" },
        rule_id: { type: "string", description: "Rule ID (for read/update/delete)" },
        data: { type: "object", description: "Rule data (for create/update). Must include: id, source_ref, description" },
      },
      required: ["operation"],
    };
  }

  async execute(input) {
    const op = input.operation || "";
    const ruleId = input.rule_id || "";
    const data = input.data || {};

    // read operations don't need the lock — they're read-only
    if (op === "list") return this._list();
    if (op === "read") return this._read(ruleId || data.id || "");

    // B9: write operations acquire the catalog lock so concurrent engines
    // (main + subagents + sandbox_exec-via-workspace_file) serialize their
    // read-modify-write on catalog.json. Without this, two writers can
    // both read N rules, one writes N+1, the other writes N+1 of its own,
    // and one write is silently lost — exactly what we saw in session
    // 6304673afaa0 thrashing catalog rule counts.
    if (op === "create") {
      return this._workspace.withFileLock("rules/catalog.json", () => this._create(data));
    }
    if (op === "update") {
      return this._workspace.withFileLock("rules/catalog.json", () => this._update(ruleId || data.id || "", data));
    }
    if (op === "delete") {
      return this._workspace.withFileLock("rules/catalog.json", () => this._delete(ruleId || data.id || ""));
    }
    // More helpful than "Unknown operation: " — tells the agent exactly what's
    // allowed and what shape to call with next time (observed in v0.5.3 E2E
    // where GLM-5.1 sent input: {} 38+ times without learning).
    return new ToolResult(
      `rule_catalog requires {operation}. Got: ${op ? `'${op}'` : "(empty)"}. ` +
      `Valid operations: list, read, create, update, delete. ` +
      `Examples: {"operation":"list"} · {"operation":"create","data":{"id":"R-01","source_ref":"民法典 710","description":"..."}}`,
      true,
    );
  }

  _load() {
    if (!fs.existsSync(this._catalogPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this._catalogPath, "utf-8"));
      return normalizeRuleCatalog(data);
    } catch { return []; }
  }

  _save(rules) {
    fs.mkdirSync(path.dirname(this._catalogPath), { recursive: true });
    fs.writeFileSync(this._catalogPath, JSON.stringify(rules, null, 2), "utf-8");
  }

  _list() {
    const rules = this._load();
    if (rules.length === 0) return new ToolResult("Catalog is empty. Use create to add rules.");
    const summary = rules.map((r) => `- ${r.id || "?"}: ${(r.description || "(no description)").slice(0, 80)}`);
    return new ToolResult(`${rules.length} rule(s):\n${summary.join("\n")}`);
  }

  _read(ruleId) {
    if (!ruleId) return new ToolResult("rule_id required for read", true);
    const rule = this._load().find((r) => r.id === ruleId);
    if (!rule) return new ToolResult(`Rule not found: ${ruleId}`, true);
    return new ToolResult(JSON.stringify(rule, null, 2));
  }

  _create(data) {
    data = normalizeRuleData(data);
    const missing = [...REQUIRED_FIELDS].filter((f) => !data[f]);
    if (missing.length > 0) return new ToolResult(missingFieldError(missing, data), true);
    const rules = this._load();
    if (rules.some((r) => r.id === data.id)) return new ToolResult(`Rule already exists: ${data.id}. Use update.`, true);
    const warnings = [...RECOMMENDED_FIELDS].filter((f) => !(f in data));
    rules.push(data);
    this._save(rules);
    let msg = `Created rule: ${data.id}`;
    if (warnings.length > 0) msg += `\nMissing recommended fields: ${warnings.join(", ")}`;
    return new ToolResult(msg);
  }

  _update(ruleId, data) {
    if (!ruleId) return new ToolResult("rule_id required for update", true);
    data = normalizeRuleData(data);
    const rules = this._load();
    const idx = rules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return new ToolResult(`Rule not found: ${ruleId}`, true);
    Object.assign(rules[idx], data);
    rules[idx].id = ruleId;
    this._save(rules);
    return new ToolResult(`Updated rule: ${ruleId}`);
  }

  _delete(ruleId) {
    if (!ruleId) return new ToolResult("rule_id required for delete", true);
    const rules = this._load();
    const newRules = rules.filter((r) => r.id !== ruleId);
    if (newRules.length === rules.length) return new ToolResult(`Rule not found: ${ruleId}`, true);
    this._save(newRules);
    return new ToolResult(`Deleted rule: ${ruleId}`);
  }
}
