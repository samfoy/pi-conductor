/**
 * Tests for RerenderCoalescer — pure timer helper used by the
 * focused-stream overlay shortcut to coalesce a burst of registry
 * events into at most two `tui.requestRender()` calls per quiet
 * window: one on the leading edge (fires synchronously the first
 * time, or any time outside the cooldown window) and one trailing
 * fire after the window quiesces.
 *
 * Slice 3 of the focused-stream overlay redesign — see
 * docs/focused-overlay-redesign-design.md §10 (re-render contract)
 * and docs/focused-overlay-redesign-plan.md §Slice 3.
 *
 * Tests use injectable clock + setTimeout mocks (NOT real timers) so
 * the leading/trailing semantics are deterministic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RerenderCoalescer } from "../src/rerender-coalescer.ts";
import { makeFakeClock } from "./helpers/fake-clock.ts";

// Slice 4 fold-in: shared fake-clock harness now lives in
// `tests/helpers/fake-clock.ts` (extracted from this file's original
// `makeFakeDeps` + the inline copy in `tests/focused-overlay-shortcut.test.ts`).
// `makeFakeDeps` here remains as a thin shim so the existing test
// bodies don't churn.
function makeFakeDeps(initialNow = 1000) {
  return makeFakeClock(initialNow);
}

test("RerenderCoalescer: fires leading-edge synchronously", () => {
  const fake = makeFakeDeps(1000);
  let fires = 0;
  const c = new RerenderCoalescer(() => fires++, 50, fake.deps);
  c.schedule();
  assert.equal(fires, 1, "first schedule must fire synchronously (leading edge)");
  assert.equal(fake.pendingCount(), 0, "no trailing timer armed yet");
});

test("RerenderCoalescer: fires trailing-edge once after quiet window", () => {
  const fake = makeFakeDeps(1000);
  let fires = 0;
  const c = new RerenderCoalescer(() => fires++, 50, fake.deps);
  c.schedule(); // leading at t=1000
  fake.advance(10);
  c.schedule(); // inside window; arms trailing
  assert.equal(fires, 1, "second schedule inside window must NOT fire synchronously");
  assert.equal(fake.pendingCount(), 1, "trailing timer must be armed");
  fake.advance(50); // past window end
  assert.equal(fires, 2, "trailing fire after window quiesces");
  assert.equal(fake.pendingCount(), 0, "no further timers pending");
});

test("RerenderCoalescer: coalesces N events in window into 2 fires (leading+trailing)", () => {
  const fake = makeFakeDeps(1000);
  let fires = 0;
  const c = new RerenderCoalescer(() => fires++, 50, fake.deps);
  // 10 schedules in rapid succession, each 1ms apart.
  for (let i = 0; i < 10; i++) {
    c.schedule();
    fake.advance(1);
  }
  // After 10 events spanning 9ms: leading + 1 trailing pending.
  assert.equal(fires, 1, "only leading-edge fired during the burst");
  assert.equal(fake.pendingCount(), 1, "exactly one trailing timer armed");
  fake.advance(100);
  assert.equal(fires, 2, "trailing fired exactly once; total = 2");
});

test("RerenderCoalescer: does not fire trailing if no event lands during window", () => {
  const fake = makeFakeDeps(1000);
  let fires = 0;
  const c = new RerenderCoalescer(() => fires++, 50, fake.deps);
  c.schedule(); // leading
  fake.advance(200); // long quiet
  assert.equal(fires, 1, "no trailing scheduled when only one event landed");
  assert.equal(fake.pendingCount(), 0, "no timer armed");
});

test("RerenderCoalescer: burst then quiesce paints final frame", () => {
  // Mirrors the design §15 concern: under stickToTail the user must
  // see the final state of a streaming run after the burst quiesces.
  // Concretely: burst of events at t=0..40, then quiet — trailing
  // fire at ~t=50 must paint the final frame.
  const fake = makeFakeDeps(1000);
  const frames: number[] = [];
  let frameCounter = 0;
  const c = new RerenderCoalescer(() => frames.push(frameCounter), 50, fake.deps);

  // Burst: 5 events at t=0,5,10,15,20 (relative). Tight enough to
  // stay inside the 50ms window so the trailing-edge timer is still
  // pending when the burst ends.
  for (let i = 0; i < 5; i++) {
    frameCounter += 1; // simulate state mutation that the next render would observe
    c.schedule();
    fake.advance(5);
  }
  // After burst: leading captured frame=1, no trailing fire yet.
  assert.deepEqual(frames, [1], "leading-edge captured first frame");
  // Quiesce: advance past window. Trailing must fire and observe the
  // most-recent state (frame=5).
  fake.advance(100);
  assert.deepEqual(
    frames,
    [1, 5],
    "trailing-edge captured the final frame (5), not a stale one",
  );
});
