#!/usr/bin/env node
/**
 * KC test runner. Discovers `tests/*.test.js` and runs each as a subprocess.
 * Pass: exit 0. Fail: exit 1 with first failure's stderr.
 *
 * Tests are written as standalone scripts that exit 0 on pass, 1 on fail.
 * They print their own progress to stdout; this runner just aggregates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(__dirname, "..", "tests");

if (!fs.existsSync(testsDir)) {
  console.error(`No tests/ directory at ${testsDir}`);
  process.exit(0);
}

const testFiles = fs.readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(testsDir, f))
  .sort();

if (testFiles.length === 0) {
  console.log("No test files found in tests/");
  process.exit(0);
}

let totalPassed = 0;
let totalFailed = 0;

for (const file of testFiles) {
  const name = path.relative(process.cwd(), file);
  console.log(`\n${"━".repeat(60)}\n▶ ${name}\n${"━".repeat(60)}`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit" });
  if (r.status === 0) totalPassed += 1;
  else totalFailed += 1;
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Files: ${totalPassed} passed, ${totalFailed} failed`);
console.log("=".repeat(60));
process.exit(totalFailed > 0 ? 1 : 0);
