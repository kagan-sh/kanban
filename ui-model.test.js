// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { ago, threadTree } from "./ui-model.js";

test("a handoff time reads as a short age", () => {
  const now = Date.UTC(2026, 10, 5, 12);
  assert.equal(ago(now, now), "just now");
  assert.equal(ago(now - 20 * 60_000, now), "20 min ago");
  assert.equal(ago(now - 3 * 60 * 60_000, now), "3 h ago");
  assert.equal(ago(now - 26 * 60 * 60_000, now), "yesterday");
  assert.equal(ago(now - 4 * 24 * 60 * 60_000, now), "4 days ago");
});

test("threads list parent before child, and an orphan stays a root", () => {
  const root = { id: "thr_a", parentThreadId: null };
  const child = { id: "thr_b", parentThreadId: "thr_a" };
  const grandchild = { id: "thr_c", parentThreadId: "thr_b" };
  const orphan = { id: "thr_d", parentThreadId: "missing" };
  assert.deepEqual(threadTree([child, grandchild, root, orphan]), [[root, 0], [child, 1], [grandchild, 2], [orphan, 0]]);
  assert.deepEqual(threadTree([]), []);
});
