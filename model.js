// @ts-check

export const STAGES = ["backlog", "in-progress", "review", "done"];
export const TITLES = { backlog: "Backlog", "in-progress": "In progress", review: "Review", done: "Done" };
export const PERSONAS = { backlog: "intake", "in-progress": "implementer", review: "reviewer-default", done: "ship" };
export const GLYPHS = { backlog: "◌", "in-progress": "◐", review: "⊙", done: "●" };
export const NEXT = { backlog: "in-progress", "in-progress": "review", review: "done", done: null };

export function stage(value) {
  if (!STAGES.includes(value)) throw new Error(`Unknown stage ${value}`);
  return value;
}

export function text(value, name, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
  return value.trim();
}

export function attention(thread) {
  if (thread.status === "error") return "Failed";
  if ((thread.lastReadAt ?? 0) < thread.latestAttentionAt) return "New reply";
  return null;
}

export function needsYou(ticket) {
  const handoff = ticket.handoff;
  const failed = Boolean(handoff && (handoff.status === "failed" || handoff.error));
  return Boolean(ticket.proposed || ticket.pendingStage || failed || ticket.threads.some(attention));
}

export function target(threads) {
  return [...threads].sort((a, b) => Number(Boolean(attention(b))) - Number(Boolean(attention(a))) || b.updatedAt - a.updatedAt)[0] ?? null;
}

export function matches(ticket, search) {
  const words = `#${ticket.number} ${ticket.title} ${ticket.threads.map(t => t.title).join(" ")}`.toLowerCase();
  return words.includes(search.trim().toLowerCase());
}

export const KINDS = ["story", "bug", "task"];
export const AGE_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
export const BUG_TEMPLATE = "## Steps to reproduce\n\n1. \n\n## Expected\n\n\n## Actual\n\n\n## Environment\n\n";
const BUG_SECTIONS = ["Steps to reproduce", "Expected", "Actual"];
const WORKING = new Set(["starting", "active", "stopping"]);

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

/** What a move must ask before it changes the ticket. Warnings still come from the move itself. */
export function planMove(ticket, stage, resolution = "done") {
  if (!STAGES.includes(stage)) return { action: "refuse", reason: `Unknown stage ${stage}` };
  if (resolution !== "done" && resolution !== "wont-do") return { action: "refuse", reason: "Unknown resolution" };
  if (resolution === "wont-do" && stage !== "done") return { action: "refuse", reason: "Won't do only applies to a move to Done" };
  if (ticket.stage === stage && (stage !== "done" || (ticket.resolution ?? "done") === resolution)) return { action: "ignore" };
  const problem = isGated(ticket.stage, stage, resolution) ? startProblem(ticket) : null;
  if (problem) return { action: "refuse", reason: `Can't start #${ticket.number}: ${problem}.` };
  const live = (ticket.threads ?? []).length > 0;
  if (stage === "done" && ticket.stage !== "done" && live) return { action: "confirm-done", stage, resolution };
  if (resolution !== "wont-do" && (stage === "in-progress" || stage === "review") && live) return { action: "handoff", stage, resolution };
  return { action: "move", stage, resolution };
}

/**
 * A handoff that already spawned its successor only archives sources that are still live.
 * @param {{ sources?: string[], nextThreadId?: string | null, threads: Record<string, { onTicket?: boolean, archived?: boolean }> }} input
 */
export function planHandoff(input) {
  const ids = [...new Set(input.sources ?? [])];
  const nextThreadId = input.nextThreadId || null;
  if (nextThreadId) {
    const archive = ids.filter(id => input.threads[id]?.onTicket && !input.threads[id]?.archived);
    return { action: "resume", nextThreadId, archive };
  }
  if (!ids.length || ids.length > 50) return { action: "refuse", reason: "Pick between 1 and 50 source threads", archive: [] };
  for (const id of ids) {
    const thread = input.threads[id];
    if (!thread?.onTicket) return { action: "refuse", reason: "Every source must be on the ticket", archive: [] };
    if (thread.archived) return { action: "refuse", reason: "Every source must be live", archive: [] };
  }
  return { action: "spawn", archive: ids };
}

