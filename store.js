// @ts-check
import { migrate, query, run, transaction } from "kagan/database";
import * as threads from "kagan/threads";
import { stage, text } from "./model.js";

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let migrated;
let chain = Promise.resolve();
let generation = 0;
const waiters = [];

/** @template T @param {() => Promise<T>} fn */
export function serial(fn) {
  const result = chain.then(fn);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

export function ready() {
  return migrated ??= migrate([
    `CREATE TABLE ticket (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('backlog','in-progress','review','done')), description TEXT NOT NULL DEFAULT '', proposed INTEGER NOT NULL DEFAULT 0, issue_repo TEXT, issue_number INTEGER, issue_url TEXT, environment_id TEXT, pending_stage TEXT, parent_id TEXT REFERENCES ticket(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id, number))`,
    `CREATE UNIQUE INDEX ticket_issue ON ticket(project_id, issue_repo COLLATE NOCASE, issue_number) WHERE issue_repo IS NOT NULL`,
    `CREATE TABLE ticket_thread (thread_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE, persona TEXT, archived_by_done INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE comment (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE, body TEXT NOT NULL, thread_id TEXT, persona TEXT, github_login TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX comment_ticket ON comment(ticket_id, created_at)`,
    `CREATE TABLE handoff (ticket_id TEXT PRIMARY KEY REFERENCES ticket(id) ON DELETE CASCADE, persona TEXT, prompt TEXT NOT NULL, consolidate INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, next_thread_id TEXT)`,
    `CREATE TABLE handoff_source (ticket_id TEXT REFERENCES handoff(ticket_id) ON DELETE CASCADE, thread_id TEXT NOT NULL, baseline TEXT, queued_id TEXT, asked_at INTEGER NOT NULL, comment_id TEXT, PRIMARY KEY(ticket_id, thread_id))`,
    `CREATE TABLE linked_repo (project_id TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(project_id, repo))`,
    `CREATE TABLE unlinked_repo (project_id TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY(project_id, repo))`,
    `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ]);
}

export function touch() {
  generation++;
  for (const resolve of waiters.splice(0)) resolve(generation);
}

export function currentGeneration() { return generation; }
export function nextChange(since) {
  return since !== generation ? Promise.resolve(generation) : new Promise(resolve => waiters.push(resolve));
}

export async function kvGet(key) {
  await ready();
  return (await query("SELECT value FROM kv WHERE key = ?", [key]))[0]?.value ?? null;
}
export async function kvSet(key, value) {
  await ready();
  await run("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

function ticket(row) {
  return { id: String(row.id), projectId: String(row.project_id), number: Number(row.number), title: String(row.title), stage: String(row.stage), description: String(row.description), proposed: Boolean(row.proposed), pendingStage: row.pending_stage, parentId: row.parent_id, environmentId: row.environment_id, issue: row.issue_repo ? { repo: row.issue_repo, number: row.issue_number, url: row.issue_url } : null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

export async function ticketRow(id) {
  await ready();
  const rows = await query("SELECT * FROM ticket WHERE id = ?", [id]);
  if (!rows.length) throw new Error(`No ticket ${id}`);
  return ticket(rows[0]);
}

export async function ticketOfThread(id) {
  await ready();
  const rows = await query("SELECT ticket_id FROM ticket_thread WHERE thread_id = ?", [id]);
  return rows.length ? ticketRow(String(rows[0].ticket_id)) : null;
}

export async function resolveTicket(ref, context) {
  if (!ref) {
    const own = context.threadId ? await ticketOfThread(context.threadId) : null;
    if (!own) throw new Error("Name a ticket or attach this thread to one");
    return own;
  }
  if (/^#[1-9]\d*$/.test(ref)) {
    await ready();
    const rows = await query("SELECT * FROM ticket WHERE project_id = ? AND number = ?", [context.projectId ?? "", Number(ref.slice(1))]);
    if (!rows.length) throw new Error(`No ticket ${ref} in this project`);
    return ticket(rows[0]);
  }
  if (ref.startsWith("tkt_")) return ticketRow(ref);
  const own = await ticketOfThread(ref);
  if (!own) throw new Error(`${ref} is not on a ticket`);
  return own;
}

export function board(projectIds) {
  return serial(async () => {
    await ready();
    const rows = await query("SELECT * FROM ticket", []);
    const links = await query("SELECT * FROM ticket_thread", []);
    const handoffs = await query("SELECT * FROM handoff", []);
    const byId = new Map();
    for (const id of new Set([...links.map(l => String(l.thread_id))])) {
      try { byId.set(id, await threads.get(id)); } catch { /* Deleted threads are unlinked by events. */ }
    }
    const tickets = rows.map(row => {
      const t = ticket(row);
      const own = links.filter(l => l.ticket_id === t.id);
      const live = own.map(l => byId.get(l.thread_id)).filter(t => t && t.archivedAt === null && t.visibility !== "hidden");
      return { ...t, threads: live, links: own.map(l => ({ threadId: String(l.thread_id), persona: l.persona })), handoff: handoffs.find(h => h.ticket_id === t.id) ?? null, updatedAt: Math.max(t.updatedAt, ...live.map(t => t.updatedAt)) };
    });
    const linked = new Set(links.map(l => l.thread_id));
    const loose = [];
    for (const projectId of projectIds) for (const t of await threads.list({ projectId, archived: false })) {
      if (t.visibility !== "hidden" && !linked.has(t.id)) loose.push(t);
    }
    return { tickets: tickets.filter(t => projectIds.includes(t.projectId)), loose };
  });
}

export async function detail(id) {
  const own = await ticketRow(id);
  const data = await board([own.projectId]);
  return { ...data.tickets.find(t => t.id === id), comments: await query("SELECT * FROM comment WHERE ticket_id = ? ORDER BY created_at, id", [id]), subTickets: data.tickets.filter(t => t.parentId === id) };
}

export function createTicket(input) { return serial(() => createTicketInner(input)); }
export async function createTicketInner(input) {
  await ready();
  const title = text(input.title, "Title");
  const wanted = stage(input.stage ?? "backlog");
  if (wanted === "done") throw new Error("Create a ticket before moving it to Done");
  await threads.project(input.projectId);
  if (input.threadId) await threads.get(input.threadId);
  const id = newId("tkt");
  const now = Date.now();
  const statements = [{ sql: `INSERT INTO ticket(id, project_id, number, title, stage, description, proposed, issue_repo, issue_number, issue_url, created_at, updated_at) SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM ticket WHERE project_id = ?`, params: [id, input.projectId, title, wanted, input.description ?? "", input.proposed ? 1 : 0, input.issue?.repo ?? null, input.issue?.number ?? null, input.issue?.url ?? null, now, now, input.projectId] }];
  if (input.threadId) statements.push({ sql: "INSERT INTO ticket_thread(thread_id, ticket_id, persona) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ticket_id = excluded.ticket_id, persona = excluded.persona, archived_by_done = 0", params: [input.threadId, id, input.persona ?? null] });
  await transaction(statements);
  touch();
  return ticketRow(id);
}

export function attach(id, threadId, persona = null) { return serial(() => attachInner(id, threadId, persona)); }
export async function attachInner(id, threadId, persona = null) {
  const t = await ticketRow(id);
  if (t.proposed || t.stage === "done") throw new Error("Accept or reopen the ticket before attaching a thread");
  await threads.get(threadId);
  await run("INSERT INTO ticket_thread(thread_id, ticket_id, persona) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ticket_id = excluded.ticket_id, persona = excluded.persona, archived_by_done = 0", [threadId, id, persona]);
  touch();
}
export function detach(threadId) {
  return serial(async () => { await ready(); await run("DELETE FROM ticket_thread WHERE thread_id = ?", [threadId]); touch(); });
}

export function editTicket(id, fields) {
  return serial(async () => {
    const t = await ticketRow(id);
    await run("UPDATE ticket SET title = ?, description = ?, updated_at = ? WHERE id = ?", [text(fields.title ?? t.title, "Title"), fields.description ?? t.description, Date.now(), id]);
    touch();
  });
}

export function acceptTicket(id) {
  return serial(async () => { await ticketRow(id); await run("UPDATE ticket SET proposed = 0 WHERE id = ?", [id]); touch(); });
}
export function dismissTicket(id) {
  return serial(async () => { await ticketRow(id); await run("DELETE FROM ticket WHERE id = ? AND proposed = 1", [id]); touch(); });
}
export function proposeMove(id, wanted) {
  return serial(async () => { await ticketRow(id); await run("UPDATE ticket SET pending_stage = ? WHERE id = ?", [stage(wanted), id]); touch(); });
}
export function dismissMove(id) {
  return serial(async () => { await ticketRow(id); await run("UPDATE ticket SET pending_stage = NULL WHERE id = ?", [id]); touch(); });
}

export function moveTicket(id, wanted) {
  return serial(async () => {
    stage(wanted);
    const t = await ticketRow(id);
    if (t.proposed) throw new Error("Accept the proposed ticket first");
    const links = await query("SELECT * FROM ticket_thread WHERE ticket_id = ?", [id]);
    if (wanted === "done" && t.stage !== "done") {
      for (const link of links) {
        const thread = await threads.get(String(link.thread_id)).catch(() => null);
        if (!thread || thread.archivedAt !== null) continue;
        await threads.archive(thread.id);
        await run("UPDATE ticket_thread SET archived_by_done = 1 WHERE thread_id = ?", [thread.id]);
      }
      await run("DELETE FROM handoff WHERE ticket_id = ?", [id]);
    }
    if (t.stage === "done" && wanted !== "done") {
      const restore = links.filter(l => l.archived_by_done);
      for (const link of restore) {
        const thread = await threads.get(String(link.thread_id)).catch(() => null);
        if (!thread) { await run("DELETE FROM ticket_thread WHERE thread_id = ?", [String(link.thread_id)]); continue; }
        if (thread.environmentId) {
          const env = await threads.environment(thread.environmentId);
          if (env.status === "destroyed" || env.status === "error") await threads.restoreEnvironment(thread.id);
        }
        await threads.unarchive(thread.id);
      }
      await run("UPDATE ticket_thread SET archived_by_done = 0 WHERE ticket_id = ?", [id]);
    }
    await run("UPDATE ticket SET stage = ?, pending_stage = NULL, updated_at = ? WHERE id = ?", [wanted, Date.now(), id]);
    touch();
    return ticketRow(id);
  });
}

export function setParent(id, parentId) {
  return serial(async () => {
    const t = await ticketRow(id);
    let walk = parentId;
    while (walk) {
      if (walk === id) throw new Error("A ticket cannot be its own ancestor");
      const parent = await ticketRow(walk);
      if (parent.projectId !== t.projectId || parent.proposed || t.proposed) throw new Error("Sub-tickets need accepted tickets in the same project");
      walk = parent.parentId;
    }
    await run("UPDATE ticket SET parent_id = ? WHERE id = ?", [parentId, id]);
    touch();
  });
}

export function addComment(id, input) { return serial(() => addCommentInner(id, input)); }
export async function addCommentInner(id, input) {
  await ticketRow(id);
  const body = text(input.body, "Comment", 100000);
  const commentId = newId("cmt");
  const now = Date.now();
  await transaction([
    { sql: "INSERT INTO comment VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params: [commentId, id, body, input.threadId ?? null, input.persona ?? null, input.githubLogin ?? null, now, now] },
    { sql: "UPDATE ticket SET updated_at = ? WHERE id = ?", params: [now, id] },
  ]);
  touch();
  return commentId;
}
export function editComment(id, body) {
  return serial(async () => { await ready(); await run("UPDATE comment SET body = ?, updated_at = ? WHERE id = ?", [text(body, "Comment", 100000), Date.now(), id]); touch(); });
}
export function deleteComment(id) {
  return serial(async () => { await ready(); await run("DELETE FROM comment WHERE id = ?", [id]); touch(); });
}
export function deleteTicket(id) {
  return serial(async () => {
    await ticketRow(id);
    for (const link of await query("SELECT thread_id FROM ticket_thread WHERE ticket_id = ?", [id])) {
      const t = await threads.get(String(link.thread_id)).catch(() => null);
      if (t && t.archivedAt === null) await threads.archive(t.id);
    }
    await run("DELETE FROM ticket WHERE id = ?", [id]);
    touch();
  });
}

export async function listRepos(projectId) {
  await ready();
  return (await query("SELECT repo FROM linked_repo WHERE project_id = ? ORDER BY repo", [projectId])).map(r => String(r.repo));
}
export function linkRepo(projectId, repo) {
  return serial(async () => {
    await ready();
    await transaction([{ sql: "INSERT OR IGNORE INTO linked_repo VALUES (?, ?)", params: [projectId, repo] }, { sql: "DELETE FROM unlinked_repo WHERE project_id = ? AND repo = ?", params: [projectId, repo] }]);
    touch();
  });
}
export function unlinkRepo(projectId, repo) {
  return serial(async () => {
    await ready();
    await transaction([{ sql: "DELETE FROM linked_repo WHERE project_id = ? AND repo = ?", params: [projectId, repo] }, { sql: "INSERT OR IGNORE INTO unlinked_repo VALUES (?, ?)", params: [projectId, repo] }]);
    touch();
  });
}
export async function autoLinkAllowed(projectId, repo) {
  await ready();
  return !(await query("SELECT repo FROM linked_repo WHERE project_id = ? AND repo = ? UNION SELECT repo FROM unlinked_repo WHERE project_id = ? AND repo = ?", [projectId, repo, projectId, repo])).length;
}
