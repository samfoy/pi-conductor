/**
 * v0.18 Slice 2 — retry planning (pure): resolveRetryPolicy cascade +
 * buildRetryTask, and the applyRetryIfNeeded dispatch gate.
 *
 * Coverage:
 *   resolveRetryPolicy:
 *     1. per-call maxAttempts wins over all lower layers
 *     2. project > user > persona ordering
 *     3. fields cascade independently (per-call attempts + project classes)
 *     4. builtin fallback when no layer specifies
 *     5. maxAttempts clamped to >= 1
 *   buildRetryTask:
 *     6. embeds class + human-1-indexed next attempt + original task
 *     7. includes error tail when present; omits when absent
 *     8. builds from the pristine original (no preamble stacking)
 *   applyRetryIfNeeded:
 *     9. fires onRetry when retryable + budget remains
 *    10. no-fire on completed / no policy / non-retryable / exhausted / no callback
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveRetryPolicy, buildRetryTask } from "../src/retry.ts";
import { applyRetryIfNeeded } from "../src/runs.ts";
import { DEFAULT_RETRY_POLICY } from "../src/failure-classify.ts";
import { emptyUsage, type Run } from "../src/types.ts";

// ── resolveRetryPolicy ──────────────────────────────────────────────────

test("per-call maxAttempts wins over all lower layers", () => {
  const p = resolveRetryPolicy({
    perCall: { maxAttempts: 5 },
    project: { maxAttempts: 4 },
    user: { maxAttempts: 3 },
    persona: { maxAttempts: 2 },
  });
  assert.equal(p.maxAttempts, 5);
});

test("project > user > persona ordering", () => {
  assert.equal(
    resolveRetryPolicy({ project: { maxAttempts: 4 }, user: { maxAttempts: 3 }, persona: { maxAttempts: 2 } }).maxAttempts,
    4,
  );
  assert.equal(
    resolveRetryPolicy({ user: { maxAttempts: 3 }, persona: { maxAttempts: 2 } }).maxAttempts,
    3,
  );
  assert.equal(resolveRetryPolicy({ persona: { maxAttempts: 2 } }).maxAttempts, 2);
});

test("fields cascade independently", () => {
  const p = resolveRetryPolicy({
    perCall: { maxAttempts: 3 },
    project: { retryableClasses: ["logic"] },
  });
  assert.equal(p.maxAttempts, 3);
  assert.deepEqual(p.retryableClasses, ["logic"]);
});

test("builtin fallback when no layer specifies", () => {
  const p = resolveRetryPolicy({});
  assert.equal(p.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts);
  assert.deepEqual(p.retryableClasses, DEFAULT_RETRY_POLICY.retryableClasses);
});

test("custom builtin honored", () => {
  const p = resolveRetryPolicy({ builtin: { maxAttempts: 2, retryableClasses: ["stall"] } });
  assert.equal(p.maxAttempts, 2);
  assert.deepEqual(p.retryableClasses, ["stall"]);
});

test("maxAttempts clamped to >= 1", () => {
  assert.equal(resolveRetryPolicy({ perCall: { maxAttempts: 0 } }).maxAttempts, 1);
  assert.equal(resolveRetryPolicy({ perCall: { maxAttempts: -3 } }).maxAttempts, 1);
});

// ── buildRetryTask ──────────────────────────────────────────────────────

test("buildRetryTask embeds class, next attempt, and original task", () => {
  const t = buildRetryTask({
    originalTask: "Fix the widget",
    failureClass: "environment",
    attempt: 0, // first attempt failed
    maxAttempts: 3,
    errorMessage: "npm ERR! ENOENT",
  });
  assert.match(t, /attempt 2 of 3/); // failed attempt 1 → next is 2
  assert.match(t, /`environment`/);
  assert.match(t, /npm ERR! ENOENT/);
  assert.match(t, /Fix the widget$/);
});

test("buildRetryTask omits error block when no message", () => {
  const t = buildRetryTask({ originalTask: "Do X", failureClass: "stall", attempt: 1, maxAttempts: 4 });
  assert.match(t, /attempt 3 of 4/);
  assert.doesNotMatch(t, /Last error:/);
});

test("buildRetryTask never stacks preambles (builds from pristine original)", () => {
  const original = "Original task body";
  const first = buildRetryTask({ originalTask: original, failureClass: "test", attempt: 0, maxAttempts: 3 });
  // A second retry builds from the SAME pristine original, not `first`.
  const second = buildRetryTask({ originalTask: original, failureClass: "test", attempt: 1, maxAttempts: 3 });
  // Exactly one "## Retry" header in each.
  assert.equal((second.match(/## Retry/g) ?? []).length, 1);
  assert.match(second, /attempt 3 of 3/);
  assert.doesNotMatch(second, /attempt 2 of 3/);
});

// ── applyRetryIfNeeded ──────────────────────────────────────────────────

function makeRun(over: Partial<Run>): Run {
  return {
    id: "tester-r",
    persona: "builder",
    task: "t",
    mode: "background",
    status: "failed",
    startTime: 1,
    lastEventAt: 1,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    retryPolicy: { maxAttempts: 3, retryableClasses: ["environment", "stall"] },
    retryAttempt: 0,
    failureClass: "environment",
    ...over,
  } as Run;
}

test("applyRetryIfNeeded fires onRetry when retryable + budget remains", () => {
  let fired = 0;
  const run = makeRun({});
  const dispatched = applyRetryIfNeeded(run, () => fired++);
  assert.equal(dispatched, true);
  assert.equal(fired, 1);
});

test("applyRetryIfNeeded no-fire on completed", () => {
  let fired = 0;
  const run = makeRun({ status: "completed", failureClass: undefined });
  assert.equal(applyRetryIfNeeded(run, () => fired++), false);
  assert.equal(fired, 0);
});

test("applyRetryIfNeeded no-fire without callback", () => {
  const run = makeRun({});
  assert.equal(applyRetryIfNeeded(run, undefined), false);
});

test("applyRetryIfNeeded no-fire without policy", () => {
  let fired = 0;
  const run = makeRun({ retryPolicy: undefined });
  assert.equal(applyRetryIfNeeded(run, () => fired++), false);
  assert.equal(fired, 0);
});

test("applyRetryIfNeeded no-fire on non-retryable class", () => {
  let fired = 0;
  const run = makeRun({ failureClass: "logic" }); // not in retryable set
  assert.equal(applyRetryIfNeeded(run, () => fired++), false);
  assert.equal(fired, 0);
});

test("applyRetryIfNeeded no-fire when attempts exhausted", () => {
  let fired = 0;
  const run = makeRun({ retryAttempt: 2 }); // 3rd (last) attempt of maxAttempts 3
  assert.equal(applyRetryIfNeeded(run, () => fired++), false);
  assert.equal(fired, 0);
});

test("applyRetryIfNeeded swallows callback exceptions", () => {
  const run = makeRun({});
  // Should not throw even though the callback does.
  assert.equal(
    applyRetryIfNeeded(run, () => {
      throw new Error("spawn boom");
    }),
    true,
  );
});
