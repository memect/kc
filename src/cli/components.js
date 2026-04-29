import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = React.createElement;

// A4: Resolve once at module load (package.json doesn't change mid-session).
// Lazy-safe via try/catch so dev-mode from odd cwd never breaks the TUI.
const KC_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch { return null; }
})();

// --- Cooking spinner ---

const COOKING_WORDS = [
  "Baking", "Blanching", "Brewing", "Caramelizing", "Cooking",
  "Fermenting", "Flambéing", "Julienning", "Kneading", "Leavening",
  "Marinating", "Proofing", "Sautéing", "Seasoning", "Simmering",
  "Stewing", "Tempering", "Whisking", "Zesting", "Garnishing", "Drizzling",
];

export function CookingSpinner({ status }) {
  const [idx, setIdx] = useState(Math.floor(Math.random() * COOKING_WORDS.length));

  useEffect(() => {
    const timer = setInterval(() => setIdx((i) => (i + 1) % COOKING_WORDS.length), 2000);
    return () => clearInterval(timer);
  }, []);

  const displayText = status || `${COOKING_WORDS[idx]}...`;

  return h(Box, null,
    h(Text, { color: "yellow" }, "  * "),
    h(Text, { dimColor: true }, displayText),
  );
}

// --- Status bar ---

const LENAT_QUOTE = "Intelligence is ten million rules.";

// F7: rolling 30-sample window for CTX smoothing + peak tracking. 30
// samples × observed update cadence (~1/sec during active turns) ≈ a
// 30-second smoothed view, which absorbs the small spikes from
// transient tool-result embeddings that made the old "instantaneous"
// display jumpy. Peak stays at the highest seen this session.
const CTX_SAMPLE_WINDOW = 30;

// Visual width of a string with CJK chars counted as 2 cells each.
// Used to truncate session IDs etc. so the status bar fits in a single
// terminal row regardless of terminal width.
function visualWidth(s) {
  let w = 0;
  for (const ch of s || "") {
    const cp = ch.codePointAt(0);
    // CJK + fullwidth + emoji rough heuristic — wide if codepoint ≥ 0x1100.
    w += cp >= 0x1100 ? 2 : 1;
  }
  return w;
}

function truncateVisual(s, maxCells) {
  if (!s) return s;
  if (visualWidth(s) <= maxCells) return s;
  // Middle-truncate so renamed sessions keep both ends visible
  // (e.g. "资管新规测试062-GLM" → "资管新规…2-GLM" — model suffix preserved).
  const headBudget = Math.floor((maxCells - 1) / 2);
  const tailBudget = maxCells - 1 - headBudget;
  const chars = [...s];
  let w = 0; let head = "";
  for (const ch of chars) {
    const cw = ch.codePointAt(0) >= 0x1100 ? 2 : 1;
    if (w + cw > headBudget) break;
    w += cw; head += ch;
  }
  let tw = 0; let tail = "";
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const cw = ch.codePointAt(0) >= 0x1100 ? 2 : 1;
    if (tw + cw > tailBudget) break;
    tw += cw; tail = ch + tail;
  }
  return head + "…" + tail;
}

