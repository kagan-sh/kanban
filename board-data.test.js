// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const store = await import("./store.js");
const boardData = await import("./board-data.js");
const threads = await import("./test/support/kagan-threads.js");
await store.ready();

async function project() {
  const id = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id, kind: "project", name: id, path: `/tmp/${id}`, sort: 1 });
  return id;
}

test("the board carries both sides of a block, the parent link and loose threads", async () => {
  const projectId = await project();
  const parent = await store.createTicket({ projectId, title: "Parent", kind: "task" });
  const child = await store.createTicket({ projectId, title: "Child", kind: "task", parentId: parent.id });
  const blocker = await store.createTicket({ projectId, title: "Blocker", kind: "task" });
  await store.blockTicket(child.id, blocker.id);
  threads.addThread("thr_loose", { projectId, title: "Loose" });
  const board = await boardData.board([projectId]);
  const byId = new Map(board.tickets.map(ticket => [ticket.id, ticket]));
  assert.equal(byId.get(child.id).parentId, parent.id);
  assert.deepEqual(byId.get(child.id).blockedBy.map(ref => ref.number), [blocker.number]);
  assert.deepEqual(byId.get(blocker.id).blocks.map(ref => ref.number), [child.number]);
  assert.deepEqual(board.loose.map(thread => thread.id), ["thr_loose"]);
});

test("detail adds comments, criteria, rank, stage history and handoff sources", async () => {
  const projectId = await project();
  const t = await store.createTicket({ projectId, title: "Detail", kind: "story", description: "## Acceptance criteria\n\n- [x] One\n- [ ] Two\n" });
  threads.addThread("thr_d", { projectId });
  await store.attach(t.id, "thr_d");
  await store.addComment(t.id, { body: "Note" });
  const detail = await boardData.detail(t.id);
  assert.deepEqual(detail.acceptanceCriteria, { done: 1, total: 2 });
  assert.deepEqual(detail.backlogRank, { position: 1, of: 1 });
  assert.equal(detail.comments[0].body, "Note");
  assert.equal(detail.handoffSources[0].id, "thr_d");
  assert.equal(detail.stageHistory[0].stage, "backlog");
  assert.equal(detail.startProblem, null);
});

test("a ticket with no kind or task is never held in Backlog", async () => {
  const projectId = await project();
  const task = await store.createTicket({ projectId, title: "Task", kind: "task" });
  const none = await store.createTicket({ projectId, title: "Imported", kind: null });
  assert.equal((await boardData.detail(task.id)).startProblem, null);
  assert.equal((await boardData.detail(none.id)).startProblem, null);
  assert.equal((await boardData.detail(none.id)).titleWarning, null);
});
