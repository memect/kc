#!/usr/bin/env node

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
