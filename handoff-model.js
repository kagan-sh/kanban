// @ts-check

export const HANDOFF_MAX = 8000;
export const HANDOFF_SECTIONS = ["Goal", "Completed", "Verified", "Decisions", "Next", "Blocked", "Safe to Pick Up"];
const REQUIRED_HANDOFF = ["Goal", "Verified"];

/** The newest `## Handoff` block, plus whether it carries the required sections. */
export function extractHandoff(output) {
  const headings = [...String(output ?? "").matchAll(/^##[ \t]+Handoff\b.*$/gim)];
  const start = headings.at(-1)?.index;
  if (start !== undefined) {
    const block = String(output).slice(start).trim();
    const found = new Set([...block.matchAll(/^###[ \t]+(.+?)[ \t]*$/gm)]
      .map(match => HANDOFF_SECTIONS.find(name => name.toLowerCase() === match[1].toLowerCase()))
      .filter(Boolean));
    if (REQUIRED_HANDOFF.every(name => found.has(name))) return { text: block.slice(0, HANDOFF_MAX), structured: true };
  }
  return { text: String(output ?? "").trim().slice(0, HANDOFF_MAX), structured: false };
}

/** The text under one `###` section of a handoff, or null when it has none. */
export function handoffSection(body, name) {
  const match = new RegExp(`^###[ \\t]+${name}[ \\t]*$([\\s\\S]*?)(?=^#{2,3}[ \\t]|(?![\\s\\S]))`, "im").exec(String(body ?? ""));
  const text = match?.[1].trim();
  return text ? text : null;
}

/** The prompt the successor starts from: what it continues, then the handoff itself. */
export function successorPrompt(ticket, handoff) {
  return [
    `Continue the work on ticket #${ticket.number} "${ticket.title}" from the person's board.`,
    "Earlier threads handed off; their handoff follows. Treat its decisions as in effect unless the person says otherwise, and check claims before relying on them.",
    "",
    handoff,
  ].join("\n");
}

/** True when the successor already exists, so a retry finishes it instead of spawning another. */
export function handoffResumes(job) {
  return Boolean(job?.nextThreadId) && job.status !== "awaiting-archive";
}
