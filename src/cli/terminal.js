// ANSI colors — no dependencies, no cursor positioning, no scroll regions.
// Everything appends to stdout naturally. Simple and reliable.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;
const CLEAR_LINE = `\r${ESC}2K`;

const COOKING_WORDS = [
  "Baking", "Blanching", "Brewing", "Caramelizing", "Cooking",
  "Fermenting", "Flambéing", "Julienning", "Kneading", "Leavening",
  "Marinating", "Proofing", "Sautéing", "Seasoning", "Simmering",
  "Stewing", "Tempering", "Whisking", "Zesting", "Garnishing", "Drizzling",
];

const LENAT_QUOTE = "Intelligence is ten million rules.";

let spinnerInterval = null;
let _sessionId = "";
let _phase = "";

function cols() {
  return process.stdout.columns || 80;
}

function hrule() {
  return `${GRAY}${"─".repeat(cols())}${RESET}`;
}

// --- Welcome screen ---

export function printWelcome() {
  const art = `
        ${BOLD}KC AGENT CLI${RESET}  ${DIM}(beta)${RESET}

        ${DIM}Hope you never know what KC was.${RESET}

        ${GRAY}Product of Memium${RESET}
        ${GRAY}kitchen-engineer42${RESET}
`;
  process.stdout.write(art + "\n");
}

// --- Status bar ---

function _statusLine() {
  const session = _sessionId ? `[${_sessionId}]` : "";
  const phasePart = _phase ? ` ${CYAN}${_phase.toUpperCase()}${RESET}` : "";
  return `  ${GRAY}⏵⏵${RESET}  KC Agent CLI ${GRAY}${session}${RESET}${phasePart}  ${GREEN}●${RESET}  ${DIM}· ${LENAT_QUOTE}${RESET}`;
}

export function updateStatus(sessionId, phase) {
  if (sessionId != null) _sessionId = sessionId;
  if (phase != null) _phase = phase;
}

// --- Prompt (printed after each turn) ---

export function printPrompt() {
  process.stdout.write(`${hrule()}\n${GRAY}❯${RESET} `);
}

export function printPromptWithStatus() {
  process.stdout.write(`${hrule()}\n${GRAY}❯${RESET} \n${hrule()}\n${_statusLine()}\n`);
  // Move cursor back up to the input line
  process.stdout.write(`${ESC}3A${ESC}3C`);
}

// --- Transcript output (just appends, scrolls naturally) ---

export function printTextDelta(text) {
  process.stdout.write(text);
}

export function printTurnComplete() {
  process.stdout.write("\n");
}

export function printToolStart(name, input) {
  const inputStr = input ? ` ${GRAY}${JSON.stringify(input)}${RESET}` : "";
  process.stdout.write(`\n  ${YELLOW}┃${RESET} ${DIM}${name}${RESET}${inputStr}\n`);
}

export function printToolResult(name, output, isError) {
  const color = isError ? RED : GREEN;
  const prefix = `  ${color}┃${RESET} `;
  if (output) {
    const lines = output.split("\n");
    const show = lines.slice(0, 20);
    for (const l of show) {
      process.stdout.write(`${prefix}${l}\n`);
    }
    if (lines.length > 20) {
      process.stdout.write(`${prefix}${GRAY}... ${lines.length - 20} more lines${RESET}\n`);
    }
  }
  process.stdout.write("\n");
}

export function printSystemMessage(message) {
  process.stdout.write(`${GRAY}${message}${RESET}\n`);
}

export function printError(message) {
  process.stdout.write(`${RED}Error: ${message}${RESET}\n`);
}

export function printUserMessage(text) {
  process.stdout.write(`${CLEAR_LINE}${GRAY}❯${RESET} ${text}\n`);
}

// --- Redraw input (for raw mode keystroke rendering) ---

export function redrawInput(text) {
  process.stdout.write(`${CLEAR_LINE}${GRAY}❯${RESET} ${text}`);
}

// --- Spinner ---

export function startSpinner() {
  if (spinnerInterval) return;
  let idx = Math.floor(Math.random() * COOKING_WORDS.length);
  const render = () => {
    const word = COOKING_WORDS[idx % COOKING_WORDS.length];
    process.stdout.write(`${CLEAR_LINE}  ${YELLOW}*${RESET} ${DIM}${word}...${RESET}`);
    idx++;
  };
  render();
  spinnerInterval = setInterval(render, 2000);
}

export function stopSpinner() {
  if (!spinnerInterval) return;
  clearInterval(spinnerInterval);
  spinnerInterval = null;
  process.stdout.write(`${CLEAR_LINE}`);
}
