// @ts-check
import { acceptanceCriteria, daysInStage, looksLikeUserStory, startProblem, USER_STORY_WARNING } from "./rules.js";
import { query } from "kagan/database";
import * as threads from "kagan/threads";
import { log } from "kagan/host";
import { backlogRank, handoffSources } from "./model.js";
import { boardRules, handoffRecord, readThread, ready, ticket, ticketRow } from "./store.js";

export async function board(projectIds) {
  await ready();
  if (!projectIds.length) return { tickets: [], loose: [] };
  const projectMarks = projectIds.map(() => "?").join(", ");
  const rows = await query(`SELECT * FROM ticket WHERE project_id IN (${projectMarks})`, projectIds);
  const ids = rows.map(row => String(row.id));
  const ticketMarks = ids.map(() => "?").join(", ");
  const [links, handoffs, handoffRows, blocks] = ids.length
    ? await Promise.all([
      query(`SELECT * FROM ticket_thread WHERE ticket_id IN (${ticketMarks})`, ids),
      query(`SELECT * FROM handoff WHERE ticket_id IN (${ticketMarks})`, ids),
      query(`SELECT ticket_id, thread_id, comment_id FROM handoff_source WHERE ticket_id IN (${ticketMarks})`, ids),
      query(`SELECT blocked_id, blocker_id FROM ticket_block WHERE blocked_id IN (${ticketMarks})`, ids),
    ])
    : [[], [], [], []];
  const byId = new Map();
  for (const id of new Set(links.map(link => String(link.thread_id)))) {
    // A deleted thread is unlinked by its event; a host failure is logged but does not fail the board.
    const thread = await readThread(id).catch((error) => { log("warn", `Couldn't read thread ${id}: ${error}`); return null; });
    if (thread) byId.set(id, thread);
  }
  const tickets = rows.map(row => {
    const t = ticket(row);
    const own = links.filter(link => link.ticket_id === t.id);
    const live = own.map(link => byId.get(link.thread_id)).filter(thread => thread && thread.archivedAt === null && thread.visibility !== "hidden");
    // Threads a Done move archived come back when the ticket leaves Done; they are shown, not counted as live.
    const archivedByDone = own.filter(link => Number(link.archived_by_done) === 1).map(link => byId.get(link.thread_id)).filter(thread => thread && thread.visibility !== "hidden");
    const job = handoffs.find(item => item.ticket_id === t.id);
    const jobSources = handoffRows.filter(item => item.ticket_id === t.id);
    return { ...t, threads: live, archivedByDone, links: own.map(link => ({ threadId: String(link.thread_id), persona: link.persona })), handoff: job ? { ...handoffRecord(job), done: jobSources.filter(item => item.comment_id != null).length, total: jobSources.length } : null, updatedAt: Math.max(t.updatedAt, ...live.map(thread => thread.updatedAt)), blockedBy: [], blocks: [] };
  });
  const ticketById = new Map(tickets.map(t => [t.id, t]));
  const refOf = (id) => {
    const t = ticketById.get(String(id));
    return t ? { id: t.id, number: t.number, title: t.title, stage: t.stage, projectId: t.projectId } : null;
  };
  for (const block of blocks) {
    const blocked = ticketById.get(String(block.blocked_id));
    const blocker = refOf(block.blocker_id);
    const waiting = refOf(block.blocked_id);
    if (blocked && blocker) blocked.blockedBy.push(blocker);
    const blockerTicket = ticketById.get(String(block.blocker_id));
    if (blockerTicket && waiting) blockerTicket.blocks.push(waiting);
  }
  const linked = new Set(links.map(link => link.thread_id));
  const loose = [];
  for (const projectId of projectIds) for (const thread of await threads.list({ projectId, archived: false })) {
    if (thread.visibility !== "hidden" && !linked.has(thread.id)) loose.push(thread);
  }
  return { tickets, loose };
}

export async function detail(id) {
  const own = await ticketRow(id);
  const data = await board([own.projectId]);
  const found = data.tickets.find(t => t.id === id);
  if (!found) throw new Error(`No ticket ${id}`);
  const rules = await boardRules(found.projectId);
  const days = found.stage === "in-progress" || found.stage === "review" ? daysInStage(found.stageAt) : null;
  const parent = found.parentId ? data.tickets.find(t => t.id === found.parentId) : null;
  return {
    ...found,
    comments: (await query("SELECT * FROM comment WHERE ticket_id = ? ORDER BY created_at, id", [id])).map(row => ({
      id: String(row.id), body: String(row.body), threadId: row.thread_id == null ? null : String(row.thread_id),
      persona: row.persona == null ? null : String(row.persona), githubLogin: row.github_login == null ? null : String(row.github_login),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    })),
    subTickets: data.tickets.filter(t => t.parentId === id).sort((a, b) => a.number - b.number),
    parent: parent ? { id: parent.id, number: parent.number, title: parent.title, stage: parent.stage } : null,
    acceptanceCriteria: acceptanceCriteria(found.description),
    startProblem: found.stage === "backlog" ? startProblem(found) : null,
    daysInStage: days,
    ageWarnDays: rules.ageWarnDays,
    titleWarning: looksLikeUserStory(found.title) ? USER_STORY_WARNING : null,
    wip: rules.wipLimit !== null ? { count: data.tickets.filter(t => t.stage === "in-progress").length, limit: rules.wipLimit } : null,
    backlogRank: backlogRank(data.tickets, id),
    stageHistory: (await query("SELECT stage, resolution, at FROM stage_history WHERE ticket_id = ? ORDER BY at, id", [id]))
      .map(row => ({ stage: String(row.stage), resolution: String(row.resolution), at: Number(row.at) })),
    handoffSources: handoffSources(found),
  };
}

