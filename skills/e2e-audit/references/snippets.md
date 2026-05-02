# Reusable Bash + Python Snippets for E2E Audits

Copy-paste these directly. They're calibrated for KC workspaces under
`~/.kc_agent/bench-*/`. Replace `WS=...` with the workspace hash dir.

---

## Setup

```bash
# Set once; rest of the snippets use this
WS=~/.kc_agent/bench-deepseek-v071/<HASH>
EV=$WS/logs/events.jsonl
```

---

## Process trace one-shot

```bash
python3 << 'PYEOF'
import json, os
from collections import Counter
WS = os.environ.get("WS")
ev_path = f"{WS}/logs/events.jsonl"

types, tools = Counter(), Counter()
transitions, refusals, hints = [], [], []
worker_empty, worker_filled = 0, 0
heap_peak = 0
user_msgs = []

for line in open(ev_path):
    e = json.loads(line)
    t = e["type"]
    types[t] += 1
    d = e.get("data", {})
    ts = e.get("ts", "")[:19]
    if t == "tool_start":
        tools[d.get("name","?")] += 1
    elif t == "tool_result" and d.get("name") == "worker_llm_call":
        out = d.get("output", "")
        try:
            p = json.loads(out) if isinstance(out, str) else out
            r = p.get("response","") if isinstance(p, dict) else ""
            (worker_empty, worker_filled) = (worker_empty + (not r), worker_filled + bool(r))
        except: pass
    elif t == "phase_transition":
        transitions.append((ts, d["from"], d["to"], d.get("forced", False), (d.get("reason") or "")[:80]))
    elif t == "phase_advance_refused":
        refusals.append((ts, d.get("from"), d.get("to"), (d.get("engineCounts") or "")[:120]))
    elif t == "phase_misfit_hint":
        hints.append((ts, d.get("phase"), d.get("tool"), (d.get("hint") or "")[:120]))
    elif t == "memory_pressure":
        heap_peak = max(heap_peak, d.get("heapUsedMB", 0))
    elif t == "user_message":
        user_msgs.append((ts, (d.get("content") or "")[:120]))

print("=== event types ===")
for k, v in sorted(types.items(), key=lambda x: -x[1]):
    print(f"  {v:5d}  {k}")

print(f"\n=== phase transitions ({len(transitions)} total) ===")
forced = sum(1 for _,_,_,f,_ in transitions if f)
print(f"forced: {forced}/{len(transitions)} = {100*forced/max(1,len(transitions)):.0f}%")
for ts, fr, to, f, r in transitions:
    print(f"  [{ts}] {fr:>20} -> {to:<20} forced={f} {r}")

print(f"\n=== phase_advance_refused ({len(refusals)}) ===")
for ts, fr, to, ec in refusals:
    print(f"  [{ts}] {fr} -> {to} | engineCounts: {ec}")

print(f"\n=== phase_misfit_hint ({len(hints)}) ===")
for ts, ph, tl, h in hints:
    print(f"  [{ts}] phase={ph} tool={tl} hint: {h}")

print(f"\n=== top tools ===")
for k, v in tools.most_common(15):
    print(f"  {v:5d}  {k}")

print(f"\n=== worker_llm: empty={worker_empty} filled={worker_filled}")
print(f"=== heap peak: {heap_peak} MB")

print(f"\n=== user messages ({len(user_msgs)}) ===")
for ts, m in user_msgs:
    print(f"  [{ts}] {m}")
PYEOF
```

---

## Worker LLM call detail (tier + max_tokens used)

```bash
python3 << 'PYEOF'
import json, os
from collections import Counter
WS = os.environ.get("WS")
calls = []
with open(f"{WS}/logs/events.jsonl") as f:
    for line in f:
        e = json.loads(line)
        if e["type"] == "tool_start" and e["data"].get("name") == "worker_llm_call":
            inp = e["data"].get("input", {})
            calls.append({"tier": inp.get("tier"), "max_tokens": inp.get("max_tokens"),
                          "prompt_len": len(inp.get("prompt",""))})
print(f"total worker_llm_call: {len(calls)}")
print(f"tier dist: {Counter(c['tier'] for c in calls)}")
print(f"max_tokens dist: {Counter(c['max_tokens'] for c in calls)}")
print(f"prompt lengths: min={min(c['prompt_len'] for c in calls):d} max={max(c['prompt_len'] for c in calls):d}")
PYEOF
```

