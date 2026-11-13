// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { SidebarList, withOtherThreads, stageGlyph } = await import("./sidebar.js");
const { agentMark, programName } = await import("./agents.js");
const busy = await import("./busy.js");
const { colors, cx, ids, labels, texts, walk } = await import("./test/support/view.js");

function instance(extra = {}) {
  const view = Object.create(SidebarList.prototype);
  Object.assign(view, {
    expanded: new Set(), collapsed: new Set(), selected: null, onlyNeeds: false,
    data: { tickets: [], loose: [] }, opened: [], acted: [],
    act(_cx, fn) { view.acted.push(fn); }, open(row) { view.opened.push(row.id); },
    ...extra,
  });
  return view;
}

const colorsValue = colors();

test("a ticket row shows its number, title, glyph and next-stage action", () => {
  const ticket = { id: "tkt_1", number: 1, title: "Ship it", stage: "backlog", projectId: "prj_1", proposed: false };
  const row = { kind: "ticket", id: "tkt_1", ticket, threads: [], thread: null, depth: 0 };
  const view = instance();
  const line = SidebarList.prototype.itemRow.call(view, row, null, colorsValue, cx());
  assert.match(texts(line).join(" "), /#1/);
  assert.ok(texts(line).includes("Ship it"), "the title is the row's text, cut with an ellipsis, not a button label");
  assert.equal(labels(line).includes("#1 Ship it"), false);
  assert.ok(ids(line).includes("row:tkt_1"));
  assert.ok(ids(line).includes("row-menu:tkt_1"), "one ··· instead of text buttons");
  assert.equal(labels(line).some(label => /In progress|Start|Ticket/.test(label)), false);
});

test("a proposed row says Proposed, and a loose thread row has only its ··· menu", () => {
  const ticket = { id: "tkt_2", number: 2, title: "Maybe", stage: "backlog", projectId: "prj_1", proposed: true };
  const view = instance();
  const proposed = SidebarList.prototype.itemRow.call(view, { kind: "ticket", id: "tkt_2", ticket, threads: [], thread: null, depth: 0 }, null, colorsValue, cx());
  assert.match(texts(proposed).join(" "), /Proposed/);
  const thread = { id: "thr_a", projectId: "prj_1", title: "Loose", status: "idle" };
  const loose = SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "thr_a", ticket: null, thread, depth: 0 }, null, colorsValue, cx());
  assert.deepEqual(labels(loose), ["···"]);
});

test("keyboard navigation selects, opens and expands rows", () => {
  const view = instance();
  const rows = [
    { id: "a", needs: true, ticket: null },
    { id: "b", needs: false, ticket: { id: "tkt_1" } },
    { id: "c", needs: false, ticket: { id: "tkt_2" } },
  ];
  const context = cx();
  SidebarList.prototype.onKey.call(view, { key: "down" }, rows, context);
  assert.equal(view.selected, "a");
  SidebarList.prototype.onKey.call(view, { key: "down" }, rows, context);
  assert.equal(view.selected, "b");
  SidebarList.prototype.onKey.call(view, { key: "right" }, rows, context);
  assert.equal(view.expanded.has("tkt_1"), true);
  SidebarList.prototype.onKey.call(view, { key: "left" }, rows, context);
  assert.equal(view.expanded.has("tkt_1"), false);
  SidebarList.prototype.onKey.call(view, { key: "enter" }, rows, context);
  assert.deepEqual(view.opened, ["b"]);
});

test("a project header folds and opens its board", () => {
  const view = instance();
  const row = { id: "prj_1", project: { id: "prj_1", name: "One" }, needs: 2 };
  const header = SidebarList.prototype.projectRow.call(view, row, colorsValue, cx());
  assert.ok(texts(header).includes("One"));
  assert.ok(ids(header).includes("project:prj_1"), "clicking the header folds the project, as in bb");
  assert.ok(ids(header).includes("board:prj_1"));
});

test("a project's loose threads sit under one Other threads heading after its tickets, and fold", () => {
  const rows = [
    { project: { id: "p" }, id: "p" },
    { kind: "thread", id: "t1", depth: 0 },
    { kind: "ticket", id: "k1", depth: 0 },
    { kind: "thread", id: "t2", depth: 0 },
  ];
  assert.deepEqual(withOtherThreads(rows, new Set()).map(r => `${r.id}:${r.depth}`), ["p:undefined", "k1:0", "other:p:0", "t1:0", "t2:0"], "loose threads line up with tickets, as in bb");
  assert.equal(withOtherThreads(rows, new Set()).find(r => r.kind === "other").count, 2);
  assert.deepEqual(withOtherThreads(rows, new Set(["other:p"])).map(r => r.id), ["p", "k1", "other:p"]);
});

test("a thread shows the bundled mark of the agent it runs", () => {
  assert.equal(programName("claude --model claude-opus-5-5"), "claude");
  assert.equal(programName("/usr/local/bin/cursor-agent"), "cursor-agent");
  assert.equal(agentMark("claude --effort high"), "agents/claude.svg");
  assert.equal(agentMark("cursor-agent"), "agents/cursor.svg");
  assert.equal(agentMark("bash"), null);
  assert.equal(agentMark(undefined), null);
});

