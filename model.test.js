// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { canNest, dropOnCard, dropOnColumn, dropOnLoose } from "./model.js";

const story = "A change.\n\n## Acceptance criteria\n\n- [ ] It lands\n";

function ticket(id, number, stage = "backlog", extra = {}) {
  return {
    id, number, stage, title: `Ticket ${number}`, projectId: "prj_1", proposed: false,
    kind: "task", description: "", parentId: null, threads: [], ...extra,
  };
}

const epic = ticket("tkt_1", 1);
const part = ticket("tkt_2", 2);
const elsewhere = ticket("tkt_3", 3, "in-progress");
const gated = ticket("tkt_4", 4, "backlog", { kind: "story", description: "" });
const ready = ticket("tkt_5", 5, "backlog", { kind: "story", description: story });

test("ranks a backlog card above or below another from the same project", () => {
  const tickets = [epic, part];
  assert.deepEqual(dropOnCard("ticket:tkt_2", "top", epic, tickets), {
    action: "rank", id: "tkt_2", place: { before: "tkt_1" }, label: "Drop to rank it above #1",
  });
  assert.deepEqual(dropOnCard("ticket:tkt_2", "bottom", epic, tickets), {
    action: "rank", id: "tkt_2", place: { after: "tkt_1" }, label: "Drop to rank it below #1",
  });
});

test("nests a card dropped on the middle, and refuses a card dropped on its own child", () => {
  const child = { ...part, parentId: "tkt_1" };
  assert.equal(canNest([epic, part], "tkt_2", "tkt_1"), true);
  assert.equal(dropOnCard("ticket:tkt_2", "middle", epic, [epic, part]).action, "nest");
  assert.equal(canNest([epic, child], "tkt_1", "tkt_2"), false);
  assert.equal(dropOnCard("ticket:tkt_1", "middle", child, [epic, child]).action, "ignore");
});

test("a drop on a card in another column moves, and a gated start says why", () => {
  assert.deepEqual(dropOnCard("ticket:tkt_3", "top", epic, [epic, elsewhere]), {
    action: "move", id: "tkt_3", stage: "backlog", label: "Drop to move to Backlog",
  });
  const refused = dropOnCard("ticket:tkt_4", "top", elsewhere, [gated, elsewhere]);
  assert.equal(refused.action, "refuse");
  assert.match(refused.reason, /Can't start #4/);
  assert.equal(dropOnColumn("ticket:tkt_5", "in-progress", [ready]).action, "move");
});

test("a proposed card cannot be dragged onto the board", () => {
  const proposed = ticket("tkt_9", 9, "backlog", { proposed: true });
  assert.equal(dropOnColumn("ticket:tkt_9", "in-progress", [proposed]).action, "refuse");
  assert.equal(dropOnCard("ticket:tkt_9", "middle", epic, [epic, proposed]).action, "refuse");
});

test("dropping a card on itself or on its own column does nothing", () => {
  assert.equal(dropOnCard("ticket:tkt_1", "middle", epic, [epic]).action, "ignore");
  assert.equal(dropOnColumn("ticket:tkt_1", "backlog", [epic]).action, "ignore");
  assert.equal(dropOnCard("ticket:tkt_1", null, epic, [epic]).action, "ignore");
});

test("a thread joins a card, makes a ticket on a column, and leaves on the loose list", () => {
  const host = { ...epic, threads: [{ id: "thr_a", title: "Work", projectId: "prj_1" }] };
  const loose = [{ id: "thr_b", title: "Loose", projectId: "prj_1" }];
  const other = [{ id: "thr_c", title: "Other", projectId: "prj_2" }];
  assert.equal(dropOnCard("thread:thr_b", "middle", host, [host], loose).action, "attach");
  assert.equal(dropOnCard("thread:thr_a", "bottom", host, [host], loose).action, "ignore");
  assert.equal(dropOnCard("thread:thr_b", "top", { ...host, stage: "done" }, [host], loose).action, "refuse");
  assert.equal(dropOnCard("thread:thr_c", "middle", host, [host], other).action, "refuse");
  assert.equal(dropOnColumn("thread:thr_b", "review", [host]).action, "create");
  assert.equal(dropOnColumn("thread:thr_a", "backlog", [host]).action, "ignore");
  assert.equal(dropOnColumn("thread:thr_b", "done", [host]).action, "refuse");
  assert.equal(dropOnLoose("thread:thr_a", [host]).action, "detach");
  assert.equal(dropOnLoose("thread:thr_b", [host]).action, "ignore");
  assert.equal(dropOnLoose("ticket:tkt_1", [host]).action, "ignore");
});
