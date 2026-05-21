/**
 * Tests for the v0.11 on_complete_hook ⇄ watchdog interaction (slice 2).
 *
 * Invariant: while a run's `on_complete_hook` is in flight (the pi
 * subprocess has already closed and the parent is awaiting a hook
 * subprocess), the watchdog must NOT classify the run as stalled.
 * `Run.hookExecuting === true` is the signal.
 *
 * WDD parallel-formula compliance: every assertion calls `evaluateRun`
 * or `classifyStall` directly with crafted fixtures whose only meaningful
 * difference from the corresponding stall-trip fixture is `hookExecuting`.
 * The mutation that drops the suppression check on the production side
 * makes the same fixture trip — that is what gives the witnesses teeth.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRun,
  classifyStall,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogConfig,
  type WatchdogState,
} from "../src/watchdog.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

const T0 = 1_700_000_000_000;
const CFG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-hook",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running" as RunStatus,
    startTime: T0,
    lastEventAt: T0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    ...overrides,
  };
}

const fresh: WatchdogState = { kind: "fresh" };

// ── evaluateRun: hookExecuting suppresses ALL transitions ──────────────

test("evaluateRun: run.hookExecuting=true suppresses soft transition (LOAD-BEARING)", () => {
  // Without hookExecuting, this fixture would fire a soft transition:
  // run is past grace (300s old), silent for 200s (>120s soft).
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    hookExecuting: true,
  });
  const out = evaluateRun(run, fresh, CFG, T0 + 200_000);
  assert.equal(out.transition.kind, "none");
  assert.deepEqual(out.nextState, fresh);
});

test("evaluateRun: run.hookExecuting=true suppresses hard transition", () => {
  // 700s silent — would normally fire hard.
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    hookExecuting: true,
  });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
});

test("evaluateRun: pin — without hookExecuting, the same fixture DOES trip soft", () => {
  // This pin test exists so the parallel formula is auditable: the
  // suppression's teeth are exactly the difference in transition.kind
  // between this fixture and the previous one.
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    // hookExecuting omitted → undefined
  });
  const out = evaluateRun(run, fresh, CFG, T0 + 200_000);
  assert.equal(out.transition.kind, "soft");
});

// ── classifyStall: hookExecuting suppresses classification ─────────────

test("classifyStall: run.hookExecuting=true returns null", () => {
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    hookExecuting: true,
  });
  const c = classifyStall(run, T0 + 700_000, DEFAULT_WATCHDOG_CONFIG);
  assert.equal(c, null);
});

test("classifyStall: pin — without hookExecuting, the same fixture classifies as hard", () => {
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
  });
  const c = classifyStall(run, T0 + 700_000, DEFAULT_WATCHDOG_CONFIG);
  assert.ok(c, "expected non-null classification when hookExecuting is undefined");
  assert.equal(c.severity, "hard");
});

// ── Composite: 200s in-flight hook vs 120s soft → no advisory ──────────
//
// This is one of the three oracle-blocking race tests for slice 2. It
// runs through `evaluateRun` (the pure detector) rather than the full
// Watchdog enforcer because the contract under test is the detector's
// suppression, not the dispatch wrapper.

test("watchdog ⇄ hook race: 200s in-flight hook does not emit a stall advisory", () => {
  // Spawn at T0; pi subprocess runs for 30s (no events past startTime),
  // closes; hook starts at T0+30_000 with hookExecuting=true; runs until
  // T0+230_000 (200s of hook execution). Detector ticks every 30s and
  // the watchdog's soft threshold is 120s.
  let prev: WatchdogState = fresh;
  const run = runFx({
    startTime: T0,
    lastEventAt: T0 + 30_000, // last event = pi's close
    hookExecuting: true,
  });
  const transitions: WatchdogState["kind"][] = [];
  for (let t = T0 + 60_000; t <= T0 + 230_000; t += 30_000) {
    const out = evaluateRun(run, prev, CFG, t);
    transitions.push(prev.kind);
    if (out.transition.kind !== "none") {
      transitions.push(out.transition.kind as WatchdogState["kind"]);
    }
    prev = out.nextState;
  }
  // Every tick must yield a no-op; never soft, never hard.
  for (const t of transitions) {
    assert.notEqual(t, "soft");
    assert.notEqual(t, "hard");
  }
});
