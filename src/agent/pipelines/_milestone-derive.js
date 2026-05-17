// v0.7.0 Group A1: filesystem-derived pipeline milestones.
//
// E2E #5 finding (DS + GLM audits): every phase gate got force-bypassed
// because the engine's pipelineMilestones were tracking *which tools the
// agent called*, not *what artifacts ended up on disk*. Both contestants
// produced real work (70 skill scripts, 28 workflows, 1951 verdicts) via
// Write/Bash/sandbox_exec, so the milestone-recording tool wrappers
// (workflow-run.js → engine._recordMilestone) never fired and the gate
// stayed empty.
//
// This module is the new canonical source. Each derive function reads
// the workspace filesystem and returns the milestone fields for that
// phase. Pipelines call these instead of (or in addition to) their
// previous tool-instrumented counters.
//
// Design: simple + correct over fast + complex. Each derive is bounded
// (~10-50 stat calls per phase, all on warm OS cache → microseconds).
// No cache layer in v0.7.0 — if profiling later shows it's hot, add it
// then. The functions are pure: same disk state in, same milestones out.
//
// Workspace param is a Workspace instance with a .cwd string. Functions
// also accept a plain workspaceCwd string for tests / one-off audits
// (e.g., re-deriving E2E #5 session-state from saved workspaces).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function cwdOf(ws) {
  return typeof ws === "string" ? ws : (ws?.cwd || ws?.path || "");
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function readDirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

function listChildren(p) {
  return readDirSafe(p).filter((e) => !e.name.startsWith("."));
}

function listChildDirs(p) {
  return listChildren(p).filter((e) => e.isDirectory());
}

function listChildFiles(p) {
  return listChildren(p).filter((e) => e.isFile());
}

// Walk a directory recursively, yielding every file path. Skips hidden
// dirs/files and __pycache__. Used by derive functions that need to
// match arbitrarily-nested artifacts (e.g., scripts/ subdirs).
//
// v0.7.2 1a: optional maxDepth caps recursion. depth=0 is root's
// direct children; depth=1 is one level down. Default unbounded
// (existing callers).
function* walkFiles(root, { maxDepth } = {}) {
  if (!dirExists(root)) return;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    for (const e of readDirSafe(dir)) {
      if (e.name.startsWith(".") || e.name === "__pycache__") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (maxDepth == null || depth < maxDepth) stack.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile()) yield p;
    }
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

// v0.8 P1-A: find the first existing file from a list of candidate relative
// paths. Returns the absolute path of the first match, or null. Used for
// "agent-might-have-written-it-anywhere" lookups where conventions vary.
//
// 资管 v0.7.5 wrote rule_skills/coverage_report.md; 贷款 v0.7.5 wrote
// output/coverage_report.md or similar. Each derive function previously
// hardcoded its own short list — extracting this helper keeps additions
// centralized.
function findFileAcrossKnownPaths(workspaceCwd, relPaths) {
  for (const rel of relPaths) {
    const abs = path.join(workspaceCwd, rel);
    if (fileExists(abs)) return abs;
  }
  return null;
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, "utf-8"); } catch { return ""; }
}

/**
 * v0.7.5 G-H1: extract `source_rules: [...]` from YAML frontmatter.
 *
 * Supports both inline and block list forms:
 *   source_rules: [R001, R005, R007]
 *   source_rules:
 *     - R001
 *     - R005
 *
 * Used by milestone derivation to credit grouped/thematic skill folders
 * + master workflows where the agent declares which rules are covered.
 * Returns an array of canonical rule IDs (e.g., ["R001", "R005"]).
 */
function parseSourceRulesFromFrontmatter(content) {
  if (!content || typeof content !== "string") return [];
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];

  // Inline form: source_rules: [R001, R005, "R007"]
  const inlineMatch = fm.match(/^source_rules\s*:\s*\[([^\]]*)\]\s*$/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map(s => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
      .map(s => canonicalRuleId(s) || s)
      .filter(rid => /^R\d+$/i.test(rid))
      .map(rid => rid.toUpperCase().replace(/^R0*(\d+)$/, (_, n) => `R${String(parseInt(n,10)).padStart(3,"0")}`));
  }

  // Block form: source_rules:\n  - R001\n  - R005
  const blockMatch = fm.match(/^source_rules\s*:\s*\n((?:[ \t]+-\s+\S+\s*\n?)+)/m);
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map(line => {
        const m = line.match(/^[ \t]+-\s+["']?([^"'\s]+)["']?\s*$/);
        return m ? m[1] : null;
      })
      .filter(Boolean)
      .map(s => canonicalRuleId(s) || s)
      .filter(rid => /^R\d+$/i.test(rid))
      .map(rid => rid.toUpperCase().replace(/^R0*(\d+)$/, (_, n) => `R${String(parseInt(n,10)).padStart(3,"0")}`));
  }

  return [];
}

function sha256OfFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

