// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const store = await import("./store.js");
const handoffStore = await import("./store-handoff.js");
const handoff = await import("./handoff.js");
const threads = await import("./test/support/kagan-threads.js");
const host = await import("./test/support/kagan-host.js");
await store.ready();

const HANDOFF = "## Handoff\n\n### Goal\nShip it\n\n### Completed\n- A change\n\n### Verified\nTests pass\n";

async function setup(threadIds = ["thr_s"]) {
  const projectId = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id: projectId, kind: "project", name: projectId, path: `/tmp/${projectId}`, sort: 1 });
  const ticket = await store.createTicket({ projectId, title: "Handoff", kind: "task" });
  threads.state.threads.clear();
  threads.state.sent.length = 0;
  threads.state.pasted.length = 0;
  threads.state.spawned.length = 0;
  threads.state.output = "before\n";
  host.state.pasted.length = 0;
  host.state.toasts.length = 0;
  host.state.openedThreads.length = 0;
  for (const id of threadIds) {
    threads.addThread(id, { projectId, title: id });
    await store.attach(ticket.id, id);
  }
  return ticket;
}

function flush() { return new Promise(resolve => setImmediate(resolve)); }

test("a handoff asks the source, saves the reply and archives it once the successor starts", async () => {
  const ticket = await setup();
  await handoff.startHandoff(ticket.id, { sourceThreadIds: ["thr_s"], persona: null, prompt: "Go" });
  await flush();
  assert.equal(threads.state.sent.length, 1);
  assert.match(threads.state.sent[0].text, /## Handoff/);
  assert.equal((await handoffStore.readHandoff(ticket.id)).status, "handing-off");

  threads.state.output = "before\n" + HANDOFF;
  await handoff.collectHandoff("thr_s");
  const detail = await (await import("./board-data.js")).detail(ticket.id);
  assert.equal(detail.comments.length, 1);
  assert.match(detail.comments[0].body, /### Goal/);
  assert.equal(detail.comments[0].threadId, "thr_s");
  assert.equal(threads.state.spawned.length, 1);
  assert.equal(threads.state.threads.get("thr_s").archivedAt, 1);
  assert.equal(await handoffStore.readHandoff(ticket.id), null);
  assert.ok(host.state.toasts.length >= 1);
  assert.equal(host.state.pasted.length, 1);
  assert.match(host.state.pasted[0].text, /## Handoff/);
});

test("a reply without Goal and Verified fails the job and spawns nothing", async () => {
  const ticket = await setup(["thr_b"]);
  await handoff.startHandoff(ticket.id, { sourceThreadIds: ["thr_b"], persona: null });
  await flush();
  threads.state.output = "before\nI finished the work but wrote no handoff.";
  await handoff.collectHandoff("thr_b");
  const job = await handoffStore.readHandoff(ticket.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /Goal and Verified/);
  assert.equal(threads.state.spawned.length, 0);
});

test("consolidation waits for every source and starts one successor from all handoffs", async () => {
  const ticket = await setup(["thr_one", "thr_two"]);
  await handoff.startHandoff(ticket.id, { sourceThreadIds: ["thr_one", "thr_two"], persona: null, consolidate: true });
  await flush();
  threads.state.output = "before\n" + HANDOFF;
  await handoff.collectHandoff("thr_one");
  assert.equal(threads.state.spawned.length, 0);
  assert.equal((await handoffStore.readHandoff(ticket.id)).done, 1);
  await handoff.collectHandoff("thr_two");
  assert.equal(threads.state.spawned.length, 1);
  assert.match(host.state.pasted[0].text, /### From thr_one/);
  assert.match(host.state.pasted[0].text, /### From thr_two/);
  assert.equal(threads.state.threads.get("thr_one").archivedAt, 1);
  assert.equal(threads.state.threads.get("thr_two").archivedAt, 1);
});

test("a failed successor settle resumes the saved thread instead of spawning another", async () => {
  const ticket = await setup(["thr_src"]);
  threads.addThread("thr_next", { projectId: ticket.projectId, title: "Successor" });
  await store.attach(ticket.id, "thr_next");
  await handoffStore.saveHandoffJob(ticket.id, { sourceThreadIds: ["thr_src"], baselines: { thr_src: 0 }, nextThreadId: "thr_next" }, "handing-off", null);
  await handoffStore.addHandoffComment(ticket.id, "thr_src", null, HANDOFF);
  await handoff.startHandoff(ticket.id, { sourceThreadIds: ["thr_src"], persona: null });
  assert.equal(threads.state.spawned.length, 0);
  assert.equal(threads.state.threads.get("thr_src").archivedAt, 1);
  assert.ok(host.state.pasted.some(item => item.id === "thr_next"));
});

test("starting without a handoff spawns a successor and leaves sources live", async () => {
  const ticket = await setup(["thr_keep"]);
  await handoff.startHandoff(ticket.id, { sourceThreadIds: ["thr_keep"], persona: null, prompt: "Skip it" });
  await flush();
  await handoff.startWithoutHandoff(ticket.id);
  assert.equal(threads.state.spawned.length, 1);
  assert.equal(threads.state.threads.get("thr_keep").archivedAt, null);
  assert.equal(await handoffStore.readHandoff(ticket.id), null);
});
