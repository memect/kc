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

function sha256OfFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch { return null; }
}

// Normalize a rule id like "R14" / "r014" / "R0014" to canonical "R014".
// Returns null for non-matching strings (e.g., thematic skill names like
// "account_identity" — those stay as-is via the second branch).
function canonicalRuleId(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^R0*(\d+)$/i);
  if (m) return `R${String(parseInt(m[1], 10)).padStart(3, "0")}`;
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
  // sometimes fan out to per-rule files (E2E #5 DS).
  const rulesExtracted = [];
  const rulesWithChunkRefs = [];
  if (dirExists(rulesDir)) {
    for (const e of listChildFiles(rulesDir)) {
      if (!e.name.endsWith(".json")) continue;
      const data = readJsonSafe(path.join(rulesDir, e.name));
      if (!data) continue;
      const items = Array.isArray(data) ? data : (data.rules || []);
      for (const r of items) {
        if (r && typeof r.id === "string" && r.id.length) {
          rulesExtracted.push(r.id);
          if (Array.isArray(r.source_chunk_ids) && r.source_chunk_ids.length > 0) {
            rulesWithChunkRefs.push(r.id);
          }
        }
      }
    }
  }

  // coverageAudited: presence of rules/coverage_audit.{md,json} OR a
  // rules/coverage_report.md / output/coverage_report.md. Loose criterion
  // because agents pick different conventions; the spirit is "did the
  // agent produce a coverage doc" not "did they put it in this exact file".
  const coverageAudited =
    fileExists(path.join(rulesDir, "coverage_audit.md")) ||
    fileExists(path.join(rulesDir, "coverage_audit.json")) ||
    fileExists(path.join(rulesDir, "coverage_report.md")) ||
    fileExists(path.join(cwd, "output", "coverage_report.md"));

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
  }

  return {
    skillsAuthored,
    skillsWithScripts,
    ruleIdsCovered: [...ruleIdsCovered],
  };
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
        if (hasPy) workflowsCreated.push(e.name);
        continue;
      }
      if (e.isFile()) {
        const m1 = e.name.match(/^(.+)_workflow\.py$/i);
        if (m1) { workflowsCreated.push(m1[1]); continue; }
        const m2 = e.name.match(/^(.+)\.json$/i);
        if (m2) {
          const data = readJsonSafe(path.join(wfRoot, e.name));
          if (data && (data.rule_id || data.entry || data.type)) workflowsCreated.push(m2[1]);
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

  return { workflowsCreated, workflowsTested };
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

  return {
    batchesProcessed,
    documentsReviewed: documentsReviewedSet.size,
    documentsReviewedKeys: [...documentsReviewedSet], // for describeState detail
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

  // coverageReportWritten: rules/coverage_report.md OR output/coverage_report.md.
  const coverageReportWritten =
    fileExists(path.join(cwd, "rules", "coverage_report.md")) ||
    fileExists(path.join(cwd, "output", "coverage_report.md"));

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

  return {
    readmeWritten,
    coverageReportWritten,
    finalDashboardWritten,
    dashboardDuplicatesDetected,
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
