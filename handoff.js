// @ts-check
import { query, run } from "kagan/database";
import { run as exec } from "kagan/process";
import * as threads from "kagan/threads";
import { openThread, settings, toast } from "kagan/host";
import { personaBody } from "./personas.js";
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

/** @param {any} ticket @param {{persona?: string | null, prompt?: string}} [options] */
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
  await store.attachInner(ticket.id, thread.id, options.persona ?? null);
  const fresh = await threads.get(thread.id);
  if (fresh.environmentId) {
    const env = await threads.environment(fresh.environmentId);
    if (env.provider === "worktree") {
      await run("UPDATE ticket SET environment_id = ? WHERE id = ? AND environment_id IS NULL", [env.id, ticket.id]);
    }
  }
  await openThread(thread.id);
  await toast(`Started #${ticket.number}. In the new thread run: kg kanban ticket show ${ticket.id}`);
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
    try {
      const next = await runHandoff(id, options);
      await store.deleteHandoff(id);
      return next;
    } catch (error) {
      await store.writeHandoffFailure(id, options, error);
      throw error;
    }
  });
}

async function runHandoff(id, options) {
  const ticket = await store.ticketRow(id);
  if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket first");
  const ids = [...new Set(options.sourceThreadIds ?? [])];
  if (!ids.length || ids.length > 50) throw new Error("Pick between 1 and 50 source threads");
  const links = await query("SELECT thread_id FROM ticket_thread WHERE ticket_id = ?", [id]);
  for (const threadId of ids) {
    if (!links.some((l) => l.thread_id === threadId)) throw new Error("Every source must be on the ticket");
    const thread = await threads.get(threadId);
    if (thread.archivedAt !== null) throw new Error("Every source must be live");
  }
  const persona = options.persona ?? null;
  const prompt = options.prompt ?? "";
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
  const next = await spawnForTicket(ticket, { persona, prompt });
  for (const threadId of ids) await threads.archive(threadId);
  store.touch();
  await toast(`Handoff on #${ticket.number} started a new thread`, { label: "Open board", command: "open-board" });
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
