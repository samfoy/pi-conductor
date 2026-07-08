/**
 * v0.18 Slice 1 — wiring tests for failure-class stamping.
 *
 * The pure classifier is covered in failure-classify.test.ts. This file
 * covers the STAMP SITES (critic note: wiring was untested):
 *   - forceTerminate stamps stall / timeout / turns from the reason
 *   - toRunRecord round-trips failureClass + retryAttempt
 *
 * The finalize() natural-exit stamp and the spawn-error stamp are
 * exercised indirectly (they call the same pure classifyFailure); a full
 * subprocess harness for finalize is out of scope for this slice and
 * belongs with the S2 retry-loop tests.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { RunRegistry, forceTerminate } from "../src/runs.ts";
import { emptyUsage, toRunRecord, type Run } from "../src/types.ts";

function makeRun(): Run {
  return {
    id: "tester-fc",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    // Point persistence at a non-existent dir: writeRecord/writeFinal are
    // fire-and-forget `void` promises; the sync assertions don't need them.
    recordPath: "/tmp/conductor-fc-test/record.json",
    transcriptPath: "/tmp/conductor-fc-test/transcript.jsonl",
    finalPath: "/tmp/conductor-fc-test/final.md",
    parentPid: process.pid,
  } as Run;
}

test("forceTerminate('stalled') stamps failureClass='stall'", () => {
  const run = makeRun();
  const reg = new RunRegistry();
  reg.register(run);
  forceTerminate(run, "stalled", reg);
  assert.equal(run.status, "killed"); // status stays killed (existing behavior)
  assert.equal(run.failureClass, "stall"); // but the reason is preserved as a class
});

test("forceTerminate('timeout') stamps failureClass='timeout'", () => {
  const run = makeRun();
  const reg = new RunRegistry();
  reg.register(run);
  forceTerminate(run, "timeout", reg);
  assert.equal(run.status, "timeout");
  assert.equal(run.failureClass, "timeout");
});

test("forceTerminate('aborted') stamps failureClass='turns'", () => {
  const run = makeRun();
  const reg = new RunRegistry();
  reg.register(run);
  forceTerminate(run, "aborted", reg);
  assert.equal(run.status, "aborted");
  assert.equal(run.failureClass, "turns");
});

test("forceTerminate('killed') with no diagnostic stamps 'unknown'", () => {
  const run = makeRun();
  const reg = new RunRegistry();
  reg.register(run);
  forceTerminate(run, "killed", reg);
  assert.equal(run.status, "killed");
  assert.equal(run.failureClass, "unknown");
});

test("toRunRecord round-trips failureClass + retryAttempt", () => {
  const run = makeRun();
  run.status = "failed";
  run.failureClass = "environment";
  run.retryAttempt = 2;
  const rec = toRunRecord(run);
  assert.equal(rec.failureClass, "environment");
  assert.equal(rec.retryAttempt, 2);
});

test("toRunRecord leaves failureClass undefined when unset", () => {
  const run = makeRun();
  const rec = toRunRecord(run);
  assert.equal(rec.failureClass, undefined);
  assert.equal(rec.retryAttempt, undefined);
});
