// @ts-check
import * as threads from "kagan/threads";

// A thread's `status` says only whether its program runs. Whether it is mid-turn comes from its turn events,
// so the list keeps that here: the job loop records each event, and a load reads each running thread's latest.
const busy = new Set();
const TURN = new Set(["thread.turn.started", "turn.started"]);
const QUIET = new Set(["turn.ended", "waiting", "idle", "exited", "stopped", "failed"]);

/** True while the thread's program is working on a turn. */
export function isBusy(threadId) {
  return busy.has(threadId);
}

/** Records one thread event from the job loop. Returns true when the busy state changed. */
export function record(type, threadId) {
  const kind = String(type).replace(/^thread\./, "");
  const had = busy.has(threadId);
  if (TURN.has(kind) || TURN.has(type)) busy.add(threadId);
  else if (QUIET.has(kind)) busy.delete(threadId);
  return had !== busy.has(threadId);
}

/** Reads the latest turn event of each running thread, so the list is right before the next event lands. */
export async function seed(running) {
  await Promise.all(running.slice(0, 40).map(async thread => {
    const latest = await threads.events(thread.id, { limit: 8, order: "desc" }).catch(() => []);
    const turn = latest.find(event => TURN.has(String(event.type)) || QUIET.has(String(event.type)));
    if (turn) record(String(turn.type), thread.id);
  }));
}
