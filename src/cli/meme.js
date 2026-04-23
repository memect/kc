import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

const h = React.createElement;

// F6: /meme easter egg. Intentionally not listed in /help — discovery
// is the point. Press ESC or Enter to dismiss. Content per the v0.6.0
// plan (item 15) — lyrics + team credit.

const LYRICS = [
  "I'll wait and soon",
  "We're stranded on the beach",
  "In our dream",
  "We part too soon",
  "But in our lies",
  "There's a truth to find",
  "The end is new",
  "A tomorrow we must reach for",
  "To be heard",
];

const TEAM = [
  "@kitchen-engineer42", "@Xigua", "@Amelia", "@01Fish",
  "@zyxthetroll", "@theon", "@DivisionDirectorXu",
  "@AnselKocen", "@CarolineCRL", "@GraceGuo",
  "@XY🌟", "@HalfM", "@GreenOrange",
  "@LilyHuang", "@Qianlili", "@songmao",
  "@zoezoe", "@yhhm",
];

export function MemeOverlay({ onDismiss }) {
  useInput((input, key) => {
    if (key.escape || key.return) onDismiss();
  });

  return h(Box, { flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, marginTop: 1, marginBottom: 1 },
    // Lyrics block
    h(Box, { flexDirection: "column" },
      ...LYRICS.map((line, i) =>
        h(Text, { key: `l-${i}`, color: "cyan", italic: true }, line),
      ),
    ),
    h(Text, null, ""),
    h(Text, { dimColor: true }, "─".repeat(60)),
    h(Text, null, ""),
    // Team credit
    h(Text, { color: "yellow", bold: true },
      "Here's to all the smart minds that are/were part of our team:"),
    h(Text, null, ""),
    h(Box, { flexWrap: "wrap" },
      ...TEAM.map((handle, i) =>
        h(Text, { key: `t-${i}`, color: "green" }, `${handle}${i < TEAM.length - 1 ? ",  " : ""}`),
      ),
    ),
    h(Text, null, ""),
    h(Text, { dimColor: true }, "Press ESC or Enter to dismiss."),
  );
}
