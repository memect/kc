---
name: task-decomposition
description: Decompose each verification rule into independent sub-tasks and assign the optimal method (rule, code, LLM, manual) to each. Use when converting extracted rules into implementation plans, when a rule skill is too expensive or inaccurate and needs restructuring, or when designing a multi-step verification pipeline. Covers MECE decomposition, method selection via the four-dimension decision matrix, cost-benefit analysis, and source tagging. Also use when auditing an existing workflow for cost optimization opportunities.
---

# Task Decomposition

Every verification rule is composite. Even the simplest-sounding rule — "check that the invoice date is within the contract period" — decomposes into a chain of distinct operations: locate the date field, extract its value, normalize the format, compare against the contract dates, and generate a comment if it fails.

The temptation is to throw the entire chain at an LLM. It works. It is also 100x more expensive than necessary and impossible to debug when it breaks.

The Lancet Method is scalpel-precision decomposition. Cut each rule into the smallest sub-tasks that are methodologically homogeneous — meaning each sub-task can be solved entirely by one method. Then assign the cheapest method that works for each sub-task. The name is deliberate: a lancet, not a cleaver. Precision matters because the cut points determine everything downstream — cost, debuggability, testability, and the eventual workflow architecture.

## MECE Decomposition

Decompose every rule into sub-tasks that are mutually exclusive and collectively exhaustive (MECE):

- **Mutually exclusive**: no two sub-tasks do the same work. If sub-task A extracts the invoice date, sub-task B does not also extract the invoice date.
- **Collectively exhaustive**: the sub-tasks together cover the entire rule. Nothing falls through the cracks. If you execute all sub-tasks in sequence, the rule is fully verified.

Each sub-task has exactly one input and one output. The output of one sub-task becomes the input of the next. This creates a pipeline with clean interfaces between stages.

Stop decomposing when a sub-task is **methodologically homogeneous** — it can be handled entirely by one method (regex, Python code, LLM call, or manual review). If a sub-task still requires two different methods, it is not yet atomic. Keep cutting.

A practical test: describe the sub-task in one sentence. If you need "and" or "then" in the sentence, it probably needs further decomposition. "Extract the date and compare it to the threshold" is two sub-tasks. "Extract the date" is one.

The canonical decomposition chain for most document verification rules is:

```
locate → extract → normalize → judge → comment
```

Not every rule has all five stages. Some rules skip normalization. Some rules do not need a comment on pass. But this chain is a reliable starting framework.

For cross-document rules (e.g., "invoice amount matches contract amount"), the chain branches: two parallel locate-extract-normalize pipelines converge at a single judge step. Draw this out before implementing. The pipeline topology — linear, branching, or converging — determines how you structure the skill folder and later the workflow.

Three common topologies:

- **Linear**: Single document, single field. `locate → extract → normalize → judge → comment`. Most threshold checks follow this pattern.
- **Converging**: Two fields from different documents or different sections. Two parallel locate-extract chains merge at the judge step. Cross-field validations and cross-document matching follow this pattern.
- **Fan-out**: One rule applied to many items within a document (e.g., validating every line item in an invoice). The locate step produces N items, each of which flows through the remaining chain independently. Scale is the critical dimension here — if N is large, the method assignments must account for per-item cost.

## The Decision Matrix

After decomposition, assign a method to each sub-task. Do not guess. Use a structured evaluation based on four dimensions. See `references/decision-matrix.md` for the complete matrix with worked examples and a cost estimation template.

**Certainty** — How predictable is the input format? If the date is always in `YYYY-MM-DD` at a known position, certainty is high. If the date appears in free-form prose with varying formats, certainty is low.

**Scale** — How many items must be processed? One field per document is low scale. A thousand line items per invoice is high scale.

**Semantic depth** — How much language understanding is required? Comparing two numbers requires none. Judging whether a risk disclosure is "adequate" requires deep understanding.

**Cost sensitivity** — What is the budget per document? A bank processing 10,000 loan files per month has different economics than a one-time audit of 50 contracts.

These four dimensions map to a method hierarchy. Always prefer the cheapest method that achieves the required accuracy:

