/**
 * Regression test for v0.8 P3-C — skill counter agent-blind invariant.
 *
 * The skill_byte_send counter (P3-A) must be invisible to the agent.
 * No new tool, no system prompt mention, no surfacing in
 * describeState / context.build outputs. Pure passive measurement to
 * events.jsonl so it doesn't influence the behavior it's measuring.
 *
 * This test grep's the codebase for any path that could leak the
 * counter to the agent's context.
 *
 * Run: `node tests/skill-counter-agent-blind.test.js`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "src");
const TEMPLATE = path.resolve(__dirname, "..", "template");

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function walkFiles(root, predicate) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && predicate(p)) out.push(p);
    }
  }
  return out;
}

console.log("\nNo tool registers `skill_byte_send` as a tool name");
{
  const toolFiles = walkFiles(path.join(SRC, "agent", "tools"), (p) => p.endsWith(".js"));
  let leakFound = false;
  for (const f of toolFiles) {
    const content = fs.readFileSync(f, "utf-8");
    // Tools declare their name via `get name()`. Look for any return value of skill_byte_send.
    if (/get\s+name\s*\(\s*\)\s*\{[^}]*["']skill_byte_send["']/.test(content)) {
      leakFound = true;
      console.error(`  LEAK in ${f}: registers skill_byte_send as tool name`);
    }
  }
  assert(!leakFound, "no tool registers skill_byte_send name");
}

console.log("\nNo template SKILL.md mentions `skill_byte_send` (would leak via system prompt)");
{
  const skillFiles = walkFiles(path.join(TEMPLATE, "skills"), (p) => p.endsWith("SKILL.md"));
  let leakFound = false;
  for (const f of skillFiles) {
    const content = fs.readFileSync(f, "utf-8");
    if (content.includes("skill_byte_send")) {
      leakFound = true;
      console.error(`  LEAK in ${path.relative(TEMPLATE, f)}: mentions skill_byte_send`);
    }
  }
  assert(!leakFound, "no SKILL.md mentions skill_byte_send");
}

console.log("\nNo AGENT.md template mentions `skill_byte_send`");
{
  const agentMd = path.join(TEMPLATE, "AGENT.md");
  if (fs.existsSync(agentMd)) {
    const content = fs.readFileSync(agentMd, "utf-8");
    assert(!content.includes("skill_byte_send"), "AGENT.md template does NOT mention skill_byte_send");
  } else {
    console.log("  (AGENT.md absent — skip)");
  }
}

console.log("\nContext-builder doesn't expose skill_byte_send field");
{
  const contextPath = path.join(SRC, "agent", "context.js");
  if (fs.existsSync(contextPath)) {
    const content = fs.readFileSync(contextPath, "utf-8");
    assert(!content.includes("skill_byte_send"), "context.js doesn't reference skill_byte_send");
  }
}

console.log("\nengine.js emits skill_byte_send ONLY to eventLog (never to context/state)");
{
  const enginePath = path.join(SRC, "agent", "engine.js");
  const content = fs.readFileSync(enginePath, "utf-8");
  // The only references should be:
  //   - eventLog.append("skill_byte_send", ...)
  //   - comments mentioning it
  // NOT in describeState / context.build / system prompt construction.
  const lines = content.split("\n");
  let leakLine = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("skill_byte_send")) continue;
    // Allowed contexts: in a comment, or as eventLog.append argument
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
    if (/eventLog\?\.append|eventLog\.append/.test(line) || /eventLog\?\.append/.test(line)) continue;
    leakLine = `line ${i + 1}: ${trimmed}`;
    break;
  }
  assert(leakLine === null, `engine.js skill_byte_send only appears in eventLog.append calls (or ${leakLine})`);
}

console.log("\ninputSchema for any tool does NOT list skill_byte_send");
{
  const toolFiles = walkFiles(path.join(SRC, "agent", "tools"), (p) => p.endsWith(".js"));
  let leakFound = false;
  for (const f of toolFiles) {
    const content = fs.readFileSync(f, "utf-8");
    // Look for skill_byte_send inside any inputSchema return value
    if (/inputSchema[\s\S]{0,2000}?skill_byte_send/.test(content)) {
      leakFound = true;
      console.error(`  LEAK in ${f}: skill_byte_send in inputSchema`);
    }
  }
  assert(!leakFound, "no tool's inputSchema mentions skill_byte_send");
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
