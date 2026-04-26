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
    // v0.6.1 A5/A6: don't reset documentsReviewed if engine emission has
    // bumped it since last scan — workflow_run hooks call _recordMilestone
    // and the increment lives in this same field. Other counters (batches,
    // accuracy, issues) come solely from filesystem scan and reset cleanly.
    const engineDocsReviewed = this.documentsReviewed;
    this.batchesProcessed = 0;
    this.totalDocuments = 0;
    this.documentsReviewed = 0;
    this.accuracyByRule = {};
    this.confidenceDistribution = { low: 0, medium: 0, high: 0 };
    this.issuesFound = [];

    // Existing canonical path: output/qc/*.json (formal QC batch reports)
    const qcDir = path.join(this._workspace.cwd, "output", "qc");
    if (fs.existsSync(qcDir)) {
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
    }

    // v0.6.1 A5: also pick up batch-style results in output/results/. E2E #4
    // showed agents writing batch QC outputs to output/results/qc_*.json
    // (e.g. unified_qc.py) instead of output/qc/, so the formal scanner
    // missed them. Heuristic match: filename starts with "qc_" or contains
    // "_batch_". Each match counts as one batch; total_checks → totalDocuments.
    const resultsDir = path.join(this._workspace.cwd, "output", "results");
    if (fs.existsSync(resultsDir)) {
      const seen = new Set();
      for (const f of fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json"))) {
        const lower = f.toLowerCase();
        if (!(lower.startsWith("qc_") || lower.includes("_batch_"))) continue;
        // Dedupe near-duplicate filenames that differ only by timestamp
        // suffix (qc_full_batch_20260424_141642.json vs _141921.json
        // — both are real batches, keep both. But qc_pt_x.json and
        // qc_pt_x_<ts>.json are usually the same batch saved twice; key
        // on the prefix before any 8-digit date.)
        const key = f.replace(/_\d{8}_\d{6}/g, "").replace(/\.json$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        this.batchesProcessed++;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf-8"));
          // Best-effort metric extraction; tolerate missing keys
          this.totalDocuments += typeof data.sample_count === "number" ? data.sample_count
            : typeof data.documents === "number" ? data.documents
            : typeof data.total === "number" ? data.total : 0;
        } catch { /* skip */ }
      }
    }

    // Restore engine-emitted documentsReviewed if filesystem reported less
    if (engineDocsReviewed > this.documentsReviewed) this.documentsReviewed = engineDocsReviewed;

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
