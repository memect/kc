import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";

const h = React.createElement;

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

export function StatusBar({ sessionId, phase, contextTokens, contextLimit }) {
  const pct = contextLimit ? Math.round((contextTokens / contextLimit) * 100) : 0;
  const ctxColor = pct > 80 ? "red" : pct > 60 ? "yellow" : "green";
  const ctxLabel = contextTokens >= 1000
    ? `${(contextTokens / 1000).toFixed(1)}k`
    : `${contextTokens || 0}`;
  const limitLabel = contextLimit >= 1000
    ? `${(contextLimit / 1000).toFixed(0)}k`
    : `${contextLimit || 0}`;

  return h(Box, { marginTop: 0 },
    h(Text, { dimColor: true }, "  ⏵⏵  KC Agent CLI "),
    h(Text, { dimColor: true }, sessionId ? `[${sessionId}]` : ""),
    phase ? h(Text, { color: "cyan" }, ` ${phase.toUpperCase()}`) : null,
    h(Text, { color: "green" }, "  ●  "),
    h(Text, { color: ctxColor }, `CTX: ${ctxLabel}/${limitLabel} (${pct}%)`),
    h(Text, { dimColor: true }, `  · ${LENAT_QUOTE}`),
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
      h(Text, { dimColor: true }, "  (beta)"),
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
    h(Text, { dimColor: true }, "Product of Memium / kitchen-engineer42"),
  );
}

// --- Tool block ---

export function ToolBlock({ name, input, output, isError, isRunning }) {
  const borderColor = isRunning ? "yellow" : isError ? "red" : "green";

  return h(Box, { flexDirection: "column", marginLeft: 2 },
    h(Box, null,
      h(Text, { color: borderColor }, "┃ "),
      h(Text, { dimColor: true }, name),
      input ? h(Text, { dimColor: true }, ` ${JSON.stringify(input)}`) : null,
    ),
    output ? h(Box, { flexDirection: "column" },
      ...output.split("\n").slice(0, 20).map((line, i) =>
        h(Box, { key: i },
          h(Text, { color: borderColor }, "┃ "),
          h(Text, null, line),
        ),
      ),
      output.split("\n").length > 20
        ? h(Box, null,
            h(Text, { color: borderColor }, "┃ "),
            h(Text, { dimColor: true }, `... ${output.split("\n").length - 20} more lines`),
          )
        : null,
    ) : null,
  );
}

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

export function InputPrompt({ value, onChange, onSubmit, isActive }) {
  useInput((input, key) => {
    if (!isActive) return;

    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    // Skip control characters
    if (key.ctrl || key.meta || key.escape) return;
    // Append printable characters
    if (input) {
      onChange(value + input);
    }
  }, { isActive });

  return h(Box, null,
    h(Text, { dimColor: true }, "❯ "),
    h(Text, null, value),
    isActive ? h(Text, { color: "gray" }, "█") : null,
  );
}
