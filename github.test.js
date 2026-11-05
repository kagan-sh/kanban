// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const github = await import("./github.js");
const store = await import("./store.js");
const threads = await import("./test/support/kagan-threads.js");
const processHost = await import("./test/support/kagan-process.js");
const host = await import("./test/support/kagan-host.js");
await store.ready();

async function project() {
  const id = `prj_${Math.random().toString(36).slice(2, 8)}`;
  threads.state.projects.push({ id, kind: "project", name: id, path: `/tmp/${id}`, sort: 1 });
  return id;
}

test("a repository is normalized through gh and a bad shape is refused before it runs", async () => {
  processHost.state.handler = () => ({ exitCode: 0, stdout: "owner/name\n", stderr: "" });
  assert.equal(await github.normalizeRepo("owner/name"), "owner/name");
  assert.equal(await github.normalizeRepo("https://github.com/owner/name"), "owner/name");
  await assert.rejects(() => github.normalizeRepo("not a repo"), /owner\/name/);
  processHost.state.handler = null;
});

test("an imported issue copies its body, comments and source, once per project", async () => {
  const projectId = await project();
  processHost.state.handler = (program, args) => {
    if (args[0] === "issue") return { exitCode: 0, stdout: JSON.stringify({ title: "Issue", body: "Body", url: "https://example.test/1", comments: [{ body: "A comment", author: { login: "octo" } }] }), stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  const t = await github.importIssue(projectId, "owner/name", 1, { proposed: true });
  assert.equal(t.proposed, true);
  assert.equal(t.kind, null);
  assert.match(t.description, /Copy of https:\/\/example.test\/1/);
  await assert.rejects(() => github.importIssue(projectId, "owner/name", 1), /already on this board/);
  processHost.state.handler = null;
});

test("a pull request pulse maps state and checks, and reports a failed read", async () => {
  const projectId = await project();
  await store.linkRepo(projectId, "owner/name");
  const t = await store.createTicket({ projectId, title: "PR", kind: "task" });
  processHost.state.handler = () => ({ exitCode: 0, stdout: JSON.stringify([{ number: 3, title: "PR", url: "https://example.test/pr/3", state: "OPEN", isDraft: true, mergedAt: null, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }] }]), stderr: "" });
  let pulse = await github.pullRequests(t);
  assert.equal(pulse.error, null);
  assert.equal(pulse.pulls[0].isDraft, true);
  assert.deepEqual(pulse.pulls[0].checks, { passed: 1, failed: 0, pending: 1 });
  processHost.state.handler = () => ({ exitCode: 1, stdout: "", stderr: "auth needed" });
  const second = await store.createTicket({ projectId, title: "PR two", kind: "task" });
  pulse = await github.pullRequests({ ...second, environmentId: null });
  assert.match(pulse.error, /auth needed/);
  processHost.state.handler = null;
});

test("an auto-linked remote is linked once and a manual unlink is respected", async () => {
  const projectId = await project();
  const record = threads.state.projects.find(item => item.id === projectId);
  record.gitRemoteUrl = "git@github.com:owner/name.git";
  processHost.state.handler = () => ({ exitCode: 0, stdout: "owner/name\n", stderr: "" });
  host.state.values.autoLinkRemote = true;
  await github.maybeAutoLink(projectId);
  assert.deepEqual(await store.listRepos(projectId), ["owner/name"]);
  await store.unlinkRepo(projectId, "owner/name");
  await github.maybeAutoLink(projectId);
  assert.deepEqual(await store.listRepos(projectId), []);
  host.state.values.autoLinkRemote = false;
  processHost.state.handler = null;
});
