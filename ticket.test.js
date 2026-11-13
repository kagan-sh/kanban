// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { renderTicket, refreshTicket } = await import("./ticket.js");
const { element } = await import("./test/support/gpui-kit.js");
const { cx, view, ids, labels, texts, walk } = await import("./test/support/view.js");

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
  assert.ok(texts(page).includes("Ship it"), "the title reads as text, left-aligned, not as a centered button label");
  assert.ok(ids(page).includes("edit-title"));
  assert.ok(ids(page).includes("tab-overview"));
  assert.match(texts(page).join(" "), /The description/);
  assert.ok(ids(page).includes("edit-ticket"));
  assert.ok(ids(page).includes("start-thread"));
  assert.ok(ids(page).includes("ticket-thread:thr_a"));
  assert.ok(labels(page).includes("Overview"));
  assert.ok(labels(page).includes("Activity · 1"));
  assert.ok(labels(page).includes("Reviews"));
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

test("an empty ticket hides relationship labels and keeps the kind control compact", () => {
  const t = detail({
    stage: "backlog", kind: "story", description: "", threads: [], links: [], handoffSources: [],
    comments: [], title: "bla",
  });
  const page = renderTicket(fake(t), cx());
  const joined = texts(page).join(" ");
  assert.match(joined, /Can't leave Backlog yet/);
  assert.equal(joined.includes("Parent"), false);
  assert.equal(joined.includes("Sub-tickets"), false);
  assert.equal(joined.includes("Blocked by"), false);
  assert.ok(labels(page).includes("+ Add a description"));
  assert.ok(labels(page).includes("Story"));
  assert.ok(labels(page).includes("Start thread"));
  const kind = walk(page).find(item => (item.ids ?? []).includes("ticket-kind"));
  assert.equal(kind.kind, "menu");
  const tab = walk(page).find(item => (item.ids ?? []).includes("tab-overview"));
  assert.deepEqual(tab.props.selected, [true]);
  assert.ok(ids(page).includes("tab-activity"));
});

test("a peer ticket is offered as a parent, not an empty heading", () => {
  const t = detail({ stage: "backlog", kind: "task", description: "Done enough", threads: [], links: [], handoffSources: [] });
  const peer = { ...t, id: "tkt_2", number: 2, title: "Other", parentId: null, proposed: false };
  const child = { ...t, id: "tkt_3", number: 3, title: "Child", parentId: t.id, proposed: false };
  const v = fake(t);
  v.data = { tickets: [t, peer, child], loose: [{ id: "thr_loose", title: "Spare", projectId: "prj_1" }] };
  const page = renderTicket(v, cx());
  const parentMenu = walk(page).find(item => (item.ids ?? []).includes("parent-ticket"));
  const offered = (parentMenu.children ?? []).filter(kid => typeof kid?.label === "string").map(kid => kid.label);
  assert.ok(labels(page).includes("+ Set parent"));
  assert.ok(offered.includes("#2 Other"));
  assert.equal(offered.includes("#3 Child"), false);
  assert.ok(labels(page).includes("Attach a thread"));
  assert.equal(texts(page).join(" ").includes("Parent"), false);
});

test("a failed ticket reload keeps the ticket open and shows the error", async () => {
  const v = fake(detail());
  v.ticketId = "tkt_missing";
  v.error = "";
  await refreshTicket(v);
  assert.equal(v.ticketId, "tkt_missing");
  assert.match(v.error, /Couldn't read #tkt_missing/);
});

test("a stage history time reads as a short date and a 24-hour time", async () => {
  const { stamp } = await import("./ticket.js");
  const at = new Date(2026, 10, 13, 9, 5).getTime();
  assert.match(stamp(at), /, 09:05$/);
  assert.equal(stamp(Number.NaN), "");
});