// Normalize a rule id to a canonical form for dedup + comparison.
// Accepts two shapes:
//   Bare-numeric: "R14" / "r014" / "R0014" → "R014"
//   Compound:    "R01-01" / "R01_01" / "R001-005" → "R001-005"
//                (zero-pads the major part to 3 digits; preserves the
//                 minor part numerically; uses dash separator canonically)
// Returns null for non-matching strings (e.g., thematic skill names like
// "account_identity" — those stay as-is and don't get credited via this
// path; their credit comes from frontmatter `source_rules:` instead).
//
// v0.8.3 P20-B2: compound form added. E2E #13 资管 used `R01-01`..`R07-01`
// naturally following the regulation's subsection numbering; v0.8.2's
// bare-only regex returned null for all 15 dirs → `rulesCovered: 0/15`
// → engine refused natural skill_testing advance.
export function canonicalRuleId(s) {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  // Compound form: R01-01, R01_01, R001-005, etc.
  const compound = trimmed.match(/^R0*(\d+)[-_](\d+)$/i);
  if (compound) {
    const major = String(parseInt(compound[1], 10)).padStart(3, "0");
    const minor = String(parseInt(compound[2], 10)).padStart(2, "0");
    return `R${major}-${minor}`;
  }
  // Bare-numeric form
  const bare = trimmed.match(/^R0*(\d+)$/i);
  if (bare) return `R${String(parseInt(bare[1], 10)).padStart(3, "0")}`;
  return null;
}

// ───────────────────────────────────────────────────────────────────
// bootstrap
// ───────────────────────────────────────────────────────────────────

export function deriveBootstrapMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const samplesDir = path.join(cwd, "samples");
  let hasSamples = false;
  let sampleCount = 0;
  if (dirExists(samplesDir)) {
    // Count any non-hidden file at any depth — agents may organize
    // samples in subdirs (E2E #5 GLM had samples/samples/ recursion).
    for (const _f of walkFiles(samplesDir)) { sampleCount++; if (sampleCount > 0) hasSamples = true; }
  }
  return { hasSamples, sampleCount };
}

// ───────────────────────────────────────────────────────────────────
// rule_extraction
// ───────────────────────────────────────────────────────────────────

export function deriveRuleExtractionMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const rulesDir = path.join(cwd, "rules");

  // rulesExtracted: every rule object across every JSON file in rules/
  // that has a non-empty `id` field. catalog.json is canonical but agents
  // sometimes fan out to per-rule files (E2E #5 DS) — or write SIBLING
  // files with the same IDs plus additional metadata (E2E #13 资管's
  // `rules/difficulty.json` added judgment-type classifications and
  // doubled the count from 15 → 30 because the engine pushed IDs without
  // dedup). v0.8.3 P20-B1: dedup by ID across all rules/*.json files.
  // First-seen wins for chunk-ref counting (catalog.json is read first
  // by alphabetical / fs order in most cases).
  const rulesExtracted = [];
  const rulesWithChunkRefs = [];
  const seenIds = new Set();
  if (dirExists(rulesDir)) {
    for (const e of listChildFiles(rulesDir)) {
      if (!e.name.endsWith(".json")) continue;
      const data = readJsonSafe(path.join(rulesDir, e.name));
      if (!data) continue;
      const items = Array.isArray(data) ? data : (data.rules || []);
      for (const r of items) {
        if (r && typeof r.id === "string" && r.id.length) {
          if (seenIds.has(r.id)) continue; // v0.8.3 P20-B1 dedup
          seenIds.add(r.id);
          rulesExtracted.push(r.id);
          // v0.8.2 P13-C: accept any of three field names for chunk
          // references. Engine historically looked only for
          // `source_chunk_ids`, but 贷款 v0.8.1 + 资管 v0.8.1 catalogs
          // wrote `chunk_ids` (the shorter form agents naturally pick
          // from the rule-extraction skill examples). `chunk_refs` is
          // a legacy alias from older audit docs. Any non-empty match
          // counts.
          const chunks = (Array.isArray(r.source_chunk_ids) && r.source_chunk_ids)
            || (Array.isArray(r.chunk_ids) && r.chunk_ids)
            || (Array.isArray(r.chunk_refs) && r.chunk_refs)
            || null;
          if (chunks && chunks.length > 0) {
            rulesWithChunkRefs.push(r.id);
          }
        }
      }
    }
  }

  // coverageAudited: presence of any coverage audit/report doc. Loose
  // criterion — agents pick different conventions; the spirit is "did the
  // agent produce a coverage doc" not "did they put it in this exact file".
  // v0.8 P1-A: use the same findFileAcrossKnownPaths helper as finalization.
  const coverageAudited = !!findFileAcrossKnownPaths(cwd, [
    path.join("rules", "coverage_audit.md"),
    path.join("rules", "coverage_audit.json"),
    path.join("rules", "coverage_report.md"),
    path.join("output", "coverage_report.md"),
    path.join("rule_skills", "coverage_report.md"),       // v0.8 P1-A
    path.join("output", "qc", "coverage_report.md"),
  ]);

  return {
    rulesExtracted,
    rulesWithChunkRefs,
    coverageAudited,
  };
}

// ───────────────────────────────────────────────────────────────────
// skill_authoring
// ───────────────────────────────────────────────────────────────────

// Recognized check-script paths inside a skill dir, per A6 spec:
//   <skillDir>/check_r###.py    (DS + most agents)
//   <skillDir>/check.py         (canonical meta-meta spec)
//   <skillDir>/scripts/check_r###.py  (XM)
//   <skillDir>/scripts/check.py
function findCheckScripts(skillDir) {
  const found = [];
  for (const f of walkFiles(skillDir)) {
    const base = path.basename(f);
    const rel = path.relative(skillDir, f);
    // Only count scripts at depth ≤ 2 (skillDir/check.py or skillDir/scripts/check.py)
    const depth = rel.split(path.sep).length;
    if (depth > 2) continue;
    if (/^check(_r[\d_-]+)?\.py$/i.test(base) || /^check_r[\d_-]+\.py$/i.test(base)) {
      found.push(f);
    }
  }
  return found;
}