export function StatusBar({ sessionId, phase, contextTokens, contextLimit }) {
  const samplesRef = useRef([]);
  const peakRef = useRef(0);

  // Push current sample + cap the ring
  const samples = samplesRef.current;
  samples.push(contextTokens || 0);
  if (samples.length > CTX_SAMPLE_WINDOW) samples.shift();
  const smoothed = samples.length > 0
    ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
    : 0;
  if ((contextTokens || 0) > peakRef.current) peakRef.current = contextTokens || 0;
  const peak = peakRef.current;

  const pct = contextLimit ? Math.round((smoothed / contextLimit) * 100) : 0;
  const ctxColor = pct > 80 ? "red" : pct > 60 ? "yellow" : "green";
  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n || 0}`;
  const ctxLabel = fmt(smoothed);
  const limitLabel = fmt(contextLimit || 0);
  // F7: peak shown when meaningfully higher than smoothed (by at least
  // 5% of the limit) so users see "we hit high water, currently back
  // down." Otherwise skip to keep the bar compact.
  const showPeak = contextLimit > 0 && (peak - smoothed) / contextLimit > 0.05;

  // Soft-threshold hint — shows up before auto-windowing kicks in at ~70%
  // so users know they can run /compact to reduce context more aggressively
  // than windowing does. Red hint at 80%+ means it's time to compact NOW.
  const compactHint = pct >= 80 ? "  · 💾 /compact"
                     : pct >= 60 ? "  · 💾 建议 /compact"
                     : "";

  // Truncate session ID to keep the bar single-row even with CJK names.
  // 14 visual cells covers most short UUIDs and ~6-7 CJK chars.
  const displaySessionId = sessionId ? truncateVisual(sessionId, 14) : "";

  return h(Box, { marginTop: 0 },
    h(Text, { dimColor: true, wrap: "truncate-end" }, "  ⏵⏵  KC "),
    h(Text, { dimColor: true, wrap: "truncate-end" }, displaySessionId ? `[${displaySessionId}]` : ""),
    phase ? h(Text, { color: "cyan", wrap: "truncate-end" }, ` ${phase.toUpperCase()}`) : null,
    h(Text, { color: "green", wrap: "truncate-end" }, "  ●  "),
    h(Text, { color: ctxColor, wrap: "truncate-end" }, `CTX: ${ctxLabel}/${limitLabel} (${pct}%)`),
    showPeak ? h(Text, { dimColor: true, wrap: "truncate-end" }, ` · peak ${fmt(peak)}`) : null,
    compactHint ? h(Text, { color: ctxColor, wrap: "truncate-end" }, compactHint) : null,
    h(Text, { dimColor: true, wrap: "truncate-end" }, `  · ${LENAT_QUOTE}`),
  );
}

// --- Task dashboard (ralph-loop) ---

export function TaskDashboard({ tasks, progress }) {
  if (!tasks || tasks.length === 0) return null;

  const { total, completed } = progress || { total: 0, completed: 0 };
  const barWidth = 20;
  const filled = total > 0 ? Math.round((completed / total) * barWidth) : 0;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

  // Show at most 8 tasks — current + a few before/after
  const currentIdx = tasks.findIndex((t) => t.status === "in_progress");
  const startIdx = Math.max(0, Math.min(currentIdx - 2, tasks.length - 8));
  const visible = tasks.slice(startIdx, startIdx + 8);
  const hasMore = tasks.length > 8;

  return h(Box, { flexDirection: "column", marginLeft: 2, marginBottom: 1, borderStyle: "single", borderColor: "gray", paddingLeft: 1, paddingRight: 1 },
    h(Text, { dimColor: true }, `Tasks [${bar}] ${completed}/${total}`),
    ...visible.map((t) => {
      const icon = t.status === "completed" ? "\u2713"
        : t.status === "in_progress" ? "\u25b8"
        : t.status === "failed" ? "\u2717"
        : "\u00b7";
      const color = t.status === "completed" ? "green"
        : t.status === "in_progress" ? "cyan"
        : t.status === "failed" ? "red"
        : "gray";
      const label = `${t.ruleId || t.id}  ${t.title}`;
      return h(Text, { key: t.id, color }, `  ${icon} ${label.slice(0, 50)}`);
    }),
    hasMore ? h(Text, { dimColor: true }, `  ... ${tasks.length - 8} more`) : null,
  );
}

// --- Welcome banner ---

export function WelcomeBanner({ projectDir, pendingInputCount = 0 } = {}) {
  return h(Box, { flexDirection: "column", marginBottom: 1, borderStyle: "round", borderColor: "gray", paddingLeft: 1, paddingRight: 1 },
    h(Box, null,
      h(Text, { bold: true }, "KC AGENT CLI"),
      h(Text, { dimColor: true }, KC_VERSION ? `  v${KC_VERSION}  (beta)` : "  (beta)"),
    ),
    h(Text, { dimColor: true }, "Hope you never know what KC was."),
    h(Text, null, ""),
    projectDir
      ? h(Box, { flexDirection: "column" },
          h(Text, { dimColor: true }, `Project: ${projectDir}`),
          h(Text, { color: "yellow", dimColor: true }, "KC has full read/write access to this directory. We recommend backing up important files."),
        )
      : null,
    pendingInputCount > 0
      ? h(Text, { color: "cyan" }, `📥 ${pendingInputCount} new file(s) pending in input/ — run /schedule for details`)
      : null,
    h(Text, null, ""),
    // H7: priority-phrasing nudge. If the developer has multiple inputs
    // with mixed roles (authoritative vs supporting), KC treats them
    // equally unless told otherwise — which led to the reg 02 starvation
    // + reg 03-10 bloat in session 6304673afaa0. Prompt explicit up-front.
    h(Text, { dimColor: true, color: "cyan" },
      "💡 Tip: If your inputs include BOTH authoritative and supporting"),
    h(Text, { dimColor: true, color: "cyan" },
      "   sources, say so at session start — e.g. \"prioritize rules/01 and"),
    h(Text, { dimColor: true, color: "cyan" },
      "   rules/02 as core; rules/03-10 are supporting context only.\""),
    h(Text, null, ""),
    h(Text, { dimColor: true }, "Product of Memium / kitchen-engineer42"),
  );
}

// --- Tool block ---

/**
 * Tool-result block.
 *
 * Rendering modes:
 *   - isRunning       → yellow border, no output (spinner shown elsewhere).
 *   - isError         → red border, ALWAYS show full output (errors are short + critical).
 *   - isRecent: true  → green border, show up to ~4 lines + "N lines hidden" footer.
 *   - isRecent: false → header only (header includes line count + byte count).
 *
 * The full output is always on disk in logs/events.jsonl. Keeping the Ink
 * tree slim is what lets KC handle long sessions without OOM / typing lag.
 */
const RECENT_PREVIEW_LINES = 4;

// B0.5: React.memo — ToolBlock renders the heaviest subtree in the TUI
// (multi-line Box + colored Text + per-line Box wrappers). Without memo,
// every `setMessages` / `setStreamingText` causes React to re-render ALL
// 50 visible ToolBlocks even though none of their props changed. Ink
// then diffs the result against the prior render. Memo lets us skip
// that work for untouched rows. The props are small primitives + short
// strings — shallow equality is the right comparator.
function ToolBlockImpl({ name, input, output, isError, isRunning, isRecent = true }) {
  const borderColor = isRunning ? "yellow" : isError ? "red" : "green";
  const outStr = typeof output === "string" ? output : "";
  const lines = outStr ? outStr.split("\n") : [];
  const bytes = outStr.length;

  const header = h(Box, null,
    h(Text, { color: borderColor }, "┃ "),
    h(Text, { dimColor: true }, name),
    input ? h(Text, { dimColor: true }, ` ${JSON.stringify(input).slice(0, 120)}`) : null,
    outStr && !isRunning
      ? h(Text, { dimColor: true }, `  (${lines.length} 行 / ${bytes} 字节)`)
      : null,
  );

  // Errors: always show in full (short + critical).
  if (isError && outStr) {
    return h(Box, { flexDirection: "column", marginLeft: 2 },
      header,
      h(Box, { flexDirection: "column" },
        ...lines.map((line, i) =>
          h(Box, { key: i },
            h(Text, { color: "red" }, "┃ "),
            h(Text, { color: "red" }, line),
          ),
        ),
      ),
    );
  }

  // Off-screen / not-recent: header only. Full output remains on disk.
  if (!isRecent || !outStr) {
    return h(Box, { marginLeft: 2 }, header);
  }

  // Recent + successful: show preview + truncation footer.
  const previewLines = lines.slice(0, RECENT_PREVIEW_LINES);
  const remaining = lines.length - previewLines.length;
  return h(Box, { flexDirection: "column", marginLeft: 2 },
    header,
    h(Box, { flexDirection: "column" },
      ...previewLines.map((line, i) =>
        h(Box, { key: i },
          h(Text, { color: borderColor }, "┃ "),
          h(Text, null, line),
        ),
      ),
      remaining > 0
        ? h(Box, null,
            h(Text, { color: borderColor }, "┃ "),
            h(Text, { dimColor: true }, `… ${remaining} 行已省略（在 logs/events.jsonl 中完整保留）`),
          )
        : null,
    ),
  );
}

export const ToolBlock = React.memo(ToolBlockImpl);

// --- Message display ---

export function MessageBlock({ role, content, toolName, toolInput, toolOutput, toolIsError }) {
  if (role === "user") {
    return h(Box, null,
      h(Text, { dimColor: true }, "❯ "),
      h(Text, null, content),
    );
  }
  if (role === "agent") {
    return h(Box, null,
      h(Text, null, content),
    );
  }
  if (role === "tool") {
    return h(ToolBlock, {
      name: toolName,
      input: toolInput,
      output: toolOutput,
      isError: toolIsError,
      isRunning: false,
    });
  }
  if (role === "system") {
    return h(Box, null,
      h(Text, { dimColor: true }, content),
    );
  }
  return null;
}

// --- Horizontal rule ---

export function HRule() {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  return h(Text, { dimColor: true }, "─".repeat(cols));
}

// --- Messages list ---

export function MessagesList({ messages }) {
  return h(Box, { flexDirection: "column" },
    ...messages.map((msg, i) =>
      h(MessageBlock, { key: i, ...msg }),
    ),
  );
}

// --- Input prompt ---

/**
 * F3: cursor-aware input with arrow-key support.
 *
 * - Left/Right: move cursor within the current line. Cursor position is
 *   internal state (not hoisted) so the parent's onChange contract
 *   stays stable.
 * - Up/Down: when the input is empty (OR cursor is at start/end), walk
 *   through a session-local history buffer of the user's past
 *   submissions. Non-destructive: editing a recalled line doesn't mutate
 *   the history entry.
 * - Home/End (or Ctrl-A/Ctrl-E): jump cursor to start/end.
 * - Backspace/Delete: deletes at cursor position (not always end-of-line).
 *
 * History is in-memory only (`historyRef`) — not persisted across sessions,
 * per v0.6.0 plan item F3 "keep simple." Cleared on `/clear`.
 */
export function InputPrompt({ value, onChange, onSubmit, isActive, placeholderRight = null }) {
  const [cursor, setCursor] = useState(value.length);
  const historyRef = useRef([]); // session-local submission history
  const historyIdxRef = useRef(null); // index while browsing history; null = live editing

  // Keep cursor in range when value changes externally (e.g. recall).
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  useInput((input, key) => {
    if (!isActive) return;

    // Submit
    if (key.return) {
      const v = value;
      if (v.trim()) historyRef.current.push(v);
      historyIdxRef.current = null;
      setCursor(0);
      onSubmit(v);
      return;
    }

    // Backspace at cursor
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      onChange(next);
      setCursor(cursor - 1);
      historyIdxRef.current = null;
      return;
    }

    // Arrow keys
    if (key.leftArrow) {
      if (cursor > 0) setCursor(cursor - 1);
      return;
    }
    if (key.rightArrow) {
      if (cursor < value.length) setCursor(cursor + 1);
      return;
    }
    if (key.upArrow) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      const idx = historyIdxRef.current == null ? hist.length : historyIdxRef.current;
      const nextIdx = Math.max(0, idx - 1);
      historyIdxRef.current = nextIdx;
      const recalled = hist[nextIdx] || "";
      onChange(recalled);
      setCursor(recalled.length);
      return;
    }
    if (key.downArrow) {
      const hist = historyRef.current;
      if (historyIdxRef.current == null) return;
      const nextIdx = historyIdxRef.current + 1;
      if (nextIdx >= hist.length) {
        historyIdxRef.current = null;
        onChange("");
        setCursor(0);
        return;
      }
      historyIdxRef.current = nextIdx;
      const recalled = hist[nextIdx] || "";
      onChange(recalled);
      setCursor(recalled.length);
      return;
    }

    // Home/End — Ctrl-A / Ctrl-E (terminal convention)
    if (key.ctrl && input === "a") { setCursor(0); return; }
    if (key.ctrl && input === "e") { setCursor(value.length); return; }

    // Skip other control combos
    if (key.ctrl || key.meta || key.escape) return;

    // Printable characters insert at cursor
    if (input) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      onChange(next);
      setCursor(cursor + input.length);
      historyIdxRef.current = null;
    }
  }, { isActive });

  // Render: split the value at the cursor so the block-cursor appears
  // inline, not just at the end.
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  return h(Box, null,
    h(Text, { dimColor: true }, "❯ "),
    h(Text, null, before),
    isActive
      ? h(Text, { color: "gray", inverse: true }, after.length > 0 ? after[0] : " ")
      : null,
    h(Text, null, after.length > 0 ? after.slice(1) : ""),
    placeholderRight
      ? h(Box, { marginLeft: 2 }, h(Text, { dimColor: true, color: "cyan" }, placeholderRight))
      : null,
  );
}
