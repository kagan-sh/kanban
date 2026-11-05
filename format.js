import { acceptanceCriteria, looksLikeUserStory, USER_STORY_WARNING } from "./rules.js";
// @ts-check

/** Never a refusal: imported GitHub titles often read this way. */
export function noteTitle(result) {
  if (!result || typeof result !== "object" || typeof result.title !== "string" || result.titleWarning) return result;
  if (!looksLikeUserStory(result.title)) return result;
  return { ...result, titleWarning: USER_STORY_WARNING };
}

/** `--json` is one JSON document. Without it, the JSON stays for agents and the prose follows for people. */
export function formatResult(result, json) {
  if (result === undefined) return json ? "null\n" : "Done\n";
  const value = noteTitle(result);
  if (json) return `${JSON.stringify(value)}\n`;
  const warning = value && typeof value === "object" && typeof value.warning === "string" ? value.warning : "";
  const note = value && typeof value === "object" && typeof value.note === "string" ? value.note : "";
  const lines = prose(value);
  return `${JSON.stringify(value, null, 2)}\n${lines ? `${lines}\n` : ""}${note ? `${note}\n` : ""}${warning ? `${warning}\n` : ""}`;
}

export function prose(result) {
  if (!result || typeof result !== "object") return "";
  if (Array.isArray(result.tickets) && Array.isArray(result.loose)) return boardLines(result);
  if (result.number != null && result.stage) return ticketLines(result);
  if (Object.hasOwn(result, "ageWarnDays")) return rulesLines(result);
  return "";
}

export function boardLines(board) {
  const lines = [...board.tickets].sort((a, b) => a.number - b.number).map(ticket => {
    const threads = (ticket.threads ?? []).length;
    return `${String(ticket.stage).padEnd(12)} #${String(ticket.number).padEnd(4)} ${ticket.title}  [${threads} thread${threads === 1 ? "" : "s"}]`;
  });
  if (board.loose.length) lines.push(`${board.loose.length} loose thread${board.loose.length === 1 ? "" : "s"} not on a ticket`);
  return lines.join("\n") || "No tickets or threads in this project.";
}

export function rulesLines(rules) {
  return [
    `Age warning after ${rules.ageWarnDays} days in In progress or Review`,
    rules.wipLimit === null ? "No work-in-progress limit" : `Work-in-progress limit: ${rules.wipLimit} tickets in In progress`,
  ].join("\n");
}

export function ticketLines(result) {
  const lines = [];
  if (result.kind) lines.push(`Kind: ${result.kind}`);
  if (result.stage === "done" && result.resolution === "wont-do") lines.push("Won't do");
  if (result.backlogRank) lines.push(`Backlog rank ${result.backlogRank.position} of ${result.backlogRank.of}`);
  const counted = Object.hasOwn(result, "acceptanceCriteria") ? result.acceptanceCriteria : null;
  if (counted) lines.push(`Acceptance criteria: ${counted.done} of ${counted.total} done`);
  else if (result.kind === "story" && Object.hasOwn(result, "acceptanceCriteria")) lines.push("Acceptance criteria: none");
  else if (result.kind === "story" && typeof result.description === "string") {
    const live = acceptanceCriteria(result.description);
    if (live) lines.push(`Acceptance criteria: ${live.done} of ${live.total} done`);
  }
  if (result.startProblem) lines.push(`Can't leave Backlog yet: ${result.startProblem}.`);
  if (typeof result.daysInStage === "number") {
    const where = result.stage === "in-progress" ? "In progress" : `In ${result.stage}`;
    const stale = typeof result.ageWarnDays === "number" && result.daysInStage > result.ageWarnDays;
    lines.push(`${where} for ${result.daysInStage} day${result.daysInStage === 1 ? "" : "s"}${stale ? `, past the ${result.ageWarnDays}-day warning` : ""}`);
  }
  if (result.wip) lines.push(`In progress holds ${result.wip.count} of a limit of ${result.wip.limit}${result.wip.count > result.wip.limit ? ", over the limit" : ""}`);
  if (result.titleWarning) lines.push(result.titleWarning);
  if (result.parent) lines.push(`Sub-ticket of #${result.parent.number} ${result.parent.title} (${result.parent.stage})`);
  for (const blocker of result.blockedBy ?? []) if (blocker?.number != null) lines.push(`Blocked by #${blocker.number} ${blocker.title} (${blocker.stage})`);
  for (const blocked of result.blocks ?? []) if (blocked?.number != null) lines.push(`Blocks #${blocked.number} ${blocked.title} (${blocked.stage})`);
  for (const child of result.subTickets ?? []) {
    const blocked = (child.blockedBy ?? []).some(ref => ref.stage !== "done");
    const note = blocked ? "blocked" : child.stage === "done" ? "" : "ready";
    lines.push(`  Sub-ticket #${child.number} ${child.title} (${child.stage}${note ? `, ${note}` : ""})`);
  }
  for (const thread of result.threads ?? []) lines.push(`  ${thread.id}  ${String(thread.status).padEnd(8)} ${thread.title}`);
  for (const comment of result.comments ?? []) {
    const who = comment.threadId ? `${comment.persona ?? "thread"} ${comment.threadId}` : comment.githubLogin ? `@${comment.githubLogin} on GitHub` : "You";
    lines.push("", `Comment by ${who}, ${new Date(comment.createdAt).toISOString()}:`, comment.body);
  }
  return lines.join("\n");
}