export function deriveSkillAuthoringMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const skillsDir = path.join(cwd, "rule_skills");
  const skillsAuthored = [];
  const skillsWithScripts = [];
  const ruleIdsCovered = new Set();

  if (!dirExists(skillsDir)) {
    return { skillsAuthored, skillsWithScripts, ruleIdsCovered: [] };
  }

  for (const e of listChildDirs(skillsDir)) {
    if (e.name.startsWith("__")) continue;
    const skillPath = path.join(skillsDir, e.name);

    // SKILL.md OR skill.md (case-insensitive — macOS/Windows users
    // produce both, see v0.7.0 F1 task).
    const hasSkillMd = listChildFiles(skillPath).some(
      (f) => f.name.toLowerCase() === "skill.md",
    );
    const checkScripts = findCheckScripts(skillPath);
    const hasAnyPy = walkFiles(skillPath).next().done === false &&
      checkScripts.length > 0;

    if (hasSkillMd || hasAnyPy) skillsAuthored.push(e.name);
    if (checkScripts.length > 0) skillsWithScripts.push(e.name);

    // Collect ruleIds covered by directory name, single check_r###.py
    // names, grouped check_r###_r###.py names, and range dirs R078_R128.
    const dirCanon = canonicalRuleId(e.name);
    if (dirCanon) ruleIdsCovered.add(dirCanon);
    const rangeDir = e.name.match(/^R0*(\d+)[_-]R0*(\d+)$/i);
    if (rangeDir) {
      const lo = parseInt(rangeDir[1], 10);
      const hi = parseInt(rangeDir[2], 10);
      for (let n = lo; n <= hi; n++) {
        ruleIdsCovered.add(`R${String(n).padStart(3, "0")}`);
      }
    }
    for (const scriptPath of checkScripts) {
      const base = path.basename(scriptPath);
      const single = base.match(/^check_r0*(\d+)\.py$/i);
      if (single) {
        ruleIdsCovered.add(`R${String(parseInt(single[1], 10)).padStart(3, "0")}`);
      }
      const grouped = base.match(/^check_r0*(\d+)[_-]+r0*(\d+)\.py$/i);
      if (grouped) {
        const lo = parseInt(grouped[1], 10);
        const hi = parseInt(grouped[2], 10);
        for (let n = lo; n <= hi; n++) {
          ruleIdsCovered.add(`R${String(n).padStart(3, "0")}`);
        }
      }
    }

    // v0.7.5 G-H1: also credit rule_ids declared in SKILL.md frontmatter
    // `source_rules:` field. Agents using grouped/thematic skill folders
    // (e.g., S01_compliance/, custodian_checks/) declare which rules
    // their grouped check covers via frontmatter; engine derivation
    // credits each declared rule_id. Audit found 资管 v0.7.4 session
    // forced through skill_authoring → skill_testing because its 10 S*
    // grouped folders weren't credited (rulesCovered=0/94).
    if (hasSkillMd) {
      try {
        const skillMdFile = listChildFiles(skillPath).find(
          (f) => f.name.toLowerCase() === "skill.md",
        );
        if (skillMdFile) {
          const content = readFileSafe(path.join(skillPath, skillMdFile.name));
          const sourceRules = parseSourceRulesFromFrontmatter(content);
          for (const rid of sourceRules) ruleIdsCovered.add(rid);
        }
      } catch { /* best-effort */ }
    }

    // v0.8.2 P13-D: also credit rule_ids declared in rule_mapping.json.
    // 资管 v0.8.1 wrote 6 thematic-overlay dirs (R01_periodic_report,
    // R02_custodian_core, etc.) each containing a rule_mapping.json that
    // maps rule_ids to engine-level check function names. The dirs have
    // no own check.py because the actual implementation lives in
    // workspace-root verify_v*.py. Without recognizing rule_mapping.json,
    // the engine treats them as orphan dirs.
    //
    // Rule-id formats in the wild include both bare-numeric (R01, R027)
    // and compound (R01-05, R02-08). canonicalRuleId() only handles the
    // bare form, so we accept either canonicalized form OR a raw key
    // that looks like a rule id (matches R\d+ optionally followed by
    // `-` or `_` and more digits).
    try {
      const mappingPath = path.join(skillPath, "rule_mapping.json");
      if (fileExists(mappingPath)) {
        const mapping = readJsonSafe(mappingPath);
        if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
          for (const key of Object.keys(mapping)) {
            const canon = canonicalRuleId(key);
            if (canon) {
              ruleIdsCovered.add(canon);
            } else if (/^R0*\d+[-_]?\d*$/i.test(key.trim())) {
              // Compound form like "R01-05" — preserve as-is
              ruleIdsCovered.add(key.trim());
            }
          }
        }
      }
    } catch { /* best-effort */ }
  }

  // v0.8 P2-F (item 22): count stub-shaped check.py files. Pairs with
  // v0.8 P2-A teaching about the inverse-stub anti-pattern. Surfaces
  // a ratio that downstream code (skill-authoring exitCriteriaMet)
  // can choose to enforce via env flag.
  const checkPyAudit = _auditCheckPyShapes(skillsDir);

  return {
    skillsAuthored,
    skillsWithScripts,
    ruleIdsCovered: [...ruleIdsCovered],
    checkPyTotal: checkPyAudit.total,
    checkPyStubCount: checkPyAudit.stubFiles.length,
    checkPyStubFiles: checkPyAudit.stubFiles,
    checkPyStubRatio: checkPyAudit.total > 0
      ? +(checkPyAudit.stubFiles.length / checkPyAudit.total).toFixed(3)
      : 0,
  };
}

