// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./test/support/kagan-loader.mjs", import.meta.url).href);
const cards = await import("./cards.js");
const { colors, cx, view, ids, labels, texts } = await import("./test/support/view.js");

const c = colors();
const context = cx();

function ticket(extra = {}) {
  return {
    id: "tkt_1", projectId: "prj_1", number: 1, title: "Ship it", stage: "backlog", description: "",
    kind: "task", resolution: "done", parentId: null, proposed: false, threads: [], issue: null, handoff: null,
    ...extra,
  };
}

test("a card shows its id, title, meta and start action", () => {
  const t = ticket({ kind: "story", description: "## Acceptance criteria\n- [x] A\n" });
  const card = cards.renderCard(view({ data: { tickets: [t], loose: [] } }), t, context, c, { md: 4 });
  assert.ok(ids(card).includes("card:tkt_1"));
  assert.ok(labels(card).includes("Ship it"));
  assert.match(labels(card).join(" "), /Start a thread/);
  assert.ok(ids(card).includes("start-card:tkt_1"));
});

test("a proposed card offers Accept and Dismiss and shows its description", () => {
  const t = ticket({ proposed: true, description: "Why this exists" });
  const card = cards.renderCard(view(), t, context, c, { md: 4 });
  assert.ok(ids(card).includes("accept:tkt_1"));
  assert.ok(ids(card).includes("dismiss:tkt_1"));
  assert.ok(labels(card).includes("Accept"));
});

test("a pending move renders its controls from action ids, not labels", () => {
  const t = ticket({ stage: "review", pendingStage: "done", threads: [] });
  const pending = cards.renderPendingMove(view(), t, context, "card");
  assert.ok(ids(pending).includes("card:accept-move"));
  assert.ok(ids(pending).includes("card:dismiss-move"));
  assert.ok(ids(pending).includes("card:wont"));
  const failed = cards.renderHandoffState(view(), ticket({ handoff: { status: "failed", error: "no reply", consolidate: false } }), context, "card");
  assert.match(labels(failed).join(" "), /Retry/);
  const busy = cards.renderHandoffState(view(), ticket({ handoff: { status: "handing-off", consolidate: true, done: 1, total: 2 } }), context, "card");
  assert.match(texts(busy).join(" "), /Consolidating 1 of 2/);
});

test("an expanded card lists its threads and a blocked card names what it waits on", () => {
  const t = ticket({ threads: [{ id: "thr_a", title: "Work", status: "active" }], blockedBy: [{ id: "tkt_2", number: 2, title: "API", stage: "backlog" }] });
  const v = view({ data: { tickets: [t], loose: [] }, openThreads: new Set(["tkt_1"]) });
  const card = cards.renderCard(v, t, context, c, { md: 4 });
  assert.ok(ids(card).includes("card-thread:thr_a"));
  assert.ok(ids(card).includes("blocked:tkt_1:tkt_2"));
  assert.match(labels(card).join(" "), /#2/);
});