test("a thread row marks work, failure and an unread reply with one small mark, and stays quiet when idle", () => {
  const view = instance();
  const nodes = thread => walk(SidebarList.prototype.itemRow.call(view, { kind: "thread", id: thread.id, ticket: null, thread, depth: 0 }, null, colorsValue, cx()));
  const base = { projectId: "prj_1", title: "T", lastReadAt: 5, latestAttentionAt: 1 };
  assert.equal(nodes({ ...base, id: "a", status: "active" }).some(n => n.kind === "spinner"), false, "a running program between turns is not busy");
  busy.record("thread.turn.started", "a");
  assert.ok(nodes({ ...base, id: "a", status: "active" }).some(n => n.kind === "spinner"));
  busy.record("thread.waiting", "a");
  assert.equal(nodes({ ...base, id: "a", status: "active" }).some(n => n.kind === "spinner"), false);
  assert.ok(texts(SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "b", ticket: null, thread: { ...base, id: "b", status: "error" }, depth: 0 }, null, colorsValue, cx())).includes("!"));
  const idle = nodes({ ...base, id: "c", status: "idle" });
  assert.equal(idle.some(n => n.kind === "spinner"), false);
  assert.equal(texts(SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "c", ticket: null, thread: { ...base, id: "c", status: "idle" }, depth: 0 }, null, colorsValue, cx())).includes("idle"), false);
});

test("busy follows turn events, whichever spelling the event arrives in", () => {
  assert.equal(busy.record("thread.turn.started", "x"), true);
  assert.equal(busy.isBusy("x"), true);
  assert.equal(busy.record("turn.started", "x"), false, "a repeat changes nothing");
  assert.equal(busy.record("turn.ended", "x"), true);
  assert.equal(busy.isBusy("x"), false);
  busy.record("thread.turn.started", "y");
  busy.record("thread.exited", "y");
  assert.equal(busy.isBusy("y"), false);
});

test("the row of the thread on screen is lit, and a folded ticket lights for its thread", async () => {
  const host = await import("./test/support/kagan-host.js");
  host.state.onScreen = "thr_open";
  try {
    const view = instance();
    const bg = node => (walk(node)[0].props.bg ?? [])[0];
    const thread = { id: "thr_open", projectId: "prj_1", title: "Open", status: "idle" };
    assert.equal(bg(SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "thr_open", ticket: null, thread, depth: 0 }, null, colorsValue, cx())), colorsValue.accent);
    const other = { ...thread, id: "thr_other" };
    assert.equal(bg(SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "thr_other", ticket: null, thread: other, depth: 0 }, null, colorsValue, cx())), undefined);
    const ticket = { id: "tkt_9", number: 9, title: "T", stage: "in-progress", projectId: "prj_1", proposed: false };
    const row = { kind: "ticket", id: "tkt_9", ticket, threads: [other, thread], thread: other, depth: 0 };
    assert.equal(bg(SidebarList.prototype.itemRow.call(view, row, null, colorsValue, cx())), colorsValue.accent);
  } finally {
    host.state.onScreen = undefined;
  }
});

test("stage circles are drawn shapes of one size, told apart by fill", () => {
  const shape = stage => walk(stageGlyph(stage, colorsValue));
  for (const stage of ["backlog", "in-progress", "review", "done"]) {
    assert.deepEqual([shape(stage)[0].props.w, shape(stage)[0].props.h], [[12], [12]], `${stage} is 12px`);
  }
  assert.ok("border_dashed" in shape("backlog")[0].props, "Backlog is a dashed ring");
  assert.ok(shape("in-progress").some(n => "rounded_tl" in n.props), "In progress fills its left half");
  assert.equal(shape("review").length, 2, "Review is a ring around a dot");
  assert.ok("bg" in shape("done")[0].props, "Done is a full disc");
});

test("the ··· menu offers Pin and Archive from kagan's thread menu, and Open ticket on board for a ticket", () => {
  const view = instance();
  const thread = { id: "thr_a", projectId: "prj_1", title: "Loose", status: "idle", pinned: false };
  const loose = view.rowActions({ kind: "thread", id: "thr_a", thread, ticket: null });
  assert.deepEqual(loose.map(a => a.label), ["Pin", "Archive"]);
  const ticket = { id: "tkt_1", number: 1, title: "T", stage: "in-progress", projectId: "prj_1" };
  const two = [thread, { ...thread, id: "thr_b", pinned: true }];
  const many = view.rowActions({ kind: "ticket", id: "tkt_1", ticket, threads: two, thread: two[0] });
  assert.deepEqual(many.map(a => a.label), ["Unpin", "Open ticket on board"], "a ticket archives only with one thread");
  const bare = view.rowActions({ kind: "ticket", id: "tkt_2", ticket, threads: [], thread: null });
  assert.deepEqual(bare.map(a => a.label), ["Open ticket on board"]);
  const child = view.rowActions({ kind: "ticket-thread", id: "child:thr_a", ticket, thread });
  assert.deepEqual(child.map(a => a.label), ["Pin", "Archive", "Open ticket on board"]);
});
