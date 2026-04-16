import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const REQUIRED_FIELDS = new Set(["id", "source_ref", "description"]);
const RECOMMENDED_FIELDS = new Set(["falsifiability_statement", "test_case_stub", "applicable_sections"]);

/**
 * CRUD on the rule registry with schema enforcement.
 * Enforces required fields (id, source_ref, description) on create/update.
 * Persists to rules/catalog.json.
 */
export class RuleCatalogTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this._catalogPath = path.join(workspace.cwd, "rules", "catalog.json");
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

    if (op === "list") return this._list();
    if (op === "read") return this._read(ruleId || data.id || "");
    if (op === "create") return this._create(data);
    if (op === "update") return this._update(ruleId || data.id || "", data);
    if (op === "delete") return this._delete(ruleId || data.id || "");
    return new ToolResult(`Unknown operation: ${op}`, true);
  }

  _load() {
    if (!fs.existsSync(this._catalogPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this._catalogPath, "utf-8"));
      return Array.isArray(data) ? data : [];
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
    const missing = [...REQUIRED_FIELDS].filter((f) => !(f in data));
    if (missing.length > 0) return new ToolResult(`Missing required fields: ${missing.join(", ")}`, true);
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
