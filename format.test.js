// @ts-check
import { newStartProblem, USER_STORY_WARNING } from "./rules.js";
import test from "node:test";
import assert from "node:assert/strict";
import { boardLines, formatResult, noteTitle, prose, rulesLines, ticketLines } from "./format.js";

const story = { kind: "story", stage: "backlog", description: "" };

test("--json is one JSON document and nothing else", () => {
  const ticket = { id: "tkt_1", number: 1, title: "Ship it", stage: "backlog", kind: "task" };
  const out = formatResult(ticket, true);
  assert.deepEqual(JSON.parse(out), ticket);
  assert.equal(out.trim().split("\n").length, 1);
  assert.match(formatResult(ticket, false), /"title": "Ship it",\n  "stage": "backlog"[\s\S]*\nKind: task/);
  assert.equal(formatResult(undefined, false), "Done\n");
});

test("the list prints one line per ticket and counts loose threads", () => {
  const board = {
    tickets: [
      { number: 2, title: "Second", stage: "in-progress", threads: [{}, {}] },
      { number: 1, title: "First", stage: "backlog", threads: [] },
    ],
    loose: [{ id: "thr_a" }],
  };
  const lines = boardLines(board).split("\n");
  assert.match(lines[0], /^backlog +#1 +First +\[0 threads\]$/);
  assert.match(lines[1], /^in-progress +#2 +Second +\[2 threads\]$/);
  assert.equal(lines[2], "1 loose thread not on a ticket");
  assert.equal(boardLines({ tickets: [], loose: [] }), "No tickets or threads in this project.");
});

test("rules print in plain words", () => {
  assert.match(rulesLines({ ageWarnDays: 14, wipLimit: null }), /No work-in-progress limit/);
  assert.match(rulesLines({ ageWarnDays: 7, wipLimit: 3 }), /after 7 days/);
  assert.match(rulesLines({ ageWarnDays: 7, wipLimit: 3 }), /limit: 3 tickets/);
});

test("a shown ticket prints rank, criteria, stage clock, relationships and comments", () => {
  const detail = {
    number: 4, title: "Ship it", stage: "review", kind: "story", resolution: "done",
    description: "## Acceptance criteria\n- [x] A\n- [ ] B\n",
    backlogRank: { position: 2, of: 5 },
    acceptanceCriteria: { done: 1, total: 2 },
    startProblem: null, daysInStage: 3, ageWarnDays: 14, wip: { count: 2, limit: 3 },
    parent: { number: 1, title: "Epic", stage: "in-progress" },
    blockedBy: [{ number: 2, title: "API", stage: "backlog" }, { number: 3, title: "Done one", stage: "done" }],
    blocks: [{ number: 5, title: "UI", stage: "backlog" }],
    subTickets: [
      { number: 6, title: "Child", stage: "backlog", blockedBy: [{ stage: "backlog" }] },
      { number: 7, title: "Finished", stage: "done", blockedBy: [] },
    ],
    threads: [{ id: "thr_a", title: "Work", status: "active" }],
    comments: [{ body: "A decision", threadId: "thr_a", persona: "implementer", createdAt: Date.UTC(2026, 10, 3) }],
  };
  const lines = ticketLines(detail);
  assert.match(lines, /Backlog rank 2 of 5/);
  assert.match(lines, /Acceptance criteria: 1 of 2 done/);
  assert.match(lines, /In review for 3 days/);
  assert.match(lines, /In progress holds 2 of a limit of 3/);
  assert.match(lines, /Sub-ticket of #1 Epic \(in-progress\)/);
  assert.match(lines, /Blocked by #2 API \(backlog\)/);
  assert.match(lines, /Blocked by #3 Done one \(done\)/);
  assert.match(lines, /Blocks #5 UI \(backlog\)/);
  assert.match(lines, /Sub-ticket #6 Child \(backlog, blocked\)/);
  assert.match(lines, /Sub-ticket #7 Finished \(done\)/);
  assert.match(lines, /Comment by implementer thr_a/);
  assert.match(lines, /A decision/);
});

test("a user-story title gets a note and is never refused", () => {
  const ticket = { number: 1, title: "As a user I want to ship", stage: "backlog", kind: "task" };
  assert.equal(noteTitle(ticket).titleWarning, USER_STORY_WARNING);
  assert.match(ticketLines(noteTitle(ticket)), /Keep the title short/);
  assert.equal(noteTitle({ ...ticket, title: "Ship the board" }).titleWarning, undefined);
});

test("a new story cannot start outside Backlog, but a task can", () => {
  assert.match(newStartProblem("story", "in-progress"), /Acceptance criteria/);
  assert.match(newStartProblem("bug", "review"), /Steps to reproduce/);
  assert.equal(newStartProblem("task", "in-progress"), null);
  assert.equal(newStartProblem("story", "backlog"), null);
  assert.equal(newStartProblem(null, "review"), null);
});


test("a ticket detail prints ticket lines, not the rules summary", () => {
  const detail = { number: 7, title: "Ship it", stage: "review", kind: "task", ageWarnDays: 14, daysInStage: 2, description: "" };
  const lines = prose(detail);
  assert.match(lines, /In review for 2 days/);
  assert.equal(lines.includes("Age warning after 14 days"), false);
  assert.match(prose({ ageWarnDays: 14, wipLimit: null }), /Age warning after 14 days/);
});
