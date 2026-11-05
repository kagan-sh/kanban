// @ts-check
import { run } from "kagan/database";
import { run as exec } from "kagan/process";
import * as threads from "kagan/threads";
import { log, openThread, pasteIntoThread, settings, toast } from "kagan/host";
import { personaBody } from "./personas.js";
import { planHandoff, resolveHandoffOptions, threadStartupInput, withSettleStep } from "./model.js";
import { extractHandoff, handoffResumes, successorPrompt } from "./handoff-model.js";
import * as store from "./store.js";
import * as handoffStore from "./store-handoff.js";

export const HANDOFF_INSTRUCTIONS = `The person is handing this ticket's work to a new thread. Reply now with a handoff for it and do no other work in this reply. The board saves only this section, as a comment on the ticket that later threads read, so it must stand on its own.

Start it with the line ## Handoff, then use these ### sections in this order. Goal and Verified are required; leave out any other section that would be empty.

### Goal
The outcome this ticket is for, in one or two sentences.
### Completed
What changed, grouped by concern, with file paths, commits, or links.
### Verified
The evidence that it works: tests run and their result, commands, traces, or checks done by hand. Then list what is still unverified. Written code that was not run is unverified. If nothing was verified, say so.
### Decisions
Each decision with its reason, and alternatives rejected.
### Next
The next concrete steps, in order.
### Blocked
Each open question that stops the work: the exact question, who decides, and by when it is needed. Put anything unclear here instead of guessing.
### Safe to Pick Up
Work someone else can do now without waiting on the blocked items.

Rules:
- Only what actually happened. Never invent decisions, changes, or context.
- Keep signal: decisions with reasons, the solution adopted (not the journey), settings and versions that matter, constraints found, file paths, anything the next thread would otherwise rediscover.
- Drop noise: corrections and retries (keep the final version), long tool output (summarise it), settled back-and-forth (keep the outcome).
- Keep a dead end only when it reveals a constraint: one sentence on what was tried, why it failed, and what it means.
- Write in the third person.`;

const BUSY = new Set(["active", "starting", "stopping", "pending"]);
const STALE_MS = 60 * 60_000;

/** Sends the ask now, or once a busy thread finishes its turn. Never awaited by the caller. */
function askForHandoff(threadId, text) {
  void (async () => {
    try {
      const thread = await threads.get(threadId);
      // shortcut: no queue-if-active in kagan, so a busy thread is asked when it turns wait. A wait longer than
      // 20 minutes is dropped; Retry asks again.
      if (BUSY.has(thread.status)) {
        await threads.wait(threadId, { timeoutMs: 20 * 60_000 });
        const fresh = await threads.get(threadId);
        if (BUSY.has(fresh.status)) throw new Error(`${threadId} is still busy; Retry the handoff when it is idle.`);
      }
      await threads.send(threadId, text);
    } catch (error) {
      await store.serial(() => handoffStore.writeHandoffFailureFor(threadId, error));
    }
  })();
}

async function outputSince(threadId, baseline) {
  const { output } = await threads.output(threadId);
  return String(output ?? "").slice(Math.max(0, Number(baseline) || 0));
}

/** @param {any} ticket @param {any} thread @param {{persona?: string | null, prompt?: string, personaText?: string, announce?: boolean, progress?: Record<string, boolean>, onProgress?: (progress: Record<string, boolean>) => Promise<void> | void}} [options] */
async function settleSpawnedThread(ticket, thread, options = {}) {
  const persona = options.persona ?? null;
  let progress = { ...(options.progress ?? {}) };
  const save = async (step) => {
    progress = withSettleStep(progress, step);
    if (options.onProgress) await options.onProgress(progress);
  };

  if (!progress.attached) {
    const links = await handoffStore.ticketThreads(ticket.id);
    if (!links.some((row) => row.threadId === thread.id)) {
      await store.attachInner(ticket.id, thread.id, persona);
    }
    await save("attached");
  }
  if (!progress.env) {
    const fresh = await threads.get(thread.id);
    if (fresh.environmentId) {
      const env = await threads.environment(fresh.environmentId);
      if (env.provider === "worktree") {
        await run("UPDATE ticket SET environment_id = ? WHERE id = ? AND environment_id IS NULL", [env.id, ticket.id]);
      }
    }
    await save("env");
  }
  if (!progress.opened) {
    await openThread(thread.id);
    await save("opened");
  }
  if (!progress.pasted) {
    const personaText = options.personaText !== undefined ? options.personaText : await personaBody(persona);
    const input = threadStartupInput({ personaText, prompt: options.prompt ?? "", ticketId: ticket.id });
    // The person presses Enter, so a pasted handoff never counts as sent work.
    await pasteIntoThread(thread.id, input);
    await save("pasted");
  }
  if (options.announce !== false && !progress.toasted) {
    await toast(`Started #${ticket.number}. Press Enter in the new thread to send the pasted prompt.`);
    await save("toasted");
  }
  return progress;
}