---

## Phase-windowed tool counts

```bash
python3 << 'PYEOF'
import json, os
from collections import Counter
WS = os.environ.get("WS")
current = "bootstrap"
per_phase = {}
with open(f"{WS}/logs/events.jsonl") as f:
    for line in f:
        e = json.loads(line)
        if e["type"] == "phase_transition":
            current = e["data"]["to"]
        elif e["type"] == "tool_start":
            per_phase.setdefault(current, Counter())[e["data"].get("name","?")] += 1
for ph, c in per_phase.items():
    print(f"=== {ph} ===")
    for n, k in c.most_common(8):
        print(f"  {k:5d}  {n}")
PYEOF
```

---

## Deliverable structural recon

```bash
echo "=== top level ===" && ls -la $WS/
echo "=== rules/ ===" && ls $WS/rules/
echo "=== rule_skills/ ===" && ls $WS/rule_skills/
echo "=== workflows/ (head) ===" && ls $WS/workflows/ | head -30
echo "=== output/ ===" && ls $WS/output/
echo "=== releases ===" && ls $WS/output/releases/ 2>/dev/null
echo "=== snapshots ===" && ls $WS/snapshots/ 2>/dev/null
echo "=== git tags ===" && (cd $WS && git tag)
echo "=== git log last 15 ===" && (cd $WS && git log --oneline | head -15)
```

---

## Catalog rule counts + chunk_refs population

```bash
python3 -c "
import json, os
WS = os.environ.get('WS')
d = json.load(open(f'{WS}/rules/catalog.json'))
print(f'total rules: {len(d)}')
with_refs = sum(1 for r in d if r.get('source_chunk_ids'))
print(f'with source_chunk_ids: {with_refs}/{len(d)} ({100*with_refs/len(d):.0f}%)')
from collections import Counter
print('verification_type dist:', Counter(r.get('verification_type') for r in d))
print('priority dist:', Counter(r.get('priority') for r in d))
"
```

---

## Skill folder check.py audit

```bash
python3 << 'PYEOF'
import os, glob
WS = os.environ.get("WS")
for d in sorted(glob.glob(f"{WS}/rule_skills/*/")):
    name = os.path.basename(os.path.dirname(d))
    files = os.listdir(d)
    has_skill = "SKILL.md" in files
    has_check = "check.py" in files
    if has_check:
        text = open(d + "check.py").read()
        is_stub = '"method": "stub"' in text or '"pass": null' in text
        lines = text.count("\n")
        print(f"  {name}: SKILL.md={has_skill} check.py=YES ({lines}L) stub={is_stub}")
    else:
        print(f"  {name}: SKILL.md={has_skill} check.py=ABSENT (skill-as-docs-only — likely workflow inversion)")
PYEOF
```

---

## Workflow code smoke

```bash
python3 << 'PYEOF'
import os, glob, ast
WS = os.environ.get("WS")
for p in sorted(glob.glob(f"{WS}/workflows/**/check.py", recursive=True)):
    try:
        text = open(p).read()
        ast.parse(text)
        lines = text.count("\n")
        regex_imports = "import re" in text or "from re " in text
        worker_calls = "worker_llm_call" in text or "import requests" in text
        print(f"  {p[len(WS):]}: parses_ok lines={lines} regex={regex_imports} llm_call={worker_calls}")
    except SyntaxError as e:
        print(f"  {p[len(WS):]}: SYNTAX ERROR — {e}")
PYEOF
```

---

## Release manifest details

```bash
python3 << 'PYEOF'
import json, os, ast
WS = os.environ.get("WS")
import glob
for rel in sorted(glob.glob(f"{WS}/output/releases/*/")):
    print(f"=== {rel[len(WS):]} ===")
    mf = rel + "manifest.json"
    if not os.path.exists(mf):
        print("  no manifest.json")
        continue
    m = json.load(open(mf))
    for k in ("label", "slug", "snapshot_tag", "snapshot_commit",
              "created_at", "kc_beta_version"):
        print(f"  {k}: {m.get(k)}")
    print(f"  rules count: {len(m.get('rules', []))}")
    print(f"  fixtures: {len(m.get('fixtures', []))}")
    notes = m.get("notes", "")
    print(f"  notes len: {len(notes)} | head: {notes[:160]}")
    rp = rel + "run.py"
    if os.path.exists(rp):
        try:
            ast.parse(open(rp).read()); print("  run.py: parses OK")
        except SyntaxError as e:
            print(f"  run.py: SYNTAX ERROR — {e}")
    cc = rel + "confidence_calibration.json"
    if os.path.exists(cc):
        cd = json.load(open(cc))
        ha = cd.get("historical_accuracy", {})
        print(f"  confidence_calibration: {len(ha)} entries{' (EMPTY)' if not ha else ''}")
PYEOF
```