1. **Rule / Regex** — Zero cost, instant, deterministic. Use when certainty is high and semantic depth is zero.
2. **Code / Python** — Zero cost, instant, deterministic. Use for calculations, transformations, and structured comparisons.
3. **LLM** — Variable cost, latency, probabilistic. Use when semantic understanding is required and cheaper methods fail.
4. **Manual** — Highest cost, highest latency, highest accuracy. Reserve for edge cases that defeat all automated methods.

Do not skip levels. Try regex before code. Try code before LLM. Try LLM before manual. Each escalation must be justified by a failure at the lower level.

When scoring a sub-task on these dimensions, be honest about uncertainty. If you are unsure whether a regex can handle the input variability, score certainty conservatively and test the regex on samples before committing. A wrong method assignment wastes more time than a conservative initial assignment that gets optimized later.

Note that dimensions interact. High scale combined with high cost sensitivity pushes hard toward code-based solutions even when moderate semantic depth would normally suggest LLM. Conversely, low scale relaxes cost pressure, making LLM viable even for tasks that could theoretically be solved with complex regex. Let the combination of dimensions guide you, not any single dimension alone.

## Cost-Benefit Awareness

Method assignment is not an academic exercise. It directly determines the cost per document in production. Every LLM call that could have been a regex is money burned. Every regex that should have been an LLM call is accuracy lost.

Consider a real scenario: matching invoices against contracts in a large enterprise. There are 31,800 invoices and 15,940 contracts. The naive approach — send every possible pair to an LLM for comparison — means 507 million pairs. At any non-trivial cost per call, this is economically absurd.

The Lancet Method decomposes this into layers:

1. **Rule layer**: Match on exact supplier name and contract number. Cost: near zero. Eliminates 99.5% of pairs.
2. **Code layer**: Fuzzy match on amount ranges and date overlap. Cost: near zero. Reduces to 12,400 candidate pairs.
3. **LLM layer**: Semantic comparison of line-item descriptions against contract scope. Cost: moderate. Reduces to 7,652 confirmed matches.
4. **Manual layer**: Human review of ~200 low-confidence matches where the LLM was uncertain. Cost: labor hours. Resolves the final ambiguous cases.

The result: 200x lower cost than the naive approach. Same accuracy. Better debuggability because each layer's output is independently verifiable. And each layer can be tested, monitored, and optimized in isolation.

The principle: **filter cheap before reasoning expensive**. Always calculate the cost per document for each sub-task. If the LLM cost for one sub-task dominates the total, that sub-task is the optimization target.

Use the cost estimation template in `references/decision-matrix.md` to plan costs at decomposition time. Do not wait until production to discover that a workflow is too expensive. The developer user has a budget. Respect it by designing within it.

## Source Tagging

Every output from every sub-task must carry an `extraction_method` tag. This is not optional metadata — it is load-bearing infrastructure. Without it, the system degrades into an opaque pipeline that nobody can diagnose, cost-optimize, or trust.

Tags enable three capabilities that you cannot afford to lose:

1. **Debugging**: When a verification result is wrong, the tag tells you which sub-task produced the error and which method was responsible. Without tags, you are debugging a black box. With tags, you can immediately narrow the investigation to one sub-task and one method.
2. **Cost attribution**: Tags let you calculate the actual cost contribution of each method per rule and per document. This drives optimization decisions — you can identify which LLM calls are consuming the most budget and target them for replacement with cheaper methods.
3. **Confidence calibration**: Different methods have different reliability profiles. A regex extraction is either right or wrong — binary confidence. An LLM extraction has a confidence distribution that varies by model tier and prompt quality. Tags feed directly into the `confidence-system` method prior, enabling calibrated confidence scores that reflect the actual reliability of each extraction source.

Tag format: a simple string field on every intermediate output. Example values: `regex`, `python_calc`, `llm_tier2`, `manual_review`. Be consistent within a project. Define the tag vocabulary once at project setup and enforce it across all skills and workflows.

## Multi-agent coordination — keep it lock-free

When a task is large enough that you reach for `agent_tool` to spawn parallel sub-agents, partition by an independent unit (one rule per sub-agent, one document per sub-agent, etc.) so the sub-agents never need to coordinate through a shared mutable file.

Lesson from a peer-team failure: they tried equal-status agents claiming work via a shared coordination file with locks. Two predictable failures emerged. (1) Agents held locks too long or forgot to release them; even with locks working, twenty agents' throughput dropped to that of two or three because most time went to waiting. (2) Fragility — agents could fail while holding a lock, try to acquire a lock they already held, or update the coordination file without acquiring a lock at all.

