// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { briefingOf, ownWords, verificationLines } from "./briefing.js";

const handoff = "## Handoff\n\n### Goal\nShip.\n\n### Completed\n- The parser handles CRLF\n- The board reads it\n\n### Verified\n- Tests pass\n- Not run: the iOS build\n\n### Blocked\nNeeds a design call on the header\n\n### Next\nWire the button";

test("a briefing gathers the newest handoffs, what was proven, and what still waits", () => {
  const b = briefingOf({
    comments: [{ body: handoff, createdAt: 10, persona: "implementer" }],
    events: [{ text: "please finish this", at: 5, role: "user" }, { text: "ok", at: 6, role: "user" }],
    threads: [{ id: "thr_a", title: "Work", attention: "unread", at: 11 }],
  });
  assert.equal(b.you.text, "please finish this");
  assert.deepEqual(b.notes[0].done, ["The parser handles CRLF", "The board reads it"]);
  assert.deepEqual(b.notes[0].verified, ["Tests pass"]);
  assert.deepEqual(b.notes[0].unverified, ["the iOS build"]);
  assert.match(b.blocked, /Needs a design call/);
  assert.equal(b.next, "Wire the button");
  assert.equal(b.waiting.id, "thr_a");
});

test("a briefing is empty when nothing is news", () => {
  assert.equal(briefingOf({ comments: [], events: [], threads: [] }), null);
  assert.equal(briefingOf({ comments: [{ body: "A note", createdAt: 1, persona: null }], events: [], threads: [] }), null);
});

test("a handoff with no Completed or Verified line still offers its next step", () => {
  const b = briefingOf({
    comments: [{ body: "## Handoff\n\n### Goal\nShip.\n\n### Verified\nNothing verified yet.\n\n### Next\nAsk the person", createdAt: 1, persona: null }],
    events: [],
    threads: [],
  });
  assert.deepEqual(b.notes[0].verified, []);
  assert.deepEqual(b.notes[0].unverified, []);
  assert.equal(b.next, "Ask the person");
});

test("a Verified section splits where it turns to what was not proven", () => {
  assert.deepEqual(verificationLines("- Tests pass\n- Not run: the iOS build\n- the migration"), {
    verified: ["Tests pass"], unverified: ["the iOS build", "the migration"],
  });
  assert.deepEqual(verificationLines("nothing verified yet"), { verified: [], unverified: [] });
});

test("the board's own text and a bare go-ahead are not what the person said", () => {
  assert.equal(ownWords(["Board: handing off", "ok"]), null);
  assert.equal(ownWords(["Adopt this persona: reviewer", "2"]), null);
  assert.equal(ownWords(["Board: handing off", "make the header stick"]), "make the header stick");
  assert.equal(ownWords(["first", "second"]), "first\nsecond");
});
