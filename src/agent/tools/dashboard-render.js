import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Generate a self-contained HTML dashboard from project metrics.
 * Aggregates: accuracy by rule, confidence distribution, evolution timeline, QC results.
 */
export class DashboardRenderTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "dashboard_render"; }
  get description() {
    return (
      "Generate a self-contained HTML dashboard from project metrics. " +
      "Aggregates accuracy, confidence distribution, evolution history, " +
      "and QC results. Saves to output/dashboards/."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        output_path: { type: "string", description: "Output file path (default: output/dashboards/dashboard.html)" },
      },
    };
  }

  async execute(input) {
    const outputPath = input.output_path || "output/dashboards/dashboard.html";
    const metrics = this._collectMetrics();
    const html = this._renderHtml(metrics);

    try {
      const resolved = this._workspace.resolvePath(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, html, "utf-8");
      return new ToolResult(`Dashboard saved to ${outputPath} (${html.length} bytes)`);
    } catch (e) {
      return new ToolResult(e.message, true);
    }
  }

  _collectMetrics() {
    const ws = this._workspace.cwd;
    const metrics = {
      generated_at: new Date().toISOString(),
      rules: [],
      confidence_distribution: { low: 0, medium: 0, high: 0 },
      evolution_iterations: 0,
      qc_batches: 0,
    };

    const catalogPath = path.join(ws, "rules", "catalog.json");
    if (fs.existsSync(catalogPath)) {
      try {
        const rules = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
        if (Array.isArray(rules)) {
          metrics.rules = rules.map((r) => ({ id: r.id || "?", description: (r.description || "").slice(0, 60) }));
        }
      } catch { /* skip */ }
    }

    const resultsDir = path.join(ws, "output", "results");
    if (fs.existsSync(resultsDir)) {
      for (const f of fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json"))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf-8"));
          const band = data.confidence_band || "medium";
          if (band in metrics.confidence_distribution) metrics.confidence_distribution[band]++;
        } catch { /* skip */ }
      }
    }

    const evoDir = path.join(ws, "logs", "evolution");
    if (fs.existsSync(evoDir)) {
      metrics.evolution_iterations = fs.readdirSync(evoDir).filter((f) => f.endsWith(".json")).length;
    }

    // v0.8 P1-G: QC counter now reads from multiple known agent-write
    // locations + counts per-doc reviews. Pre-v0.8 read only output/qc/*.json
    // top-level; 资管 v0.7.5 wrote output/results/production_qc_results.json
    // so the dashboard showed `QC Batches: 0` despite 126 pairs of data.
    let qcBatches = 0;
    let qcDocsReviewed = 0;

    // (a) Top-level batch files in output/qc/ (贷款 v0.7.5 shape)
    const qcDir = path.join(ws, "output", "qc");
    if (fs.existsSync(qcDir)) {
      for (const f of fs.readdirSync(qcDir).filter((f) => f.endsWith(".json"))) {
        qcBatches++;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(qcDir, f), "utf-8"));
          const n = Number(data?.documents_reviewed);
          if (Number.isFinite(n) && n > qcDocsReviewed) qcDocsReviewed = n;
        } catch { /* skip malformed */ }
      }
    }

    // (b) Per-doc reviews at output/qc/reviews/ (贷款 detail shape)
    const reviewsDir = path.join(ws, "output", "qc", "reviews");
    if (fs.existsSync(reviewsDir)) {
      const reviewFiles = fs.readdirSync(reviewsDir).filter((f) => f.endsWith(".json"));
      qcDocsReviewed = Math.max(qcDocsReviewed, reviewFiles.length);
    }

    // (c) production_qc_results.json shape (资管 v0.7.5)
    const productionQc = path.join(ws, "output", "results", "production_qc_results.json");
    if (fs.existsSync(productionQc)) {
      qcBatches++;
      try {
        const data = JSON.parse(fs.readFileSync(productionQc, "utf-8"));
        const totalDocs = Number(data?.total_docs);
        if (Number.isFinite(totalDocs)) qcDocsReviewed = Math.max(qcDocsReviewed, totalDocs);
        // Otherwise, dedup doc keys from nested results
        if (!Number.isFinite(totalDocs) && data?.results && typeof data.results === "object") {
          const docSet = new Set();
          for (const docs of Object.values(data.results)) {
            if (docs && typeof docs === "object") {
              for (const k of Object.keys(docs)) docSet.add(k);
            }
          }
          if (docSet.size > 0) qcDocsReviewed = Math.max(qcDocsReviewed, docSet.size);
        }
      } catch { /* skip */ }
    }

    metrics.qc_batches = qcBatches;
    metrics.qc_docs_reviewed = qcDocsReviewed;

    return metrics;
  }

  _renderHtml(metrics) {
    const rulesHtml = metrics.rules.map((r) => `<tr><td>${r.id}</td><td>${r.description}</td></tr>`).join("\n");
    const conf = metrics.confidence_distribution;
    const total = conf.low + conf.medium + conf.high;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KC Agent Dashboard</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #0a0a0a; color: #e5e5e5; }
h1 { color: #a3a3a3; font-size: 1.5em; }
h2 { color: #737373; font-size: 1.1em; margin-top: 2em; }
.card { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 16px; margin: 12px 0; }
.metric { display: inline-block; margin-right: 32px; }
.metric .value { font-size: 2em; font-weight: bold; color: #22c55e; }
.metric .label { font-size: 0.85em; color: #737373; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid #262626; }
th { color: #737373; font-size: 0.85em; }
.bar { height: 20px; border-radius: 4px; display: inline-block; }
.bar-low { background: #ef4444; }
.bar-med { background: #eab308; }
.bar-high { background: #22c55e; }
.timestamp { color: #525252; font-size: 0.8em; }
</style>
</head>
<body>
<h1>KC Agent Dashboard</h1>
<p class="timestamp">Generated: ${metrics.generated_at}</p>
<div class="card">
<div class="metric"><span class="value">${metrics.rules.length}</span><br><span class="label">Rules</span></div>
<div class="metric"><span class="value">${total}</span><br><span class="label">Results</span></div>
<div class="metric"><span class="value">${metrics.evolution_iterations}</span><br><span class="label">Evolution Cycles</span></div>
<div class="metric"><span class="value">${metrics.qc_batches}</span><br><span class="label">QC Batches</span></div>
<div class="metric"><span class="value">${metrics.qc_docs_reviewed || 0}</span><br><span class="label">Docs Reviewed</span></div>
</div>
<h2>Confidence Distribution</h2>
<div class="card">
<div>Low: ${conf.low} &nbsp; <span class="bar bar-low" style="width:${conf.low * 5}px"></span></div>
<div>Medium: ${conf.medium} &nbsp; <span class="bar bar-med" style="width:${conf.medium * 5}px"></span></div>
<div>High: ${conf.high} &nbsp; <span class="bar bar-high" style="width:${conf.high * 5}px"></span></div>
</div>
<h2>Rules</h2>
<div class="card">
<table>
<tr><th>ID</th><th>Description</th></tr>
${rulesHtml || '<tr><td colspan="2">No rules in catalog yet</td></tr>'}
</table>
</div>
</body>
</html>`;
  }
}
