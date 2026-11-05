// @ts-check
// Delivery rules shared by the CLI, the store and the board.

export const KINDS = ["story", "bug", "task"];
export const BUG_TEMPLATE = "## Steps to reproduce\n\n1. \n\n## Expected\n\n\n## Actual\n\n\n## Environment\n\n";
const BUG_SECTIONS = ["Steps to reproduce", "Expected", "Actual"];
export const AGE_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

/** @param {string} value @param {boolean} [allowNone] */
export function parseKind(value, allowNone = false) {
  if (allowNone && value === "none") return null;
  if (!KINDS.includes(value)) throw new Error("Kind must be story, bug, or task");
  return value;
}

/** @param {string} description @param {string} name */
export function section(description, name) {
  const lines = String(description ?? "").split(/\r?\n/);
  const wanted = name.toLocaleLowerCase();
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index]);
    if (!heading || heading[2].toLocaleLowerCase() !== wanted) continue;
    const level = heading[1].length;
    const body = [];
    for (const line of lines.slice(index + 1)) {
      const next = /^(#{1,6})\s/.exec(line);
      if (next && next[1].length <= level) break;
      body.push(line);
    }
    return body.join("\n");
  }
  return null;
}

/** @param {string} description */
export function acceptanceCriteria(description) {
  const body = section(description, "Acceptance criteria");
  if (body === null) return null;
  let done = 0;
  let total = 0;
  for (const line of body.split("\n")) {
    const item = /^\s*[-*+]\s+\[([ xX])\]\s+\S/.exec(line);
    if (!item) continue;
    total += 1;
    if (item[1] !== " ") done += 1;
  }
  return { done, total };
}

/** @param {{kind: string | null, description: string}} ticket */
export function startProblem(ticket) {
  if (ticket.kind === "story") {
    const criteria = acceptanceCriteria(ticket.description);
    if (!criteria) return "no \"## Acceptance criteria\" list";
    if (criteria.total === 0) return "its \"## Acceptance criteria\" section has no \"- [ ]\" items";
    return null;
  }
  if (ticket.kind === "bug") {
    const missing = BUG_SECTIONS.filter(name => !section(ticket.description, name)?.replace(/^\s*\d+\.\s*$/gm, "").trim());
    return missing.length ? `a bug needs "## ${missing.join("\", \"## ")}" filled in` : null;
  }
  return null;
}

/** @param {string} from @param {string} to @param {string} [resolution] */
export function isGated(from, to, resolution = "done") {
  return from === "backlog" && to !== "backlog" && !(to === "done" && resolution === "wont-do");
}

/** A new ticket has no description yet, so only Backlog or a kind that needs nothing can take one. */
export function newStartProblem(kind, stage) {
  return stage === "backlog" ? null : startProblem({ kind, description: "" });
}

/** @param {string} title */
export function looksLikeUserStory(title) {
  return /^\s*as an?\s/i.test(String(title ?? ""));
}
export const USER_STORY_WARNING = "Titles that start with \"As a\" read as a user story. Keep the title short and put the story in the description.";

/** @param {number | null} stageAt @param {number} [now] */
export function daysInStage(stageAt, now = Date.now()) {
  return stageAt === null || stageAt === undefined ? null : Math.max(0, Math.floor((now - stageAt) / DAY_MS));
}

