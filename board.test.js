// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const { BoardPanel } = await import("./board.js");
const { InputState } = await import("./test/support/gpui-component.js");
const { colors, cx, view, ids, labels, texts } = await import("./test/support/view.js");

function board(extra = {}) {
  const instance = Object.create(BoardPanel.prototype);
  Object.assign(instance, {
    projectId: "prj_1", shown: new Set(), data: { tickets: [], loose: [] }, search: InputState("s"),
    over: null, drag: null, jumpId: null, doneLimit: 5, composerOpen: false, repos: [], issues: [],
    columns: [{}, {}, {}, {}], ruleMap: new Map(), openThreads: new Set(), ticketId: null,
    rule: null, ...extra,
  });
  instance.ticketsIn = () => extra.tickets ?? [];
  instance.dragSource = (el) => el;
  instance.dropTarget = (el) => el;
  instance.act = () => {};
  instance.remember = async () => {};
  instance.menu = () => view().menu();
  return instance;
}

const colorsValue = colors();
const context = cx();

test("a column shows its title, count and cards", () => {
  const ticket = { id: "tkt_1", projectId: "prj_1", number: 1, title: "Ship", stage: "backlog", description: "", kind: "task", resolution: "done", parentId: null, proposed: false, threads: [], issue: null, handoff: null, blockedBy: [] };
  const instance = board({ tickets: [ticket] });
  const column = BoardPanel.prototype.renderColumn.call(instance, "backlog", 0, context, colorsValue, { lg: 8 }, { ageWarnDays: 14, wipLimit: null }, 0, "");
  assert.match(texts(column).join(" "), /Backlog/);
  assert.ok(ids(column).includes("column:backlog"));
  assert.ok(ids(column).includes("ticket:tkt_1"));
  assert.ok(labels(column).join(" ").includes("New ticket"));
});

test("an over-limit In progress header shows the count against the limit", () => {
  const instance = board({ tickets: [] });
  const column = BoardPanel.prototype.renderColumn.call(instance, "in-progress", 1, context, colorsValue, { lg: 8 }, { ageWarnDays: 14, wipLimit: 1 }, 3, "");
  assert.match(texts(column).join(" "), /3 \/ 1/);
});

test("a move request from the host is stored for the next ticket load", () => {
  const instance = Object.create(BoardPanel.prototype);
  instance.projectId = null; instance.ticketId = null;
  instance.applyContext({ props: { projectId: "prj_9", ticketId: "tkt_9", move: "review", moveAt: 3 } });
  assert.equal(instance.projectId, "prj_9");
  assert.equal(instance.ticketId, "tkt_9");
  assert.deepEqual(instance.requestedMove, { stage: "review", ticketId: "tkt_9" });
});

test("a move request only applies to the ticket it named", () => {
  const instance = Object.create(BoardPanel.prototype);
  instance.ticket = { id: "tkt_2" };
  instance.requestedMove = { stage: "review", ticketId: "tkt_1" };
  const moves = [];
  instance.move = (ticket, stage) => moves.push([ticket.id, stage]);
  BoardPanel.prototype.consumeMove.call(instance, context);
  assert.deepEqual(moves, []);
  instance.requestedMove = { stage: "review", ticketId: "tkt_2" };
  BoardPanel.prototype.consumeMove.call(instance, context);
  assert.deepEqual(moves, [["tkt_2", "review"]]);
});
