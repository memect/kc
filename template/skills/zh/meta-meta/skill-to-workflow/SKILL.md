---
name: skill-to-workflow
description: Distill a proven verification skill into a Python workflow with worker LLM prompts. Use when a rule skill has been tested and reaches the SKILL_ACCURACY threshold defined in .env. Covers the decision of what to implement as code vs LLM calls, prompt engineering for small context windows, model tier selection and progressive downgrade, and testing workflows against the coding agent's own results as ground truth. Also use when optimizing existing workflows for cost or speed.
---

# Skill to Workflow

The skill is the ground truth. The workflow is a cheaper, faster approximation. Your job is to make the approximation as good as the original while being as cheap as possible.

## Engineering Goal

Optimize the full chain: **shortest workflow** (fewest nodes) → **smallest model per node** (cheapest tier that meets accuracy) → **shortest prompt per model** (minimum tokens). This is the engineering objective — not prompt template sophistication or framework compliance.

## When to Start

A skill is ready for workflow distillation when:
- It has been tested on all documents in Samples/.
- Its accuracy meets or exceeds the SKILL_ACCURACY threshold in `.env`.
- Edge cases are documented in the skill's `assets/corner_cases.json`.
- You understand the rule well enough to explain exactly how you verify it.

If any of these are not true, go back and iterate on the skill first.

## The Distillation Decision

For each step in your skill-based verification process, ask:

### Can this be done with regex or Python? (Cost: zero)
- Date extraction with known formats → regex
- Numeric comparison against threshold → Python arithmetic
- Chinese numeral conversion → Python lookup table
- Format validation (ID numbers, codes) → regex
- Table cell extraction from structured markdown → string manipulation

If yes, write it as code. These are free, fast, and deterministic.

### Does this require language understanding? (Cost: worker LLM call)
- Finding the relevant section in a document → LLM
- Extracting an entity described in natural language → LLM
- Judging semantic adequacy ("adequate risk disclosure") → LLM
- Resolving ambiguous references → LLM

If yes, design a worker LLM prompt. Use the smallest model tier that maintains accuracy.

### The hybrid approach (most common)
Most rules are a mix: regex extracts the number, Python compares it to the threshold, LLM handles the exceptional cases. Design the workflow as a pipeline where cheap steps run first and expensive steps run only when needed.

### When regex alone isn't enough — decision rubric

Before declaring distillation complete, audit each rule's `verification_type` / `metric` / `evidence_type` (or equivalent fields in your catalog). For rules where the required verification is one of:

- **Semantic** ("is this a positive guarantee or a disclaimer?")
- **Contextual** ("interpret this in light of the document's product type")
- **Counterfactual** ("what should this value be, given the other fields?")
- **Cross-field arithmetic** ("does 期初 + 收益 - 分配 = 期末?")

regex alone rarely suffices. Three acceptable forms:

1. **Pure regex with documented limits** — write the regex check, include a comment explaining the fragility (e.g., "matches syntactic pattern only; cannot detect semantic guarantees")
2. **Hybrid regex + LLM** — regex baseline catches obvious cases, `worker_llm_call` (tier1-2) handles ambiguous ones. The hybrid workflow declares which rule_ids escalate.
3. **Pure LLM via `worker_llm_call`** — for fully semantic rules where no regex baseline is meaningful.

Don't ship pure regex for a rule whose `verification_type` is `judgment` / `semantic` without the documented-limits note. Future-you or a colleague will assume the regex is sufficient and that bug will hide for months.

### Worker LLM cost-aware tier choice

If you do escalate to LLM:
- **tier1** (most capable, ~¥0.001-0.002/doc): cross-field reasoning, ambiguity resolution, rules that benefit from chain-of-thought
- **tier2-3**: bulk extraction with simple semantic checks
- **tier4** (cheapest): high-volume keyword-spotting that regex can't handle. Note: tier4 models on SiliconFlow are Qwen3.5 thinking-mode — `content` can return empty if `reasoning_content` consumes max_tokens. Test with realistic prompts before relying. If you see empty responses, either bump max_tokens to ≥8192, shorten your prompt, or fall back to tier1-2.

Both v0.7.1 audit conductors (DS and GLM) defaulted to all-regex distillation and only added LLM escalation when the human user explicitly asked for "V2 with worker LLM". If your rule catalog has any rules where the verification is genuinely semantic, you should reach for `worker_llm_call` yourself — don't wait to be asked.

## Workflow Structure

A workflow is a Python file (or small set of files) in `workflows/`:

```
workflows/
  rule_001_capital_adequacy/
    workflow_v1.py        # The main workflow script
    prompts/
      extract.txt         # Worker LLM prompt for extraction
      judge.txt           # Worker LLM prompt for judgment (if needed)
    config.json           # Model assignments, thresholds
```

The workflow file should have a clear entry point:

```python
def verify(document_text: str, config: dict) -> dict:
    """
    Returns:
        {
            "rule_id": "R001",
            "result": "pass" | "fail" | "missing" | "error",
            "extracted_value": ...,
            "confidence": 0.0-1.0,
            "comment": "..." (only when fail),
            "model_used": "...",
            "llm_calls": int,
            "llm_tokens": int
        }
    """
```

