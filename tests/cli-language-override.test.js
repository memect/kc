/**
 * Regression test for v0.8.3 P20-B3 (Task #218) — CLI `--zh` / `--en`
 * flag override survives workspace .env LANGUAGE overlay.
 *
 * Pre-v0.8.3 bug (E2E #13): user launched `kc-beta --zh` against
 * workspaces whose .env had `LANGUAGE=en`. The flag override applied
 * `config.language = "zh"` in main(), but the engine constructor's
 * `_overlayWorkspaceEnv()` then read workspace .env's LANGUAGE=en and
 * overwrote it back. The overlay's `penvWon` check only looked at
 * `process.env[k]`, not the in-memory config.language CLI override.
 *
 * Fix: set `process.env.LANGUAGE = languageOverride` after applying
 * the override to config. Then the overlay's `penvWon` check sees a
 * conflicting process.env value and skips the workspace .env field.
 *
 * Run: `node tests/cli-language-override.test.js`
 */
import fs from "node:fs";

const cliPath = new URL("../src/cli/index.js", import.meta.url).pathname;

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\ncli/index.js: languageOverride sets BOTH config.language AND process.env.LANGUAGE");
{
  const src = fs.readFileSync(cliPath, "utf-8");
  // Find the languageOverride block in main()
  const m = src.match(/if \(languageOverride\) \{[\s\S]*?\}/);
  assert(m !== null, "languageOverride if-block found");
  const body = m[0];
  assert(/config\.language\s*=\s*languageOverride/.test(body),
    "still assigns to config.language");
  assert(/process\.env\.LANGUAGE\s*=\s*languageOverride/.test(body),
    "v0.8.3 P20-B3: also sets process.env.LANGUAGE so overlay penvWon check honors CLI flag");
}

console.log("\nFunctional: overlay penvWon check honors process.env.LANGUAGE");
{
  // Stand-in for engine._overlayWorkspaceEnv's penvWon logic — the
  // check at engine.js:408 reads:
  //   const penvWon = envKey.some((k) => process.env[k] && process.env[k] !== wsValue);
  //   if (penvWon) continue;
  // We mimic that semantics here to prove that with process.env.LANGUAGE
  // set, a workspace .env LANGUAGE=<different> value will be skipped.
  const orig = process.env.LANGUAGE;
  try {
    // Pre-v0.8.3 behavior simulation: process.env.LANGUAGE not set,
    // workspace .env says LANGUAGE=en → overlay applies "en"
    delete process.env.LANGUAGE;
    const wsValue1 = "en";
    const envKey1 = ["LANGUAGE"];
    const penvWon1 = envKey1.some((k) => process.env[k] && process.env[k] !== wsValue1);
    assert(penvWon1 === false, "pre-v0.8.3: no process.env.LANGUAGE → overlay applies workspace value");

    // Post-v0.8.3 behavior simulation: process.env.LANGUAGE = "zh" (from
    // CLI flag), workspace .env says LANGUAGE=en → overlay SKIPS
    process.env.LANGUAGE = "zh";
    const wsValue2 = "en";
    const envKey2 = ["LANGUAGE"];
    const penvWon2 = envKey2.some((k) => process.env[k] && process.env[k] !== wsValue2);
    assert(penvWon2 === true, "v0.8.3: process.env.LANGUAGE=zh + workspace=en → penvWon=true → overlay skips");

    // Edge: process.env.LANGUAGE matches workspace value → overlay no-ops harmlessly
    process.env.LANGUAGE = "en";
    const wsValue3 = "en";
    const envKey3 = ["LANGUAGE"];
    const penvWon3 = envKey3.some((k) => process.env[k] && process.env[k] !== wsValue3);
    assert(penvWon3 === false, "process.env.LANGUAGE matches workspace value → no conflict");
  } finally {
    if (orig === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = orig;
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
