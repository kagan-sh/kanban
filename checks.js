// @ts-check

/** Counts for a GitHub statusCheckRollup: passed, failed and still running. */
export function checkCounts(rollup) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const check of rollup ?? []) {
    const state = String(check.conclusion ?? check.state ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) counts.passed += 1;
    else if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)) counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

