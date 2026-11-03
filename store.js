// @ts-check
import { migrate, query, run, transaction } from "kagan/database";
import * as threads from "kagan/threads";
import { stage, text, KINDS, BUG_TEMPLATE, isGated, startProblem, acceptanceCriteria, daysInStage, rankFor, rankOrder, looksLikeUserStory, USER_STORY_WARNING } from "./model.js";

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

// A CHECK on ADD COLUMN is refused, so new databases add the column and the
// script checks the value. Databases that already recorded the CHECK form
// still match that history.
const columnChecks = {
  "ALTER TABLE ticket ADD COLUMN kind TEXT": "ALTER TABLE ticket ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('story', 'bug', 'task'))",
  "ALTER TABLE ticket ADD COLUMN resolution TEXT NOT NULL DEFAULT 'done'": "ALTER TABLE ticket ADD COLUMN resolution TEXT NOT NULL DEFAULT 'done' CHECK (resolution IN ('done', 'wont-do'))",
};

export function ready() {
  const statements = [
    // Fresh installs only. An older incompatible SQLite under
    // ~/.kagan/plugins/dev.kagan.kanban/data/ must be moved aside first.
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
    `ALTER TABLE ticket ADD COLUMN kind TEXT`,
    `ALTER TABLE ticket ADD COLUMN resolution TEXT NOT NULL DEFAULT 'done'`,
    `ALTER TABLE ticket ADD COLUMN stage_at INTEGER`,
    `ALTER TABLE ticket ADD COLUMN rank REAL`,
    `CREATE TABLE ticket_block (blocked_id TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE, blocker_id TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE, PRIMARY KEY (blocked_id, blocker_id))`,
    `CREATE INDEX ticket_block_blocker ON ticket_block (blocker_id)`,
    `CREATE TABLE board_rules (project_id TEXT PRIMARY KEY, age_warn_days INTEGER NOT NULL DEFAULT 14, wip_limit INTEGER)`,
    `UPDATE ticket SET rank = (SELECT ordered.n FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY proposed DESC, (pending_stage IS NOT NULL) DESC, updated_at DESC, number) AS n FROM ticket WHERE stage = 'backlog') AS ordered WHERE ordered.id = ticket.id) WHERE stage = 'backlog' AND rank IS NULL`,
  ];
  return migrated ??= migrate(statements).catch(error => {
    if (!String(error).includes("cannot be changed")) throw error;
    return migrate(statements.map(sql => columnChecks[sql] ?? sql));
  });
}

export function touch() {
  generation++;
  for (const resolve of waiters.splice(0)) resolve(generation);
}

export function currentGeneration() { return generation; }
export function nextChange(since) {
  if (since !== generation) return Promise.resolve(generation);
  return new Promise((resolve) => {
    if (since !== generation) {
      resolve(generation);
      return;
    }
    waiters.push(resolve);
  });
}

