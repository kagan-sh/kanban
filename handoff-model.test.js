// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_SECTIONS, extractHandoff, handoffResumes, handoffSection, successorPrompt } from "./handoff-model.js";

const output = "Some chatter\n\n## Handoff\n\n### Goal\nShip it.\n\n### Completed\n- A change\n\n### Verified\nTests pass.\n";

test("a handoff is read from the newest block when Goal and Verified are present", () => {
  const found = extractHandoff(output);
  assert.equal(found.structured, true);
  assert.equal(found.text, output.slice(output.indexOf("## Handoff")).trim());
  assert.deepEqual(HANDOFF_SECTIONS, ["Goal", "Completed", "Verified", "Decisions", "Next", "Blocked", "Safe to Pick Up"]);
});

test("a reply without Goal or Verified is not a handoff", () => {
  assert.equal(extractHandoff("## Handoff\n\n### Goal\nOnly a goal.\n").structured, false);
  assert.equal(extractHandoff("### Verified\nOnly evidence.\n").structured, false);
  assert.equal(extractHandoff("no handoff here").structured, false);
});

test("the newest block wins when a thread wrote one before", () => {
  const twice = `${output}\n\n### Next\n\nSecond try\n\n## Handoff\n\n### Goal\nSecond\n\n### Verified\nStill passes.\n`;
  const found = extractHandoff(twice);
  assert.equal(found.structured, true);
  assert.match(found.text, /Second/);
  assert.equal(found.text.includes("Ship it"), false);
});

test("a section ends at the next heading", () => {
  assert.equal(handoffSection(output, "Goal"), "Ship it.");
  assert.equal(handoffSection(output, "Completed"), "- A change");
  assert.equal(handoffSection(output, "Verified"), "Tests pass.");
  assert.equal(handoffSection(output, "Next"), null);
});

test("the successor prompt carries the handoff and how to treat it", () => {
  const text = successorPrompt({ id: "tkt_1", number: 1, title: "Ship it" }, output);
  assert.match(text, /#1 "Ship it"/);
  assert.match(text, /decisions as in effect/);
  assert.match(text, /## Handoff/);
});

test("a saved successor is resumed instead of spawned twice", () => {
  assert.equal(handoffResumes({ nextThreadId: "thr_next", status: "handing-off" }), true);
  assert.equal(handoffResumes({ nextThreadId: "thr_next", status: "failed" }), true);
  assert.equal(handoffResumes({ nextThreadId: "thr_next", status: "awaiting-archive" }), false);
  assert.equal(handoffResumes({ nextThreadId: null, status: "handing-off" }), false);
  assert.equal(handoffResumes(null), false);
});
