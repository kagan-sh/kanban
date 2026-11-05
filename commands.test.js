// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { execute } = await import("./cli.js");
await import("./commands.js");
const store = await import("./store.js");
const threads = await import("./test/support/kagan-threads.js");
const host = await import("./test/support/kagan-host.js");
const processHost = await import("./test/support/kagan-process.js");
await store.ready();

function context(projectId, threadId = null) {
  return {
    flags: {}, args: [], projectId, ticketContext: { projectId, threadId },
    project: () => projectId, thread: (ref) => ref ?? threadId,
  };
}

async function project() {
  const id = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id, kind: "project", name: id, path: `/tmp/${id}`, sort: 1 });
  return id;
}

test("rank reports the new Backlog place", async () => {
  const projectId = await project();
  const a = await store.createTicket({ projectId, title: "A", kind: "task" });
  await store.createTicket({ projectId, title: "B", kind: "task" });
  const result = await execute({ command: "ticket", argv: ["rank", a.id, "--bottom", "--json"], projectId, threadId: null });
  assert.deepEqual(result.backlogRank, { position: 2, of: 2 });
});

test("show returns the ticket detail and comments", async () => {
  const projectId = await project();
  const t = await store.createTicket({ projectId, title: "Show", kind: "task" });
  await store.addComment(t.id, { body: "A note" });
  const detail = await execute({ command: "ticket", argv: ["show", t.id, "--json"], projectId, threadId: null });
  assert.equal(detail.comments[0].body, "A note");
  assert.equal(detail.number, t.number);
});

test("an agent cannot archive another thread or delete a ticket without Done", async () => {
  const projectId = await project();
  const t = await store.createTicket({ projectId, title: "Gate", kind: "task" });
  threads.addThread("thr_gate_a", { projectId });
  threads.addThread("thr_gate_b", { projectId });
  host.state.values.agentMoveToDone = false;
  await assert.rejects(() => execute({ command: "ticket", argv: ["remove", "thr_gate_b"], projectId, threadId: "thr_gate_a" }), /Archiving another thread/);
  await assert.rejects(() => execute({ command: "ticket", argv: ["delete", t.id], projectId, threadId: "thr_gate_a" }), /needs Agents can move to Done/);
  host.state.values.agentMoveToDone = true;
});

test("an issue import from an agent is proposed, not accepted", async () => {
  const projectId = await project();
  threads.addThread("thr_import", { projectId });
  processHost.state.handler = (program, args) => {
    if (args[0] === "repo") return { exitCode: 0, stdout: "owner/name\n", stderr: "" };
    if (args[0] === "issue" && args[1] === "view") return { exitCode: 0, stdout: JSON.stringify({ title: "Imported", body: "Body", url: "https://example.test/1", comments: [] }), stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  host.state.values.agentAutoApproveAdds = false;
  const ticket = await execute({ command: "repos", argv: ["import", "owner/name", "1", "--json"], projectId, threadId: "thr_import" });
  assert.equal(ticket.proposed, true);
  assert.equal(ticket.kind, null);
  await assert.rejects(() => execute({ command: "repos", argv: ["import", "owner/name", "1"], projectId, threadId: null }), /already on this board/);
  host.state.values.agentAutoApproveAdds = true;
  processHost.state.handler = null;
});

test("a repo issue list continues when one repo fails", async () => {
  const projectId = await project();
  await store.linkRepo(projectId, "good/one");
  await store.linkRepo(projectId, "bad/two");
  processHost.state.handler = (program, args) => {
    const repo = args[args.indexOf("--repo") + 1];
    if (repo === "bad/two") return { exitCode: 1, stdout: "", stderr: "boom" };
    return { exitCode: 0, stdout: JSON.stringify([{ number: 1, title: "Issue", url: "u", labels: [], assignees: [], author: { login: "a" } }]), stderr: "" };
  };
  const issues = await execute({ command: "repos", argv: ["issues", "--json"], projectId, threadId: null });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].repo, "good/one");
  processHost.state.handler = null;
});