export async function kvGet(key) {
  await ready();
  return (await query("SELECT value FROM kv WHERE key = ?", [key]))[0]?.value ?? null;
}
export async function kvSet(key, value) {
  await ready();
  await run("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
export async function kvJson(key, fallback) {
  try {
    const raw = await kvGet(key);
    if (raw == null) return fallback;
    return JSON.parse(String(raw));
  } catch {
    await kvSet(key, JSON.stringify(fallback));
    return fallback;
  }
}

function ticket(row) {
  return {
    id: String(row.id), projectId: String(row.project_id), number: Number(row.number), title: String(row.title), stage: String(row.stage),
    description: String(row.description), proposed: Boolean(row.proposed), pendingStage: row.pending_stage, parentId: row.parent_id, environmentId: row.environment_id,
    issue: row.issue_repo ? { repo: row.issue_repo, number: row.issue_number, url: row.issue_url } : null,
    kind: row.kind == null ? null : String(row.kind), resolution: row.resolution == null ? "done" : String(row.resolution),
    stageAt: row.stage_at == null ? null : Number(row.stage_at), rank: row.rank == null ? null : Number(row.rank),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
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
    const blocks = await query("SELECT blocked_id, blocker_id FROM ticket_block", []);
    const byId = new Map();
    for (const id of new Set([...links.map(l => String(l.thread_id))])) {
      try { byId.set(id, await threads.get(id)); } catch { /* Deleted threads are unlinked by events. */ }
    }
    const tickets = rows.map(row => {
      const t = ticket(row);
      const own = links.filter(l => l.ticket_id === t.id);
      const live = own.map(l => byId.get(l.thread_id)).filter(t => t && t.archivedAt === null && t.visibility !== "hidden");
      return { ...t, threads: live, links: own.map(l => ({ threadId: String(l.thread_id), persona: l.persona })), handoff: handoffs.find(h => h.ticket_id === t.id) ?? null, updatedAt: Math.max(t.updatedAt, ...live.map(t => t.updatedAt)), blockedBy: [], blocks: [] };
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
  const found = data.tickets.find(t => t.id === id);
  if (!found) throw new Error(`No ticket ${id}`);
  const rules = await boardRules(found.projectId);
  const days = found.stage === "in-progress" || found.stage === "review" ? daysInStage(found.stageAt) : null;
  return {
    ...found,
    comments: await query("SELECT * FROM comment WHERE ticket_id = ? ORDER BY created_at, id", [id]),
    subTickets: data.tickets.filter(t => t.parentId === id),
    acceptanceCriteria: acceptanceCriteria(found.description),
    startProblem: found.stage === "backlog" ? startProblem(found) : null,
    daysInStage: days,
    ageWarnDays: rules.ageWarnDays,
    titleWarning: looksLikeUserStory(found.title) ? USER_STORY_WARNING : null,
    wip: rules.wipLimit !== null ? { count: data.tickets.filter(t => t.stage === "in-progress").length, limit: rules.wipLimit } : null,
  };
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
  const kind = input.kind === undefined ? "story" : input.kind;
  if (kind !== null && !KINDS.includes(kind)) throw new Error("Kind must be story, bug, or task");
  let description = input.description == null || input.description === ""
    ? ""
    : text(String(input.description), "Description", 20_000);
  if (kind === "bug" && !description.trim()) description = BUG_TEMPLATE;
  const statements = [{
    sql: `INSERT INTO ticket(id, project_id, number, title, stage, description, proposed, issue_repo, issue_number, issue_url, created_at, updated_at, kind, stage_at, rank) SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'backlog' THEN COALESCE(MAX(rank), 0) + 1 ELSE NULL END FROM ticket WHERE project_id = ?`,
    params: [id, input.projectId, title, wanted, description, input.proposed ? 1 : 0, input.issue?.repo ?? null, input.issue?.number ?? null, input.issue?.url ?? null, now, now, kind, now, wanted, input.projectId],
  }];
  for (const blockerId of input.blockerIds ?? []) {
    const blocker = await ticketRow(blockerId);
    if (blocker.projectId !== input.projectId) throw new Error("A blocker has to be a ticket in the same project");
    statements.push({ sql: "INSERT INTO ticket_block (blocked_id, blocker_id) VALUES (?, ?)", params: [id, blocker.id] });
  }
  if (input.threadId) statements.push({ sql: "INSERT INTO ticket_thread(thread_id, ticket_id, persona) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ticket_id = excluded.ticket_id, persona = excluded.persona, archived_by_done = 0", params: [input.threadId, id, input.persona ?? null] });
  await transaction(statements);
  touch();
  return ticketRow(id);
}

export function attach(id, threadId, persona = null) { return serial(() => attachInner(id, threadId, persona)); }
export async function attachInner(id, threadId, persona = null) {
  const t = await ticketRow(id);
  if (t.proposed || t.stage === "done") throw new Error("Accept or reopen the ticket before attaching a thread");
  const thread = await threads.get(threadId);
  if (thread.projectId !== t.projectId) throw new Error("Attach a thread from the same project as the ticket");
  await run("INSERT INTO ticket_thread(thread_id, ticket_id, persona) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ticket_id = excluded.ticket_id, persona = excluded.persona, archived_by_done = 0", [threadId, id, persona]);
  touch();
}
export function detach(threadId) {
  return serial(async () => { await ready(); await run("DELETE FROM ticket_thread WHERE thread_id = ?", [threadId]); touch(); });
}

export function editTicket(id, fields) {
  return serial(async () => {
    const t = await ticketRow(id);
    let description = fields.description === undefined
      ? t.description
      : (fields.description === "" ? "" : text(String(fields.description), "Description", 20_000));
    const kind = fields.kind === undefined ? t.kind : fields.kind;
    if (kind !== null && !KINDS.includes(kind)) throw new Error("Kind must be story, bug, or task");
    if (fields.kind === "bug" && !description.trim()) description = BUG_TEMPLATE;
    await run("UPDATE ticket SET title = ?, description = ?, kind = ?, updated_at = ? WHERE id = ?", [text(fields.title ?? t.title, "Title"), description, kind, Date.now(), id]);
    touch();
    return ticketRow(id);
  });
}

export function acceptTicket(id) {
  return serial(async () => { await ticketRow(id); await run("UPDATE ticket SET proposed = 0 WHERE id = ?", [id]); touch(); });
}
export function dismissTicket(id) {
  return serial(async () => { await ticketRow(id); await run("DELETE FROM ticket WHERE id = ? AND proposed = 1", [id]); touch(); });
}
export function proposeMove(id, wanted) {
  return serial(async () => {
    const t = await ticketRow(id);
    const next = stage(wanted);
    const problem = isGated(t.stage, next, "done") ? startProblem(t) : null;
    if (problem) throw new Error(`Can't start #${t.number}: ${problem}.`);
    await run("UPDATE ticket SET pending_stage = ? WHERE id = ?", [next, id]);
    touch();
  });
}
export function dismissMove(id) {
  return serial(async () => { await ticketRow(id); await run("UPDATE ticket SET pending_stage = NULL WHERE id = ?", [id]); touch(); });
}

export function moveTicket(id, wanted, resolution = "done") {
  return serial(async () => {
    stage(wanted);
    if (resolution !== "done" && resolution !== "wont-do") throw new Error("Unknown resolution");
    if (resolution === "wont-do" && wanted !== "done") throw new Error("Won't do only applies to a move to Done");
    const t = await ticketRow(id);
    if (t.proposed) throw new Error("Accept the proposed ticket first");
    const problem = isGated(t.stage, wanted, resolution) ? startProblem(t) : null;
    if (problem) throw new Error(`Can't start #${t.number}: ${problem}.`);
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
    const now = Date.now();
    const kept = wanted === "done" ? resolution : "done";
    await run(`UPDATE ticket SET stage_at = CASE WHEN stage = ? THEN stage_at ELSE ? END, stage = ?, resolution = ?, pending_stage = NULL, rank = CASE WHEN ? = 'backlog' AND rank IS NULL THEN (SELECT COALESCE(MAX(other.rank), 0) + 1 FROM ticket other WHERE other.project_id = ticket.project_id) ELSE rank END, updated_at = ? WHERE id = ?`, [wanted, now, wanted, kept, wanted, now, id]);
    touch();
    const moved = await ticketRow(id);
    const notes = [];
    if (wanted === "in-progress") {
      const names = (await query("SELECT t.number FROM ticket t JOIN ticket_block b ON b.blocker_id = t.id WHERE b.blocked_id = ? AND t.stage != 'done' ORDER BY t.number", [id])).map(row => `#${row.number}`);
      if (names.length) notes.push(`Still blocked by ${names.join(", ")}`);
      const rules = await boardRules(moved.projectId);
      if (rules.wipLimit !== null) {
        const count = Number((await query("SELECT COUNT(*) AS n FROM ticket WHERE project_id = ? AND stage = 'in-progress'", [moved.projectId]))[0].n);
        if (count > rules.wipLimit) notes.push(`In progress now holds ${count} tickets, over this project's limit of ${rules.wipLimit}. Finish one before starting another.`);
      }
    }
    return notes.length ? { ...moved, warning: notes.join("\n") } : moved;
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

async function waitsOn(startId, targetId) {
  const rows = await query(`WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT b.blocker_id FROM ticket_block b JOIN up ON b.blocked_id = up.id) SELECT id FROM up WHERE id = ?`, [startId, targetId]);
  return rows.length > 0;
}

export function blockTicket(id, blockerId) {
  return serial(async () => {
    const t = await ticketRow(id);
    const blocker = await ticketRow(blockerId);
    if (t.proposed || blocker.proposed) throw new Error("Accept the tickets before linking a blocker");
    if (t.projectId !== blocker.projectId) throw new Error("A blocker has to be a ticket in the same project");
    if (t.id === blocker.id) throw new Error("A ticket can't block itself");
    if (await waitsOn(blocker.id, t.id)) throw new Error(`#${blocker.number} is already blocked by #${t.number}`);
    await run("INSERT OR IGNORE INTO ticket_block (blocked_id, blocker_id) VALUES (?, ?)", [t.id, blocker.id]);
    touch();
  });
}

export function unblockTicket(id, blockerId) {
  return serial(async () => {
    await ticketRow(id);
    const blocker = await ticketRow(blockerId);
    await run("DELETE FROM ticket_block WHERE blocked_id = ? AND blocker_id = ?", [id, blocker.id]);
    touch();
  });
}

export function rankTicket(id, place) {
  return serial(async () => {
    const t = await ticketRow(id);
    if (t.stage !== "backlog") throw new Error(`#${t.number} is in ${t.stage}. Only Backlog has an order to change.`);
    const anchorId = place.before ?? place.after ?? null;
    if (anchorId) {
      const anchor = await ticketRow(anchorId);
      if (anchor.id === t.id) throw new Error("A ticket can't be ranked against itself.");
      if (anchor.projectId !== t.projectId) throw new Error(`#${anchor.number} is in another project. Only tickets of one project are ranked against each other.`);
      if (anchor.stage !== "backlog") throw new Error(`#${anchor.number} is in ${anchor.stage}, not Backlog.`);
    }
    const others = async () => (await query("SELECT id, rank, number FROM ticket WHERE project_id = ? AND stage = 'backlog' AND id != ?", [t.projectId, id]))
      .map(row => ({ id: String(row.id), rank: row.rank == null ? null : Number(row.rank), number: Number(row.number) }))
      .sort(rankOrder);
    let rank = rankFor(await others(), place);
    if (rank === null) {
      const list = await others();
      await transaction(list.map((item, index) => ({ sql: "UPDATE ticket SET rank = ? WHERE id = ?", params: [index + 1, item.id] })));
      rank = rankFor(await others(), place);
    }
    await run("UPDATE ticket SET rank = ? WHERE id = ?", [rank, id]);
    touch();
    return ticketRow(id);
  });
}

export async function boardRules(projectId) {
  await ready();
  const rows = await query("SELECT age_warn_days, wip_limit FROM board_rules WHERE project_id = ?", [projectId]);
  if (!rows.length) return { ageWarnDays: 14, wipLimit: null };
  return { ageWarnDays: Number(rows[0].age_warn_days), wipLimit: rows[0].wip_limit == null ? null : Number(rows[0].wip_limit) };
}

export function setBoardRules(projectId, rules) {
  return serial(async () => {
    const current = await boardRules(projectId);
    const next = { ...current, ...rules };
    if (!Number.isInteger(next.ageWarnDays) || next.ageWarnDays < 1 || next.ageWarnDays > 365) throw new Error("Warning days must be a whole number from 1 to 365");
    if (next.wipLimit !== null && (!Number.isInteger(next.wipLimit) || next.wipLimit < 1 || next.wipLimit > 999)) throw new Error("Work-in-progress limit must be a whole number from 1 to 999, or off");
    await run("INSERT INTO board_rules (project_id, age_warn_days, wip_limit) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET age_warn_days = excluded.age_warn_days, wip_limit = excluded.wip_limit", [projectId, next.ageWarnDays, next.wipLimit]);
    touch();
    return next;
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
    await run("DELETE FROM ticket_block WHERE blocked_id = ? OR blocker_id = ?", [id, id]);
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
