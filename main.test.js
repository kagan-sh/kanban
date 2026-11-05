// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { joinParentTicket } = await import("./main.js");
const store = await import("./store.js");
const threads = await import("./test/support/kagan-threads.js");
await store.ready();

async function project() {
  const id = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id, kind: "project", name: id, path: `/tmp/${id}`, sort: 1 });
  return id;
}

test("a thread spawned by a ticket's thread joins that ticket", async () => {
  const projectId = await project();
  const ticket = await store.createTicket({ projectId, title: "Parent", kind: "task" });
  threads.addThread("thr_parent", { projectId });
  await store.attach(ticket.id, "thr_parent");
  threads.addThread("thr_child", { projectId, parentThreadId: "thr_parent" });
  await joinParentTicket("thr_child");
  assert.equal((await store.ticketOfThread("thr_child"))?.id, ticket.id);
});

test("a child already on another ticket is left alone", async () => {
  const projectId = await project();
  const first = await store.createTicket({ projectId, title: "First", kind: "task" });
  const second = await store.createTicket({ projectId, title: "Second", kind: "task" });
  threads.addThread("thr_p2", { projectId });
  await store.attach(first.id, "thr_p2");
  threads.addThread("thr_c2", { projectId, parentThreadId: "thr_p2" });
  await store.attach(second.id, "thr_c2");
  await joinParentTicket("thr_c2");
  assert.equal((await store.ticketOfThread("thr_c2"))?.id, second.id);
});

test("a Done or proposed parent does not take a new child", async () => {
  const projectId = await project();
  const done = await store.createTicket({ projectId, title: "Done", kind: "task" });
  threads.addThread("thr_p3", { projectId });
  await store.attach(done.id, "thr_p3");
  await store.moveTicket(done.id, "done", "wont-do");
  threads.addThread("thr_c3", { projectId, parentThreadId: "thr_p3" });
  await joinParentTicket("thr_c3");
  assert.equal(await store.ticketOfThread("thr_c3"), null);
});
