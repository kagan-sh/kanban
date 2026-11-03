// @ts-check
import { query, run } from "kagan/database";
import { run as exec } from "kagan/process";
import * as threads from "kagan/threads";
import { openThread, settings, toast } from "kagan/host";
import { personaBody } from "./personas.js";
import { handoffSteps, planHandoff } from "./model.js";
import * as store from "./store.js";

export const HANDOFF_INSTRUCTIONS = `Write a standalone handoff as a ticket comment with kg kanban ticket comment. Start with ## Handoff, then ### Goal and ### Current State (both required). Include Context, What Changed, Decisions Made, Open Questions, and Next Steps as ### sections when useful. State only what actually happened, with decisions, reasons, paths, constraints and concrete next actions. Drop retries and long tool output. Write in the third person.`;

export function extractHandoff(output) {
  const start = [...output.matchAll(/^##[ \t]+Handoff[ \t]*$/gim)].at(-1)?.index;
  if (start === undefined) throw new Error("The reply has no handoff");
  const block = output.slice(start).split(/\n##[ \t]+/)[0].trim().slice(0, 8000);
  if (!/^###[ \t]+Goal[ \t]*\r?$/im.test(block) || !/^###[ \t]+Current State[ \t]*\r?$/im.test(block)) {
    throw new Error("The handoff needs Goal and Current State sections");
  }
  return block;
}

/** Attach, env, open and toast for a thread that already exists. */
async function settleSpawnedThread(ticket, thread, persona, { announce = true } = {}) {
  const links = await query("SELECT thread_id FROM ticket_thread WHERE ticket_id = ?", [ticket.id]);
  if (!links.some((row) => String(row.thread_id) === thread.id)) {
    await store.attachInner(ticket.id, thread.id, persona ?? null);
  }
  const fresh = await threads.get(thread.id);
  if (fresh.environmentId) {
    const env = await threads.environment(fresh.environmentId);
    if (env.provider === "worktree") {
      await run("UPDATE ticket SET environment_id = ? WHERE id = ? AND environment_id IS NULL", [env.id, ticket.id]);
    }
  }
  await openThread(thread.id);
  if (announce) await toast(`Started #${ticket.number}. In the new thread run: kg kanban ticket show ${ticket.id}`);
}

/** @param {any} ticket @param {{persona?: string | null, prompt?: string, onSpawned?: (thread: any) => Promise<void> | void}} [options] */
export async function spawnForTicket(ticket, options = {}) {
  await personaBody(options.persona);
  const program = String(settings().defaultProgram || "claude");
  const project = await threads.project(ticket.projectId);
  /** @type {import("kagan/threads").EnvironmentSpec} */
  let environment;
  if (ticket.environmentId) {
    const env = await threads.environment(ticket.environmentId);
    if (env.status === "destroyed" || env.status === "error") {
      const links = await query("SELECT thread_id FROM ticket_thread WHERE ticket_id = ?", [ticket.id]);
      if (!links.length) throw new Error("Restore the ticket's environment before starting a thread");
      await threads.restoreEnvironment(String(links[0].thread_id));
    }
    environment = { kind: "reuse", environmentId: ticket.environmentId };
  } else if (project.kind === "personal") {
    environment = { kind: "personal" };
  } else {
    const git = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: project.path });
    environment = git.exitCode === 0
      ? { kind: "worktree", branch: `kanban/${ticket.number}` }
      : { kind: "project-default" };
  }
  const title = (options.prompt || "").trim() || `#${ticket.number} ${ticket.title}`;
  const thread = await threads.spawn({
    projectId: ticket.projectId,
    program,
    title,
    environment,
    metadata: {
      kanbanTicketId: ticket.id,
      kanbanTicketNumber: ticket.number,
      persona: options.persona ?? null,
      hint: `Run kg kanban ticket show ${ticket.id} first; read its description and comments.`,
    },
  });
  if (options.onSpawned) await options.onSpawned(thread);
  await settleSpawnedThread(ticket, thread, options.persona);
  return thread;
}

export function startThread(id, options = {}) {
  return store.serial(async () => {
    const ticket = await store.ticketRow(id);
    if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket before starting a thread");
    return spawnForTicket(ticket, options);
  });
}

export function startHandoff(id, options) {
  return store.serial(async () => {
    let nextThreadId = options.nextThreadId ?? null;
    try {
      const next = await runHandoff(id, options, (spawned) => { nextThreadId = spawned; });
      await store.deleteHandoff(id);
      return next;
    } catch (error) {
      await store.writeHandoffFailure(id, { ...options, nextThreadId }, error);
      throw error;
    }
  });
}

async function sourceThreads(id, ids) {
  const links = await query("SELECT thread_id FROM ticket_thread WHERE ticket_id = ?", [id]);
  const linked = new Set(links.map((row) => String(row.thread_id)));
  /** @type {Record<string, { onTicket: boolean, archived: boolean }>} */
  const found = {};
  for (const threadId of ids) {
    if (!linked.has(threadId)) {
      found[threadId] = { onTicket: false, archived: false };
      continue;
    }
    const thread = await threads.get(threadId).catch(() => null);
    found[threadId] = { onTicket: true, archived: !thread || thread.archivedAt !== null };
  }
  return found;
}

async function runHandoff(id, options, onSpawned) {
  const ticket = await store.ticketRow(id);
  if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket first");
  const ids = [...new Set(options.sourceThreadIds ?? [])];
  const plan = planHandoff({
    sources: ids,
    nextThreadId: options.nextThreadId ?? null,
    threads: await sourceThreads(id, ids),
  });
  if (plan.action === "refuse") throw new Error(plan.reason);
  const persona = options.persona ?? null;
  const prompt = options.prompt ?? "";
  let next = null;
  for (const step of handoffSteps(plan)) {
    if (step === "comment") {
      const sources = ids.map((threadId) => `\`${threadId}\``).join(", ");
      await store.addCommentInner(id, {
        body: [
          "## Handoff request",
          "",
          `Sources: ${sources}`,
          persona ? `Persona: ${persona}` : null,
          prompt ? `\n${prompt}` : null,
          "",
          HANDOFF_INSTRUCTIONS,
        ].filter((line) => line !== null).join("\n"),
        persona,
      });
    } else if (step === "spawn") {
      next = await spawnForTicket(ticket, {
        persona,
        prompt,
        onSpawned: async (thread) => {
          onSpawned(thread.id);
          await store.saveHandoffProgress(id, { ...options, sourceThreadIds: ids, nextThreadId: thread.id });
        },
      });
    } else if (step === "finish-successor") {
      next = await threads.get(plan.nextThreadId);
      await settleSpawnedThread(ticket, next, persona, { announce: false });
    } else if (step === "archive") {
      for (const threadId of plan.archive) await threads.archive(threadId);
    }
  }
  store.touch();
  if (!next && plan.action === "resume") next = await threads.get(plan.nextThreadId);
  await toast(
    plan.action === "resume" ? `Handoff on #${ticket.number} finished` : `Handoff on #${ticket.number} started a new thread`,
    { label: "Open board", command: "open-board" },
  );
  return next;
}

export async function retryHandoff(id) {
  const job = await store.readHandoff(id);
  if (!job) throw new Error("That ticket has no handoff to retry");
  return startHandoff(id, {
    sourceThreadIds: job.sources,
    persona: job.persona,
    prompt: job.prompt,
    consolidate: job.consolidate,
    nextThreadId: job.nextThreadId,
  });
}

export function startWithoutHandoff(id) {
  return store.serial(async () => {
    const ticket = await store.ticketRow(id);
    if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket before starting a thread");
    const job = await store.readHandoff(id);
    const thread = await spawnForTicket(ticket, { persona: job?.persona ?? null, prompt: job?.prompt || "" });
    await store.deleteHandoff(id);
    return thread;
  });
}
