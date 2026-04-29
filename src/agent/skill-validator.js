/**
 * v0.6.2 I2: Skill validator (was D3c, deferred from v0.6.0/v0.6.1).
 *
 * E2E #4 demonstrated that broken `check_r###.py` contents go undetected
 * until production_qc throws (e.g., `SyntaxError: unexpected character
 * after line continuation character` from line 733 of unified_qc.py).
 * This validator catches such breakage at the skill_authoring phase
 * boundary instead of months later in production.
 *
 * Design constraints:
 *  - exitCriteriaMet is sync, so validation is sync (execFileSync).
 *  - 110 files × ~50ms subprocess = 5.5s worst case; caching by mtime
 *    keeps steady-state cost at ~0 (only re-validate freshly modified
 *    files).
 *  - Failures are diagnostic, not punitive: `force: true` on phase_advance
 *    still bypasses. The validator's job is to refuse the auto-advance,
 *    not to trap the agent.
 *
 * Validation rules per `check_*.py`:
 *  1. File ≥ 100 bytes (smoke test for empty stubs).
 *  2. Passes `python3 -c "import ast; ast.parse(open(F).read())"` (no
 *     syntax errors).
 *  3. Defines a function reachable by one of the names: `check_rule`,
 *     `verify`, OR `check_r<digits>` (e.g. `check_r014`, `check_r013_r017`).
 *     v0.7.0 A6 broadened the third pattern after E2E #5 audit found
 *     three sessions independently chose `def check_r###` over the
 *     canonical names — the validator was too strict.
 *
 * Disable mechanism: if `python3` is not on PATH, validator silently
 * passes everything and emits a one-time warning — we don't want the
 * gate to block on missing tooling. Gate effectively no-ops.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// v0.7.0 A6: entry-point check is a sanity probe, not a style enforcer.
// The validator's real signal comes from `≥ 100 bytes` + `ast.parse
// passes`. Restricting to specific verb names rejected 27/28 GLM
// scripts in E2E #5 — the cost outweighed the catch (every contestant
// converged on a different naming convention).
//
// New rule: any top-level `def \w+(...)` counts. Rejects pure-imports
// or comment-only stubs (which is what we actually wanted to catch),
// accepts anything with real logic. The check_*.py *filename* (matched
// by the path regex in `findCheckScripts`) carries the rule-id signal;
// the function name doesn't need to.
const ENTRY_POINT_REGEX = /^(?:async\s+)?def\s+\w+\s*\(/m;
const MIN_BYTES = 100;

export class SkillValidator {
  constructor() {
    /** @type {Map<string, { mtime: number, ok: boolean, error?: string }>} */
    this._cache = new Map();
    /** @type {boolean|null} - null = untested, true/false once probed */
    this._pythonAvailable = null;
    /** @type {boolean} - one-time warning suppression */
    this._warned = false;
  }

  /**
   * Probe whether python3 is available. Cached after first call.
   * @returns {boolean}
   */
  _probePython() {
    if (this._pythonAvailable !== null) return this._pythonAvailable;
    try {
      execFileSync("python3", ["-c", "import ast"], { stdio: "ignore", timeout: 5000 });
      this._pythonAvailable = true;
    } catch {
      this._pythonAvailable = false;
    }
    return this._pythonAvailable;
  }

  /**
   * Validate one file. Returns `{ ok, error? }`. Cached by mtime.
   * @param {string} filePath - Absolute path to the .py file
   * @returns {{ ok: boolean, error?: string }}
   */
  validateFile(filePath) {
    let mtime;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      return { ok: false, error: "file not found" };
    }
    const cached = this._cache.get(filePath);
    if (cached && cached.mtime === mtime) {
      return { ok: cached.ok, error: cached.error };
    }
    const result = this._runValidation(filePath);
    this._cache.set(filePath, { mtime, ...result });
    return result;
  }

  /**
   * Validate all files in a list. Returns:
   *  - ok: boolean — true iff every file passes
   *  - failures: array of { filePath, error } for each failing file
   *  - skipped: boolean — true if python3 unavailable (validator no-op'd)
   *
   * @param {string[]} filePaths
   * @returns {{ ok: boolean, failures: Array<{filePath:string, error:string}>, skipped: boolean }}
   */
  validateAll(filePaths) {
    if (!this._probePython()) {
      if (!this._warned) {
        // eslint-disable-next-line no-console
        console.warn("[skill-validator] python3 not on PATH — skill validation skipped. " +
          "Phase gate will not catch syntax errors. Install python3 to enable.");
        this._warned = true;
      }
      return { ok: true, failures: [], skipped: true };
    }
    const failures = [];
    for (const f of filePaths) {
      const r = this.validateFile(f);
      if (!r.ok) failures.push({ filePath: f, error: r.error || "unknown" });
    }
    return { ok: failures.length === 0, failures, skipped: false };
  }

  /**
   * Manually invalidate cache for a path — used when the caller knows
   * the file changed but mtime granularity might not have caught it.
   */
  invalidate(filePath) { this._cache.delete(filePath); }

  // --- Internal ---

  _runValidation(filePath) {
    // Rule 1: size check (cheap)
    let size;
    try { size = fs.statSync(filePath).size; }
    catch { return { ok: false, error: "stat failed" }; }
    if (size < MIN_BYTES) {
      return { ok: false, error: `file too small (${size} < ${MIN_BYTES} bytes)` };
    }

    // Rule 2: ast.parse smoke test via subprocess
    try {
      execFileSync("python3", [
        "-c",
        `import ast,sys\ntry:\n ast.parse(open(${JSON.stringify(filePath)}).read())\nexcept SyntaxError as e:\n print(f"SyntaxError: {e}", file=sys.stderr); sys.exit(1)\nexcept Exception as e:\n print(f"{type(e).__name__}: {e}", file=sys.stderr); sys.exit(1)\n`,
      ], { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
    } catch (e) {
      const stderr = (e.stderr ? e.stderr.toString() : "") || e.message || "subprocess failed";
      return { ok: false, error: stderr.trim().slice(0, 300) };
    }

    // Rule 3: entry-point regex (after parse OK so we know file is readable)
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); }
    catch { return { ok: false, error: "read failed after parse OK" }; }
    if (!ENTRY_POINT_REGEX.test(content)) {
      return { ok: false, error: "no callable defined: file has imports/comments only, no top-level `def`" };
    }

    return { ok: true };
  }
}