// v0.8 P2-F: walk rule_skills/<id>/ for check_*.py and check each for
// stub-shape patterns. Returns {total, stubFiles}. Patterns recognized
// as stubs (per v0.7.x audit findings):
//   - returns literal `"verdict": "NOT_APPLICABLE"` (资管 v0.7.5 variant)
//   - returns literal `"pass": null` (v0.7.0 legacy)
//   - returns literal `"method": "stub"`
//   - AND none of: workflow import, >20 non-comment lines.
// Substantive signals override the stub-return signal (a check.py that
// imports + delegates to a workflow but happens to return NOT_APPLICABLE
// for some sub-path is not a stub).
function _auditCheckPyShapes(skillsDir) {
  const stubFiles = [];
  let total = 0;
  if (!dirExists(skillsDir)) return { total, stubFiles };

  for (const dirEntry of listChildDirs(skillsDir)) {
    if (dirEntry.name.startsWith("__")) continue;
    const skillPath = path.join(skillsDir, dirEntry.name);
    const scripts = findCheckScripts(skillPath);
    for (const scriptPath of scripts) {
      total++;
      if (_isCheckPyStubShaped(scriptPath)) {
        stubFiles.push(path.relative(skillsDir, scriptPath));
      }
    }
  }
  return { total, stubFiles };
}

