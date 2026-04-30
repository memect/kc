# KC Update Design v7 — v0.7.0 architectural overhaul

## Status

**2026-04-29.** v0.7.0 shipped after E2E #5 (3-way LLM benchmark on
`test_data_3_lite/` with GLM-5.1, DeepSeek-v4, Xiaomi MiMo-2.5,
Tencent hy3 conductors). Two finished (DS, GLM); both audits in
`archive/e2e_test_20260428_{ds,glm}_session_audit.md`.

Source plan: `~/.claude/plans/please-read-the-project-swift-rossum.md`
(eleven groups, K through J). This doc records what actually shipped
and what slipped to v0.7.1.

Previous design docs:
- `docs/update_design_v6.md` — v0.6.0 → v0.6.3 design + v0.6.4 deferred
  bucket (became v0.7.0)
- `docs/update_design_v5.md` — v0.5.6 → v0.6.0
- `DEV_LOG.md` — release notes per version

---

## Locked design principles (carried from v0.6.x, sharpened by E2E #5)

1. **Hard tracking, soft executing** — the engine measures what is on
   disk, not which tools the agent called. v0.7.0 makes this real:
   tool-wrapper milestone recorders are now auxiliary signal at best;
   pipelineMilestones is a cache of disk facts.
2. **Thin harness, fat skills** — engine code stays narrow and
   filesystem-honest; methodology, ordering, grouping live in
   meta-meta skills the agent reads at the right phase. v0.7.0 ships
   the new `work-decomposition` skill as the canonical example.
3. **Floor before freedom** — every freedom v0.7.0 grants the agent
   (TaskBoard ownership, methodology choice, PATTERNS.md memory) is
   covered by a disk-derived gate. The agent decides shape; the
   engine verifies coverage.

---

## E2E #5 findings that drove v0.7.0

> **The hard-tracking layer never constrained either alive contestant.**
> Engine milestones stayed at zero across phases the agent had completed
> real work in. Every phase gate got force-bypassed (12/12 across DS+GLM).
> Both shipped non-runnable release bundles. Tracking-as-ground-truth
> from v0.6.1 failed silently because tracking was wired to milestone-
> recording tool wrappers, and agents who use Write/Bash/sandbox_exec
> directly bypass the recorders.

Secondary findings:
- GLM peaked at 3.8 GB heap; DS at 1.5 GB
- Release tool layout convention undocumented; both contestants
  invented different non-matching shapes
- v0.6.2 skill validator regex disagreed with KC's own meta-meta spec
  (3 of 4 contestants got rejected on style)
- 2026-04-28 static audit found 3 critical + 9 high engine/CLI bugs
  orthogonal to E2E findings

---

## What shipped in v0.7.0

Eight commits, ten groups merged. Stack on `main` after release tag:

```
v0.7.0       Group J — release (version + DEV_LOG + design v7 + tag)
5a04085      Group C/E partial — release tool layout fallback (#98) + budget-aware compact (#93)
601c1d1      Group E partial — per-provider contextLimit (#96)
3c9ff83      Group F — filesystem & UX polish (#84, #92, #95)
a26d9ce      Group D — skill format alignment (describeState inline + skill-creator scoping)
0da3879      Group B — agent-owned decomposition + work-decomposition skill
857dcfe      Group H — static-audit critical + high (defensive fixes)
bba1943      Group A — hard-tracking floor (filesystem-derived milestones)
153a3a3      Group K — license migration + meme defensive obfuscation
```

### Group K — license migration (PolyForm Noncommercial 1.0.0 + meme protection)

Personal users free, no republish-as-new-product, enterprises pay.
Verbatim PolyForm Noncommercial 1.0.0 LICENSE + LICENSE-COMMERCIAL.md
(contact: heavysal@gmail.com). package.json switches `"license":
"MIT"` → `"license": "SEE LICENSE IN LICENSE"`. Welcome banner gets a
license footer. Historical commits stay under MIT for those release
versions; v0.7.0+ is PolyForm.

