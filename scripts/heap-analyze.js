#!/usr/bin/env node
/**
 * Analyze a logs/heap.jsonl file produced by the B0.1 heap sampler.
 *
 * Usage:
 *   node scripts/heap-analyze.js <path-to-heap.jsonl>
 *   node scripts/heap-analyze.js                           # auto-find most recent workspace
 *
 * Prints a compact summary:
 *   - Run duration, sample count, sample cadence
 *   - RSS / heap min/max/avg + trend slope (MB/hour)
 *   - External memory + arrayBuffers trend (catches Buffer / pdfjs / Uint8Array leaks)
 *   - History length + task-queue size growth (catches engine-side accumulators)
 *
 * Intended output format: human-readable, copy-pasteable into a commit message
 * or DEV_LOG entry. Designed for the v0.6.0 B0.7 conformance gate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function findMostRecentHeapJsonl() {
  const root = join(os.homedir(), ".kc_agent", "workspaces");
  let sessions;
  try { sessions = readdirSync(root); }
  catch { return null; }
  const candidates = [];
  for (const s of sessions) {
    const p = join(root, s, "logs", "heap.jsonl");
    try {
      const st = statSync(p);
      if (st.isFile()) candidates.push({ path: p, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path || null;
}

function parseJsonl(path) {
  const rows = [];
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { /* skip malformed */ }
  }
  return rows;
}

function linearSlope(xs, ys) {
  if (xs.length < 2) return 0;
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sxx = xs.reduce((acc, x) => acc + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function summarize(rows, label) {
  if (rows.length === 0) { console.log(`${label}: no samples`); return; }
  const start = new Date(rows[0].t).getTime();
  const end = new Date(rows[rows.length - 1].t).getTime();
  const durationHours = (end - start) / 3_600_000;
  const hoursFromStart = rows.map((r) => (new Date(r.t).getTime() - start) / 3_600_000);

  const metrics = [
    ["RSS (MB)", "rssMB"],
    ["Heap used (MB)", "heapUsedMB"],
    ["External (MB)", "externalMB"],
    ["ArrayBuffers (MB)", "arrayBuffersMB"],
    ["History length", "historyLen"],
    ["Tasks in-progress", "tasksInProgress"],
    ["Tasks pending", "tasksPending"],
  ];

  // v0.6.2 K1: component breakdown — only printed if any row has the
  // components field (post-v0.6.2 sessions).
  const componentMetrics = [
    [".historyMB",      (r) => r.components?.historyMB ?? 0],
    [".eventLogMB",     (r) => r.components?.eventLogMB ?? 0],
    [".toolResultsMB",  (r) => r.components?.toolResultsMB ?? 0],
    [".subagentsMB",    (r) => r.components?.subagentsMB ?? 0],
    [".bundleCacheMB",  (r) => r.components?.bundleCacheMB ?? 0],
  ];
  const hasComponents = rows.some((r) => r.components);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${label}`);
  console.log(`  Samples: ${rows.length}  ·  Duration: ${fmt(durationHours)}h  ·  First: ${rows[0].t}  Last: ${rows[rows.length - 1].t}`);
  console.log(`  Phases hit: ${Array.from(new Set(rows.map((r) => r.phase))).join(", ")}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  ${"metric".padEnd(22)} ${"min".padStart(8)} ${"max".padStart(8)} ${"avg".padStart(8)} ${"Δ".padStart(8)} ${"slope/h".padStart(10)}`);

  for (const [name, key] of metrics) {
    const values = rows.map((r) => r[key] ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const delta = values[values.length - 1] - values[0];
    const slopeH = durationHours > 0 ? linearSlope(hoursFromStart, values) : 0;
    console.log(
      `  ${name.padEnd(22)} ${fmt(min).padStart(8)} ${fmt(max).padStart(8)} ${fmt(avg).padStart(8)} ${fmt(delta).padStart(8)} ${fmt(slopeH).padStart(10)}`,
    );
  }

  if (hasComponents) {
    console.log(`\n  ${"component (MB)".padEnd(22)} ${"min".padStart(8)} ${"max".padStart(8)} ${"avg".padStart(8)} ${"Δ".padStart(8)} ${"slope/h".padStart(10)}`);
    for (const [name, getter] of componentMetrics) {
      const values = rows.map(getter);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const delta = values[values.length - 1] - values[0];
      const slopeH = durationHours > 0 ? linearSlope(hoursFromStart, values) : 0;
      console.log(
        `  ${name.padEnd(22)} ${fmt(min).padStart(8)} ${fmt(max).padStart(8)} ${fmt(avg).padStart(8)} ${fmt(delta).padStart(8)} ${fmt(slopeH).padStart(10)}`,
      );
    }
  }
  console.log();

  // Verdict for the RSS trajectory — B0.7 conformance gate reads this line
  const rssValues = rows.map((r) => r.rssMB ?? 0);
  const rssMin = Math.min(...rssValues);
  const rssMax = Math.max(...rssValues);
  const rssDrift = rssMin > 0 ? (rssMax - rssMin) / rssMin : 0;
  const driftPct = (rssDrift * 100).toFixed(1);
  const verdict = rssDrift <= 0.10
    ? `✅ FLAT (±${driftPct}% within B0.7 gate)`
    : rssDrift <= 0.25
      ? `⚠️  DRIFTING (±${driftPct}% — borderline)`
      : `❌ GROWING (±${driftPct}% — B0.7 gate would FAIL)`;
  console.log(`  Verdict: ${verdict}`);
  console.log();
}

function main() {
  let path = process.argv[2];
  if (!path) {
    path = findMostRecentHeapJsonl();
    if (!path) fail("no heap.jsonl found in ~/.kc_agent/workspaces/*/logs/ and none passed as arg");
    console.log(`(auto-selected most recent: ${path})`);
  }
  const rows = parseJsonl(path);
  if (rows.length === 0) fail(`no valid rows in ${path}`);
  summarize(rows, path);
}

main();
