import fs from "node:fs";
import path from "node:path";
import { PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";
import { deriveProductionQcMilestones } from "./_milestone-derive.js";

const FREQUENCY_MAP = { high: 1.0, mid: 0.5, low: 0.2 };

export class ProductionQCPipeline extends Pipeline {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this.batchesProcessed = 0;
    this.totalDocuments = 0;
    this.documentsReviewed = 0;
    this.accuracyByRule = {};
    this.confidenceDistribution = { low: 0, medium: 0, high: 0 };
    this.issuesFound = [];
    this.monitoringPhase = "initial";
    this._samplingRate = 0.5;
    this._accuracyThreshold = 0.9;
    this._scanWorkspace();
  }

  _scanWorkspace() {
    this._loadConfig();
    this._scanQcResults();
  }

  _loadConfig() {
    const envPath = path.join(this._workspace.cwd, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      if (line.startsWith("MONITOR_FREQUENCY=")) this._samplingRate = FREQUENCY_MAP[line.split("=")[1].trim().toLowerCase()] ?? 0.5;
      if (line.startsWith("WORKFLOW_ACCURACY=")) try { this._accuracyThreshold = parseFloat(line.split("=")[1]); } catch { /* skip */ }
    }
  }

  _scanQcResults() {
    // v0.7.0 A1: route through filesystem-derived helper. The helper
    // recognizes both DS-style results (object with `results` keyed by
    // rule_id, doc-paths in nested keys) AND GLM-style array-of-verdicts
    // (one entry per doc with .verdict/.file/.path) — neither matched
    // the v0.6.1 A5 heuristic alone, so E2E #5 saw batchesProcessed=0
    // even with 1,951 verdicts on disk.
    const engineDocsReviewed = this.documentsReviewed;
    const m = deriveProductionQcMilestones(this._workspace);
    this.batchesProcessed = m.batchesProcessed;
    this.documentsReviewed = m.documentsReviewed;

    // Layered: still extract accuracyByRule / confidence / issues from
    // canonical output/qc/*.json batches when present. The helper
    // doesn't try to reconstruct accuracy semantics (too schema-specific),
    // but if the agent followed canonical schema, we surface it.
    this.totalDocuments = 0;
    this.accuracyByRule = {};
    this.confidenceDistribution = { low: 0, medium: 0, high: 0 };
    this.issuesFound = [];
    const qcDir = path.join(this._workspace.cwd, "output", "qc");
    if (fs.existsSync(qcDir)) {
      for (const f of fs.readdirSync(qcDir).filter((f) => f.endsWith(".json")).sort()) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(qcDir, f), "utf-8"));
          this.totalDocuments += typeof data.documents === "number" ? data.documents : (data.total || 0);
          if (data.accuracy_by_rule) Object.assign(this.accuracyByRule, data.accuracy_by_rule);
          if (data.confidence) {
            for (const band of ["low", "medium", "high"]) this.confidenceDistribution[band] += data.confidence[band] || 0;
          }
          if (Array.isArray(data.issues)) this.issuesFound.push(...data.issues);
        } catch { /* skip */ }
      }
    }

    // Restore engine-emitted documentsReviewed if disk-derived is lower
    // (engine increment may know about reviews not yet flushed to disk)
    if (engineDocsReviewed > this.documentsReviewed) this.documentsReviewed = engineDocsReviewed;

    // Determine monitoring phase. v0.7.0 H5 fix: empty accuracyByRule
    // no longer flips to "stable" via vacuous truth — require at least
    // one rule with an accuracy reading before claiming stability.
    if (this.batchesProcessed < 3) this.monitoringPhase = "initial";
    else if (this.issuesFound.length > 0) this.monitoringPhase = "active";
    else {
      const accuracies = Object.values(this.accuracyByRule);
      if (accuracies.length > 0 && accuracies.every((a) => a >= this._accuracyThreshold)) {
        this.monitoringPhase = "stable";
      } else {
        // Helper-derived batches with no accuracy data: agent ran QC but
        // didn't surface accuracy schema. Treat as `active` (work
        // happened, but engine can't auto-bless stability).
        this.monitoringPhase = "active";
      }
    }
  }

  describeState() {
    this._scanWorkspace();
    const parts = ["## Phase: PRODUCTION_QC\nRun workflows on production documents from input/, monitor quality via confidence-based sampling. This phase transitions from active review to stable spot-checking as accuracy stabilizes."];
    parts.push(`### Progress\n- Batches: ${this.batchesProcessed}\n- Documents: ${this.totalDocuments}\n- Reviewed: ${this.documentsReviewed}\n- Monitoring: ${this.monitoringPhase}\n- Sampling rate: ${(this._samplingRate * 100).toFixed(0)}%`);

    if (Object.keys(this.accuracyByRule).length) {
      const lines = Object.entries(this.accuracyByRule).map(([r, a]) => `- ${r}: ${a}`);
      parts.push("### Accuracy by rule\n" + lines.join("\n"));
    }

    if (this.monitoringPhase === "stable") {
      parts.push("### Status: Stable monitoring. Spot-check only.");
    }
    return parts.join("\n\n");
  }

  onToolResult(toolName, toolInput, result) {
    if (result.isError) return null;
    const wasStable = this.monitoringPhase === "stable";
    if (toolName === "workspace_file" && (toolInput.path || "").includes("output/")) this._scanQcResults();
    if (!wasStable && this.monitoringPhase === "stable") {
      return new PipelineEvent({ type: "milestone", message: "Production QC reached stable monitoring phase." });
    }
    return null;
  }

  /**
   * v0.6.1 A5: gate requires at least one batch processed (real telemetry)
   * AND the legacy stable-monitoring criterion. Without the batch floor, the
   * agent could declare PRODUCTION_QC done from a clean session-state file
   * (E2E #4: phase advanced into PRODUCTION_QC, agent ran 6,930 checks via
   * sandbox_exec to non-canonical paths, batchesProcessed stayed 0, exit
   * fired anyway because monitoringPhase defaults can flip to "stable" with
   * empty accuracyByRule + zero issues).
   */
  exitCriteriaMet() {
    return this.batchesProcessed > 0 && this.monitoringPhase === "stable";
  }

  exportState() {
    return {
      batchesProcessed: this.batchesProcessed,
      totalDocuments: this.totalDocuments,
      documentsReviewed: this.documentsReviewed,
      monitoringPhase: this.monitoringPhase,
      accuracyByRule: this.accuracyByRule,
      issuesCount: this.issuesFound.length,
    };
  }

  importState(data) {
    if (typeof data.batchesProcessed === "number" && data.batchesProcessed > this.batchesProcessed) this.batchesProcessed = data.batchesProcessed;
    if (typeof data.totalDocuments === "number" && data.totalDocuments > this.totalDocuments) this.totalDocuments = data.totalDocuments;
    if (typeof data.documentsReviewed === "number" && data.documentsReviewed > this.documentsReviewed) this.documentsReviewed = data.documentsReviewed;
    if (data.monitoringPhase) this.monitoringPhase = data.monitoringPhase;
    if (data.accuracyByRule && typeof data.accuracyByRule === "object") Object.assign(this.accuracyByRule, data.accuracyByRule);
  }
}
