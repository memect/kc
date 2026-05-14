#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Parse --en / --zh / --parallelism from anywhere in argv
const args = process.argv.slice(2);
let languageOverride = null;
let parallelismOverride = null;
const filtered = [];
for (const arg of args) {
  if (arg === "--en") languageOverride = "en";
  else if (arg === "--zh") languageOverride = "zh";
  else if (arg.startsWith("--parallelism=")) {
    const n = parseInt(arg.slice("--parallelism=".length), 10);
    if (Number.isFinite(n) && n >= 1) parallelismOverride = Math.min(n, 8);
  }
  else filtered.push(arg);
}
const subcommand = filtered[0];

// B3: Surface parallelism intent via env so loadSettings() picks it up uniformly.
// Matches the workspace-.env pattern other KC configs use.
if (parallelismOverride !== null) {
  process.env.KC_PARALLELISM = String(parallelismOverride);
}

// A4: Startup banner. Prevents the v0.3.2-ghost-install problem (user ran
// 4 releases worth of "fixes" that were silently not installed because of
// a stale global npm cache — invisible in field trials until v0.5.5).
// Always-on; prints version + resolved script path so users can immediately
// see what's running. Skipped for `--version` / `--help` because those have
// their own output.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch { return "unknown"; }
}
function printBanner() {
  try {
    const v = readPkgVersion();
    process.stderr.write(`⏵⏵  KC Agent CLI  v${v}  ·  ${__filename}\n`);
  } catch { /* silent */ }
}
const isVersion = args.includes("--version") || args.includes("-v");
const isHelp = args.includes("--help") || args.includes("-h");
const suppressBanner = isVersion || isHelp;
if (!suppressBanner) printBanner();

// v0.7.5 G-F1: `--version` prints version and exits. Previously the flag
// suppressed the banner but fell through to TUI launch (audit confirmed
// during v0.7.4 testing). Print + exit before the subcommand dispatch.
if (isVersion) {
  process.stdout.write(`${readPkgVersion()}\n`);
  process.exit(0);
}

(async () => {
  if (subcommand === "onboard" || subcommand === "setup") {
    const { onboard } = await import("../src/cli/onboard.js");
    await onboard();
  } else if (subcommand === "config") {
    const { configEditor } = await import("../src/cli/config.js");
    await configEditor();
  } else if (subcommand === "init") {
    const { init } = await import("../src/cli/init.js");
    await init();
  } else {
    const { main } = await import("../src/cli/index.js");
    await main({ languageOverride });
  }
})();
