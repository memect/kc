import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Run one structured iteration of the evolution loop.
 * Enforces: diagnose -> classify -> fix instructions -> log.
 * Classification is CODE: counts failure rate, applies threshold.
 * Routes corner cases to CornerCaseRegistry automatically.
 */
export class EvolutionCycleTool extends BaseTool {
  constructor(workspace, cornerCases) {
    super();
    this._workspace = workspace;
    this._cornerCases = cornerCases;
  }

  get name() { return "evolution_cycle"; }
  get description() {
    return (
      "Run one structured iteration of diagnose -> classify -> fix -> log. " +
      "Provide test results with failures. The tool classifies failures as " +
      "systemic (>10%) or corner case (<10%), routes corner cases to the " +
      "registry, and saves a structured evolution log entry."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "Rule being evolved" },
        total_test_docs: { type: "integer", description: "Total number of documents tested" },
        failed_docs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              doc_id: { type: "string" },
              diagnosis: { type: "string", enum: ["parsing", "extraction", "judgment", "scope"] },
              root_cause: { type: "string" },
            },
          },
          description: "List of failed documents with diagnosis",
        },
        accuracy_before: { type: "number", description: "Accuracy before this cycle" },
        fix_applied: { type: "string", description: "Description of the fix applied (or planned)" },
      },
      required: ["rule_id", "total_test_docs", "failed_docs", "accuracy_before"],
    };
  }

  async execute(input) {
    const ruleId = input.rule_id || "";
    const total = input.total_test_docs || 0;
    const failures = input.failed_docs || [];
    const accuracyBefore = input.accuracy_before || 0;
    const fixApplied = input.fix_applied || "";

    if (!ruleId || total <= 0) return new ToolResult("rule_id and total_test_docs required", true);

    // Read systemic threshold from .env
    let systemicThreshold = 0.10;
    const envPath = path.join(this._workspace.cwd, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("SYSTEMIC_THRESHOLD=")) {
          try { systemicThreshold = parseFloat(line.split("=")[1].trim()); }
          catch { /* ignore */ }
        }
      }
    }

    const failureRate = failures.length / total;
    const classification = failureRate >= systemicThreshold ? "systemic" : "corner_case";

    // Check repeated patterns
    const repeatedPatterns = this._checkRepeatedPatterns(ruleId, failures);

    // Route corner cases to registry
    const cornerCasesAdded = [];
    if (classification === "corner_case") {
      for (const f of failures) {
        const c = {
          id: `CC_${ruleId}_${f.doc_id || "unknown"}`,
          ruleId,
          detectionPattern: f.root_cause || "unknown pattern",
          resolution: fixApplied || "pending fix",
          affectedDocuments: [f.doc_id || ""],
          discoveryDate: new Date().toISOString(),
          status: "active",
        };
        this._cornerCases.add(c);
        cornerCasesAdded.push(c.id);
      }
    }

    // Count iteration
    const logDir = path.join(this._workspace.cwd, "logs", "evolution");
    fs.mkdirSync(logDir, { recursive: true });
    const existing = fs.readdirSync(logDir).filter((f) => f.startsWith(`${ruleId}_iter_`));
    const iteration = existing.length + 1;

    // Build log entry
    const logEntry = {
      iteration, rule_id: ruleId, timestamp: new Date().toISOString(),
      accuracy_before: accuracyBefore, total_docs: total,
      failed_docs: failures.length, failure_rate: Math.round(failureRate * 1000) / 1000,
      classification, failures, fix_applied: fixApplied,
      corner_cases_added: cornerCasesAdded, repeated_patterns: repeatedPatterns,
    };

    const logPath = path.join(logDir, `${ruleId}_iter_${String(iteration).padStart(3, "0")}.json`);
    fs.writeFileSync(logPath, JSON.stringify(logEntry, null, 2), "utf-8");

    const response = {
      iteration, classification,
      failure_rate: `${(failureRate * 100).toFixed(1)}%`,
      action: classification === "systemic"
        ? "REWRITE component — systemic issue affecting >10% of documents"
        : `Recorded ${cornerCasesAdded.length} corner case(s) — do NOT patch main workflow`,
      repeated_patterns: repeatedPatterns,
      log_saved: path.relative(this._workspace.cwd, logPath),
    };

    if (repeatedPatterns.length > 0) {
      response.warning = "Repeated failure patterns detected. Consider escalating approach.";
    }

    return new ToolResult(JSON.stringify(response, null, 2));
  }

  _checkRepeatedPatterns(ruleId, failures) {
    const logDir = path.join(this._workspace.cwd, "logs", "evolution");
    if (!fs.existsSync(logDir)) return [];
    const currentCauses = new Set(failures.map((f) => (f.root_cause || "").toLowerCase()).filter(Boolean));
    const repeated = [];

    for (const f of fs.readdirSync(logDir).filter((f) => f.startsWith(`${ruleId}_iter_`)).sort()) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(logDir, f), "utf-8"));
        const prevCauses = new Set((data.failures || []).map((f) => (f.root_cause || "").toLowerCase()).filter(Boolean));
        for (const cause of currentCauses) {
          if (prevCauses.has(cause) && !repeated.includes(cause)) repeated.push(cause);
        }
      } catch { /* skip */ }
    }
    return repeated;
  }
}
