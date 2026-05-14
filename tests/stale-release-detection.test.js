/**
 * Regression test for v0.8 P0-D — stale release detection.
 *
 * Background:
 * 资管 v0.7.5 session shipped two release bundles (`v1` snapped 04:01,
 * `v1-pure-regex` snapped 04:42) BEFORE the user's 04:54 prompt drove
 * 14 hybrid workflow_v2.py builds. Neither bundle was re-released; the
 * shipped artifact didn't match the workspace work. Engine had no signal.
 *
 * v0.8 P0-D adds a SOFT gate via deriveFinalizationMilestones: detects
 * workflows/<rule>/workflow_v*.py or rule_skills/<id>/SKILL.md (or
 * skill.md) modified after the most-recent release manifest's created_at,
 * sets `releaseIsStale: true` with a detail object listing newer files.
 *
 * Run: `node tests/stale-release-detection.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deriveFinalizationMilestones } from "../src/agent/pipelines/_milestone-derive.js";

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-stale-test-"));
  fs.mkdirSync(path.join(dir, "output", "releases", "v1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows", "R001"), { recursive: true });
  fs.mkdirSync(path.join(dir, "rule_skills", "R001"), { recursive: true });
  return dir;
}

function writeReleaseManifest(ws, slug, createdAt) {
  const dir = path.join(ws, "output", "releases", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    kc_beta_version: "0.7.5",
    created_at: createdAt.toISOString(),
    notes: "test release",
  }, null, 2));
  // Also a README so other checks pass
  fs.writeFileSync(path.join(dir, "README.md"), "x".repeat(600));
}

function writeWorkflow(ws, rule, version, mtime) {
  const file = path.join(ws, "workflows", rule, `workflow_v${version}.py`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# workflow ${rule} v${version}\nimport re\n`);
  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }
}

console.log("\nCase 1: no release directory → not stale");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kc-stale-test-"));
  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === false, "releaseIsStale=false when no releases/");
  assert(m.staleReleaseDetail === null, "no detail");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nCase 2: release exists, no workspace changes → not stale");
{
  const ws = makeWorkspace();
  const releaseTs = new Date(Date.now() - 60_000); // 1 min ago
  writeReleaseManifest(ws, "v1", releaseTs);
  writeWorkflow(ws, "R001", 1, new Date(releaseTs.getTime() - 30_000)); // older than release

  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === false, "not stale when no newer files");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nCase 3: workflow modified AFTER release → stale");
{
  const ws = makeWorkspace();
  const releaseTs = new Date(Date.now() - 60_000); // 1 min ago
  writeReleaseManifest(ws, "v1", releaseTs);
  writeWorkflow(ws, "R001", 1, new Date(releaseTs.getTime() + 10_000)); // newer than release

  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === true, "releaseIsStale=true when workflow newer than release");
  assert(m.staleReleaseDetail !== null, "detail object present");
  assert(Array.isArray(m.staleReleaseDetail.newerFiles), "newerFiles is array");
  assert(m.staleReleaseDetail.newerFiles.length === 1, `newerFiles has 1 entry (got ${m.staleReleaseDetail.newerFiles.length})`);
  assert(/workflows\/R001\/workflow_v1\.py/.test(m.staleReleaseDetail.newerFiles[0].path), "newerFiles includes the workflow path");
  assert(typeof m.staleReleaseDetail.hint === "string", "detail has hint string");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nCase 4: SKILL.md (uppercase) and skill.md (lowercase) both detected");
{
  const ws = makeWorkspace();
  const releaseTs = new Date(Date.now() - 60_000);
  writeReleaseManifest(ws, "v1", releaseTs);
  fs.writeFileSync(path.join(ws, "rule_skills", "R001", "SKILL.md"), "x");
  fs.writeFileSync(path.join(ws, "rule_skills", "R001", "check.py"), "x");
  // touch them after release
  const future = new Date(releaseTs.getTime() + 10_000);
  fs.utimesSync(path.join(ws, "rule_skills", "R001", "SKILL.md"), future, future);
  fs.utimesSync(path.join(ws, "rule_skills", "R001", "check.py"), future, future);

  // Add a lowercase variant too (资管 pattern)
  fs.mkdirSync(path.join(ws, "rule_skills", "R002"), { recursive: true });
  fs.writeFileSync(path.join(ws, "rule_skills", "R002", "skill.md"), "x");
  fs.utimesSync(path.join(ws, "rule_skills", "R002", "skill.md"), future, future);

  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === true, "stale detected");
  const paths = m.staleReleaseDetail.newerFiles.map((f) => f.path);
  assert(paths.some((p) => /R001\/SKILL\.md$/.test(p)), "uppercase SKILL.md detected");
  assert(paths.some((p) => /R001\/check\.py$/.test(p)), "check.py detected");
  assert(paths.some((p) => /R002\/skill\.md$/.test(p)), "lowercase skill.md detected");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nCase 5: .accept_stale_release marker bypasses the warning");
{
  const ws = makeWorkspace();
  const releaseTs = new Date(Date.now() - 60_000);
  writeReleaseManifest(ws, "v1", releaseTs);
  writeWorkflow(ws, "R001", 1, new Date(releaseTs.getTime() + 10_000));
  fs.writeFileSync(path.join(ws, "output", "releases", "v1", ".accept_stale_release"), "");

  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === false, "marker bypasses staleness");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nCase 6: most-recent release wins when multiple bundles exist");
{
  const ws = makeWorkspace();
  const olderTs = new Date(Date.now() - 120_000); // 2 min ago
  const newerTs = new Date(Date.now() - 60_000);  // 1 min ago
  writeReleaseManifest(ws, "v1-old", olderTs);
  writeReleaseManifest(ws, "v1-new", newerTs);

  // workflow touched between the two releases — newer than v1-old but older than v1-new
  writeWorkflow(ws, "R001", 1, new Date(olderTs.getTime() + 30_000));

  const m = deriveFinalizationMilestones(ws);
  assert(m.releaseIsStale === false, "uses newest release as baseline; workflow older than newest");
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