This is a reference, not a rigid contract. Adapt the structure to the specific rule. The important thing is that every workflow produces a result that can be compared against the skill-based ground truth.

## Prompt Engineering for Worker LLMs

Worker LLMs have smaller context windows (typically 16K-32K tokens). Design prompts that:

1. **Are self-contained.** Include everything the model needs in the prompt. Do not assume the model has context from previous calls.
2. **Specify the output format.** "Return a JSON object with fields: value, confidence, reasoning." Structured output reduces parsing errors.
3. **Include the narrowed context.** Do not send the entire document. Use the tree-processing pipeline (full document → relevant chapter → relevant section) to narrow the context before calling the worker LLM.
4. **Are written in the document's language.** Chinese documents get Chinese prompts. English documents get English prompts. Do not mix languages in a single prompt.
5. **Provide examples sparingly.** One or two examples help. Ten examples waste context window and risk overfitting.

## Model Tier Selection

Start with the highest tier (TIER1) for each step. Measure accuracy. Then try lower tiers:

1. Run the workflow with TIER1 on all Samples/. Record accuracy per step.
2. For each step, try TIER2. If accuracy stays above WORKFLOW_ACCURACY, keep TIER2.
3. Continue downgrading per step until accuracy drops below threshold.
4. Record the optimal tier per step in `config.json`.

Different steps within the same workflow can use different model tiers. Extraction might need TIER2 while judgment might work fine with TIER3.

### Formal Downgrade Protocol

The basic approach above works, but a more rigorous protocol prevents premature tier commitments:

**Direction**: Start top-down (TIER1 → TIER4) to establish the accuracy ceiling first. You need to know the best possible accuracy before trading it for cost savings.

**Minimum test runs**: Run at least a meaningful number of documents (e.g., min(10, total_samples)) at each candidate tier before making a tier decision. Small samples are unreliable — a 3-document test could be misleading.

**Accuracy delta trigger**: If a lower tier's accuracy is significantly below the higher tier (e.g., >5 percentage points), stay at the higher tier for that step. If the delta is within tolerance, use the cheaper tier.

**Per-step independence**: Each workflow step is assessed separately. Record the optimal tier per step in `config.json`. Do not assume the whole workflow must use one tier.

**Re-assessment trigger**: If production quality control shows a step's accuracy degrading (e.g., due to new document formats), re-run the tier assessment for that step.

**Model-task recommendation list**: Maintain a per-project mapping of (task_type → recommended_tier) based on your testing experience. Over time, these lists can be collected across projects to build generalized tier recommendations.

All numbers here (10 documents, 5 percentage points, etc.) are recommended starting points. The coding agent and developer user should calibrate these — or replace them entirely with a different assessment approach — based on their specific volume, accuracy requirements, and cost constraints. The pattern matters: **test at each tier → compare accuracy → commit when within tolerance → re-assess on degradation**.

This follows the same tier-transition framework as parser escalation in `document-parsing`: a quality/accuracy score drives the decision to stay, escalate, or skip.

## Testing Against Ground Truth

The coding agent's skill-based results are the ground truth. For each document in Samples/:

1. Run the workflow.
2. Compare the workflow's result against the skill-based result.
3. Log discrepancies: which step failed, what was expected vs actual.
4. Compute accuracy: `(matching results) / (total documents)`.
5. If accuracy < WORKFLOW_ACCURACY, diagnose and fix. Use `evolution-loop` methodology.

## Versioning

Each iteration of a workflow is a new version file: `workflow_v1.py`, `workflow_v2.py`, etc. Track which version is active in `config.json`. See `version-control` skill for the full methodology.

## Releasing Workflows

Once workflows hit accuracy threshold, they can be packaged for end users via the `release` tool. Each release is a self-contained directory under `output/releases/<slug>/` with the pinned workflows, a Python runner, a confidence scorer, an HTML dashboard generator, and a `serve.sh` helper. The bundle has no kc-beta dependency — anyone with Python and a worker LLM API key can run `python run.py <doc>` and produce verification results.

What to include is your call: all rules in catalog, or a curated subset via the `include` parameter; bundling 1-3 representative samples as `fixtures/` if you want the recipient to be able to dry-run without their own data.

The `release` tool snapshots the workspace first (git tag `snap/release-<slug>`), so the bundle is regenerable from git even if `output/releases/` is later cleaned. Decide when to release — there's no automation, no forced cadence. Typical triggers: workflows reach SKILL/WORKFLOW_ACCURACY thresholds, a stakeholder needs a hand-off, a production cron should run pinned versions instead of latest. Discuss with the developer user.

## Cost Tracking

Track the cost of each workflow run:
- Number of LLM calls per document.
- Total tokens consumed per document.
- Model tier used per call.

This data helps the developer user understand the production cost and informs further optimization.

## Worker LLM API

Worker LLMs are accessed via SiliconFlow API. Connection details are in `.env`:
- `SILICONFLOW_API_KEY` for authentication
- `SILICONFLOW_BASE_URL` for the API endpoint
- Model names in `TIER1` through `TIER4`

See `references/worker-llm-catalog.md` for current model capabilities and context window sizes.
