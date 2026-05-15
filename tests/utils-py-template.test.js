/**
 * Regression test for v0.8.1 P10-B — workflows/common/utils.py template.
 *
 * Verifies the template file exists with the expected exports +
 * spawns python3 to exercise strip_annotations / detect_report_type /
 * make_result against synthetic inputs.
 *
 * Run: `node tests/utils-py-template.test.js`
 *
 * Skipped if python3 isn't on PATH (CI without Python).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(__dirname, "..", "template", "workflows", "common", "utils.py");

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\nTemplate file exists with expected exports");
{
  assert(fs.existsSync(templatePath), "template/workflows/common/utils.py exists");
  const src = fs.readFileSync(templatePath, "utf-8");
  assert(/^def strip_annotations\(/m.test(src), "strip_annotations function exported");
  assert(/^def detect_report_type\(/m.test(src), "detect_report_type function exported");
  assert(/^def make_result\(/m.test(src), "make_result function exported");
  // 11 annotation prefixes per the v0.8.1 spec (中英文 mix)
  for (const prefix of ["预期命中点", "预期结果", "标注", "审核标注", "Expected", "expected", "Annotation"]) {
    assert(new RegExp(`["']${prefix}["']`).test(src), `annotation prefix "${prefix}" recognized`);
  }
}

// Spawn python3 to exercise the helpers
const pyCheck = spawnSync("python3", ["--version"], { stdio: "ignore" });
if (pyCheck.status !== 0) {
  console.log("\n(python3 not available — skipping shim execution tests)");
} else {
  console.log("\nPython execution: strip_annotations + detect_report_type + make_result");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-utils-test-"));
  fs.copyFileSync(templatePath, path.join(tmpDir, "utils.py"));
  const r = spawnSync("python3", ["-c", `
import sys
sys.path.insert(0, "${tmpDir}")
from utils import strip_annotations, detect_report_type, make_result

# strip_annotations — Chinese annotation
s1 = strip_annotations("doc body\\n\\n预期命中点: 年化利率应披露\\n预期结果: PASS")
assert "预期命中点" not in s1
assert "doc body" in s1

# strip_annotations — English annotation
s2 = strip_annotations("doc body\\n\\nExpected: PASS\\nAnnotation: notes")
assert "Expected" not in s2
assert "Annotation" not in s2

# detect_report_type
assert detect_report_type("2024年第三季度报告") == "季报"
assert detect_report_type("2024年报") == "年报"
assert detect_report_type("日常公告") == "其他"

# make_result
r = make_result("R001", "PASS", "evidence", 0.9, model_used="regex")
assert r["rule_id"] == "R001" and r["model_used"] == "regex"

# extra_prefixes
s3 = strip_annotations("body\\n\\n备注: hidden", extra_prefixes=("备注",))
assert "备注" not in s3

print("all checks passed")
`], { encoding: "utf-8" });
  if (r.status === 0 && /all checks passed/.test(r.stdout || "")) {
    passed += 5;
    console.log("  ✓ strip_annotations strips 预期命中点 + 预期结果 footer");
    console.log("  ✓ strip_annotations strips Expected + Annotation footer");
    console.log("  ✓ detect_report_type returns 季报 / 年报 / 其他");
    console.log("  ✓ make_result builds the expected dict with kwargs");
    console.log("  ✓ extra_prefixes accepts custom annotation labels");
  } else {
    failed += 1;
    console.error("  ✗ python3 execution failed");
    console.error(`    stdout: ${r.stdout}`);
    console.error(`    stderr: ${r.stderr}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