---

## Ground-truth check vs seeded violations

The test corpus at `archive/test_data_3_lite/samples/trust/三季度_含违规/`
has 4 docs with ground truth in filename: `（非我行托管）`,
`（期末可供分配利润不一致）`, `（信保基金金额有误）`, `一致：`.

After locating the agent's testing artifact (e.g.,
`output/trust_samples_test.json`), grep for each ground-truth substring
and verify the corresponding check fired correctly:

```bash
python3 << 'PYEOF'
import json, os
WS = os.environ.get("WS")
GT = {
    "非我行托管": "custodian_is_nb",     # should be False
    "信保基金金额有误": "trust_security_fund",  # should be False
    "期末可供分配利润不一致": "profit_distribution",  # should be False
    "一致": None,  # control — all checks should pass
}
data = json.load(open(f"{WS}/output/trust_samples_test.json"))
for doc, fields in data.items():
    label = next((k for k in GT if k in doc), None)
    expected_field = GT.get(label) if label else None
    checks = fields.get("checks", {})
    print(f"\n{label} | {doc[:50]}")
    if expected_field:
        match = next((k for k in checks if expected_field in k), None)
        if match:
            v = checks[match]
            ok = (v == False)  # violation correctly caught when False
            print(f"  {match} = {v} -> {'CAUGHT' if ok else 'MISSED ❌'}")
        else:
            print(f"  no field matching '{expected_field}' in checks")
    else:
        # control — survey all fields for unexpected False
        falses = [k for k, v in checks.items() if v is False]
        if falses:
            print(f"  control has False checks (possible false positives): {falses}")
PYEOF
```

---

## Per-skill QC aggregate

```bash
python3 << 'PYEOF'
import json, os
WS = os.environ.get("WS")
d = json.load(open(f"{WS}/output/qc_batch_results.json"))
docs = {k: v for k, v in d.items() if not k.startswith("_") and isinstance(v, dict)}
skills_seen = set()
for v in docs.values():
    skills_seen |= {k for k in v if not k.startswith("_") and isinstance(v[k], dict)}
print(f"docs in batch: {len(docs)}")
for skill in sorted(skills_seen):
    p = f = t = n = 0
    for doc in docs.values():
        s = doc.get(skill, {})
        p += s.get("passed", 0); f += s.get("failed", 0)
        t += s.get("total", 0); n += s.get("na", 0)
    pr = p / max(1, p + f) * 100
    flag = "  ⚠️ ROUTER MISS?" if (p == 0 and f == 0) else ""
    print(f"  {skill:25} passed={p:4} failed={f:4} total={t:4} NA={n:4} pass_rate={pr:.1f}%{flag}")
PYEOF
```

---

## User intervention timeline cross-reference

```bash
python3 << 'PYEOF'
import json, os
WS = os.environ.get("WS")
import subprocess
# Pull all user_message events
prompts = []
with open(f"{WS}/logs/events.jsonl") as f:
    for line in f:
        e = json.loads(line)
        if e["type"] == "user_message":
            prompts.append((e["ts"], e["data"].get("content","")))
# For each prompt, list files modified in next 10 minutes via git log
for ts, content in prompts:
    print(f"\n[{ts}] PROMPT: {content[:200]}")
    # git log --since=ts --until=ts+10min --name-only
    result = subprocess.run(
        ["git", "-C", WS, "log", "--since", ts, "--until",
         ts.replace(":", "_") + "+10m" if False else "now",
         "--pretty=format:%h %s", "-n", "5"],
        capture_output=True, text=True
    )
    for ln in result.stdout.split("\n")[:6]:
        print(f"    {ln}")
PYEOF
```

(Git-since-timestamp is approximate; this is a guide, not surgical.
Cross-reference visually against the phase-transition timeline.)

---

## Walk-all-output-paths sanity check