function _isCheckPyStubShaped(scriptPath) {
  let content;
  try { content = fs.readFileSync(scriptPath, "utf-8"); }
  catch { return false; }

  // Substantive signal 1: imports a workflow (direct delegation)
  if (/from\s+workflows[.\w]+\s+import|^import\s+workflows\./m.test(content)) {
    return false;
  }

  // Stub return patterns. A check.py is a stub if it ALWAYS returns one
  // of these regardless of input. We detect "always returns" by checking
  // that the file has no other verdict literal — no PASS, FAIL, WARNING
  // returns elsewhere. A scaffold with 30+ lines but a single
  // NOT_APPLICABLE return path (like 资管 v0.7.5's 14 check.py files) is
  // still a stub by behavior — line count is unreliable.
  const stubReturn1 = /return\s+\{[^}]*["']verdict["']\s*:\s*["']NOT_APPLICABLE["']/m.test(content);
  const stubReturn2 = /return\s+\{[^}]*["']pass["']\s*:\s*None/m.test(content);
  const stubReturn3 = /return\s+\{[^}]*["']method["']\s*:\s*["']stub["']/m.test(content);
  const hasStubReturn = stubReturn1 || stubReturn2 || stubReturn3;

  if (!hasStubReturn) return false;

  // If we find ANY other verdict (PASS, FAIL, WARNING), the file is doing
  // real branching even if one path returns NOT_APPLICABLE — not a stub.
  const hasOtherVerdict =
    /["']verdict["']\s*:\s*["']PASS["']/m.test(content) ||
    /["']verdict["']\s*:\s*["']FAIL["']/m.test(content) ||
    /["']verdict["']\s*:\s*["']WARNING["']/m.test(content) ||
    /\bmake_result\b/.test(content); // common helper that produces non-stub returns

  return !hasOtherVerdict;
}

// ───────────────────────────────────────────────────────────────────
// skill_testing
// ───────────────────────────────────────────────────────────────────

export function deriveSkillTestingMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const skillsDir = path.join(cwd, "rule_skills");
  // Use a Set so the v0.7.1 1a output/-side scan can add without duplicates.
  const tested = new Set();

  if (dirExists(skillsDir)) {
    for (const e of listChildDirs(skillsDir)) {
      if (e.name.startsWith("__")) continue;
      const skillPath = path.join(skillsDir, e.name);
      // Tested ⇔ has any of: tests/ dir, test_results.json, test_results/,
      // assets/test_cases.json, OR a successful test artifact like
      // *_test_output.json. Loose because agents use different conventions.
      const hasTestArtifact =
        dirExists(path.join(skillPath, "tests")) ||
        fileExists(path.join(skillPath, "test_results.json")) ||
        dirExists(path.join(skillPath, "test_results")) ||
        fileExists(path.join(skillPath, "assets", "test_cases.json")) ||
        listChildFiles(skillPath).some((f) =>
          /^(test|.*_test)_(output|result|log)/i.test(f.name) && f.name.endsWith(".json"));
      if (hasTestArtifact) tested.add(e.name);
    }
  }

  // v0.7.1 1a / v0.7.2 1a: credit rules whose verdicts appear anywhere
  // under output/*.json. Agents persist batch-test results in
  // conductor-specific shapes (this is the recurring drift point —
  // engine derivation has to match disk reality, not the other way
  // around). Shapes seen across E2E #5/6/7:
  //
  //   - DS v0.7.0/0.7.1: catalog.json as array of {id: "R001", ...}
  //     entries; skill_test_*.json as {doc_name: {R019a: bool, ...}};
  //     skill_test_阳光资产.json with {doc, results: {R019a: ...}}
  //   - GLM v0.7.1: rule_stats.json as {D01-01: {PASS, FAIL, NA}, ...};
  //     full_test_results_v[1-6].json as {sample_id: {path, meta,
  //     results: {D01-01: {verdict, ...}}}} (nested 2 levels deep, why
  //     v0.7.1's shallow walk missed them)
  //
  // The collector recurses (depth-limited) and uses two heuristics to
  // separate rule_ids from sample_ids / doc_names:
  //   1. Rule-id shape: starts with letter, ≤ 30 chars, contains digits
  //      (matches R001, D01-01, T02-31; rejects 06f2ed1488, doc paths)
  //   2. Verdict-shape on values: {verdict, passed, pass, PASS, FAIL}
  //      keys signal that the parent dict's keys are rule_ids
  const ruleIdShape = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
  const isRuleIdShape = (s) => typeof s === "string" && ruleIdShape.test(s) && /\d/.test(s);
  const looksLikeVerdict = (v) =>
    v && typeof v === "object" && !Array.isArray(v) && (
      v.verdict !== undefined ||
      v.passed !== undefined ||
      v.pass !== undefined ||
      typeof v.PASS === "number" ||
      typeof v.FAIL === "number"
    );
  const collectFromJsonFile = (data, depth = 0) => {
    if (!data || depth > 4) return;
    if (typeof data !== "object") return;
    if (Array.isArray(data)) {
      for (const r of data) collectFromJsonFile(r, depth + 1);
      return;
    }
    // {rule_id: "X"} or {id: "R001"} on a rule entry
    if (isRuleIdShape(data.rule_id)) tested.add(data.rule_id);
    if (isRuleIdShape(data.id)) tested.add(data.id);
    // {<rule_id>: <verdict_shaped>, ...}  (rule_stats / per-doc test_results)
    for (const [k, v] of Object.entries(data)) {
      if (isRuleIdShape(k) && looksLikeVerdict(v)) tested.add(k);
    }
    // {results: {<rule_id>: ...}} — keys must look rule-id-shaped
    if (data.results && typeof data.results === "object" && !Array.isArray(data.results)) {
      for (const k of Object.keys(data.results)) {
        if (isRuleIdShape(k)) tested.add(k);
      }
    }
    // Recurse into nested objects (handles {sample_id: {results: {...}}})
    for (const v of Object.values(data)) {
      if (v && typeof v === "object") collectFromJsonFile(v, depth + 1);
    }
  };

  const outputDir = path.join(cwd, "output");
  for (const p of walkFiles(outputDir, { maxDepth: 6 })) {
    if (!p.endsWith(".json")) continue;
    collectFromJsonFile(readJsonSafe(p));
  }

  // DS v070 wrote a top-level aggregate at either rules/test_results.json
  // OR rule_skills/test_results.json. Both seen in the wild; check both.
  for (const candidate of [
    path.join(cwd, "rules", "test_results.json"),
    path.join(cwd, "rule_skills", "test_results.json"),
    path.join(cwd, "test_results.json"),
  ]) {
    if (fileExists(candidate)) collectFromJsonFile(readJsonSafe(candidate));
  }

  // skillsPassing — per-skill accuracy threshold. Without a uniform
  // schema across agent outputs we report `tested` as the floor; the
  // pipeline's existing _loadTestResults() can layer accuracy on top.
  return { skillsTested: [...tested] };
}

// ───────────────────────────────────────────────────────────────────
// distillation
// ───────────────────────────────────────────────────────────────────

export function deriveDistillationMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const wfRoot = path.join(cwd, "workflows");
  const workflowsCreated = [];
  // v0.7.5 G-H1: also track rule IDs covered by workflows. Grouped/master
  // workflows (e.g., 贷款 v0.7.4's master + R001 template) cover multiple
  // rules; declare them via SKILL.md frontmatter `source_rules: [...]`.
  // Engine credits each declared rule_id so workflowsCovered milestone
  // matches catalog reality.
  const ruleIdsCovered = new Set();

  const creditWorkflowSourceRules = (workflowDir) => {
    // Check for a SKILL.md (or workflow.md) declaring source_rules
    const candidates = listChildFiles(workflowDir).filter(
      (f) => /^(skill|workflow)\.md$/i.test(f.name),
    );
    for (const c of candidates) {
      const content = readFileSafe(path.join(workflowDir, c.name));
      for (const rid of parseSourceRulesFromFrontmatter(content)) {
        ruleIdsCovered.add(rid);
      }
    }
    // Also: per-workflow config.json may declare rule coverage
    const configPath = path.join(workflowDir, "config.json");
    if (fileExists(configPath)) {
      const data = readJsonSafe(configPath);
      const rules = Array.isArray(data?.source_rules) ? data.source_rules :
                    Array.isArray(data?.rules) ? data.rules :
                    Array.isArray(data?.rule_ids) ? data.rule_ids : [];
      for (const r of rules) {
        const canon = canonicalRuleId(String(r));
        if (canon) ruleIdsCovered.add(canon);
      }
    }
  };

  if (dirExists(wfRoot)) {
    // Two layouts seen in E2E #5:
    //   workflows/<id>/workflow_v#.py  (canonical, what release.js expects)
    //   workflows/<id>_workflow.py     (DS + GLM flat layout)
    //   workflows/<id>.json            (DS regex_skill manifest)
    // Accept all three; downstream release tool's auto-relocator (Group C)
    // can normalize.
    for (const e of listChildren(wfRoot)) {
      if (e.isDirectory()) {
        const sub = path.join(wfRoot, e.name);
        const hasPy = listChildFiles(sub).some((f) =>
          /workflow.*\.py$/i.test(f.name) || /^check.*\.py$/i.test(f.name));
        if (hasPy) {
          workflowsCreated.push(e.name);
          // Dir name might itself be a rule_id
          const canon = canonicalRuleId(e.name);
          if (canon) ruleIdsCovered.add(canon);
          // Plus any frontmatter / config-declared source_rules
          creditWorkflowSourceRules(sub);
        }
        continue;
      }
      if (e.isFile()) {
        const m1 = e.name.match(/^(.+)_workflow\.py$/i);
        if (m1) {
          workflowsCreated.push(m1[1]);
          const canon = canonicalRuleId(m1[1]);
          if (canon) ruleIdsCovered.add(canon);
          continue;
        }
        const m2 = e.name.match(/^(.+)\.json$/i);
        if (m2) {
          const data = readJsonSafe(path.join(wfRoot, e.name));
          if (data && (data.rule_id || data.entry || data.type)) {
            workflowsCreated.push(m2[1]);
            const canon = canonicalRuleId(data.rule_id || m2[1]);
            if (canon) ruleIdsCovered.add(canon);
            // Manifest-declared source_rules
            const rules = Array.isArray(data.source_rules) ? data.source_rules :
                          Array.isArray(data.rules) ? data.rules : [];
            for (const r of rules) {
              const c2 = canonicalRuleId(String(r));
              if (c2) ruleIdsCovered.add(c2);
            }
          }
          continue;
        }
      }
    }
  }

  // workflowsTested — look for per-workflow test artifacts. Same loose
  // contract as skill_testing: any test_results.json / test_results/ /
  // baseline_*.json present means the workflow has been exercised.
  const workflowsTested = [];
  if (dirExists(wfRoot)) {
    for (const e of listChildDirs(wfRoot)) {
      const sub = path.join(wfRoot, e.name);
      if (
        fileExists(path.join(sub, "test_results.json")) ||
        dirExists(path.join(sub, "test_results")) ||
        listChildFiles(sub).some((f) => /^(baseline|test|result)_.*\.json$/i.test(f.name))
      ) {
        workflowsTested.push(e.name);
      }
    }
  }

  return {
    workflowsCreated,
    workflowsTested,
    // v0.7.5 G-H1: rule_ids the engine credits as having workflow coverage
    // (either via dir name being a canonical rule_id, or via SKILL.md /
    // workflow.md / config.json frontmatter declaring source_rules: [...]).
    // Pipelines that check workflow coverage against the catalog should
    // prefer ruleIdsCovered over workflowsCreated for grouped patterns.
    ruleIdsCovered: [...ruleIdsCovered],
  };
}

// ───────────────────────────────────────────────────────────────────
// production_qc
// ───────────────────────────────────────────────────────────────────

export function deriveProductionQcMilestones(workspace) {
  const cwd = cwdOf(workspace);
  const outputDir = path.join(cwd, "output");
  let batchesProcessed = 0;
  const documentsReviewedSet = new Set();
  const candidateDirs = [
    path.join(outputDir, "results"),
    path.join(outputDir, "qc"),
    path.join(outputDir, "distillation"),
  ];

  for (const dir of candidateDirs) {
    if (!dirExists(dir)) continue;
    for (const e of listChildFiles(dir)) {
      if (!e.name.endsWith(".json")) continue;
      const data = readJsonSafe(path.join(dir, e.name));
      if (data === null || data === undefined) continue;

      // Heuristic, two shapes seen in E2E #5:
      //   (a) DS — object with results/verdicts/n_skills/batch_id keys
      //   (b) GLM — array of per-document verdict objects (each has
      //       .verdict + .file/.path)
      let isBatch = false;
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (first && typeof first === "object" && "verdict" in first) isBatch = true;
      } else if (data && typeof data === "object") {
        isBatch = !!(
          data.batch_id ||
          data.n_skills ||
          data.results ||
          data.verdicts ||
          data.verdict_stats ||
          data.accuracyByRule
        );
      }
      if (!isBatch) continue;
      batchesProcessed++;

      // Documents reviewed: deduped doc paths from whatever shape we got.
      if (Array.isArray(data)) {
        for (const r of data) {
          if (r && typeof r === "object") {
            const key = r.path || r.file || r.doc || r.document;
            if (key) documentsReviewedSet.add(String(key));
          }
        }
      } else if (data.results && typeof data.results === "object") {
        for (const r of Object.values(data.results)) {
          if (r && typeof r === "object") {
            for (const docKey of Object.keys(r)) documentsReviewedSet.add(docKey);
          }
        }
      }
      if (Array.isArray(data.documents)) {
        for (const d of data.documents) {
          documentsReviewedSet.add(typeof d === "string" ? d : (d?.path || JSON.stringify(d)));
        }
      }
    }
  }

  // v0.8 P1-A: per-doc QC review files at output/qc/reviews/doc_*.json
  // (贷款 v0.7.5 shape). Each file is a single review object with
  // {review_id, document, verdict}. Engine previously skipped these
  // because they don't match the batch heuristic, causing
  // `documents_reviewed: 0` despite 16 docs on disk.
  const perDocReviewsDir = path.join(outputDir, "qc", "reviews");
  if (dirExists(perDocReviewsDir)) {
    for (const e of listChildFiles(perDocReviewsDir)) {
      if (!e.name.endsWith(".json")) continue;
      const data = readJsonSafe(path.join(perDocReviewsDir, e.name));
      if (!data || typeof data !== "object" || !data.verdict) continue;
      // Document identifier: prefer explicit fields, fall back to filename
      const docKey = data.document || data.doc || data.file || data.path || e.name.replace(/\.json$/, "");
      documentsReviewedSet.add(String(docKey));
    }
  }

  // v0.8 P1-A: also read numeric `documents_reviewed: N` from any
  // top-level batch file (贷款 review_001.json declares 16 directly).
  // We use this only when the doc set is smaller than the claim — agents
  // sometimes write summary batches without enumerating individual docs.
  let declaredDocCount = 0;
  for (const dir of candidateDirs) {
    if (!dirExists(dir)) continue;
    for (const e of listChildFiles(dir)) {
      if (!e.name.endsWith(".json")) continue;
      const data = readJsonSafe(path.join(dir, e.name));
      if (!data || typeof data !== "object") continue;
      const n = Number(data.documents_reviewed);
      if (Number.isFinite(n) && n > declaredDocCount) declaredDocCount = n;
    }
  }
  const documentsReviewed = Math.max(documentsReviewedSet.size, declaredDocCount);

  return {
    batchesProcessed,
    documentsReviewed,
    documentsReviewedKeys: [...documentsReviewedSet], // for describeState detail
    documentsReviewedDeclared: declaredDocCount > documentsReviewedSet.size ? declaredDocCount : 0,
  };
}

// ───────────────────────────────────────────────────────────────────
// finalization
// ───────────────────────────────────────────────────────────────────

export function deriveFinalizationMilestones(workspace) {
  const cwd = cwdOf(workspace);

  // readmeWritten: at least one populated README.md under output/releases/*/
  // (≥500 bytes — sub-template-stub size). Catches DS + GLM E2E #5
  // failure where run.py was shipped without a real README.
  let readmeWritten = false;
  const releasesRoot = path.join(cwd, "output", "releases");
  if (dirExists(releasesRoot)) {
    outer: for (const e of listChildDirs(releasesRoot)) {
      const readme = path.join(releasesRoot, e.name, "README.md");
      try {
        const stat = fs.statSync(readme);
        if (stat.isFile() && stat.size >= 500) { readmeWritten = true; break outer; }
      } catch { /* skip */ }
    }
  }
  // Also accept (in priority order):
  //   - rule_skills/README.md (the v0.6.0 finalization pipeline target)
  //   - workspace-root README.md (GLM E2E #5 wrote here)
  // Avoids false-negatives when the agent picks a different shipping
  // location than the canonical release/v1/ directory.
  if (!readmeWritten) {
    for (const candidate of [
      path.join(cwd, "rule_skills", "README.md"),
      path.join(cwd, "README.md"),
    ]) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size >= 500) { readmeWritten = true; break; }
      } catch { /* skip */ }
    }
  }

  // coverageReportWritten: accept multiple known agent-write locations.
  // v0.8 P1-A: added rule_skills/coverage_report.md (资管 v0.7.5 wrote here)
  // and coverage_audit.md variants (贷款 v0.7.5 wrote rules/coverage_audit.md).
  // The "coverage doc" concept covers both report-style + audit-style files.
  const coverageReportWritten = !!findFileAcrossKnownPaths(cwd, [
    path.join("rules", "coverage_report.md"),
    path.join("rules", "coverage_audit.md"),                // 贷款 v0.7.5
    path.join("rules", "coverage_audit.json"),
    path.join("output", "coverage_report.md"),
    path.join("rule_skills", "coverage_report.md"),         // 资管 v0.7.5
    path.join("output", "qc", "coverage_report.md"),        // future-proofing
  ]);

  // finalDashboardWritten: at least one dashboards/*.html that is NOT a
  // duplicate of any other. DS + GLM both shipped byte-identical
  // dashboards under different filenames; sha256-distinct guards against
  // it. Single-file case is OK (one dashboard, no comparison needed).
  // Multi-file case requires hashes.size >= 2 OR htmls.length === 1.
  //
  // Fallback path (v0.6.0 final_dashboard.html) only applies when
  // dashboards/ doesn't exist at all — if dashboards/ exists with
  // duplicates, the gate stays closed so Group C's dedup error fires.
  let finalDashboardWritten = false;
  const dashboardsDir = path.join(cwd, "output", "dashboards");
  let dashboardDuplicatesDetected = false;
  if (dirExists(dashboardsDir)) {
    const htmls = listChildFiles(dashboardsDir).filter((e) => e.name.endsWith(".html"));
    if (htmls.length > 0) {
      const hashes = new Set();
      for (const h of htmls) {
        const sig = sha256OfFile(path.join(dashboardsDir, h.name));
        if (sig) hashes.add(sig);
      }
      if (htmls.length === 1) finalDashboardWritten = hashes.size >= 1;
      else if (hashes.size >= 2) finalDashboardWritten = true;
      else dashboardDuplicatesDetected = true;
    }
  } else {
    // No dashboards/ dir — accept v0.6.0 single-file convention
    if (fileExists(path.join(cwd, "output", "final_dashboard.html"))) {
      finalDashboardWritten = true;
    }
  }

  // v0.8 P0-D: stale-release detection. SOFT gate — surfaces a warning,
  // doesn't refuse phase advance. 资管 audit § 9.1 finding 11 found both
  // release bundles snapped BEFORE the user's "更激进 worker LLM" prompt
  // drove 14 hybrid workflow_v2.py builds, but neither was re-released.
  // We detect by comparing the most-recent release manifest's created_at
  // against the mtimes of workflows/ and rule_skills/.
  const staleRelease = _detectStaleRelease(cwd);

  return {
    readmeWritten,
    coverageReportWritten,
    finalDashboardWritten,
    dashboardDuplicatesDetected,
    releaseIsStale: staleRelease.isStale,
    staleReleaseDetail: staleRelease.detail,
  };
}

