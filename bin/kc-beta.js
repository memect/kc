#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Parse --en / --zh from anywhere in argv (session-only language override)
const args = process.argv.slice(2);
let languageOverride = null;
const filtered = [];
for (const arg of args) {
  if (arg === "--en") languageOverride = "en";
  else if (arg === "--zh") languageOverride = "zh";
  else filtered.push(arg);
}
const subcommand = filtered[0];

// A4: Startup banner. Prevents the v0.3.2-ghost-install problem (user ran
// 4 releases worth of "fixes" that were silently not installed because of
// a stale global npm cache — invisible in field trials until v0.5.5).
// Always-on; prints version + resolved script path so users can immediately
// see what's running. Skipped for `--version` / `--help` because those have
// their own output.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function printBanner() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
    const scriptPath = __filename;
    process.stderr.write(`⏵⏵  KC Agent CLI  v${pkg.version}  ·  ${scriptPath}\n`);
  } catch { /* package.json missing or unreadable — silent */ }
}
const suppressBanner = args.includes("--version") || args.includes("-v") ||
                       args.includes("--help") || args.includes("-h");
if (!suppressBanner) printBanner();

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
