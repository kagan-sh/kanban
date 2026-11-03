// @ts-check
import { View } from "gpui-kit";
import { next, reply, fail } from "kagan/jobs";
import { context, openPanel, log } from "kagan/host";
import { cli } from "./cli.js";
import * as store from "./store.js";
export { BoardPanel, SidebarList } from "./views.js";

export default class Plugin extends View {
  init(_props, cx) {
    this.jobs = cx.spawn(async () => {
      try {
        await store.ready();
      } catch (error) {
        const message = `Kanban database: ${error}`;
        log("error", message);
        for (;;) {
          const job = await next();
          try { fail(job.id, message); } catch { /* already settled */ }
        }
      }
      for (;;) {
        const job = await next();
        if (job.kind === "event") {
          reply(job.id, null);
          cx.spawn(async () => {
            try {
              if (job.type === "thread.deleted") await store.detach(job.threadId);
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
              try { fail(job.id, String(error)); } catch { /* already replied */ }
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