// v0.8 P0-D: detect whether workflows/ or rule_skills/ contain files
// modified after the most-recent release manifest was written. Returns
// {isStale: bool, detail: {releaseTs?, releasePath?, newerFiles?: [...]}}.
// SOFT semantics — the milestone is informational; phase advance still
// works. The agent + downstream tooling (e2e-audit) decides what to do.
function _detectStaleRelease(cwd) {
  const releasesRoot = path.join(cwd, "output", "releases");
  if (!dirExists(releasesRoot)) return { isStale: false, detail: null };

  // Find most-recent release manifest (by created_at OR fs mtime as fallback).
  let latestRelease = null; // {path, createdAt: Date}
  for (const e of listChildDirs(releasesRoot)) {
    const manifestPath = path.join(releasesRoot, e.name, "manifest.json");
    try {
      const stat = fs.statSync(manifestPath);
      if (!stat.isFile()) continue;
      let createdAt = stat.mtime;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (m?.created_at) {
          const parsed = new Date(m.created_at);
          if (!Number.isNaN(parsed.getTime())) createdAt = parsed;
        }
      } catch { /* fall back to mtime */ }
      if (!latestRelease || createdAt > latestRelease.createdAt) {
        latestRelease = { path: manifestPath, createdAt, slug: e.name };
      }
    } catch { /* skip */ }
  }

  if (!latestRelease) return { isStale: false, detail: null };

  // Walk workflows/ and rule_skills/ for files newer than latestRelease.createdAt.
  // Cap to first 10 newer-than-release matches to bound report size.
  const newerFiles = [];
  const cutoff = latestRelease.createdAt.getTime();
  const SCAN_DIRS = ["workflows", "rule_skills"];
  for (const sub of SCAN_DIRS) {
    const root = path.join(cwd, sub);
    if (!dirExists(root)) continue;
    const stack = [root];
    while (stack.length && newerFiles.length < 10) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (ent.name.startsWith(".") || ent.name === "__pycache__" || ent.name === "node_modules") continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { stack.push(p); continue; }
        if (!ent.isFile()) continue;
        // Care about workflow_v*.py + check.py + SKILL.md/skill.md only —
        // not __pycache__, not test artifacts, not .json.
        if (!/(workflow_v\d+\.py|check\.py|SKILL\.md|skill\.md)$/.test(ent.name)) continue;
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > cutoff) {
            newerFiles.push({
              path: path.relative(cwd, p),
              mtime: new Date(st.mtimeMs).toISOString(),
            });
            if (newerFiles.length >= 10) break;
          }
        } catch { /* skip */ }
      }
    }
  }

  if (newerFiles.length === 0) return { isStale: false, detail: null };

  // SOFT: accept_stale_release marker bypasses the warning. Agents that
  // intentionally accept the older release write this file.
  const acceptPath = path.join(cwd, "output", "releases", latestRelease.slug, ".accept_stale_release");
  if (fileExists(acceptPath)) return { isStale: false, detail: { acceptedAt: latestRelease.slug } };

  return {
    isStale: true,
    detail: {
      releasePath: path.relative(cwd, latestRelease.path),
      releaseSlug: latestRelease.slug,
      releaseCreatedAt: latestRelease.createdAt.toISOString(),
      newerFiles,
      totalNewerCount: newerFiles.length,
      hint: "Workspace artifacts modified after release was built. Either re-run the release tool or write .accept_stale_release into the release dir to acknowledge.",
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Phase-keyed dispatcher (convenience for tests + offline audit).
// ───────────────────────────────────────────────────────────────────

export const DERIVE_BY_PHASE = {
  bootstrap: deriveBootstrapMilestones,
  rule_extraction: deriveRuleExtractionMilestones,
  skill_authoring: deriveSkillAuthoringMilestones,
  skill_testing: deriveSkillTestingMilestones,
  distillation: deriveDistillationMilestones,
  production_qc: deriveProductionQcMilestones,
  finalization: deriveFinalizationMilestones,
};

export function deriveAllMilestones(workspace) {
  const out = {};
  for (const [phase, fn] of Object.entries(DERIVE_BY_PHASE)) {
    out[phase] = fn(workspace);
  }
  return out;
}
