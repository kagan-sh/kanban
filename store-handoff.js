// @ts-check
// The handoff job's rows, kept apart from the ticket store they point at.
import { query, run, transaction } from "kagan/database";
import { addCommentInner, handoffRecord, kvJson, kvSet, ready, touch } from "./store.js";

export async function readHandoff(id) {
  await ready();
  const rows = await query("SELECT * FROM handoff WHERE ticket_id = ?", [id]);
  if (!rows.length) return null;
  const sourceRows = await query("SELECT thread_id, comment_id FROM handoff_source WHERE ticket_id = ?", [id]);
  const sources = sourceRows.map(row => String(row.thread_id));
  const done = sourceRows.filter(row => row.comment_id != null).length;
  return { ...handoffRecord(rows[0]), ticketId: String(rows[0].ticket_id), sources, done, total: sources.length };
}

/** @param {any} id @param {{persona?: string | null, prompt?: string, consolidate?: boolean, sourceThreadIds?: string[], nextThreadId?: string | null, baselines?: Record<string, number>}} options @param {string} status @param {string | null} error */
async function upsertHandoff(id, options, status, error) {
  await ready();
  await run(
    `INSERT INTO handoff (ticket_id, persona, prompt, consolidate, status, error, next_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id) DO UPDATE SET persona = excluded.persona, prompt = excluded.prompt, consolidate = excluded.consolidate, status = excluded.status, error = excluded.error, next_thread_id = COALESCE(excluded.next_thread_id, handoff.next_thread_id)`,
    [id, options.persona ?? null, options.prompt ?? "", options.consolidate ? 1 : 0, status, error, options.nextThreadId ?? null],
  );
  const sources = [...new Set(options.sourceThreadIds ?? [])];
  if (sources.length) {
    const now = Date.now();
    const existing = await query("SELECT thread_id FROM handoff_source WHERE ticket_id = ?", [id]);
    const known = new Set(existing.map(row => String(row.thread_id)));
    await transaction(sources.filter(threadId => !known.has(threadId)).map(threadId => ({
      sql: "INSERT INTO handoff_source (ticket_id, thread_id, baseline, queued_id, asked_at, comment_id) VALUES (?, ?, ?, NULL, ?, NULL)",
      params: [id, threadId, options.baselines?.[threadId] ?? null, now],
    })));
    // A retry re-asks the sources still pending, so their baseline moves with the new ask.
    for (const threadId of sources) {
      if (options.baselines?.[threadId] === undefined) continue;
      await run("UPDATE handoff_source SET baseline = ?, asked_at = ? WHERE ticket_id = ? AND thread_id = ? AND comment_id IS NULL", [options.baselines[threadId], now, id, threadId]);
    }
  }
  touch();
}

/** Saves the job. Sources keep their baselines and saved comments when the job is only updated. */
export function saveHandoffJob(id, options, status, error) {
  return upsertHandoff(id, options, status, error);
}

/** Sources still waiting for their handoff comment. */
export async function pendingHandoffSources(id) {
  await ready();
  return (await query("SELECT thread_id, baseline FROM handoff_source WHERE ticket_id = ? AND comment_id IS NULL ORDER BY thread_id", [id]))
    .map(row => ({ threadId: String(row.thread_id), baseline: row.baseline == null ? 0 : Number(row.baseline) }));
}

/** Jobs waiting on this source thread's reply. */
export async function handoffsWaitingOn(threadId) {
  await ready();
  const rows = await query("SELECT h.* FROM handoff h JOIN handoff_source s ON s.ticket_id = h.ticket_id WHERE s.thread_id = ? AND s.comment_id IS NULL AND h.status = 'handing-off'", [threadId]);
  const jobs = [];
  for (const row of rows) {
    const job = await readHandoff(String(row.ticket_id));
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function handoffComments(id) {
  await ready();
  const rows = await query("SELECT thread_id, body FROM comment WHERE ticket_id = ? AND thread_id IS NOT NULL AND body LIKE '%## Handoff%' ORDER BY created_at", [id]);
  return rows.map(row => ({ thread_id: String(row.thread_id), body: String(row.body) }));
}

export async function ticketThreads(id) {
  await ready();
  return (await query("SELECT thread_id, persona FROM ticket_thread WHERE ticket_id = ?", [id]))
    .map(row => ({ threadId: String(row.thread_id), persona: row.persona == null ? null : String(row.persona) }));
}

/** Saves one source's handoff, and marks that source answered so a retry never asks it again. Call inside a serial section. */
export async function addHandoffComment(id, threadId, persona, body) {
  const commentId = await addCommentInner(id, { body, threadId, persona });
  await run("UPDATE handoff_source SET comment_id = ? WHERE ticket_id = ? AND thread_id = ?", [commentId, id, threadId]);
  return commentId;
}

export function markHandoffAwaitingArchive(id, options) {
  return upsertHandoff(id, options, "awaiting-archive", null);
}

export function markHandoffFailed(id, error) {
  return run("UPDATE handoff SET status = 'failed', error = ? WHERE ticket_id = ?", [error, id]).then(touch);
}

/** An ask that could not be sent fails every job still waiting on that source. */
export async function writeHandoffFailureFor(threadId, error) {
  for (const job of await handoffsWaitingOn(threadId)) await markHandoffFailed(job.ticketId, String(error));
}

export async function staleHandoffs(ms) {
  await ready();
  return query("SELECT ticket_id, error FROM handoff WHERE status = 'handing-off' AND EXISTS (SELECT 1 FROM handoff_source s WHERE s.ticket_id = handoff.ticket_id AND s.asked_at < ?)", [Date.now() - ms]);
}

export async function deleteHandoff(id) {
  await ready();
  await run("DELETE FROM handoff WHERE ticket_id = ?", [id]);
  await run("DELETE FROM kv WHERE key = ?", [`handoff-settle:${id}`]);
  touch();
}

export async function readSettleProgress(id) {
  const raw = await kvJson(`handoff-settle:${id}`, {});
  return raw && typeof raw === "object" ? raw : {};
}

export async function writeSettleProgress(id, progress) {
  await kvSet(`handoff-settle:${id}`, JSON.stringify(progress ?? {}));
}

