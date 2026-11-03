// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  canNest, commentWhen, descriptionPreview, dropOnCard, dropOnColumn, dropOnLoose, failInterruptedHandoff,
  handoffSteps, moveWarning, needsYou, pendingMoveControls, planHandoff, planMove, remainingSettleSteps,
  resolveHandoffOptions, SETTLE_AFTER_SPAWN, SETTLE_STEPS, threadStartupInput, withSettleStep,
} from "./model.js";

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

test("a failed handoff needs attention even when the error text is empty", () => {
  const quiet = ticket("tkt_9", 9, "in-progress");
  assert.equal(needsYou(quiet), false);
  assert.equal(needsYou({ ...quiet, handoff: { status: "failed", error: null } }), true);
  assert.equal(needsYou({ ...quiet, handoff: { status: "running", error: "The reply has no handoff" } }), true);
});

test("a move with live threads confirms Done and offers a handoff before it archives", () => {
  const working = { ...elsewhere, threads: [{ id: "thr_a" }] };
  assert.equal(planMove(working, "done").action, "confirm-done");
  assert.equal(planMove(working, "review").action, "handoff");
  assert.equal(planMove(working, "backlog").action, "move");
  assert.equal(planMove({ ...elsewhere, threads: [] }, "done").action, "move");
  assert.equal(planMove(gated, "in-progress").action, "refuse");
  assert.equal(planMove(working, "in-progress").action, "ignore");
});

test("a handoff retry finishes cleanup and does not spawn again", () => {
  const live = { thr_a: { onTicket: true, archived: false }, thr_b: { onTicket: true, archived: false } };
  const spawned = planHandoff({ sources: ["thr_a", "thr_b"], threads: live });
  assert.deepEqual(handoffSteps(spawned), ["comment", "spawn"]);
  assert.deepEqual(spawned.archive, ["thr_a", "thr_b"]);
  assert.ok(SETTLE_AFTER_SPAWN.includes("attach"));
  assert.ok(SETTLE_AFTER_SPAWN.includes("paste"));
  assert.ok(SETTLE_AFTER_SPAWN.includes("toast"));
  assert.equal(planHandoff({ sources: ["thr_a"], threads: { thr_a: { onTicket: true, archived: true } } }).action, "refuse");
  const resume = planHandoff({
    sources: ["thr_a", "thr_b"],
    nextThreadId: "thr_next",
    threads: { thr_a: { onTicket: true, archived: true }, thr_b: { onTicket: true, archived: false } },
  });
  assert.equal(resume.action, "resume");
  assert.equal(resume.nextThreadId, "thr_next");
  assert.deepEqual(resume.archive, ["thr_b"]);
  assert.deepEqual(handoffSteps(resume), ["finish-successor"]);
});

test("resubmitting a failed handoff resumes the saved successor instead of spawning again", () => {
  const saved = {
    status: "failed",
    sources: ["thr_a"],
    persona: "implementer",
    prompt: "Continue",
    consolidate: false,
    nextThreadId: "thr_next",
  };
  const merged = resolveHandoffOptions({ sourceThreadIds: ["thr_a"], persona: "implementer", prompt: "Continue" }, saved);
  assert.equal(merged.action, "resume");
  assert.equal(merged.nextThreadId, "thr_next");
  assert.equal(planHandoff({
    sources: merged.sourceThreadIds,
    nextThreadId: merged.nextThreadId,
    threads: { thr_a: { onTicket: true, archived: false } },
  }).action, "resume");
  assert.deepEqual(handoffSteps({ action: "resume", nextThreadId: "thr_next", archive: ["thr_a"] }), ["finish-successor"]);
});

test("a new handoff while archival awaits keeps the saved sources and refuses a successor as a source", () => {
  const awaiting = {
    status: "awaiting-archive",
    sources: ["thr_a"],
    persona: "implementer",
    prompt: "Continue",
    consolidate: false,
    nextThreadId: "thr_b",
  };
  assert.equal(resolveHandoffOptions({ sourceThreadIds: ["thr_b"], prompt: "Next" }, awaiting).action, "refuse");
  const resume = resolveHandoffOptions({ sourceThreadIds: ["thr_b"] }, { ...awaiting, status: "failed", nextThreadId: "thr_b" });
  assert.equal(resume.action, "resume");
  assert.deepEqual(resume.sourceThreadIds, ["thr_a"]);
  assert.equal(resume.prompt, "Continue");
  assert.equal(planHandoff({
    sources: ["thr_b"],
    nextThreadId: "thr_b",
    threads: { thr_b: { onTicket: true, archived: false } },
  }).action, "refuse");
});

