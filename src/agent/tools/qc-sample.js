import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

const FREQUENCY_RATES = { high: 0.5, mid: 0.3, low: 0.1 };

/**
 * Draw adaptive sample from production results for quality review.
 * Stratifies by confidence band: review ALL low, sample medium, spot-check high.
 */
export class QCSampleTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
  }

  get name() { return "qc_sample"; }
  get description() {
    return (
      "Draw an adaptive sample from production results for quality review. " +
      "Stratifies by confidence band (low=review all, medium=sample, high=spot-check). " +
      "Returns list of document IDs to review."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        results_path: { type: "string", description: "Path to results directory (default: output/results/)" },
      },
    };
  }

  async execute(input) {
    const resultsPath = input.results_path || "output/results";
    let resultsDir;
    try { resultsDir = this._workspace.resolvePath(resultsPath); }
    catch (e) { return new ToolResult(e.message, true); }

    if (!fs.existsSync(resultsDir) || !fs.statSync(resultsDir).isDirectory()) {
      return new ToolResult(`Results directory not found: ${resultsPath}`, true);
    }

    // Load MONITOR_FREQUENCY from .env
    let mediumRate = 0.3;
    const envPath = path.join(this._workspace.cwd, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("MONITOR_FREQUENCY=")) {
          const freq = line.split("=")[1].trim().toLowerCase();
          mediumRate = FREQUENCY_RATES[freq] ?? 0.3;
        }
      }
    }

    const low = [], medium = [], high = [];
    const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf-8"));
        const band = data.confidence_band || "medium";
        const entry = { file: f, rule_id: data.rule_id || "", confidence: data.confidence || 0 };
        if (band === "low") low.push(entry);
        else if (band === "high") high.push(entry);
        else medium.push(entry);
      } catch { /* skip */ }
    }

    const toReview = [...low];
    if (medium.length > 0) {
      const sampleSize = Math.max(1, Math.floor(medium.length * mediumRate));
      toReview.push(...this._sample(medium, sampleSize));
    }
    if (high.length > 0) {
      const spotSize = Math.max(1, Math.floor(high.length * 0.1));
      toReview.push(...this._sample(high, spotSize));
    }

    const report = {
      total_results: low.length + medium.length + high.length,
      distribution: { low: low.length, medium: medium.length, high: high.length },
      sampling_rate_medium: mediumRate,
      to_review: toReview.length,
      review_list: toReview,
    };
    return new ToolResult(JSON.stringify(report, null, 2));
  }

  _sample(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length));
  }
}
