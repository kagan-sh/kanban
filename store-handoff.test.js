// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const store = await import("./store.js");
const handoffStore = await import("./store-handoff.js");
const threads = await import("./test/support/kagan-threads.js");
await store.ready();

async function setup() {
  const projectId = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id: projectId, kind: "project", name: projectId, path: `/tmp/${projectId}`, sort: 1 });
  const t = await store.createTicket({ projectId, title: "Handoff", kind: "task" });
  threads.addThread("thr_s", { projectId });
  await store.attach(t.id, "thr_s");
  return t;
}

test("a handoff job keeps its sources, baselines and saved comments", async () => {
  const t = await setup();
  await handoffStore.saveHandoffJob(t.id, { persona: "implementer", prompt: "Go", sourceThreadIds: ["thr_s"], baselines: { thr_s: 123 } }, "handing-off", null);
  let job = await handoffStore.readHandoff(t.id);
  assert.equal(job.status, "handing-off");
  assert.equal(job.sources[0], "thr_s");
  assert.deepEqual(await handoffStore.pendingHandoffSources(t.id), [{ threadId: "thr_s", baseline: 123 }]);
  await handoffStore.addHandoffComment(t.id, "thr_s", "implementer", "## Handoff\n\n### Goal\nGo\n\n### Verified\nTests");
  job = await handoffStore.readHandoff(t.id);
  assert.equal(job.done, 1);
  assert.deepEqual(await handoffStore.pendingHandoffSources(t.id), []);
  assert.equal((await handoffStore.handoffComments(t.id))[0].body.includes("### Goal"), true);
  await handoffStore.markHandoffAwaitingArchive(t.id, { ...job, nextThreadId: "thr_next" });
  assert.equal((await handoffStore.readHandoff(t.id)).status, "awaiting-archive");
  await handoffStore.deleteHandoff(t.id);
  assert.equal(await handoffStore.readHandoff(t.id), null);
});

test("a retry moves the baseline only for sources still waiting", async () => {
  const t = await setup();
  threads.addThread("thr_w", { projectId: t.projectId });
  await store.attach(t.id, "thr_w");
  await handoffStore.saveHandoffJob(t.id, { sourceThreadIds: ["thr_s", "thr_w"], baselines: { thr_s: 10, thr_w: 10 } }, "handing-off", null);
  await handoffStore.addHandoffComment(t.id, "thr_s", null, "## Handoff\n\n### Goal\nA\n\n### Verified\nB");
  await handoffStore.saveHandoffJob(t.id, { sourceThreadIds: ["thr_s", "thr_w"], baselines: { thr_s: 99, thr_w: 77 } }, "handing-off", null);
  const pending = await handoffStore.pendingHandoffSources(t.id);
  assert.deepEqual(pending, [{ threadId: "thr_w", baseline: 77 }]);
});

test("a job waiting on one source is found by that thread only", async () => {
  const t = await setup();
  await handoffStore.saveHandoffJob(t.id, { sourceThreadIds: ["thr_s"], baselines: { thr_s: 0 } }, "handing-off", null);
  assert.equal((await handoffStore.handoffsWaitingOn("thr_s")).length, 1);
  assert.equal((await handoffStore.handoffsWaitingOn("thr_other")).length, 0);
  await handoffStore.markHandoffFailed(t.id, "no reply");
  assert.equal((await handoffStore.handoffsWaitingOn("thr_s")).length, 0);
});

test("a Done move clears the handoff job and its settle progress", async () => {
  const t = await setup();
  await handoffStore.saveHandoffJob(t.id, { sourceThreadIds: ["thr_s"], baselines: { thr_s: 0 } }, "handing-off", null);
  await handoffStore.writeSettleProgress(t.id, { pasted: true });
  await store.moveTicket(t.id, "done", "wont-do");
  assert.equal(await handoffStore.readHandoff(t.id), null);
  assert.deepEqual(await handoffStore.readSettleProgress(t.id), {});
});
