/**
 * v0.18-S5 — ensemble_auto wiring: the awaitTerminal backstop (kill-hang
 * fix) and the no-onRetry/no-onChain spawn invariant.
 *
 * The real spawnStep closure calls the live queue (spawns pi), so the
 * finalize→resolve path is a live-gated concern; these tests exercise the
 * two invariants that DON'T need a subprocess:
 *   1. awaitTerminal resolves on an operator kill (forceTerminate, which
 *      fires NO onComplete) — the exact hang the critic found.
 *   2. awaitTerminal resolves via the onComplete fast path too, once only.
 *   3. awaitTerminal covers the enqueue→subscribe race (already-terminal).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { awaitTerminal } from "../src/tools.ts";
import { RunRegistry, forceTerminate } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(id: string): Run {
  return {
    id,
    persona: "builder",
    task: "t",
    mode: "background",
    status: "running",
    startTime: 1,
    lastEventAt: 1,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    parentPid: process.pid,
  } as Run;
}

test("awaitTerminal resolves on an operator kill (forceTerminate, no onComplete) — hang fix", async () => {
  const reg = new RunRegistry();
  const run = makeRun("builder-kill");
  reg.register(run);
  const { promise } = awaitTerminal(reg, "builder-kill");
  // Operator kill: forceTerminate fires registry.notify but NO onComplete.
  forceTerminate(run, "killed", reg);
  const settled = await promise; // must not hang
  assert.equal(settled.status, "killed");
  assert.equal(settled.failureClass, "unknown"); // user kill → unknown class
});

test("awaitTerminal resolves on a stall kill with failureClass=stall", async () => {
  const reg = new RunRegistry();
  const run = makeRun("builder-stall");
  reg.register(run);
  const { promise } = awaitTerminal(reg, "builder-stall");
  forceTerminate(run, "stalled", reg);
  const settled = await promise;
  assert.equal(settled.failureClass, "stall");
});

test("awaitTerminal fast-path settle resolves once (guard vs backstop)", async () => {
  const reg = new RunRegistry();
  const run = makeRun("builder-fast");
  reg.register(run);
  const { promise, settle } = awaitTerminal(reg, "builder-fast");
  run.status = "completed";
  settle(run); // fast path (onComplete analog)
  // A subsequent terminal notify must NOT re-resolve to something else.
  reg.notify(run);
  const settled = await promise;
  assert.equal(settled.status, "completed");
});

test("awaitTerminal covers the enqueue→subscribe race (already terminal)", async () => {
  const reg = new RunRegistry();
  const run = makeRun("builder-race");
  run.status = "failed";
  reg.register(run); // registered already-terminal before awaitTerminal
  const { promise } = awaitTerminal(reg, "builder-race");
  const settled = await promise; // resolves immediately from the list() check
  assert.equal(settled.status, "failed");
});

test("awaitTerminal ignores other runs' terminals", async () => {
  const reg = new RunRegistry();
  const mine = makeRun("builder-mine");
  const other = makeRun("builder-other");
  reg.register(mine);
  reg.register(other);
  const { promise } = awaitTerminal(reg, "builder-mine");
  let resolved = false;
  promise.then(() => (resolved = true));
  forceTerminate(other, "killed", reg); // different run
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "must not resolve on another run's terminal");
  forceTerminate(mine, "killed", reg);
  await promise;
});
