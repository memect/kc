# events.jsonl Schema Reference

KC writes one JSON event per line to `<workspace>/logs/events.jsonl`.
Events have stable shape:

```json
{"seq": <int>, "ts": "<ISO8601>", "type": "<event_type>", "data": {...}}
```

Note the field is `type`, not `event` — easy mistake.

## Event types and their `data` shapes

### `user_message`
```json
{"content": "the user's prompt text"}
```
Used to extract user intervention timeline. Often the prompt is in CJK;
print full content not just first 200 chars.

### `assistant_message`
```json
{"content": "<text or null>", "toolCalls": [{"id":..., "type":"function", "function":{"name":..., "arguments":"<json string>"}}]}
```
`content: null` is normal when the assistant's turn was tool-calls-only.

### `llm_start`
```json
{"model": "<model id>", "messageCount": <int>}
```
Useful for spotting the model the conductor used + how long the message
list got before each LLM call.

### `tool_start`
```json
{"name": "<tool_name>", "input": {...tool-specific...}}
```

### `tool_result`
```json
{"name": "<tool_name>", "output": "<string or object>", "isError": <bool>, "traceId": "<string|null>"}
```
For `worker_llm_call`, `output` is a JSON string with shape
`{"response": ..., "model_used": ..., "tier": ..., "tokens_in": ..., "tokens_out": ...}`.

### `phase_transition`
```json
{"from": "<phase>", "to": "<phase>", "forced": <bool>, "reason": "<string>"}
```
Phases (in order): `bootstrap`, `rule_extraction`, `skill_authoring`,
`skill_testing`, `distillation`, `production_qc`, `finalization`.

### `phase_advance_refused`
```json
{"from": "<phase>", "to": "<phase>", "engineCounts": "<string|null>"}
```
v0.7.1 Group 2c added `engineCounts` to this event. Empty engineCounts on
bootstrap → rule_extraction refusals indicates the bootstrap phase doesn't
populate the counts string yet.

### `phase_misfit_hint`
```json
{"phase": "<source phase>", "tool": "<tool that triggered>", "hint": "<advisory text>"}
```
Advisory only — does not refuse the action. Read the hint text to know
which v0.7.1 nudge it is (chunk_refs, coverage_audit, ephemeral-test,
stub-check.py, etc.).

### `memory_pressure`
```json
{"heapUsedMB": <int>, "heapTotalMB": <int>, "rssMB": <int>, "historyLength": <int>, "kind": "<string>"}
```

### `compact`
```json
{"keptMessages": <int>, "droppedMessages": <int>, "savedTokens": <int>, ...}
```
Absent over a multi-hour run = no compactions = E2 budget-aware compact
held. Many compactions in a short run = budget thresholds may be too
aggressive.

### `skill_invoked`
```json
{"skill": "<name | (unknown)>", "via_tool": "<tool>", "phase": "<phase>"}
```
The `(unknown)` placeholder appears when the skill name didn't resolve —
usually because the skill was invoked via filesystem read rather than a
formal skill-load mechanism. Not a bug per se but worth noting.

### `turn_complete`
```json
{}
```
Marks the end of an assistant turn (post-tool-results). Useful as a
turn boundary for windowing.

### `tool_args_recovered`
```json
{"tool": "<tool_name>", "original": "<malformed JSON>", "recovered": "<clean JSON>"}
```
Engine repaired malformed tool arguments before the tool dispatched.
Not an error — but a high count signals the conductor model emits
non-strict JSON (trailing commas, unquoted keys, single-quotes, etc.)
that the engine has to clean up. E2E #7 GLM had 58 of these (out of
510 tool calls); DS had 0. Worth tallying in the audit's process-trace
section as a model-trait signal. Threshold for noting: > 20 recoveries.

### `tool_args_parse_failed`
```json
{"tool": "<tool_name>", "raw": "<unparseable input>"}
```
Engine couldn't repair the malformed args; tool call was dropped.
Should be << recovered count. E2E #7 GLM had 3 (DS had 0). High
parse_failed rate indicates the conductor's JSON output is genuinely
broken in ways the engine's repair logic doesn't handle —
investigate the raw inputs.

### `context_windowed`
```json
{"keptMessages": <int>, "droppedMessages": <int>, ...}
```
Soft variant of `compact` — drops oldest messages without LLM
summarization. Cheaper but less fidelity-preserving. E2E #7 GLM
had 4 of these (vs 0 compacts), DS had 0 of either. Note in the
audit's heap profile section as a windowing decision the engine
made on the fly.

## Counts you'll want every audit

```python
from collections import Counter
import json

types = Counter()
tools = Counter()
phase_hist = []

for line in open(EVENTS_PATH):
    e = json.loads(line)
    types[e["type"]] += 1
    if e["type"] == "tool_start":
        tools[e["data"].get("name","?")] += 1
    if e["type"] == "phase_transition":
        d = e["data"]
        phase_hist.append((e["ts"][:19], d["from"], d["to"], d["forced"]))
```

For per-phase tool breakdown, walk events in order tracking the current
phase from `phase_transition` events:

```python
current = "bootstrap"
per_phase_tools = {}
for line in open(EVENTS_PATH):
    e = json.loads(line)
    if e["type"] == "phase_transition":
        current = e["data"]["to"]
    elif e["type"] == "tool_start":
        per_phase_tools.setdefault(current, Counter())[e["data"]["name"]] += 1
```

This often reveals e.g. "agent did all 50 sandbox_exec calls in
distillation, none in skill_testing" — diagnostic for whether testing
phase was real.
