// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { checkCounts } from "./checks.js";

test("GitHub check rollups count once per conclusion", () => {
  assert.deepEqual(checkCounts([
    { conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" },
    { conclusion: "FAILURE" }, { conclusion: "CANCELLED" }, { conclusion: "TIMED_OUT" },
    { status: "IN_PROGRESS" }, { state: "PENDING" },
  ]), { passed: 3, failed: 3, pending: 2 });
  assert.deepEqual(checkCounts([]), { passed: 0, failed: 0, pending: 0 });
  assert.deepEqual(checkCounts(undefined), { passed: 0, failed: 0, pending: 0 });
});
