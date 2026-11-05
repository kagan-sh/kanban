// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { BUG_TEMPLATE, acceptanceCriteria, daysInStage, isGated, looksLikeUserStory, parseKind, section, startProblem, USER_STORY_WARNING } from "./rules.js";

const story = "A change.\n\n## Acceptance criteria\n\n- [x] It lands\n- [ ] It is logged\n";

test("acceptance criteria count only checklist items under their heading", () => {
  assert.deepEqual(acceptanceCriteria(story), { done: 1, total: 2 });
  assert.deepEqual(acceptanceCriteria("## Acceptance criteria\n\n- [X] Caps count\n"), { done: 1, total: 1 });
  assert.deepEqual(acceptanceCriteria("## Acceptance criteria\n\nNo items"), { done: 0, total: 0 });
  assert.equal(acceptanceCriteria("## Other\n- [ ] Not counted\n"), null);
  assert.deepEqual(acceptanceCriteria("## Acceptance criteria\n\n```md\n- [ ] Code block\n```\n"), { done: 0, total: 1 });
  assert.deepEqual(acceptanceCriteria("## Acceptance criteria\n\n### Sub\n- [ ] Still inside the section\n"), { done: 0, total: 1 });
});

test("a section stops at a heading of the same or higher level", () => {
  assert.equal(section("## A\nbody\n## B\nother", "a"), "body");
  assert.equal(section("## A\nbody\n### B\ninner\n## C\nother", "A"), "body\n### B\ninner");
  assert.equal(section("no headings", "A"), null);
});

test("a story or bug is held in Backlog until its sections are filled in", () => {
  assert.equal(startProblem({ kind: "story", description: story }), null);
  assert.match(startProblem({ kind: "story", description: "" }), /Acceptance criteria/);
  assert.match(startProblem({ kind: "story", description: "## Acceptance criteria\n\nNo items" }), /no "- \[ \]" items/);
  assert.match(startProblem({ kind: "bug", description: "" }), /Steps to reproduce/);
  assert.equal(startProblem({ kind: "bug", description: "## Steps to reproduce\nSomething\n\n## Expected\nIt works\n\n## Actual\nIt fails\n" }), null);
  assert.equal(startProblem({ kind: "task", description: "" }), null);
  assert.equal(startProblem({ kind: null, description: "" }), null);
});

test("won't do reaches Done without the start rules", () => {
  assert.equal(isGated("backlog", "in-progress"), true);
  assert.equal(isGated("backlog", "done"), true);
  assert.equal(isGated("backlog", "done", "wont-do"), false);
  assert.equal(isGated("review", "done"), false);
});

test("kinds and user-story titles are read the way the board shows them", () => {
  assert.equal(parseKind("bug"), "bug");
  assert.equal(parseKind("none", true), null);
  assert.throws(() => parseKind("epic"), /story, bug, or task/);
  assert.equal(looksLikeUserStory("As a user I want this"), true);
  assert.equal(looksLikeUserStory("As an admin I want this"), true);
  assert.equal(looksLikeUserStory("Ship the board"), false);
  assert.match(USER_STORY_WARNING, /Keep the title short/);
  assert.match(BUG_TEMPLATE, /## Steps to reproduce/);
});

test("whole days in a column are counted and unknown times stay unknown", () => {
  const day = 24 * 60 * 60_000;
  assert.equal(daysInStage(null), null);
  assert.equal(daysInStage(Date.now() - 3 * day, Date.now()), 3);
  assert.equal(daysInStage(Date.now() + day), 0);
});
