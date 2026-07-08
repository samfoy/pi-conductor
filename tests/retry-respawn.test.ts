/**
 * v0.18-S2 — witness the loop-termination property end-to-end via a
 * queue spy: buildOnRetryCallback's re-spawn must carry
 * `retryAttempt = failedAttempt + 1` and a diagnostic-augmented task.
 *
 * This is the direct witness the critic asked for: if the increment were
 * dropped, retries would never advance toward the shouldRetry cap and the
 * loop would be unbounded. Capturing the enqueued opts proves it advances.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildOnRetryCallback } from "../src/tools.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run } from "../src/types.ts";

function makePersona() {
  return {
    name: "builder",
    description: "test",
    model: undefined,
    thinking: undefined,
    inheritContext: "none" as const,
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 10,
    systemPrompt: "sp",
    source: "builtin" as const,
    sourcePath: "/fake/builder.md",
    readOnly: false,
    onCompleteHook: undefined,
    onCompleteHookTimeoutSeconds: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    retryMaxAttempts: undefined,
  };
}

function makeFailedRun(attempt: number): Run {
  return {
    id: "builder-x",
    persona: "builder",
    task: "AUGMENTED-DO-NOT-REUSE",
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
    retryAttempt: attempt,
    retryPolicy: { maxAttempts: 3, retryableClasses: ["environment"] },
    failureClass: "environment",
    errorMessage: "npm ERR! ENOENT",
  } as Run;
}

test("S2: re-spawn carries retryAttempt+1 and augments from pristine original", () => {
  const captured: any[] = [];
  const fakeQueue = { enqueueOrSpawn: (o: any) => captured.push(o) } as any;

  const cb = buildOnRetryCallback({
    originalTask: "PRISTINE ORIGINAL TASK",
    persona: makePersona() as any,
    cfg: DEFAULT_CONFIG,
    queue: fakeQueue,
    cwd: "/tmp",
    retryMaxAttempts: 3,
    pushNotification: () => {},
    getParentMessages: () => [],
  });

  // The run that just failed was attempt 0 (original spawn).
  cb(makeFailedRun(0));

  assert.equal(captured.length, 1);
  const spawn = captured[0];
  // Termination witness: the retry advances the attempt counter.
  assert.equal(spawn.retryAttempt, 1);
  // Task is built from the PRISTINE original, not the failed run's task.
  assert.match(spawn.task, /PRISTINE ORIGINAL TASK/);
  assert.doesNotMatch(spawn.task, /AUGMENTED-DO-NOT-REUSE/);
  assert.match(spawn.task, /## Retry \(attempt 2 of 3\)/);
  assert.match(spawn.task, /`environment`/);
  // Self-propagating: the re-spawn carries onRetry so it can retry again.
  assert.equal(typeof spawn.onRetry, "function");
  // Background mode + budget threaded through.
  assert.equal(spawn.mode, "background");
  assert.equal(spawn.retryMaxAttempts, 3);
});

test("S2: successive retries keep advancing the attempt counter", () => {
  const captured: any[] = [];
  const fakeQueue = { enqueueOrSpawn: (o: any) => captured.push(o) } as any;
  const cb = buildOnRetryCallback({
    originalTask: "T",
    persona: makePersona() as any,
    cfg: DEFAULT_CONFIG,
    queue: fakeQueue,
    cwd: "/tmp",
    retryMaxAttempts: 3,
    pushNotification: () => {},
    getParentMessages: () => [],
  });

  // Simulate the re-spawn of attempt 1 failing → should enqueue attempt 2.
  cb(makeFailedRun(1));
  assert.equal(captured[0].retryAttempt, 2);
  assert.match(captured[0].task, /attempt 3 of 3/);
});
