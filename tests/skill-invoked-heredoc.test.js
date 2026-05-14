/**
 * Regression test for v0.8 P1-E — skill_invoked heredoc false-positive.
 *
 * Background:
 * v0.7.5 G-C6 fixed the read-only regex (only fire skill_invoked on reads
 * of SKILL.md paths). But the audit found:
 *   `cat << 'PYEOF' > /tmp/x.py`
 * matches the read-verb regex (`\b(cat|head|...)\b`) even though the
 * heredoc operator `<<` means cat is consuming inline content, NOT a
 * file path. 资管 v0.7.5 audit § 5f confirmed 1 spurious skill_invoked
 * event per session of this kind.
 *
 * v0.8 P1-E: exclude any sandbox_exec command containing `<<` from the
 * isRead classification.
 *
 * Run: `node tests/skill-invoked-heredoc.test.js`
 */

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Mirror the engine's isRead classifier algorithm
function isRead(toolName, inputData) {
  const cmd = String(inputData?.command || "");
  const isHeredoc = cmd.includes("<<");
  return (
    (toolName === "workspace_file" && inputData?.operation === "read") ||
    (toolName === "sandbox_exec" && !isHeredoc && /\b(cat|head|tail|less|grep|view|read)\b/.test(cmd))
  );
}

console.log("\nHeredoc patterns are NOT reads");
{
  assert(!isRead("sandbox_exec", { command: "cat << 'EOF' > /tmp/x.py" }), "quoted heredoc to file");
  assert(!isRead("sandbox_exec", { command: "cat <<EOF > /tmp/x.py" }), "no-space heredoc");
  assert(!isRead("sandbox_exec", { command: "cat <<-EOF > /tmp/x.py" }), "strip-tabs heredoc");
  assert(!isRead("sandbox_exec", { command: "cat << 'PYEOF' > rule_skills/R01/SKILL.md" }), "heredoc to SKILL.md is not a read");
}

console.log("\nReal reads still fire");
{
  assert(isRead("sandbox_exec", { command: "cat SKILL.md" }), "plain cat is a read");
  assert(isRead("sandbox_exec", { command: "cat rule_skills/R01/SKILL.md" }), "cat per-rule SKILL.md");
  assert(isRead("sandbox_exec", { command: "head -20 SKILL.md" }), "head is a read");
  assert(isRead("sandbox_exec", { command: "grep pattern SKILL.md" }), "grep is a read");
  assert(isRead("workspace_file", { operation: "read", path: "skills/foo/SKILL.md" }), "workspace_file read");
}

console.log("\nWrites are not reads");
{
  assert(!isRead("workspace_file", { operation: "write", path: "skills/foo/SKILL.md" }), "workspace_file write");
  assert(!isRead("sandbox_exec", { command: "echo hello > out.txt" }), "echo redirect is not a read");
  assert(!isRead("sandbox_exec", { command: "python script.py" }), "python invocation is not a read");
}

console.log("\nEdge: cat with redirect (still a read of the source)");
{
  // `cat src > dst` IS reading src (and writing to dst). The agent did read
  // SKILL.md. Whether this should fire is debatable; the existing v0.7.5
  // behavior is to fire (the cat verb matched). v0.8 P1-E doesn't change
  // this — only heredoc (`<<`) is excluded.
  assert(isRead("sandbox_exec", { command: "cat SKILL.md > /tmp/notes.txt" }), "cat-with-redirect (no heredoc) still a read");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
