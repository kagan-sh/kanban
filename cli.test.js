// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { parse, cli } = await import("./cli.js");
const store = await import("./store.js");
const threads = await import("./test/support/kagan-threads.js");
const host = await import("./test/support/kagan-host.js");
await store.ready();

test("the parser reads repeated flags, values and the bare arguments after --", () => {
  assert.deepEqual(parse(["list", "--project", "p1", "--json"]), { args: ["list"], flags: { project: "p1", json: true } });
  assert.deepEqual(parse(["ticket", "add", "A", "title", "--kind", "bug", "--top"]), { args: ["ticket", "add", "A", "title"], flags: { kind: "bug", top: true } });
  assert.deepEqual(parse(["--", "--not-a-flag"]).args, ["--not-a-flag"]);
  assert.throws(() => parse(["--project"]), /needs a value/);
  assert.throws(() => parse(["--project", "a", "--project", "b"]), /Repeated option/);
  assert.throws(() => parse(["--nope"]), /Unknown option/);
});

test("--json is one JSON document; without it the prose follows", async () => {
  const projectId = "prj_cli";
  threads.state.projects.push({ id: projectId, kind: "project", name: "CLI", path: "/tmp/cli", sort: 1 });
  const job = { kind: "cli", command: "ticket", argv: ["add", "JSON ticket", "--kind", "task", "--json"], projectId, threadId: null };
  const result = await cli(job);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.title, "JSON ticket");
  assert.equal(parsed.kind, "task");
  const text = await cli({ ...job, argv: ["add", "Text ticket", "--kind", "task"] });
  assert.match(text.stdout, /"title": "Text ticket"[\s\S]*Created #/);
});

test("a void mutation still returns one JSON document under --json", async () => {
  const projectId = "prj_cli_void";
  threads.state.projects.push({ id: projectId, kind: "project", name: "Void", path: "/tmp/void", sort: 1 });
  const t = await store.createTicket({ projectId, title: "Void", kind: "task" });
  threads.addThread("thr_void", { projectId });
  await store.attach(t.id, "thr_void");
  const result = await cli({ kind: "cli", command: "ticket", argv: ["detach", "thr_void", "--json"], projectId, threadId: null });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "null");
});

test("an agent add is proposed unless the board accepts additions", async () => {
  const projectId = "prj_cli_agent";
  threads.state.projects.push({ id: projectId, kind: "project", name: "Agent", path: "/tmp/agent", sort: 1 });
  threads.addThread("thr_agent", { projectId });
  host.state.values.agentAutoApproveAdds = false;
  const result = await cli({ kind: "cli", command: "ticket", argv: ["add", "Proposed", "--kind", "task", "--json"], projectId, threadId: "thr_agent" });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).proposed, true);
  host.state.values.agentAutoApproveAdds = true;
});

test("Done needs its setting, and won't-do is refused while moves wait", async () => {
  const projectId = "prj_cli_done";
  threads.state.projects.push({ id: projectId, kind: "project", name: "Done", path: "/tmp/done", sort: 1 });
  const t = await store.createTicket({ projectId, title: "Done", kind: "task" });
  host.state.values.agentMoveToDone = false;
  const refused = await cli({ kind: "cli", command: "move", argv: ["done", t.id], projectId, threadId: null });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /Agents can move tickets to Done is off/);
  host.state.values.agentMoveToDone = true;
  host.state.values.agentAutoApproveMoves = false;
  const wont = await cli({ kind: "cli", command: "move", argv: ["done", t.id, "--wont-do"], projectId, threadId: "thr_agent" });
  assert.equal(wont.exitCode, 1);
  assert.match(wont.stderr, /cannot be proposed/);
  host.state.values.agentAutoApproveMoves = true;
});

test("parent --none makes a sub-ticket top-level again", async () => {
  const projectId = "prj_cli_parent";
  threads.state.projects.push({ id: projectId, kind: "project", name: "Parent", path: "/tmp/parent", sort: 1 });
  const parent = await store.createTicket({ projectId, title: "Parent", kind: "task" });
  const child = await store.createTicket({ projectId, title: "Child", kind: "task" });
  const set = await cli({ kind: "cli", command: "ticket", argv: ["parent", child.id, "--to", parent.id, "--json"], projectId, threadId: null });
  assert.equal(set.exitCode, 0);
  const clear = await cli({ kind: "cli", command: "ticket", argv: ["parent", child.id, "--none", "--json"], projectId, threadId: null });
  assert.equal(clear.exitCode, 0);
  assert.equal((await store.ticketRow(child.id)).parentId, null);
});
