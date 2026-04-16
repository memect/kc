import fs from "node:fs";
import path from "node:path";
import { PipelineEvent } from "./index.js";
import { Pipeline } from "./base.js";

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
    this.batchesProcessed = 0;
    this.totalDocuments = 0;
    this.documentsReviewed = 0;
    this.accuracyByRule = {};
    this.confidenceDistribution = { low: 0, medium: 0, high: 0 };
    this.issuesFound = [];

    const qcDir = path.join(this._workspace.cwd, "output", "qc");
    if (!fs.existsSync(qcDir)) return;

    for (const f of fs.readdirSync(qcDir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(qcDir, f), "utf-8"));
        this.batchesProcessed++;
        this.totalDocuments += typeof data.documents === "number" ? data.documents : (data.total || 0);
        this.documentsReviewed += data.reviewed || 0;
        if (data.accuracy_by_rule) Object.assign(this.accuracyByRule, data.accuracy_by_rule);
        if (data.confidence) {
          for (const band of ["low", "medium", "high"]) this.confidenceDistribution[band] += data.confidence[band] || 0;
        }
        if (Array.isArray(data.issues)) this.issuesFound.push(...data.issues);
      } catch { /* skip */ }
    }

    // Determine monitoring phase
    if (this.batchesProcessed < 3) this.monitoringPhase = "initial";
    else if (this.issuesFound.length > 0) this.monitoringPhase = "active";
    else if (Object.values(this.accuracyByRule).every((a) => a >= this._accuracyThreshold)) this.monitoringPhase = "stable";
    else this.monitoringPhase = "active";
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

  exitCriteriaMet() { return this.monitoringPhase === "stable"; }

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
