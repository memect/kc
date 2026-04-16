import fs from "node:fs";
import path from "node:path";
import { BaseTool, ToolResult } from "./base.js";

/**
 * Test a workflow step at a lower worker LLM tier.
 * Compares accuracy at target tier against current baseline.
 * Used during distillation to find the minimum viable tier.
 */
export class TierDowngradeTool extends BaseTool {
  constructor(workspace, workerLlm) {
    super();
    this._workspace = workspace;
    this._worker = workerLlm;
  }

  get name() { return "tier_downgrade"; }
  get description() {
    return (
      "Test a workflow step at a lower worker LLM tier. Compares accuracy " +
      "against baseline. Use during distillation to find the cheapest tier " +
      "that meets accuracy threshold."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        rule_id: { type: "string", description: "Rule ID being tested" },
        prompt: { type: "string", description: "The extraction/judgment prompt to test" },
        test_inputs: { type: "array", items: { type: "string" }, description: "List of document text chunks to test" },
        expected_outputs: { type: "array", items: { type: "string" }, description: "Expected correct outputs" },
        current_tier: { type: "string", description: "Current tier (baseline)" },
        target_tier: { type: "string", description: "Lower tier to test" },
      },
      required: ["rule_id", "prompt", "test_inputs", "expected_outputs", "current_tier", "target_tier"],
    };
  }

  async execute(input) {
    const ruleId = input.rule_id || "";
    const prompt = input.prompt || "";
    const testInputs = input.test_inputs || [];
    const expected = input.expected_outputs || [];
    const currentTier = input.current_tier || "tier1";
    const targetTier = input.target_tier || "tier2";

    if (!testInputs.length || !expected.length || testInputs.length !== expected.length) {
      return new ToolResult("test_inputs and expected_outputs must be non-empty and same length", true);
    }

    const currentResults = await this._runTier(currentTier, prompt, testInputs);
    const targetResults = await this._runTier(targetTier, prompt, testInputs);

    if (!currentResults) return new ToolResult(`Failed to run at ${currentTier}`, true);
    if (!targetResults) return new ToolResult(`Failed to run at ${targetTier}`, true);

    const currentAcc = this._accuracy(currentResults, expected);
    const targetAcc = this._accuracy(targetResults, expected);
    const delta = currentAcc - targetAcc;

    // Read threshold from .env
    let threshold = 0.9;
    const envPath = path.join(this._workspace.cwd, ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("WORKFLOW_ACCURACY=")) {
          try { threshold = parseFloat(line.split("=")[1].trim()); }
          catch { /* ignore */ }
        }
      }
    }

    // Read tier tolerance from .env (default from onboarding config)
    let tolerance = 0.05;
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        if (line.startsWith("TIER_TOLERANCE=")) {
          try { tolerance = parseFloat(line.split("=")[1].trim()); }
          catch { /* ignore */ }
        }
      }
    }

    const report = {
      rule_id: ruleId, current_tier: currentTier, target_tier: targetTier,
      current_accuracy: Math.round(currentAcc * 1000) / 1000,
      target_accuracy: Math.round(targetAcc * 1000) / 1000,
      accuracy_delta: Math.round(delta * 1000) / 1000,
      threshold, tolerance, test_count: testInputs.length,
    };
    return new ToolResult(JSON.stringify(report, null, 2));
  }

  async _runTier(tier, prompt, inputs) {
    const results = [];
    for (const text of inputs) {
      const fullPrompt = `${prompt}\n\nDocument text:\n${text}`;
      const result = await this._worker.execute({ tier, prompt: fullPrompt, max_tokens: 2048 });
      if (result.isError) return null;
      try {
        const data = JSON.parse(result.content);
        results.push(data.response || "");
      } catch {
        results.push(result.content);
      }
    }
    return results;
  }

  _accuracy(outputs, expected) {
    if (!expected.length) return 0;
    let matches = 0;
    for (let i = 0; i < expected.length; i++) {
      if (outputs[i] && expected[i].trim().toLowerCase() !== "" &&
          outputs[i].toLowerCase().includes(expected[i].trim().toLowerCase())) {
        matches++;
      }
    }
    return matches / expected.length;
  }
}