/** @param {any} ticket @param {{persona?: string | null, prompt?: string, onSpawned?: (thread: any) => Promise<void> | void, progress?: Record<string, boolean>, onProgress?: (progress: Record<string, boolean>) => Promise<void> | void}} [options] */
export async function spawnForTicket(ticket, options = {}) {
  const personaText = await personaBody(options.persona);
  const program = String(settings().defaultProgram || "claude");
  const project = await threads.project(ticket.projectId);
  /** @type {import("kagan/threads").EnvironmentSpec} */
  let environment;
  if (ticket.environmentId) {
    const env = await threads.environment(ticket.environmentId);
    if (env.status === "destroyed" || env.status === "error") {
      const links = await handoffStore.ticketThreads(ticket.id);
      if (!links.length) throw new Error("Restore the ticket's environment before starting a thread");
      await threads.restoreEnvironment(links[0].threadId);
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
  const title = `#${ticket.number} ${ticket.title}`;
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
  await settleSpawnedThread(ticket, thread, {
    persona: options.persona ?? null,
    prompt: options.prompt ?? "",
    personaText,
    announce: true,
    progress: options.progress,
    onProgress: options.onProgress,
  });
  return thread;
}

export function startThread(id, options = {}) {
  return store.serial(async () => {
    const ticket = await store.ticketRow(id);
    if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket before starting a thread");
    return spawnForTicket(ticket, options);
  });
}

async function sourcesOf(id, ids) {
  const linked = new Set((await handoffStore.ticketThreads(id)).map(row => row.threadId));
  /** @type {Record<string, { onTicket: boolean, archived: boolean }>} */
  const found = {};
  for (const threadId of ids) {
    if (!linked.has(threadId)) {
      found[threadId] = { onTicket: false, archived: false };
      continue;
    }
    const thread = await store.readThread(threadId).catch((error) => { log("warn", `Couldn't read thread ${threadId}: ${error}`); return null; });
    found[threadId] = { onTicket: true, archived: !thread || thread.archivedAt !== null };
  }
  return found;
}

async function saveJob(id, options, status, error) {
  await handoffStore.saveHandoffJob(id, {
    persona: options.persona ?? null,
    prompt: options.prompt ?? "",
    consolidate: Boolean(options.consolidate),
    sourceThreadIds: options.sourceThreadIds ?? [],
    nextThreadId: options.nextThreadId ?? null,
    baselines: options.baselines,
  }, status, error);
}

/** Asks each source for a handoff and returns once the asks are out. The successor starts when they answer. */
export function startHandoff(id, options = {}) {
  return store.serial(async () => {
    const saved = await handoffStore.readHandoff(id);
    if (handoffResumes(saved)) return finishSuccessorInner(id, saved);
    const merged = resolveHandoffOptions(options, saved);
    if (merged.action === "refuse") throw new Error(merged.reason);
    const ticket = await store.ticketRow(id);
    if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket before handing off");
    const ids = [...new Set(merged.sourceThreadIds ?? [])];
    const plan = planHandoff({ sources: ids, threads: await sourcesOf(id, ids) });
    if (plan.action === "refuse") throw new Error(plan.reason);
    const baselines = {};
    for (const threadId of ids) baselines[threadId] = (await threads.output(threadId)).output.length;
    await saveJob(id, { ...merged, nextThreadId: null, baselines }, "handing-off", null);
    const pending = (await handoffStore.pendingHandoffSources(id)).map(source => source.threadId);
    if (!pending.length) return finishSuccessorInner(id, merged);
    for (const threadId of pending) askForHandoff(threadId, HANDOFF_INSTRUCTIONS);
    return { asked: pending };
  });
}

/** Starts the successor once every source has a saved handoff comment. */
function finishSuccessor(id, job) {
  return store.serial(() => finishSuccessorInner(id, job));
}

async function finishSuccessorInner(id, job) {
  const ticket = await store.ticketRow(id);
  const all = await handoffStore.handoffComments(id);
  // One comment per source: a retry can leave an older one behind.
  const newest = new Map();
  for (const comment of all) newest.set(comment.thread_id, comment);
  const comments = [...newest.values()];
  if (!comments.length) throw new Error("No handoff has arrived yet");
  const progress = await handoffStore.readSettleProgress(id);
  const text = comments.map(comment => comments.length > 1 ? `### From ${comment.thread_id}\n\n${comment.body}` : comment.body).join("\n\n");
  // A successor id saved before it settled means the thread exists; resuming must not spawn a second one.
  const next = job.nextThreadId
    ? await threads.get(job.nextThreadId)
    : await spawnForTicket(ticket, {
      persona: job.persona,
      prompt: successorPrompt(ticket, text),
      progress,
      onProgress: (next) => handoffStore.writeSettleProgress(id, next),
      onSpawned: (thread) => handoffStore.saveHandoffJob(id, { ...job, nextThreadId: thread.id }, "handing-off", null),
    });
  if (job.nextThreadId) {
    await settleSpawnedThread(ticket, next, {
      persona: job.persona,
      prompt: successorPrompt(ticket, text),
      progress,
      onProgress: (next) => handoffStore.writeSettleProgress(id, next),
    });
  }
  await handoffStore.markHandoffAwaitingArchive(id, { ...job, nextThreadId: next.id });
  await archiveSourcesInner(id).catch((error) => log("warn", `Couldn't archive handoff sources: ${error}`));
  store.touch();
  return next;
}

/**
 * Called for a source thread that has answered. Saves the newest handoff as a comment,
 * then starts the successor when every source has one.
 */
export function collectHandoff(threadId) {
  return store.serial(async () => {
    const jobs = await handoffStore.handoffsWaitingOn(threadId);
    for (const job of jobs) {
      const pending = await handoffStore.pendingHandoffSources(job.ticketId);
      const source = pending.find(item => item.threadId === threadId);
      if (!source) continue;
      const output = await outputSince(threadId, source.baseline);
      const { text, structured } = extractHandoff(output);
      if (!structured) {
        await saveJob(job.ticketId, job, "failed", "The thread replied without a handoff that has Goal and Verified.");
        store.touch();
        continue;
      }
      const link = (await handoffStore.ticketThreads(job.ticketId)).find(item => item.threadId === threadId);
      await handoffStore.addHandoffComment(job.ticketId, threadId, link?.persona ?? null, text);
      const left = await handoffStore.pendingHandoffSources(job.ticketId);
      if (left.length) {
        store.touch();
        continue;
      }
      await finishSuccessorInner(job.ticketId, job).catch(async (error) => {
        await saveJob(job.ticketId, job, "failed", error instanceof Error ? error.message : String(error));
        store.touch();
      });
    }
  });
}

export async function retryHandoff(id) {
  const job = await handoffStore.readHandoff(id);
  if (!job) throw new Error("That ticket has no handoff to retry");
  if (handoffResumes(job)) return finishSuccessor(id, job);
  return startHandoff(id, {
    sourceThreadIds: job.sources,
    persona: job.persona,
    prompt: job.prompt,
    consolidate: job.consolidate,
    nextThreadId: null,
  });
}

export function archiveSources(id) {
  return store.serial(() => archiveSourcesInner(id));
}

async function archiveSourcesInner(id) {
  const job = await handoffStore.readHandoff(id);
  if (!job) return;
  const failed = [];
  const linked = new Set((await handoffStore.ticketThreads(id)).map(row => row.threadId));
  for (const threadId of job.sources) {
    if (threadId === job.nextThreadId) continue;
    // A source detached from the ticket since the ask is no longer ours to archive.
    if (!linked.has(threadId)) continue;
    const thread = await store.readThread(threadId).catch((error) => { log("warn", `Couldn't read thread ${threadId}: ${error}`); return null; });
    if (!thread || thread.archivedAt !== null) continue;
    try { await threads.archive(threadId); } catch (error) { failed.push(`${threadId}: ${error}`); }
  }
  if (failed.length) {
    await saveJob(id, job, "awaiting-archive", failed.join("\n"));
    store.touch();
    throw new Error(`Couldn't archive ${failed.length} source thread(s). Try again.`);
  }
  await handoffStore.deleteHandoff(id);
  store.touch();
  await toast("Archived the handoff sources");
}

export function startWithoutHandoff(id) {
  return store.serial(async () => {
    const ticket = await store.ticketRow(id);
    if (ticket.proposed || ticket.stage === "done") throw new Error("Accept or reopen the ticket before starting a thread");
    const job = await handoffStore.readHandoff(id);
    const thread = await spawnForTicket(ticket, { persona: job?.persona ?? null, prompt: job?.prompt || "" });
    await handoffStore.deleteHandoff(id);
    return thread;
  });
}

let lastExpiry = 0;
/** A handoff nobody answered within an hour fails, so the card offers Retry and Start without handoff. */
export function expireHandoffs(force = false) {
  if (!force && Date.now() - lastExpiry < 60_000) return Promise.resolve();
  lastExpiry = Date.now();
  return store.serial(async () => {
    for (const row of await handoffStore.staleHandoffs(STALE_MS)) {
      await handoffStore.markHandoffFailed(row.ticket_id, row.error ?? "No handoff arrived within an hour. Retry, or start the thread without one.");
    }
  });
}
