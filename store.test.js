// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const store = await import("./store.js");
const handoffStore = await import("./store-handoff.js");
const boardData = await import("./board-data.js");
const threads = await import("./test/support/kagan-threads.js");

await store.ready();

function project() {
  const id = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id, kind: "project", name: id, path: `/tmp/${id}`, sort: 1 });
  return id;
}

test("a new ticket gets the next number and the bottom of its Backlog", async () => {
  const projectId = project();
  const first = await store.createTicket({ projectId, title: "First", kind: "task" });
  const second = await store.createTicket({ projectId, title: "Second", kind: "task" });
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  assert.ok(second.rank > first.rank);
  assert.equal((await store.ticketRow(first.id)).stage, "backlog");
  assert.equal((await boardData.detail(first.id)).stageHistory[0].stage, "backlog");
});

test("ranking moves a ticket within Backlog and keeps the order stable", async () => {
  const projectId = project();
  const a = await store.createTicket({ projectId, title: "A", kind: "task" });
  const b = await store.createTicket({ projectId, title: "B", kind: "task" });
  const c = await store.createTicket({ projectId, title: "C", kind: "task" });
  await store.rankTicket(c.id, { top: true });
  assert.deepEqual((await store.backlogPlace(c.id)), { position: 1, of: 3 });
  await store.rankTicket(a.id, { after: b.id });
  assert.deepEqual((await store.backlogPlace(a.id)), { position: 3, of: 3 });
  await store.rankTicket(b.id, { before: a.id });
  assert.deepEqual((await store.backlogPlace(b.id)), { position: 2, of: 3 });
  assert.deepEqual((await store.backlogPlace(b.id)), (await boardData.detail(b.id)).backlogRank);
  await store.moveTicket(b.id, "in-progress");
  await assert.rejects(() => store.rankTicket(b.id, { top: true }), /Only Backlog/);
});

