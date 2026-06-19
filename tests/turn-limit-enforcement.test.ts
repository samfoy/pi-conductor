/**
 * Tests for v0.17-S4 — turn-count enforcement loop + grace injection.
 *
 * WDD witnesses:
 *   W1: maxTurns=3, turns reaches 3 → gracePeriodActive=true (steerable run)
 *   W2: steerable run at maxTurns → grace steering message injected (enqueue spy)
 *   W3: non-steerable run at maxTurns → forceTerminate("aborted") immediately
 *   W4: steerable run after grace period exhausted → forceTerminate("aborted")
 *   W5: run without maxTurns → no enforcement, no grace injection
 *   W6: idempotency — second call on already-aborted run is a strict no-op
 *   W7: GRACE_MESSAGE contains "wrap up"
 *   W8: forceTerminate("aborted") sets run.status to "aborted"
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkTurnLimit,
  GRACE_MESSAGE,
  forceTerminate,
  type TurnLimitTerminateFn,
  type GraceEnqueueFn,
} from "../src/runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

// ── Fixture helpers ───────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-test",
    persona: "builder",
    task: "test task",
    mode: "background",
    status: "running" as RunStatus,
    startTime: T0,
    lastEventAt: T0,
    messages: [],
    usage: { ...emptyUsage() },
    cwd: "/tmp",
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    parentPid: process.pid,
    gracePeriodActive: false,
    gracePeriodStartTurn: undefined,
    maxTurns: undefined,
    graceTurns: 5,
    ...overrides,
  };
}

// ── W1: steerable run reaches maxTurns → gracePeriodActive = true ─────

test("S4-W1: gracePeriodActive set to true when steerable run reaches maxTurns", () => {
  const reg = new RunRegistry();
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "rpc",
    usage: { ...emptyUsage(), turns: 3 },
  });
  reg.register(run);

  let ftCalled = false;
  // Inject no-op enqueue spy to avoid real RPC timer
  const noopEnqueue: GraceEnqueueFn = () => {};
  checkTurnLimit(run, reg, () => { ftCalled = true; }, noopEnqueue);

  assert.equal(run.gracePeriodActive, true, "gracePeriodActive should be true");
  assert.equal(run.gracePeriodStartTurn, 3, "gracePeriodStartTurn should be stamped");
  assert.equal(ftCalled, false, "forceTerminate should NOT be called for steerable runs at limit");
});

// ── W2: steerable run at maxTurns → grace message injected ────────────

test("S4-W2: steerable run at maxTurns → grace message enqueued with correct content", () => {
  const reg = new RunRegistry();
  const enqueueCalls: Array<string> = [];
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "rpc",
    usage: { ...emptyUsage(), turns: 3 },
  });
  reg.register(run);

  const enqueueSpy: GraceEnqueueFn = (_r, msg) => {
    enqueueCalls.push(msg);
  };
  checkTurnLimit(run, reg, () => {}, enqueueSpy);

  assert.equal(enqueueCalls.length, 1, "exactly one enqueue call");
  assert.match(enqueueCalls[0], /wrap up/i, "grace message should contain 'wrap up'");
  assert.equal(enqueueCalls[0], GRACE_MESSAGE, "message matches GRACE_MESSAGE constant");
});

// ── W3: non-steerable run at maxTurns → forceTerminate("aborted") ─────

test("S4-W3: non-steerable run at maxTurns → forceTerminate called with aborted", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "print",
    usage: { ...emptyUsage(), turns: 3 },
  });
  reg.register(run);

  checkTurnLimit(run, reg, (r, reason) => {
    ftCalls.push({ reason });
  });

  assert.equal(ftCalls.length, 1, "forceTerminate called exactly once");
  assert.equal(ftCalls[0].reason, "aborted", "reason is aborted");
  // run.errorMessage should be set
  assert.ok(
    run.errorMessage?.includes("turn limit"),
    `errorMessage should mention turn limit, got: ${run.errorMessage}`,
  );
  // gracePeriodActive stays false for non-steerable
  assert.equal(run.gracePeriodActive, false);
});

test("S4-W3b: non-steerable run: forceTerminate NOT called at turn 2 when maxTurns=3", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "print",
    usage: { ...emptyUsage(), turns: 2 },
  });
  reg.register(run);

  checkTurnLimit(run, reg, (r, reason) => {
    ftCalls.push({ reason });
  });

  assert.equal(ftCalls.length, 0, "forceTerminate should NOT be called at turn 2");
});

// ── W4: steerable run after grace exhausted → forceTerminate("aborted") ─

test("S4-W4: steerable run: forceTerminate called when gracePeriodStartTurn + graceTurns reached", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  // Simulate: grace period started at turn 3, graceTurns=5, now at turn 8
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "rpc",
    gracePeriodActive: true,
    gracePeriodStartTurn: 3,
    usage: { ...emptyUsage(), turns: 8 }, // 3 + 5 = 8
  });
  reg.register(run);

  // Grace escalation path never calls enqueue; pass a spy for safety
  checkTurnLimit(run, reg, (r, reason) => {
    ftCalls.push({ reason });
  }, () => {});

  assert.equal(ftCalls.length, 1, "forceTerminate called once at grace exhaustion");
  assert.equal(ftCalls[0].reason, "aborted", "reason is aborted");
});

test("S4-W4b: steerable run: forceTerminate NOT called before grace period exhausted (turn 7 with graceTurns=5)", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "rpc",
    gracePeriodActive: true,
    gracePeriodStartTurn: 3,
    usage: { ...emptyUsage(), turns: 7 }, // 3 + 5 - 1 = 7, not yet exhausted
  });
  reg.register(run);

  checkTurnLimit(run, reg, (r, reason) => {
    ftCalls.push({ reason });
  }, () => {});

  assert.equal(ftCalls.length, 0, "forceTerminate NOT called at turn 7");
});

// ── W5: run without maxTurns → no enforcement ─────────────────────────

test("S4-W5: run without maxTurns → no enforcement, gracePeriodActive stays false", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  const enqueueCalls: string[] = [];
  const run = makeRun({
    maxTurns: undefined,
    graceTurns: 5,
    streamingMode: "rpc",
    usage: { ...emptyUsage(), turns: 100 },
  });
  reg.register(run);

  checkTurnLimit(run, reg, (r, reason) => {
    ftCalls.push({ reason });
  }, (r, msg) => { enqueueCalls.push(msg); });

  assert.equal(ftCalls.length, 0, "no forceTerminate without maxTurns");
  assert.equal(run.gracePeriodActive, false, "gracePeriodActive stays false");
  assert.equal(enqueueCalls.length, 0, "no enqueue without maxTurns");
});

// ── W6: idempotency — already terminal run is no-op ───────────────────

test("S4-W6: already-aborted run → checkTurnLimit is a strict no-op", () => {
  const reg = new RunRegistry();
  const enqueueCalls: string[] = [];
  const ftCalls: Array<{ reason: string }> = [];
  const run = makeRun({
    maxTurns: 3,
    graceTurns: 5,
    streamingMode: "rpc",
    status: "aborted" as RunStatus,
    gracePeriodActive: false,
    usage: { ...emptyUsage(), turns: 3 },
  });
  reg.register(run);

  checkTurnLimit(
    run, reg,
    (r, reason) => { ftCalls.push({ reason }); },
    (r, msg) => { enqueueCalls.push(msg); },
  );

  assert.equal(ftCalls.length, 0, "no forceTerminate on terminal run");
  assert.equal(enqueueCalls.length, 0, "no enqueue on terminal run");
  assert.equal(run.gracePeriodActive, false, "gracePeriodActive unchanged");
});

test("S4-W6b: completed run → checkTurnLimit is a strict no-op", () => {
  const reg = new RunRegistry();
  const ftCalls: Array<{ reason: string }> = [];
  const run = makeRun({
    maxTurns: 3,
    status: "completed" as RunStatus,
    usage: { ...emptyUsage(), turns: 3 },
  });
  reg.register(run);

  checkTurnLimit(run, reg, (r, reason) => { ftCalls.push({ reason }); });

  assert.equal(ftCalls.length, 0, "no forceTerminate on completed run");
});

// ── W7: grace message content check ───────────────────────────────────

test("S4-W7: GRACE_MESSAGE contains 'wrap up' (case-insensitive)", () => {
  assert.match(GRACE_MESSAGE, /wrap up/i, "GRACE_MESSAGE must contain 'wrap up'");
  assert.match(GRACE_MESSAGE, /turn limit/i, "GRACE_MESSAGE should mention turn limit");
});

// ── W8: forceTerminate("aborted") sets run.status to "aborted" ────────

test("S4-W8: forceTerminate with reason=aborted sets run.status to aborted", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);

  forceTerminate(run, "aborted", reg);

  assert.equal(run.status, "aborted", "run.status should be aborted");
});
