// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { renderTicket, refreshTicket } = await import("./ticket.js");
const { element } = await import("./test/support/gpui-kit.js");
const { cx, view, ids, labels, texts } = await import("./test/support/view.js");

function detail(extra = {}) {
  return {
    id: "tkt_1", projectId: "prj_1", number: 1, title: "Ship it", stage: "review", kind: "task", resolution: "done",
    proposed: false, pendingStage: null, parentId: null, description: "The description", issue: null, handoff: null,
    threads: [{ id: "thr_a", title: "Work", status: "active", projectId: "prj_1", pinned: false }],
    links: [{ threadId: "thr_a", persona: null }], archivedByDone: [], blockedBy: [], blocks: [],
    comments: [{ id: "cmt_1", body: "A note", threadId: "thr_a", persona: "implementer", githubLogin: null, createdAt: Date.now(), updatedAt: Date.now() }],
    subTickets: [], parent: null, stageHistory: [{ stage: "backlog", resolution: "done", at: Date.now() }],
    handoffSources: [{ id: "thr_a", title: "Work" }], acceptanceCriteria: null, startProblem: null,
    daysInStage: 2, ageWarnDays: 14, titleWarning: null, wip: null, backlogRank: null,
    ...extra,
  };
}

function fake(ticket) {
  return view({
    ticket, ticketId: ticket.id, data: { tickets: [ticket], loose: [] }, projects: [{ id: "prj_1", name: "One" }],
    attentionButtons: () => element("needs"), menu: () => element("menu"),
    ticketRepos: ["owner/name"], pulls: [], pullsError: null, changes: [], section: "overview",
  });
}

test("the ticket page shows its title, description, threads, relationships and actions", () => {
  const t = detail();
  const page = renderTicket(fake(t), cx());
  assert.match(texts(page).join(" "), /Ship it/);
  assert.match(texts(page).join(" "), /The description/);
  assert.ok(ids(page).includes("edit-ticket"));
  assert.ok(ids(page).includes("start-thread"));
  assert.ok(ids(page).includes("ticket-thread:thr_a"));
  assert.ok(ids(page).includes("tab-overview"));
  assert.ok(ids(page).includes("tab-activity"));
  assert.ok(ids(page).includes("tab-reviews"));
});

test("a comment can be edited and deleted from the activity tab", () => {
  const t = detail();
  const v = fake(t);
  v.section = "activity";
  const page = renderTicket(v, cx());
  assert.ok(ids(page).includes("comment-edit:cmt_1"));
  assert.ok(ids(page).includes("comment-delete:cmt_1"));
  assert.ok(ids(page).includes("save-comment"));
  assert.ok(ids(page).includes("cmt_1"));
});

test("the reviews tab shows repos, pull checks, changes and stage history", () => {
  const t = detail();
  const v = fake(t);
  v.section = "reviews";
  v.pulls = [{ repo: "owner/name", number: 3, title: "PR", url: "https://example.test/3", state: "OPEN", isDraft: false, mergedAt: null, checks: { passed: 2, failed: 1, pending: 0 } }];
  v.changes = [{ threadId: "thr_a", title: "Work", added: 3, removed: 1, base: "main" }];
  const page = renderTicket(v, cx());
  assert.ok(ids(page).includes("pull:https://example.test/3"));
  assert.ok(ids(page).includes("change:thr_a"));
  assert.match(texts(page).join(" "), /owner\/name/);
  assert.match(texts(page).join(" "), /Backlog/);
});

test("a failed ticket reload keeps the ticket open and shows the error", async () => {
  const v = fake(detail());
  v.ticketId = "tkt_missing";
  v.error = "";
  await refreshTicket(v);
  assert.equal(v.ticketId, "tkt_missing");
  assert.match(v.error, /Couldn't read #tkt_missing/);
});
