/**
 * Tests for the v0.10 watchdog detector — pure `evaluateRun`.
 *
 * Slice 1 scope: detection only. No enforcer, no kill path, no event
 * subscription. The detector is a pure function of (run snapshot, prior
 * state, config, now) → (transition, next state).
 *
 * Coverage targets (per design.md §2 + critic A3):
 *   1. fresh running, within grace → none
 *   2. past grace, no stall → none
 *   3. crossing soft first time → soft
 *   4. soft already, still soft → none (deduped via state)
 *   5. soft → hard
 *   6. hard, no recovery → none (deduped)
 *   7. recovered after soft (lastEventAt advanced) → recovered
 *   8. paused run (any age) → none
 *   9. terminal status → none
 *  10. (A3) streaming-thinking — periodic message_update bumps
 *      lastEventAt so the detector should NOT fire soft.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRun,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogConfig,
  type WatchdogState,
} from "../src/watchdog.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const CFG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

const T0 = 1_700_000_000_000;

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-test",
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
const soft: WatchdogState = { kind: "soft", crossedAt: T0 + 130_000 };
const hard: WatchdogState = { kind: "hard", crossedAt: T0 + 610_000 };

// ── Default config sanity ─────────────────────────────────────────────

test("DEFAULT_WATCHDOG_CONFIG: thresholds match design (120s/600s/30s)", () => {
  assert.equal(DEFAULT_WATCHDOG_CONFIG.softThresholdSeconds, 120);
  assert.equal(DEFAULT_WATCHDOG_CONFIG.hardThresholdSeconds, 600);
  assert.equal(DEFAULT_WATCHDOG_CONFIG.graceSeconds, 30);
});

test("DEFAULT_WATCHDOG_CONFIG: hard exceeds soft (sanity invariant)", () => {
  assert.ok(
    DEFAULT_WATCHDOG_CONFIG.hardThresholdSeconds >
      DEFAULT_WATCHDOG_CONFIG.softThresholdSeconds,
  );
});

// ── Negative cases (transition.kind === "none") ──────────────────────

test("evaluateRun: fresh run within grace window returns none", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  // 10s into the run, no events since start; grace covers it.
  const out = evaluateRun(run, fresh, CFG, T0 + 10_000);
  assert.equal(out.transition.kind, "none");
  assert.deepEqual(out.nextState, fresh);
});

test("evaluateRun: past grace, fresh activity → none", () => {
  // Run is 60s old (past 30s grace) and last event was 10s ago — well
  // under 120s soft. No transition.
  const run = runFx({ startTime: T0, lastEventAt: T0 + 50_000 });
  const out = evaluateRun(run, fresh, CFG, T0 + 60_000);
  assert.equal(out.transition.kind, "none");
  assert.equal(out.nextState.kind, "fresh");
});

test("evaluateRun: paused run inside soft window returns none (LOAD-BEARING)", () => {
  // Even though silent for >120s, paused runs do not stall.
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    pausedAt: T0 + 60_000,
  });
  const out = evaluateRun(run, fresh, CFG, T0 + 200_000);
  assert.equal(out.transition.kind, "none");
  assert.deepEqual(out.nextState, fresh);
});

test("evaluateRun: paused run inside hard window returns none", () => {
  const run = runFx({
    startTime: T0,
    lastEventAt: T0,
    pausedAt: T0 + 60_000,
  });
  const out = evaluateRun(run, soft, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
  // State preserved untouched while paused.
  assert.deepEqual(out.nextState, soft);
});

test("evaluateRun: terminal status (completed) returns none, never stalls", () => {
  const run = runFx({ status: "completed", lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
});

test("evaluateRun: terminal status (failed) returns none", () => {
  const run = runFx({ status: "failed", lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
});

test("evaluateRun: queued status returns none (not yet running)", () => {
  const run = runFx({ status: "queued", lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
});

test("evaluateRun: paused (RunStatus=paused) returns none", () => {
  const run = runFx({ status: "paused", lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "none");
});

// ── Crossing soft ────────────────────────────────────────────────────

test("evaluateRun: crossing soft threshold first time → soft (LOAD-BEARING)", () => {
  // 130s of silence; 120s soft threshold. State was fresh.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 130_000);
  assert.equal(out.transition.kind, "soft");
  if (out.transition.kind === "soft") {
    assert.equal(out.transition.silentSeconds, 130);
    assert.equal(out.transition.thresholdSeconds, 120);
  }
  assert.equal(out.nextState.kind, "soft");
});

test("evaluateRun: soft state, still in soft band, no advance → none (deduped)", () => {
  // Silence has stretched from 130s to 200s; still soft band, still
  // already soft. No transition emitted.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, soft, CFG, T0 + 200_000);
  assert.equal(out.transition.kind, "none");
  assert.equal(out.nextState.kind, "soft");
});

// ── Crossing hard ────────────────────────────────────────────────────

test("evaluateRun: soft → hard when ageSeconds crosses hard threshold", () => {
  // 610s silent; previously soft. Crosses hard.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, soft, CFG, T0 + 610_000);
  assert.equal(out.transition.kind, "hard");
  if (out.transition.kind === "hard") {
    assert.equal(out.transition.silentSeconds, 610);
    assert.equal(out.transition.thresholdSeconds, 600);
  }
  assert.equal(out.nextState.kind, "hard");
});

test("evaluateRun: fresh → hard if first tick fires past hard threshold", () => {
  // Run was idle through both thresholds; first observation puts us
  // straight at hard. Should still emit hard (skipping soft).
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 700_000);
  assert.equal(out.transition.kind, "hard");
  assert.equal(out.nextState.kind, "hard");
});

test("evaluateRun: hard already, still silent → none (deduped)", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, hard, CFG, T0 + 800_000);
  assert.equal(out.transition.kind, "none");
  assert.equal(out.nextState.kind, "hard");
});

// ── Recovery ─────────────────────────────────────────────────────────

test("evaluateRun: was soft, lastEventAt advanced inside soft window → recovered", () => {
  // Last event was 10s ago — well under 120s soft. State was soft;
  // run came back to life.
  const run = runFx({ startTime: T0, lastEventAt: T0 + 200_000 });
  const out = evaluateRun(run, soft, CFG, T0 + 210_000);
  assert.equal(out.transition.kind, "recovered");
  if (out.transition.kind === "recovered") {
    assert.equal(out.transition.previousKind, "soft");
  }
  assert.equal(out.nextState.kind, "fresh");
});

test("evaluateRun: was hard, lastEventAt advanced → recovered (from hard)", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 + 700_000 });
  const out = evaluateRun(run, hard, CFG, T0 + 710_000);
  assert.equal(out.transition.kind, "recovered");
  if (out.transition.kind === "recovered") {
    assert.equal(out.transition.previousKind, "hard");
  }
  assert.equal(out.nextState.kind, "fresh");
});

test("evaluateRun: fresh state with fresh activity → none (no spurious recovery)", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 + 40_000 });
  const out = evaluateRun(run, fresh, CFG, T0 + 50_000);
  assert.equal(out.transition.kind, "none");
  assert.equal(out.nextState.kind, "fresh");
});

// ── A3 amendment: streaming-thinking spurious-soft regression ───────

test("evaluateRun: streaming thinking with periodic events does NOT trigger soft (A3)", () => {
  // Per critic.md A3: a run that's emitting message_update events for
  // streaming thinking text bumps lastEventAt regularly. The detector
  // looks at `lastEventAt`, not at "the run produced no tool output."
  // Simulate 10 minutes of run-time with event ticks every 30s.
  const run = runFx({ startTime: T0 });
  let now = T0 + 30_000; // past grace
  let state: WatchdogState = fresh;
  // 20 ticks of 30s — total 10 min — each tick the run emitted an event
  // 1s before the watchdog tick.
  for (let i = 0; i < 20; i++) {
    const eventAt = now - 1_000;
    const r: Run = { ...run, lastEventAt: eventAt };
    const out = evaluateRun(r, state, CFG, now);
    assert.equal(
      out.transition.kind,
      "none",
      `streaming-thinking tick #${i} should not fire (lastEventAt=${eventAt}, now=${now})`,
    );
    state = out.nextState;
    now += 30_000;
  }
  assert.equal(state.kind, "fresh");
});

// ── Edge cases ───────────────────────────────────────────────────────

test("evaluateRun: ageSeconds at exact soft boundary (120.0s) is treated as crossed", () => {
  // Boundary semantics: design says >= soft. age = 120.000s should fire.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 120_000);
  assert.equal(out.transition.kind, "soft");
});

test("evaluateRun: ageSeconds 1ms below soft (119.999s) is NOT crossed", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, fresh, CFG, T0 + 119_999);
  assert.equal(out.transition.kind, "none");
  assert.equal(out.nextState.kind, "fresh");
});

test("evaluateRun: ageSeconds at exact hard boundary (600.0s) is treated as crossed", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, soft, CFG, T0 + 600_000);
  assert.equal(out.transition.kind, "hard");
});

test("evaluateRun: undefined state defaults to fresh", () => {
  // Convenience: callers calling for the first time pass undefined.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const out = evaluateRun(run, undefined, CFG, T0 + 130_000);
  assert.equal(out.transition.kind, "soft");
});
