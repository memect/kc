#!/usr/bin/env node
// v0.8 P4 — marathon driver CLI entry point.
//
// Drives KC across an unattended long-run by tailing the workspace's
// events.jsonl and writing continuation prompts to its inbox.jsonl.
//
// Usage:
//   kc-marathon --workspace <path> --goal "<goal description>" \
//     [--max-wall-clock 8h] [--stuck-after 30m] [--language en|zh] [--session-id <id>]
//
// Example (in another terminal, while `kc-beta` runs in workspace foo):
//   kc-marathon --workspace ~/.kc_agent/workspaces/foo \
//     --goal "Verify the new regulation against samples/" \
//     --max-wall-clock 6h
//
// Architecture:
//   - Separate process from KC engine (filesystem-watcher IPC)
//   - State persisted at ~/.kc_agent/marathons/<session_id>/state.json
//   - Decisions logged to ~/.kc_agent/marathons/<session_id>/decisions.jsonl
//   - KC's engine watches <workspace>/.kc_marathon/inbox.jsonl

import fs from "node:fs";
import path from "node:path";
import { MarathonDriver } from "../src/marathon/driver.js";

function parseDuration(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|ms)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] || "s").toLowerCase();
  const mults = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * (mults[u] || 1000));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`kc-marathon — unattended-run driver for KC

Usage:
  kc-marathon --workspace <path> --goal "<goal>" [options]

Required:
  --workspace <path>       Absolute path to a KC workspace
  --goal "<goal>"          Goal description sent as the initial prompt

Options:
  --session-id <id>        Marathon session id (default: derived from workspace name + timestamp)
  --language en|zh         Continuation prompt language (default: en)
  --max-wall-clock 12h     Stop after wall-clock duration (default: 12h)
  --stuck-after 30m        Send unstick prompt after this much idle (default: 30m)
  --poll-ms 5000           Events.jsonl tail cadence in ms (default: 5000)
  --help, -h               Show this help

Examples:
  kc-marathon --workspace ~/.kc_agent/workspaces/foo --goal "Verify..."
  kc-marathon --workspace ./ws --goal "..." --max-wall-clock 4h --language zh

Architecture: separate process from kc-beta. Driver tails the workspace's
events.jsonl and writes prompts to <workspace>/.kc_marathon/inbox.jsonl.
The engine (with v0.8 marathon-input integration) reads inbox lines as
synthetic user prompts. State persists at ~/.kc_agent/marathons/<id>/.

Marathon stop conditions:
  - --max-wall-clock exceeded
  - finalization phase + ≥5 turns settled
  - SIGINT (Ctrl-C) — clean shutdown, state preserved
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || (!args.workspace && !args._.length)) {
    printHelp();
    process.exit(args.help || args.h ? 0 : 1);
  }

  const workspaceArg = args.workspace || args._[0];
  if (!workspaceArg) {
    console.error("Error: --workspace required");
    process.exit(1);
  }
  const workspaceCwd = path.resolve(workspaceArg);
  if (!fs.existsSync(workspaceCwd)) {
    console.error(`Error: workspace not found: ${workspaceCwd}`);
    process.exit(1);
  }

  const goal = args.goal;
  if (!goal || goal === true) {
    console.error('Error: --goal "<description>" required');
    process.exit(1);
  }

  const sessionId = args["session-id"] || `${path.basename(workspaceCwd)}-${Date.now()}`;
  const language = args.language === "zh" ? "zh" : "en";
  const maxWallclockMs = parseDuration(args["max-wall-clock"]) ?? 12 * 60 * 60 * 1000;
  const stuckAfterMs = parseDuration(args["stuck-after"]) ?? 30 * 60 * 1000;
  const pollMs = parseInt(args["poll-ms"] || "5000", 10);

  const driver = new MarathonDriver({
    workspaceCwd,
    sessionId,
    goal,
    language,
    maxWallclockMs,
    stuckAfterMs,
    pollMs,
  });

  await driver.run();
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
