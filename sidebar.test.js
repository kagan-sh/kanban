// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { SidebarList } = await import("./sidebar.js");
const { colors, cx, ids, labels, texts } = await import("./test/support/view.js");

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
  assert.match(labels(line).join(" "), /Ship it/);
  assert.ok(ids(line).includes("row:tkt_1"));
  assert.ok(ids(line).includes("move-ticket:tkt_1:in-progress"));
});

test("a proposed row says Proposed, and a loose thread row offers Ticket", () => {
  const ticket = { id: "tkt_2", number: 2, title: "Maybe", stage: "backlog", projectId: "prj_1", proposed: true };
  const view = instance();
  const proposed = SidebarList.prototype.itemRow.call(view, { kind: "ticket", id: "tkt_2", ticket, threads: [], thread: null, depth: 0 }, null, colorsValue, cx());
  assert.match(texts(proposed).join(" "), /Proposed/);
  const thread = { id: "thr_a", projectId: "prj_1", title: "Loose", status: "idle" };
  const loose = SidebarList.prototype.itemRow.call(view, { kind: "thread", id: "thr_a", ticket: null, thread, depth: 0 }, null, colorsValue, cx());
  assert.ok(ids(loose).includes("newtkt:thr_a"));
  assert.ok(ids(loose).includes("archive:thr_a"));
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
  assert.match(labels(header).join(" "), /One/);
  assert.ok(ids(header).includes("board:prj_1"));
});