`/meme` easter egg: bytenode was the original plan but meme.js imports
react+ink (ESM-only) and bytenode targets CJS — bridging would need an
esbuild bundle dep. Switched to encoded-source (base64 + XOR) which
achieves the same defensive goal without extra deps. Source moved to
`src/cli/meme.source.js` (excluded from npm), generated `meme.js` is
shipped. 112-char watermark survives in the decoded payload to
identify origin in copies.

### Group A — hard-tracking floor (the architectural payload)

**The fix for E2E #5's central failure.** New
`src/agent/pipelines/_milestone-derive.js` centralizes filesystem
checks for every phase's milestones. Every pipeline's `_scan*` /
`exitCriteriaMet` / `describeState` routes through it. Disk wins over
tool-wrapper recorders.

Concrete derivations:

| Phase | Criterion | Disk derivation |
|---|---|---|
| bootstrap | hasSamples | `samples/` non-empty (recursive count) |
| rule_extraction | rulesExtracted | `rules/catalog.json` parse → entries with `id` |
| rule_extraction | rulesWithChunkRefs | catalog entries with non-empty `source_chunk_ids` |
| rule_extraction | coverageAudited | `rules/coverage_audit.{md,json}` exists |
| skill_authoring | skillsAuthored | glob `rule_skills/*/SKILL.md` (case-insensitive) |
| skill_authoring | skillsWithScripts | glob `rule_skills/*/check_*.py` OR `scripts/check*.py` |
| skill_testing | skillsTested | `tests/`, `test_results.json`, or `assets/test_cases.json` |
| distillation | workflowsCreated | three-layout fallback (subdir / flat / json manifest) |
| distillation | workflowsTested | per-workflow `test_results/` or test-result JSON |
| production_qc | batchesProcessed | DS-shape (results dict) OR GLM-shape (array of verdicts) |
| production_qc | documentsReviewed | unique doc paths inside result JSONs |
| finalization | readmeWritten | `output/releases/*/README.md`, `rule_skills/README.md`, OR workspace-root README.md ≥500B |
| finalization | finalDashboardWritten | sha256-distinct dashboards/*.html (no byte-duplicates) |

Companion fixes in this group:
- **A2** — `forced` flag honesty: `force && nextPhase !== expected` →
  `!!force`. Audit logs now reflect 12/12 force-bypasses (was 0/12 in
  E2E #5). New `direction: "forward"|"rollback"` field disambiguates.
- **A3** — Refusal text scrubbed of `force:true`. Old refusal trained
  the agent to bypass. New refusal points at `/status` + describeState
  + missing milestones. `force` stays in the schema (discoverable),
  is no longer hand-fed.
- **A4** — Skill validator runs on every workspace_file write to
  rule_skills paths, not just at exitCriteriaMet. Failures surface
  in describeState within one tool-call cycle.
- **A5** — TaskManager.reconcileAgainstDisk: at every phase boundary,
  walks "completed" tasks in PER_RULE_PHASES and flips back to pending
  if helper-derived ruleIdsCovered doesn't include them. Catches the
  E2E #5 DS gap (70/70 done but 56 dirs / 36 with check_*.py on disk).
- **A6** — Skill validator regex loosened to `/^def \w+\s*\(/m` (any
  top-level def). Previous strict naming rejected 27/28 GLM scripts;
  the real signal comes from `≥100 bytes + ast.parse passes`.

**Verification (offline replay of E2E #5 session-state files):**
- DS would advance naturally through `bootstrap` and `skill_authoring`
  (1 of 6 transitions natural; rest block honestly because DS didn't
  do chunk refs / coverage audit / skill testing).
- GLM would advance naturally through `bootstrap`, `rule_extraction`,
  `skill_authoring` (3 of 6; skill_testing / distillation / qc block
  honestly because GLM skipped real testing in 5 minutes).
- Force-bypass count drops from 12/12 to ~8/12, and the remaining
  forces have honest reasons rather than gate misalignment.

### Group H — static-audit critical + high (12 bugs, defensive)

Three critical + nine high from the 2026-04-28 audit. Several (C2
exit-gate accuracy bug, H4 scripts/ dir bug, H5 production-qc
vacuous-truth flip) collapsed into Group A's filesystem-derived
rewrite. Remaining shipped fixes:

- **C3** StatusBar ref mutation in render → moved to useEffect
- **H1** trackedPromise tail .catch (defensive against secondary throws)
- **H3** withSyncFileLock now uses resolvePath (path-traversal safe)
- **H6** showWelcome dismissed on first non-system message
- **H7** /compact IIFE has top-level .catch
- **H8** /resume IIFE same
- **H9** loadEnvFile wrapped in try/catch (no longer crashes bootstrap
  on permission-denied .env)

C1, H1, H2 — audit was overstated; defensive comments added explaining
why the existing code is safe enough.

### Group B — agent-owned decomposition (the architectural payload, on top of A)

The freedom layer that A's floor enables.

- **B1** — New `template/skills/{zh,en}/meta-meta/work-decomposition/SKILL.md`
  (~400 lines each language). Teaches: ordering methodologies
  (Shannon-Huffman recommended default, BFS, DFS, binary partition),
  grouping rules (when to bundle vs split), three-axis difficulty
  triage (CoT depth + module count + cross-rule interaction),
  PATTERNS.md memory discipline (✅/❌ examples).
- **B2** — `TaskManager.PER_RULE_PHASES = new Set()`. Engine no longer
  auto-creates per-rule tasks. Agent reads describeState rule list,
  decides decomposition shape, calls TaskCreate. Feature-flag
  `KC_AGENT_OWNS_TASKBOARD=0` restores v0.6.x behavior for staged
  rollout (slated for removal in v0.8.0).
- **B3** — PATTERNS.md plumbing. `engine._readProjectMemory()` reads
  `rules/PATTERNS.md` (5 KB cap). `ContextAssembler.build()` takes
  `projectMemory` param; renders as a "Project memory" block in the
  system prompt for skill_authoring + skill_testing.
- **B4** — Difficulty triage taught inside the skill (not engine-
  enforced). Convention: `rules/difficulty.json`.

Tradeoff flagged in DEV_LOG: more freedom widens the strong/weak
conductor gap. Mitigation is Group A's filesystem-derived floor —
bad grouping fails the gate; user sees missing milestones honestly.

### Group D — skill format alignment

- **D1** — skill_authoring describeState inlines the canonical skill
  folder layout spec directly. ~250 token cost per turn; benefit is
  first-attempt structural compliance (E2E #5: 3 of 4 contestants
  ignored the spec because reading it required navigation).
- **D2** — skill-creator description rewritten in zh + en to clarify
  it's Anthropic's scaffolding toolkit (apply after KC's per-rule
  skills exist), not the primary reference for building them. Read
  `meta-meta/skill-authoring` + `meta-meta/work-decomposition` first.
  Directory rename deferred (would touch 6 src files + npm package
  convention; clearer description achieves the same scope clarity).

### Group F — filesystem & UX polish

- **F1** — `Workspace.fsCaseSensitive` detected at construction via
  `.kc-case-probe-MIXED` + `.kc-case-probe-mixed` pair. macOS/Windows
  → false. Foundation for tools to warn on case collisions
  (workspace_file warning hookup deferred to v0.7.1).
- **F2** — /resume now calls `setTaskList` + `setTaskProgress` on the
  resumed engine's taskManager. TUI task panel populates correctly.
- **F3** — `Scheduler.pendingInputCount()` excludes hidden files. Agent
  scratch goes under `input/.kc-scratch/` (sidecar marker hidden by
  the standard "starts with ." filter).

### Group E partial — per-provider contextLimit (#96)

`providerContextCap` field on providers.js entries. Effective
contextLimit clamps `min(requested, cap)` with a console warning when
clamped. SiliconFlow gets `providerContextCap: 200000` so future
GLM-5.1 sessions can't hit the deployment hard ceiling that broke
E2E #5 GLM at 203,363 tokens.

### Group C/E partial — release tool + budget-aware compact

- **#98** — `release.js _findLatestWorkflow` falls through canonical
  subdir layout, DS/GLM flat layout, and DS regex_skill manifest.
  "no workflows found" error rewritten to spell out accepted layouts +
  actionable next steps.
- **#93** — _runTaskLoopSerial compact threshold: `messages.length > 15`
  → `totalTokens > 60% of kcContextLimit` (configurable via
  `KC_COMPACT_THRESHOLD_TOKENS`). E2E #5 GLM saw 76 memory_pressure
  events and DS saw 46 because the message-count threshold pre-empted
  natural windowing; budget-aware threshold restores headroom.

---

## Expansion (2026-04-30) — folded the v0.7.1 deferrals back in

User decision the day after the initial v0.7.0 tag (which was never
pushed): roll the five deferred items into v0.7.0 itself. Tag deleted
locally + re-applied at HEAD after the expansion landed. The expanded
v0.7.0 is the architectural overhaul in full.

Five additional commits on top of `d2cd75f`:

```
2be19c7  N — finalization release template (#94 remainder)
9e12da7  G — parser/chunker rebuild (#91)
28ff6de  E1m — minimal event-atomic context (#90)
418b6ae  M — case-collision warning in workspace_file write (#84 remainder)
e792a7f  L — Anthropic SSE thinking_delta + signature_delta (#76)
```

Plus J2 (this commit + retag).

**Group L — Anthropic SSE thinking_delta**: llm-client.js Anthropic
SSE branch normalizes `thinking_delta` to OpenAI-shape `reasoning_content`
+ stashes `signature_delta` as a custom `reasoning_signature` field;
_buildAnthropicBody re-attaches both as a `{type: "thinking",
thinking, signature}` block at the top of the assistant content array
on the next turn. OpenAI-format providers never emit signature_delta;
the new code paths are no-ops for them. Engine.js's v0.6.3
reasoning_content round-trip handles it without an Anthropic-specific
branch.

**Group M — case-collision warning hookup**: workspace_file `_write`
on case-insensitive filesystems checks for siblings sharing the
target's lowercase basename, surfaces a `⚠ case-collision:` note in
the tool result text. Write proceeds (warning, not refusal). E2E #5
GLM hit this exactly with SKILL.md/skill.md collapsing into one
inode then disappearing under archive_file.

**Group E1m — minimal event-atomic context**: derived view on top of
the existing flat messages array. New `src/agent/history/event-history.js`
exports EventType enum + messagesToEvents + eventsToMessages +
findEventBoundary + countEvents. message-utils.js findSafeSplitPoint
delegates to findEventBoundary as primary cut chooser; legacy
heuristic walk kept as belt-and-braces. compact() and windowing
unchanged — they already routed through findSafeSplitPoint, get
event-aware cuts for free. v0.8.x can invert the storage direction
(events as canonical, messages as derived view) cheaply via the
reversible helpers.

**Group N — finalization release template**: `template/release/v1/`
ships a runnable skeleton — `run.py` (190 LOC dispatcher),
`kc_runtime/` (doc_parser + confidence helpers), `render_dashboard.py`
(single-file HTML), `serve.sh`. Engine wiring: new `Pipeline.onPhaseEnter()`
hook (base.js); finalization implements it to copy the template
into `output/releases/v1/` + run a populator that fills the .tmpl
files from session-state. New `_releaseBundlePreflightOk()` exit
criterion blocks `canonicalLayoutDone=True` until every required
file (run.py, manifest.json, README.md, kc_runtime/doc_parser.py +
confidence.py) exists.

**Group G — parser/chunker rebuild**: new
`src/agent/document-parser.js` extractText() dispatches by extension
— pdfjs-dist (PDF), mammoth (DOCX, dynamic-imported new dep),
word-extractor (DOC, dynamic-imported new dep), native fs (TXT/MD)
with UTF-8/GBK fallback for CJK, LibreOffice CLI as final fallback.
tools/document-chunk.js's "// For other formats" stub replaced with
a call to extractText. Returns `{text, via, ok, error?}` so callers
can record which strategy produced the text. Dynamic imports mean
existing setups can defer `npm install` after upgrade until they
actually touch DOCX/DOC content.

---

## Out of scope (truly v0.7.1+)

After the expansion, the only items genuinely out of v0.7.0 scope are:

- **Static-audit revisits for C1/H1/H2** — defensive comments left in
  place during v0.7.0 Group H; these were judged overstated. No change
  planned.
- **Full event-atomic refactor** (events as primary store, messages
  derived view) — E1m landed the minimal version. Escalate only if
  E2E #6 shows the minimal is insufficient.
- **AMCS-mirrored full agent harness** for finalization template — N
  landed the minimal runnable. Escalate if E2E #6 surfaces gaps.

---

## Verification

### Per-group verification done

- **Group A**: re-processed DS + GLM E2E #5 session-state files;
  derived milestones match disk reality. Force-bypass would drop from
  12/12 → ~8/12.
- **Group H**: syntax check + smoke boot of `kc-beta --help`.
- **Group B**: skill content reads cleanly; PER_RULE_PHASES empty;
  describeState surfaces PATTERNS.md when present.
- **Group D**: describeState inline visible in skill_authoring system
  prompt build.
- **Group F**: case-sensitivity probe writes/reads/cleans up;
  pendingInputCount excludes hidden.
- **Group E partial**: clamp logic verified offline (requested=400000,
  cap=200000 → 200000 + warning).
- **Group C/E partial**: release-tool fallback recognizes the three
  layouts; compact threshold reads kcContextLimit correctly.

### Final E2E #6 verification (planned, not yet run)

Re-run the E2E #5 setup on `archive/test_data_3_lite/` post-v0.7.0:
- Same four conductors + same workers
- Same workspace structure

**Success criteria**:
1. Force-bypass count drops to ≤ 3/12 across DS+GLM (from 12/12).
2. Engine milestones match disk reality at every phase boundary.
3. Release bundles produced by `release` tool actually run (`run.py`
   exits 0 on smoke input).
4. GLM heap stays bounded — < 2 GB peak on a 24h-equivalent run
   (vs 3.8 GB in E2E #5). Note: full mitigation requires v0.7.1
   event-atomic context; v0.7.0's budget-aware compact is partial.
5. Capability-sensitivity visible — strong conductors should produce
   well-grouped tasks + lean PATTERNS.md; weaker conductors flatter
   task lists. Both should still satisfy Group A gates.

---

## Open risks

1. **Group A breakage of legitimate workflows**. If the filesystem-
   derivation criteria are still too strict (e.g., requiring
   coverage_audit.md while a future agent uses a different filename),
   gates re-block. Mitigation: A6's loose validator + extraction.js's
   relaxed test-shape acceptance. Watch for new force-bypasses in E2E #6
   that aren't in v0.7.0's loosening list.

2. **Group B capability gap**. Strong/weak conductor variance widens
   with agent-owned tasking. Mitigation: Group A floor catches weak
   output. v0.7.1 may add an opt-in "TaskBoard suggestions" surface
   that points the agent at the work-decomposition skill earlier.

3. **Group C release tool fallback false-positives**. The new
   workflows/<id>.json manifest path follows .entry pointer; if .entry
   is malformed, the tool falls back silently to "no workflow." Watch
   E2E #6 for shipped manifests with broken pointers.

4. **Group K bytenode-deviation**. Encoded-source approach raises bar
   against grep, not against a determined reverser. Plagiarism deterrence
   is "moderate" — watermark + license + npm license field. If users
   redistribute KC under a different name, the watermark survives in
   the decoded payload as evidence of origin.

5. **E2E #6 doesn't validate**. If the architectural rewrite surfaces
   a new failure class. Each group is independently revertable; v0.7.0.x
   hot-fix track if needed.

---

*Drafted 2026-04-29 post-implementation. Source: full E2E #5 audit
docs (`archive/e2e_test_20260428_*`), `docs/update_design_v6.md`
deferred sections, the v0.7.0 plan in `~/.claude/plans/`. Next:
E2E #6 verification, then v0.7.1 plan with the deferred items.*