KC's preferred patterns:

- **Single-dispatcher** — `TaskManager` hands tasks out one at a time to the conductor. No locks, no peer coordination. This is the default ralph-loop architecture.
- **Partition-by-unit** — when spawning sub-agents via `agent_tool`, give each one a non-overlapping slice (per-rule, per-document). Sub-agents write to their own `sub_agents/<taskId>/` for state, and to per-rule paths in `rule_skills/<id>/` or `workflows/<id>/` for shared artifacts. Block 11's git auto-commit serializes the shared writes; partition-by-rule keeps last-writer-wins from being a problem.

If two would-be sub-agents need to talk to each other to make progress, they should probably be one task (run sequentially) or a sequence (parent dispatches second after first finishes), not concurrent peers.

## Anti-Patterns

Five failure modes recur across projects. Learn to recognize them early.

**LLM-for-everything.** Sending an entire document to an LLM with "check if this complies with Rule X" works in demos. In production, it costs 100x more than a decomposed pipeline, provides no accuracy gain for deterministic checks, and is impossible to debug because you cannot tell which sub-check failed. The diagnostic signal: if a sub-task's input is fully predictable and requires zero language understanding, it does not belong in an LLM call.

**Rule over-engineering.** Building a 500-line regex to handle every possible date format when an LLM handles normalization better. If a rule becomes brittle and requires constant maintenance, the sub-task belongs at a higher method level. The diagnostic signal: if the regex needs patching after every new document batch, the sub-task has outgrown regex.

**Black-box pipeline.** Chaining sub-tasks without intermediate outputs. When the final result is wrong, you cannot tell where the error entered. Every sub-task must produce a logged, inspectable intermediate result. If debugging a rule requires re-running the entire pipeline end-to-end, the pipeline lacks checkpoints.

**Monolithic end-to-end.** Running every sub-task for every document, even when an early sub-task could short-circuit the pipeline. If the locate step finds that the relevant section does not exist, skip extract, normalize, judge, and comment. Go directly to "field missing." Short-circuit logic saves both cost and time.

**Premature optimization.** Spending days designing the optimal method assignment before testing anything. Get the decomposition right first. Assign all sub-tasks to LLM. Prove it works end-to-end on Samples/. Then optimize by pushing sub-tasks down to cheaper methods one at a time, verifying accuracy is maintained at each step. Correctness first, cost second. The decomposition itself is the hard part — method assignment can always be revised later.

## Integration

Task decomposition sits between rule extraction and skill authoring in the KC Reborn lifecycle. It is the bridge that translates abstract rules into concrete implementation plans.

**Input**: A rule catalog from `rule-extraction`. Each rule is an atomic, testable verification requirement. If a rule is not yet atomic, send it back to rule extraction for further decomposition before attempting task decomposition.

**Output**: A per-rule sub-task decomposition — a list of sub-tasks, each with a defined input, output, and assigned method. This decomposition feeds directly into `skill-authoring`, where each rule's sub-tasks become the implementation plan for the skill folder. The decomposition also serves as the testing contract: each sub-task's output is independently testable.

Method assignments also inform tier selection in `skill-to-workflow`. When a skill is distilled into a workflow, the method assignments from decomposition become the initial workflow architecture:

- Regex and code sub-tasks become deterministic code in `scripts/`.
- LLM sub-tasks become worker LLM prompts in `prompts/`, with model tier selected per the `skill-to-workflow` downgrade protocol.
- Manual sub-tasks become escalation paths in the `quality-control` layer, triggered by low confidence scores.

The decomposition is not static. As you test and iterate via `evolution-loop`, you will discover that some method assignments were wrong. A sub-task you thought was deterministic turns out to have edge cases that need LLM handling. A sub-task you assigned to LLM turns out to be solvable with a simple regex. Update the decomposition. Track changes with `version-control`.

A well-decomposed rule is a well-understood rule. If you struggle to decompose a rule into clean sub-tasks, that usually means you do not yet understand the rule well enough. Go back to the developer user. Ask how they verify this rule manually. Their manual process is often the best decomposition blueprint — it reveals the natural sub-task boundaries that no amount of abstract analysis will surface.
