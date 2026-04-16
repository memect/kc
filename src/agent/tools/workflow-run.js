import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Execute a distilled workflow script against a document.
 * Runs the workflow script in sandbox, attaches ConfidenceScorer
 * result and trace ID automatically. Saves structured result to output/results/.
 */
export class WorkflowRunTool extends BaseTool {
  constructor(workspace, versionManager, confidenceScorer, { timeout = 120 } = {}) {
    super();
    this._workspace = workspace;
    this._versionMgr = versionManager;
    this._confidence = confidenceScorer;
    this._timeout = timeout;
  }

  get name() { return "workflow_run"; }

  get description() {
    return (
      "Execute a distilled workflow against a document. Runs the workflow " +
      "script, attaches confidence scores and trace IDs automatically. " +
      "Results saved to output/results/."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "Rule ID whose workflow to execute" },
        document_path: { type: "string", description: "Relative path to document in workspace" },
        workflow_version: { type: "integer", description: "Workflow version to run (default: latest)" },
      },
      required: ["rule_id", "document_path"],
    };
  }

  async execute(input) {
    const ruleId = input.rule_id || "";
    const docPath = input.document_path || "";
    const wfVersion = input.workflow_version;

    if (!ruleId || !docPath) return new ToolResult("rule_id and document_path required", true);

    // Find workflow script
    const wfDir = path.join(this._workspace.cwd, "workflows", ruleId);
    const wfScript = this._findWorkflow(
      fs.existsSync(wfDir) ? wfDir : path.join(this._workspace.cwd, "workflows"),
      ruleId, wfVersion,
    );
    if (!wfScript) return new ToolResult(`No workflow found for ${ruleId} in workflows/`, true);

    let docResolved;
    try { docResolved = this._workspace.resolvePath(docPath); }
    catch (e) { return new ToolResult(e.message, true); }
    if (!fs.existsSync(docResolved)) return new ToolResult(`Document not found: ${docPath}`, true);

    // Run workflow in subprocess
    const cmd = `python ${wfScript} ${docResolved}`;
    let output;
    try {
      output = await this._exec(cmd);
    } catch (e) {
      return new ToolResult(e.message, true);
    }

    // Parse output
    let resultData;
    try {
      const lines = output.trim().split("\n");
      resultData = JSON.parse(lines[lines.length - 1]);
    } catch {
      resultData = { raw_output: output.slice(0, 5000) };
    }

    // Attach confidence score
    const extractedValue = String(resultData.extracted_value || resultData.value || "");
    const method = resultData.extraction_method || "llm";
    const confidence = this._confidence.score({
      ruleId, extractedValue, extractionMethod: method, documentName: path.basename(docResolved),
    });
    resultData.confidence = confidence;
    resultData.confidence_band = this._confidence.getBand(confidence);

    // Attach trace ID
    resultData.trace_id = this._versionMgr.generateTraceId(ruleId, "workflow_result");
    resultData.rule_id = ruleId;
    resultData.document = docPath;

    // Save result
    const resultsDir = path.join(this._workspace.cwd, "output", "results");
    fs.mkdirSync(resultsDir, { recursive: true });
    const resultFile = path.join(resultsDir, `${ruleId}_${path.parse(docResolved).name}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(resultData, null, 2), "utf-8");

    return new ToolResult(JSON.stringify(resultData, null, 2));
  }

  _findWorkflow(wfDir, ruleId, version) {
    if (!fs.existsSync(wfDir) || !fs.statSync(wfDir).isDirectory()) return null;

    if (version) {
      const target = path.join(wfDir, `workflow_v${version}.py`);
      if (fs.existsSync(target)) return target;
    }

    const entries = fs.readdirSync(wfDir).sort();
    const versioned = entries.filter((f) => /^workflow_v\d+\.py$/.test(f));
    if (versioned.length > 0) return path.join(wfDir, versioned[versioned.length - 1]);

    const any = entries.find((f) => f.endsWith(".py") && f.toLowerCase().includes("workflow"));
    if (any) return path.join(wfDir, any);

    const pyFile = entries.find((f) => f.endsWith(".py"));
    return pyFile ? path.join(wfDir, pyFile) : null;
  }

  _exec(command) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const proc = spawn("sh", ["-c", command], {
        cwd: this._workspace.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        signal: controller.signal,
      });
      let output = "";
      proc.stdout.on("data", (d) => { output += d.toString(); });
      proc.stderr.on("data", (d) => { output += d.toString(); });
      const timer = setTimeout(() => { controller.abort(); reject(new Error(`Workflow timed out after ${this._timeout}s`)); }, this._timeout * 1000);
      proc.on("close", (code) => { clearTimeout(timer); resolve(output); });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }
}
