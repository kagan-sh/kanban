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
      await store.ready();
      for (;;) {
        const job = await next();
        if (job.kind === "event") {
          reply(job.id, null);
          cx.spawn(async () => {
            if (job.type === "thread.deleted") await store.detach(job.threadId);
            store.touch();
          });
        } else {
          cx.spawn(async () => {
            try {
              if (job.kind === "cli") reply(job.id, await cli(job));
              else if (job.kind === "command") {
                const t = job.command === "open-ticket" && job.threadId
                  ? await store.ticketOfThread(job.threadId)
                  : null;
                await openPanel("board", {
                  projectId: t?.projectId ?? job.projectId ?? context().projectId,
                  ticketId: t?.id,
                });
                reply(job.id, null);
              } else throw new Error(`Unknown job ${job.kind}`);
            } catch (error) {
              log("error", String(error));
              fail(job.id, String(error));
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