/** Spawn saves the successor before any source is archived, so a retry can finish the cleanup. */
export function handoffSteps(plan) {
  if (plan.action === "resume") return ["archive"];
  if (plan.action === "spawn") return ["comment", "spawn", "save-next", "archive"];
  return [];
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

/** @param {{proposed: boolean, rank: number | null, number: number}} a @param {{proposed: boolean, rank: number | null, number: number}} b @param {(a: any, b: any) => number} [tie] */
export function backlogOrder(a, b, tie = () => 0) {
  return Number(b.proposed) - Number(a.proposed) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || tie(a, b) || a.number - b.number;
}

/** @param {{rank: number | null, number: number}} a @param {{rank: number | null, number: number}} b */
export function rankOrder(a, b) {
  return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.number - b.number;
}

/** @param {readonly {id: string, rank: number | null}[]} others @param {{top?: true, bottom?: true, before?: string, after?: string}} place */
export function rankFor(others, place) {
  const ranks = others.map(item => item.rank).filter(rank => rank !== null);
  if ("top" in place && place.top) return ranks.length ? Math.min(...ranks) - 1 : 1;
  if ("bottom" in place && place.bottom) return ranks.length ? Math.max(...ranks) + 1 : 1;
  const anchorId = "before" in place && place.before ? place.before : place.after;
  const at = others.findIndex(item => item.id === anchorId);
  if (at < 0) throw new Error("That ticket is not in this Backlog.");
  const anchor = others[at].rank;
  if (anchor === null) return null;
  const neighbour = others[at + ("before" in place && place.before ? -1 : 1)]?.rank;
  if (neighbour === undefined) return anchor + ("before" in place && place.before ? -1 : 1);
  if (neighbour === null) return null;
  const middle = (anchor + neighbour) / 2;
  return middle === anchor || middle === neighbour ? null : middle;
}

/** @param {any[]} tickets @param {string} stage @param {string} boardProjectId @param {string[]} shownIds */
export function sortColumn(tickets, stage, boardProjectId, shownIds) {
  const tie = (a, b) => {
    const place = (id) => id === boardProjectId ? -1 : Math.max(shownIds.indexOf(id), 0);
    return place(a.projectId) - place(b.projectId);
  };
  return [...tickets].sort(stage === "backlog"
    ? (a, b) => backlogOrder(a, b, tie)
    : (a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.updatedAt - a.updatedAt || a.number - b.number);
}

/** @param {any} ticket */
export function openBlockers(ticket) {
  return (ticket.blockedBy ?? []).filter(ref => ref.stage !== "done");
}

/** @param {readonly any[]} tickets @param {string} ticketId @param {string} blockerId */
export function canBlock(tickets, ticketId, blockerId) {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const ticket = byId.get(ticketId);
  const blocker = byId.get(blockerId);
  if (!ticket || !blocker || ticket.id === blocker.id || ticket.projectId !== blocker.projectId || ticket.proposed || blocker.proposed) return false;
  const seen = new Set();
  const waiting = [blocker.id];
  for (let id = waiting.pop(); id !== undefined; id = waiting.pop()) {
    if (id === ticket.id) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    waiting.push(...(byId.get(id)?.blockedBy ?? []).map(ref => ref.id));
  }
  return true;
}

/** @param {readonly any[]} children */
export function subTicketLine(children) {
  if (!children.length) return null;
  const wont = children.filter(child => child.stage === "done" && child.resolution === "wont-do").length;
  const done = children.filter(child => child.stage === "done" && child.resolution !== "wont-do").length;
  const noun = children.length === 1 ? "sub-ticket" : "sub-tickets";
  return `${done} of ${children.length} ${noun} done${wont ? ` · ${wont} won't do` : ""}`;
}

/** Thread status from `threads.list` only. Idle tickets stay quiet. Pending is a status, not a model. */
export function threadStatusLine(threads) {
  let working = 0;
  let pending = 0;
  let need = 0;
  for (const thread of threads ?? []) {
    if (WORKING.has(thread.status)) working += 1;
    else if (thread.status === "pending") pending += 1;
    if (attention(thread)) need += 1;
  }
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (pending) parts.push(`${pending} pending`);
  if (need) parts.push(`${need} ${need === 1 ? "needs" : "need"} you`);
  return parts.length ? `Thread status · ${parts.join(" · ")}` : null;
}

/** @param {string} description @param {string | null} kind */
export function criteriaLine(description, kind) {
  const counted = acceptanceCriteria(description);
  if (!counted || (counted.total === 0 && kind !== "story")) return null;
  return `AC ${counted.done}/${counted.total}`;
}

/** @param {{title?: string, id?: string}} thread @param {string} search */
export function threadMatches(thread, search) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return `${thread.title ?? ""} ${thread.id ?? ""}`.toLowerCase().includes(needle);
}

/** @param {string} payload */
export function parseDrag(payload) {
  const text = String(payload ?? "");
  const split = text.indexOf(":");
  if (split < 1) return null;
  const kind = text.slice(0, split);
  const id = text.slice(split + 1);
  if ((kind !== "ticket" && kind !== "thread") || !id) return null;
  return { kind, id };
}

const IGNORE = { action: "ignore", label: "" };

/** @param {string} reason */
function refuse(reason) {
  return { action: "refuse", reason, label: reason };
}

/** @param {readonly {id: string, projectId: string, proposed?: boolean, parentId?: string | null}[]} tickets @param {string} childId @param {string} parentId */
export function canNest(tickets, childId, parentId) {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  const child = byId.get(childId);
  const parent = byId.get(parentId);
  if (!child || !parent || child.projectId !== parent.projectId || child.proposed || parent.proposed) return false;
  for (let at = parent; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (at.id === child.id) return false;
  }
  return true;
}

/** @param {string} threadId @param {readonly any[]} tickets @param {readonly any[]} loose */
function projectOfThread(threadId, tickets, loose) {
  for (const ticket of tickets) {
    const thread = (ticket.threads ?? []).find(item => item.id === threadId);
    if (thread) return thread.projectId ?? ticket.projectId;
  }
  return loose.find(thread => thread.id === threadId)?.projectId ?? null;
}

/** @param {any} ticket @param {string} stage */
function moveDecision(ticket, stage) {
  if (ticket.proposed) return refuse("Accept the proposed ticket first");
  if (ticket.stage === stage) return IGNORE;
  const problem = isGated(ticket.stage, stage, "done") ? startProblem(ticket) : null;
  if (problem) return refuse(`Can't start #${ticket.number}: ${problem}.`);
  return { action: "move", id: ticket.id, stage, label: `Drop to move to ${TITLES[stage]}` };
}

/** @param {string} threadId @param {any} card @param {readonly any[]} tickets @param {readonly any[]} loose */
function dropThreadOnCard(threadId, card, tickets, loose) {
  if ((card.threads ?? []).some(thread => thread.id === threadId)) return IGNORE;
  if (card.proposed || card.stage === "done") return refuse("Accept or reopen the ticket before attaching a thread");
  const projectId = projectOfThread(threadId, tickets, loose);
  if (projectId && projectId !== card.projectId) return refuse("Attach a thread from the same project as the ticket");
  return { action: "attach", ticketId: card.id, threadId, label: "Drop to add the thread" };
}

/**
 * A card is the innermost target, so a drop it does not want becomes the column's move.
 * Top and bottom of a Backlog card rank; the middle nests when that is allowed.
 * @param {string} payload @param {"top"|"middle"|"bottom"|null} side @param {any} card @param {readonly any[]} tickets @param {readonly any[]} [loose]
 */
export function dropOnCard(payload, side, card, tickets, loose = []) {
  if (!side) return IGNORE;
  const parsed = parseDrag(payload);
  if (!parsed || !card) return IGNORE;
  if (parsed.kind === "thread") return dropThreadOnCard(parsed.id, card, tickets, loose);
  const dragged = tickets.find(ticket => ticket.id === parsed.id);
  if (!dragged || dragged.id === card.id) return IGNORE;
  if (dragged.proposed) return refuse("Accept the proposed ticket first");
  if (side !== "middle" && dragged.stage === "backlog" && card.stage === "backlog" && dragged.projectId === card.projectId && !card.proposed) {
    const above = side === "top";
    return {
      action: "rank",
      id: dragged.id,
      place: above ? { before: card.id } : { after: card.id },
      label: `Drop to rank it ${above ? "above" : "below"} #${card.number}`,
    };
  }
  if (side === "middle" && canNest(tickets, dragged.id, card.id)) {
    return { action: "nest", id: dragged.id, parentId: card.id, label: "Drop to make it a sub-ticket" };
  }
  return moveDecision(dragged, card.stage);
}

/** @param {string} payload @param {string} stage @param {readonly any[]} tickets */
export function dropOnColumn(payload, stage, tickets) {
  const parsed = parseDrag(payload);
  if (!parsed || !STAGES.includes(stage)) return IGNORE;
  if (parsed.kind === "thread") {
    if (stage === "done") return refuse("Create a ticket before moving it to Done");
    const home = tickets.find(ticket => (ticket.threads ?? []).some(thread => thread.id === parsed.id));
    if (home?.stage === stage) return IGNORE;
    const label = stage === "backlog" ? "Drop to make a ticket" : `Drop to make a ticket in ${TITLES[stage]}`;
    return { action: "create", threadId: parsed.id, stage, label };
  }
  const dragged = tickets.find(ticket => ticket.id === parsed.id);
  if (!dragged) return IGNORE;
  return moveDecision(dragged, stage);
}

/** @param {string} payload @param {readonly any[]} tickets */
export function dropOnLoose(payload, tickets) {
  const parsed = parseDrag(payload);
  if (!parsed || parsed.kind !== "thread") return IGNORE;
  const home = tickets.find(ticket => (ticket.threads ?? []).some(thread => thread.id === parsed.id));
  if (!home) return IGNORE;
  return { action: "detach", threadId: parsed.id, label: "Drop to take it off its ticket" };
}

export function sidebarRows(projects, tickets, live, activeProject, expanded, collapsed, frozen = []) {
  const byId = new Map(live.filter(t => !t.archivedAt && t.visibility !== "hidden").map(t => [t.id, t]));
  const linked = new Set(tickets.flatMap(t => t.links.map(l => l.threadId)));
  const previous = new Map(frozen.map((id, ix) => [id, ix]));
  const rows = [];
  const place = { review: 0, "in-progress": 1, backlog: 2, thread: 3 };
  for (const project of projects) {
    const items = tickets.filter(t => t.projectId === project.id && t.stage !== "done").map(t => {
      const threads = t.links.map(l => byId.get(l.threadId)).filter(Boolean);
      return { id: t.id, ticket: { ...t, threads }, threads, thread: target(threads), depth: 0, place: place[t.stage], needs: needsYou({ ...t, threads }), pinned: threads.some(t => t.pinned), updatedAt: Math.max(t.updatedAt, ...threads.map(t => t.updatedAt)) };
    });
    const listed = new Map(items.map(r => [r.id, r]));
    const children = new Map();
    for (const item of items) {
      const parent = listed.get(item.ticket.parentId);
      if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), item]);
    }
    const family = item => {
      for (const child of children.get(item.id) ?? []) {
        family(child);
        item.needs ||= child.needs;
        item.pinned ||= child.pinned;
        item.updatedAt = Math.max(item.updatedAt, child.updatedAt);
      }
    };
    const roots = items.filter(r => !listed.has(r.ticket.parentId));
    roots.forEach(family);
    const loose = [...byId.values()].filter(t => t.projectId === project.id && !linked.has(t.id)).map(t => ({ id: t.id, thread: t, ticket: null, needs: Boolean(attention(t)), pinned: t.pinned, updatedAt: t.updatedAt, place: place.thread, depth: 0 }));
    if (!items.length && !loose.length && project.id !== activeProject) continue;
    rows.push({ id: project.id, project, needs: [...items, ...loose].filter(r => r.needs).length });
    if (collapsed.has(project.id)) continue;
    const ordered = list => {
      const rank = r => r.needs ? 0 : r.pinned ? 1 : 2 + r.place;
      const natural = [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
      const known = natural.filter(r => previous.has(r.id)).sort((a, b) => previous.get(a.id) - previous.get(b.id));
      let ix = 0;
      return natural.map(r => previous.has(r.id) ? known[ix++] : r);
    };
    const emit = (item, depth) => {
      rows.push({ ...item, depth });
      if (!item.ticket) return;
      if (expanded.has(item.id)) for (const thread of item.threads) rows.push({ id: `child:${thread.id}`, ticket: item.ticket, thread, depth: depth + 1, needs: Boolean(attention(thread)) });
      for (const child of ordered(children.get(item.id) ?? [])) emit(child, depth + 1);
    };
    for (const item of ordered([...roots, ...loose])) emit(item, 0);
  }
  return rows;
}
