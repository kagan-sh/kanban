// @ts-check
import { View } from "gpui-kit";
import { next, reply, fail } from "kagan/jobs";
import { context, openPanel, log } from "kagan/host";
import * as threads from "kagan/threads";
import { cli } from "./cli.js";
import * as store from "./store.js";
import * as handoff from "./handoff.js";
export { BoardPanel, SidebarList } from "./views.js";

/** A thread a ticket's thread started joins that ticket, unless it is already on another. */
export async function joinParentTicket(threadId) {
  // The attach is a read-check-write, so it belongs inside the write queue.
  return store.serial(async () => {
    const thread = await threads.get(threadId).catch(() => null);
    if (!thread?.parentThreadId) return;
    const own = await store.ticketOfThread(threadId);
    if (own) return;
    const parent = await store.ticketOfThread(thread.parentThreadId);
    if (!parent || parent.stage === "done" || parent.proposed) return;
    await store.attachInner(parent.id, threadId);
  });
}

export default class Plugin extends View {
  init(_props, cx) {
    this.jobs = cx.spawn(async () => {
      try {
        await store.ready();
        await handoff.expireHandoffs(true);
      } catch (error) {
        // ready() is retryable; each job will surface the real error until the cause clears.
        log("error", `Kanban database: ${error}`);
      }
      for (;;) {
        const job = await next();
        if (job.kind === "event") {
          reply(job.id, null);
          cx.spawn(async () => {
            try {
              if (job.type === "thread.deleted") await store.detach(job.threadId);
              if (job.type === "thread.waiting") { await handoff.collectHandoff(job.threadId); await handoff.expireHandoffs(); }
              if (job.type === "thread.idle") await handoff.expireHandoffs();
              if (job.type === "thread.created") await joinParentTicket(job.threadId);
              store.touch();
            } catch (error) {
              log("error", String(error));
            }
          });
        } else {
          cx.spawn(async () => {
            try {
              if (job.kind === "cli") {
                reply(job.id, await cli(job));
                return;
              }
              if (job.kind === "command") {
                // Reply before openPanel so the command never hits the 10s job timeout
                // and never wedges later CLI jobs.
                const threadId = typeof job.threadId === "string" ? job.threadId : null;
                const projectId = typeof job.projectId === "string" ? job.projectId : null;
                reply(job.id, null);
                const t = job.command === "open-ticket" && threadId
                  ? await store.ticketOfThread(threadId)
                  : null;
                await openPanel("board", {
                  projectId: t?.projectId ?? projectId ?? context().projectId,
                  ticketId: t?.id,
                });
                return;
              }
              throw new Error(`Unknown job ${job.kind}`);
            } catch (error) {
              log("error", String(error));
              try { fail(job.id, String(error)); } catch (replyError) { log("debug", `Job ${job.id} was already replied to: ${replyError}`); }
            }
          });
        }
      }
    });
  }

  render() {
    return "";
  }
}
