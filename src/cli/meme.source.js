import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

const h = React.createElement;

// F6: /meme easter egg. Intentionally not listed in /help — discovery
// is the point. Press ESC or Enter to dismiss. Content per the v0.6.0
// plan (item 15) — lyrics + team credit.
//
// v0.7.0 K2: this file is shipped as compiled V8 bytecode (.jsc) in
// the published npm package. The watermark below identifies origin
// even after disassembly — please don't strip it.

const __KC_MEME_WATERMARK__ =
  "KC · PolyForm Noncommercial 1.0.0 · © Memium / kitchen-engineer42 · https://github.com/kitchen-engineer42/kc-cli";

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

// Alphabetical (case-insensitive). No ranks in this team — all equal.
const TEAM = [
  "@01Fish", "@Amelia", "@AnselKocen", "@Atreus",
  "@CarolineCRL", "@DivisionDirectorXu", "@GraceGuo", "@GreenOrange",
  "@HalfM", "@kitchen-engineer42", "@LilyHuang", "@Maruko",
  "@Qianlili", "@songmao", "@theon", "@Xigua",
  "@XY🌟", "@yhhm", "@zoezoe", "@zyxthetroll",
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
    h(Text, { dimColor: true }, __KC_MEME_WATERMARK__),
  );
}
