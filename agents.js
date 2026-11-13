// @ts-check

// The agents kagan bundles a mark for, by command name, as its thread picker draws them.
const MARKS = {
  claude: "agents/claude.svg",
  codex: "agents/codex.svg",
  gemini: "agents/gemini.svg",
  copilot: "agents/copilot.svg",
  opencode: "agents/opencode.svg",
  "cursor-agent": "agents/cursor.svg",
  kimi: "agents/kimi.svg",
};

/** The program's command name: its first word, without a folder or an extension. */
export function programName(program) {
  const first = String(program ?? "").trim().split(/\s+/)[0] ?? "";
  return first.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? "";
}

/** The bundled mark for the program a thread runs, or null when kagan has none. */
export function agentMark(program) {
  return MARKS[programName(program)] ?? null;
}