test("retry skips paste after a later toast failure", () => {
  const afterPaste = withSettleStep(withSettleStep({}, "attached"), "pasted");
  assert.deepEqual(remainingSettleSteps(afterPaste), ["env", "opened", "toasted"]);
  assert.ok(!remainingSettleSteps(afterPaste).includes("pasted"));
  assert.deepEqual(
    remainingSettleSteps(withSettleStep(withSettleStep(withSettleStep(withSettleStep(withSettleStep({}, "attached"), "env"), "opened"), "pasted"), "toasted")),
    [],
  );
});

test("a finished handoff leaves sources live until Archive sources", () => {
  assert.equal(needsYou({ ...elsewhere, handoff: { status: "awaiting-archive", error: null } }), true);
  assert.ok(!handoffSteps({ action: "spawn", archive: ["thr_a"] }).includes("archive"));
  assert.ok(!handoffSteps({ action: "resume", nextThreadId: "thr_next", archive: ["thr_a"] }).includes("archive"));
});

test("the prompt and persona are pasted as thread input, not only the title", () => {
  const text = threadStartupInput({
    personaText: "# Implementer\nShip it.",
    prompt: "Fix the flaky test",
    ticketId: "tkt_3",
  });
  assert.match(text, /# Implementer/);
  assert.match(text, /Fix the flaky test/);
  assert.match(text, /kg kanban ticket show tkt_3/);
  assert.equal(
    threadStartupInput({ ticketId: "tkt_3" }),
    "Run kg kanban ticket show tkt_3 first; read its description and comments.",
  );
});

test("a proposed move still has Accept, Dismiss and Won't do after the board sets pendingMove", async () => {
  const proposed = { ...elsewhere, pendingStage: "review" };
  const done = { ...elsewhere, pendingStage: "done" };
  assert.deepEqual(pendingMoveControls(proposed, "card:tkt_3"), {
    prompt: "Move to Review?",
    actions: [
      { id: "card:tkt_3:accept-move", label: "Accept" },
      { id: "card:tkt_3:dismiss-move", label: "Dismiss" },
    ],
  });
  assert.deepEqual(pendingMoveControls(done, "detail").actions.map(a => a.label), ["Accept", "Dismiss", "Won't do"]);
  assert.equal(pendingMoveControls(elsewhere, "card:tkt_3"), null);
  const { readFileSync } = await import("node:fs");
  const views = readFileSync(new URL("./views.js", import.meta.url), "utf8");
  assert.match(views, /renderPendingMove\(/);
  assert.match(views, /this\.pendingMove = null/);
  assert.equal(/^\s*pendingMove\(/m.test(views), false);
});

test("an interrupted running handoff becomes a failed job Retry can finish", () => {
  const running = { ticket_id: "tkt_1", status: "running", error: null, next_thread_id: "thr_next" };
  const failed = failInterruptedHandoff(running);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Interrupted before the handoff finished");
  assert.equal(failed.next_thread_id, "thr_next");
  assert.equal(failInterruptedHandoff({ ...running, error: "toast failed" }).error, "toast failed");
  assert.equal(failInterruptedHandoff({ ...running, status: "failed" }).status, "failed");
});

test("a handoff move keeps the same WIP and blocker warning as a plain move", () => {
  assert.equal(moveWarning({ warning: "Still blocked by #2" }), "Still blocked by #2");
  assert.equal(moveWarning({ id: "tkt_1" }), "");
  assert.equal(moveWarning(null), "");
});

test("a proposed card shows a short description, and comments show when they were written", () => {
  assert.equal(descriptionPreview("Ship it."), "Ship it.");
  assert.equal(descriptionPreview("x".repeat(300)).endsWith("…"), true);
  assert.equal(descriptionPreview("   "), null);
  assert.equal(commentWhen(Date.UTC(2026, 10, 3)), new Date(Date.UTC(2026, 10, 3)).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  assert.equal(commentWhen(null), "");
});

test("a Done move clears handoff settle progress so reopen then handoff starts fresh", async () => {
  const { readFileSync } = await import("node:fs");
  const storeSrc = readFileSync(new URL("./store.js", import.meta.url), "utf8");
  assert.match(storeSrc, /wanted === "done"[\s\S]*?await deleteHandoff\(id\)/);
  assert.equal(/wanted === "done" && t\.stage !== "done"[\s\S]*?DELETE FROM handoff WHERE ticket_id/.test(storeSrc), false);
  const stale = SETTLE_STEPS.reduce((done, step) => withSettleStep(done, step), {});
  assert.deepEqual(remainingSettleSteps(stale), []);
  assert.deepEqual(remainingSettleSteps({}), [...SETTLE_STEPS]);
});
