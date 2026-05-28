/**
 * Tests for `CompletionWakeTracker` — the item-11 dead-man-switch
 * for missed completion wakes.
 *
 * Pure unit tests; no timers, no I/O. The host's `setInterval` +
 * `pi.on("turn_start", ...)` wiring is covered by the integration
 * smoke at `tests/index.test.ts` (or by manual re-run of the
 * builder-rjpb scenario).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CompletionWakeTracker,
  DEFAULT_MAX_REFIRES_PER_RUN,
  DEFAULT_STALE_THRESHOLD_MS,
} from "../src/completion-wake-tracker.ts";

test("CompletionWakeTracker: track sets sentAt + refireCount=0", () => {
  const t = new CompletionWakeTracker();
  t.track("builder-x", 1000);
  const entry = t.inspectPending().get("builder-x");
  assert.ok(entry, "must be in pending after track()");
  assert.equal(entry.sentAt, 1000);
  assert.equal(entry.refireCount, 0);
});

test("CompletionWakeTracker: clearOnTurnStart clears all pending", () => {
  const t = new CompletionWakeTracker();
  t.track("a", 1000);
  t.track("b", 1100);
  assert.ok(t.hasPending());
  t.clearOnTurnStart();
  assert.equal(t.hasPending(), false);
  assert.equal(t.inspectPending().size, 0);
});

test("CompletionWakeTracker: tick within threshold → no refire, no expired", () => {
  const t = new CompletionWakeTracker({ staleThresholdMs: 30_000 });
  t.track("a", 1000);
  // 29s after sending — under the 30s threshold.
  const res = t.tick(1000 + 29_000);
  assert.deepEqual(res, { refire: [], expired: [] });
  // Pending entry unchanged.
  assert.equal(t.inspectPending().get("a")?.sentAt, 1000);
  assert.equal(t.inspectPending().get("a")?.refireCount, 0);
});

test("CompletionWakeTracker: tick past threshold → refire and reset sentAt + bump refireCount", () => {
  const t = new CompletionWakeTracker({ staleThresholdMs: 30_000 });
  t.track("a", 1000);
  const now = 1000 + 30_001; // 30.001s after sending
  const res = t.tick(now);
  assert.deepEqual(res.refire, ["a"]);
  assert.deepEqual(res.expired, []);
  // sentAt resets; refireCount bumps.
  const entry = t.inspectPending().get("a");
  assert.ok(entry);
  assert.equal(entry.sentAt, now);
  assert.equal(entry.refireCount, 1);
});

test("CompletionWakeTracker: tick at refire cap → entry moves to expired and is removed", () => {
  const t = new CompletionWakeTracker({
    staleThresholdMs: 30_000,
    maxRefiresPerRun: 2,
  });
  // Track + drive past threshold three times to hit the cap.
  t.track("a", 1000);
  let res = t.tick(1000 + 30_001);
  assert.deepEqual(res.refire, ["a"]);
  res = t.tick(1000 + 60_002);
  assert.deepEqual(res.refire, ["a"]);
  // Now refireCount === 2 (== cap). One more stale tick → expired.
  res = t.tick(1000 + 90_003);
  assert.deepEqual(res.refire, []);
  assert.deepEqual(res.expired, ["a"]);
  // And it's removed from pending.
  assert.equal(t.inspectPending().has("a"), false);
});

test("CompletionWakeTracker: drop removes a specific entry without affecting others", () => {
  const t = new CompletionWakeTracker();
  t.track("a", 1000);
  t.track("b", 1100);
  t.drop("a");
  assert.equal(t.inspectPending().has("a"), false);
  assert.ok(t.inspectPending().has("b"));
});

test("CompletionWakeTracker: defaults — threshold 30s, cap 2 refires", () => {
  // Pinned defaults so a regression on the constants is loud.
  assert.equal(DEFAULT_STALE_THRESHOLD_MS, 30_000);
  assert.equal(DEFAULT_MAX_REFIRES_PER_RUN, 2);
});

test("CompletionWakeTracker: tick returns multiple runs at once", () => {
  // Concurrent stale wakes — both surface in the same tick.
  const t = new CompletionWakeTracker({ staleThresholdMs: 30_000 });
  t.track("a", 1000);
  t.track("b", 1500);
  const res = t.tick(1000 + 60_000); // both > 30s old
  assert.equal(res.refire.length, 2);
  assert.ok(res.refire.includes("a"));
  assert.ok(res.refire.includes("b"));
});

test("CompletionWakeTracker: tick on empty tracker is a no-op", () => {
  const t = new CompletionWakeTracker();
  const res = t.tick(99_999);
  assert.deepEqual(res, { refire: [], expired: [] });
});