test("a move records its column time, history and the WIP warning", async () => {
  const projectId = project();
  await store.setBoardRules(projectId, { ageWarnDays: 2, wipLimit: 1 });
  const a = await store.createTicket({ projectId, title: "A", kind: "task" });
  const b = await store.createTicket({ projectId, title: "B", kind: "task" });
  const moved = await store.moveTicket(a.id, "in-progress");
  assert.equal(moved.stage, "in-progress");
  assert.ok(moved.stageAt > 0);
  const detail = await boardData.detail(a.id);
  assert.equal(detail.daysInStage, 0);
  assert.equal(detail.stageHistory.at(-1).stage, "in-progress");
  const warned = await store.moveTicket(b.id, "in-progress");
  assert.match(warned.warning, /over this project's limit of 1/);
});

test("an accepted move is refused once the ticket changed after the proposal", async () => {
  const projectId = project();
  const t = await store.createTicket({ projectId, title: "Ship", kind: "task" });
  await store.proposeMove(t.id, "review");
  const proposed = await store.ticketRow(t.id);
  assert.equal(proposed.pendingStage, "review");
  assert.ok(proposed.pendingScope);
  await store.editTicket(t.id, { title: "Renamed" });
  await assert.rejects(() => store.moveTicket(t.id, "review"), /changed after the move was proposed/);
  await store.dismissMove(t.id);
  assert.equal((await store.ticketRow(t.id)).pendingStage, null);
});

test("proposed tickets are accepted or dismissed, and cannot be dragged as accepted", async () => {
  const projectId = project();
  const proposed = await store.createTicket({ projectId, title: "Maybe", kind: "task", proposed: true });
  await assert.rejects(() => store.attach(proposed.id, "thr_missing"), /Accept or reopen/);
  await store.acceptTicket(proposed.id);
  assert.equal((await store.ticketRow(proposed.id)).proposed, false);
  const dismissed = await store.createTicket({ projectId, title: "No", kind: "task", proposed: true });
  await store.dismissTicket(dismissed.id);
  await assert.rejects(() => store.ticketRow(dismissed.id), /No ticket/);
});

test("a proposed ticket cannot propose a move, and a settled ticket has nothing to dismiss", async () => {
  const projectId = project();
  const proposed = await store.createTicket({ projectId, title: "Maybe", kind: "task", proposed: true });
  await assert.rejects(() => store.proposeMove(proposed.id, "review"), /Accept the proposed ticket/);
  const settled = await store.createTicket({ projectId, title: "Settled", kind: "task" });
  await assert.rejects(() => store.dismissMove(settled.id), /no move awaiting acceptance/);
});

test("editing or deleting a missing comment is an error", async () => {
  await assert.rejects(() => store.editComment("cmt_missing", "Body"), /No comment/);
  await assert.rejects(() => store.deleteComment("cmt_missing"), /No comment/);
});

test("a story needs its criteria and a bug its sections before leaving Backlog", async () => {
  const projectId = project();
  const story = await store.createTicket({ projectId, title: "Story", kind: "story" });
  await assert.rejects(() => store.moveTicket(story.id, "in-progress"), /Acceptance criteria/);
  await store.editTicket(story.id, { description: "## Acceptance criteria\n\n- [ ] It lands\n" });
  assert.equal((await store.moveTicket(story.id, "in-progress")).stage, "in-progress");
  const bug = await store.createTicket({ projectId, title: "Bug", kind: "bug", description: "" });
  assert.match((await store.ticketRow(bug.id)).description, /## Steps to reproduce/);
  await assert.rejects(() => store.moveTicket(bug.id, "review"), /Steps to reproduce/);
  await store.moveTicket(bug.id, "done", "wont-do");
  assert.equal((await store.ticketRow(bug.id)).resolution, "wont-do");
});

test("blocking refuses cycles and clears when the blocker reaches Done", async () => {
  const projectId = project();
  const a = await store.createTicket({ projectId, title: "A", kind: "task" });
  const b = await store.createTicket({ projectId, title: "B", kind: "task" });
  await store.blockTicket(b.id, a.id);
  assert.deepEqual((await boardData.detail(b.id)).blockedBy.map(ref => ref.number), [a.number]);
  await assert.rejects(() => store.blockTicket(a.id, b.id), /already blocked/);
  await assert.rejects(() => store.blockTicket(a.id, a.id), /can't block itself/i);
  const moved = await store.moveTicket(b.id, "in-progress");
  assert.match(moved.warning, /Still blocked by #1/);
  await store.moveTicket(a.id, "done", "wont-do");
  assert.deepEqual((await boardData.detail(b.id)).blockedBy.map(ref => ref.stage), ["done"]);
});

test("parent links stay in one project, and deleting the parent frees the children", async () => {
  const projectId = project();
  const parent = await store.createTicket({ projectId, title: "Parent", kind: "task" });
  const child = await store.createTicket({ projectId, title: "Child", kind: "task", parentId: parent.id });
  assert.deepEqual((await boardData.detail(child.id)).parent.number, parent.number);
  assert.deepEqual((await boardData.detail(parent.id)).subTickets.map(t => t.number), [child.number]);
  await assert.rejects(() => store.setParent(parent.id, child.id), /own sub-tickets/);
  await store.deleteTicket(parent.id);
  assert.equal((await store.ticketRow(child.id)).parentId, null);
});

test("comments are stored, edited, read in camelCase and deleted", async () => {
  const projectId = project();
  const t = await store.createTicket({ projectId, title: "Comments", kind: "task" });
  const id = await store.addComment(t.id, { body: "First" });
  let detail = await boardData.detail(t.id);
  assert.equal(detail.comments[0].body, "First");
  assert.equal(detail.comments[0].createdAt > 0, true);
  assert.equal(detail.comments[0].githubLogin, null);
  await store.editComment(id, "Edited");
  detail = await boardData.detail(t.id);
  assert.equal(detail.comments[0].body, "Edited");
  assert.ok(detail.comments[0].updatedAt >= detail.comments[0].createdAt);
  await store.deleteComment(id);
  assert.equal((await boardData.detail(t.id)).comments.length, 0);
});

test("Done archives live threads and only the threads it archived come back", async () => {
  const projectId = project();
  const t = await store.createTicket({ projectId, title: "Ship", kind: "task" });
  threads.addThread("thr_a", { projectId });
  threads.addThread("thr_b", { projectId, archivedAt: 1 });
  await store.attach(t.id, "thr_a");
  await store.attach(t.id, "thr_b");
  await store.moveTicket(t.id, "done");
  assert.equal(threads.state.threads.get("thr_a").archivedAt, 1);
  assert.equal((await boardData.detail(t.id)).threads.length, 0);
  assert.equal((await boardData.detail(t.id)).archivedByDone.length, 1);
  await store.moveTicket(t.id, "in-progress");
  assert.equal(threads.state.threads.get("thr_a").archivedAt, null);
  assert.equal(threads.state.threads.get("thr_b").archivedAt, 1);
});

test("a failed or corrupt kv value is reset, but a failed read is not invented", async () => {
  await store.kvSet("broken", "not json");
  assert.deepEqual(await store.kvJson("broken", { fresh: true }), { fresh: true });
  assert.equal(await store.kvGet("broken"), JSON.stringify({ fresh: true }));
  assert.deepEqual(await store.kvJson("missing", []), []);
});