Group 1a's path-traversal bug (engine derivation walks too shallow)
is the kind of issue that hides until an agent writes test artifacts
in a deeper layout than expected. Run this to inspect every JSON
under `output/` and surface which ones the engine's derivation
*would* see vs miss based on depth.

Useful both pre- and post-engine-fix: pre-fix, it diagnoses
"why is skillsTested=0 when there are clearly test results";
post-fix, it verifies the new walk catches the depths agents
actually use.

```bash
python3 << 'PYEOF'
import os, json
WS = os.environ.get("WS")
print("=== all output/*.json ===")
for root, dirs, files in os.walk(f"{WS}/output"):
    dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__pycache__")
    for f in sorted(files):
        if not f.endswith(".json"): continue
        p = os.path.join(root, f)
        rel = p[len(WS)+1:]
        depth = rel.count("/")  # path components from workspace root
        try:
            d = json.load(open(p))
        except: continue
        # Heuristic: does this file contain rule_id evidence the engine
        # would credit?
        has_rule_id_field = isinstance(d, dict) and "rule_id" in d
        has_results_dict = isinstance(d, dict) and isinstance(d.get("results"), dict)
        has_top_level_rule_keys = (
            isinstance(d, dict)
            and any(isinstance(v, dict) and ("PASS" in v or "verdict" in v or "passed" in v)
                    for v in d.values())
        )
        is_rule_array = isinstance(d, list) and d and isinstance(d[0], dict) and ("id" in d[0] or "rule_id" in d[0])
        has_evidence = has_rule_id_field or has_results_dict or has_top_level_rule_keys or is_rule_array
        flag = "  <- RULE EVIDENCE" if has_evidence else ""
        deep = "  <- DEEP (>=4)" if depth >= 4 else ""
        print(f"  depth={depth} {rel}{deep}{flag}")
PYEOF
```

Cross-reference against the engine derivation's actual walk
(`grep walkFiles src/agent/pipelines/_milestone-derive.js`). If a
RULE EVIDENCE file at depth ≥ 5 isn't credited, that's a real bug
to file.

---

## v0.7.2+ regression-check (post-engine-fix)

Run this after each E2E #8+ session to verify the v0.7.2 fixes
didn't regress. Each line is a one-shot.

```bash
WS=~/.kc_agent/bench-{conductor}-v0XX/<HASH>
PKG_VERSION=$(node -e "console.log(require('/path/to/kc_cli/package.json').version)")

# 1b: manifest reports live package version
python3 -c "import json; m = json.load(open('$WS/output/releases/v1-0-hybrid/manifest.json' if __import__('os').path.exists('$WS/output/releases/v1-0-hybrid/manifest.json') else '$WS/output/releases/v1-0/manifest.json')); print('kc_beta_version:', m.get('kc_beta_version'), '| expected:', '$PKG_VERSION', '| OK:', m.get('kc_beta_version') == '$PKG_VERSION')"

# 1c: confidence_calibration non-empty when QC has data
python3 -c "import json, glob; ls = glob.glob('$WS/output/releases/*/confidence_calibration.json'); [print(p, '->', len(json.load(open(p)).get('historical_accuracy', {})), 'rules') for p in ls]"

# 1d: no leftover template scaffold v1/ alongside customized release
ls $WS/output/releases/ 2>/dev/null
# Expect: ONE customized dir (v1-0, v1-0-hybrid, etc.), NO bare v1/ with .tmpl files

# 1e: bootstrap refusals had non-empty engineCounts
python3 -c "
import json
for line in open('$WS/logs/events.jsonl'):
    e = json.loads(line)
    if e['type'] == 'phase_advance_refused' and e['data'].get('from') == 'bootstrap':
        ec = e['data'].get('engineCounts', '')
        print('bootstrap refusal engineCounts:', repr(ec[:120]))
"

# 1a: skill_testing → distillation natural advance? (the headline win)
grep '"phase_transition"' $WS/logs/events.jsonl | python3 -c "
import json, sys
for line in sys.stdin:
    e = json.loads(line)
    d = e.get('data', {})
    if d.get('to') == 'distillation':
        print('skill_testing -> distillation forced=', d.get('forced'))
"
```

Each fix should now be in the "PASS" column. If any are still in
the "FAIL" column, the fix regressed — file as a Group X bug in the
audit's "Bugs" section.
