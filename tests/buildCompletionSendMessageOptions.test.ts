/**
 * Tests for `buildCompletionSendMessageOptions` — the
 * `pi.sendMessage` options arg builder for sub-agent completion
 * notifications.
 *
 * Locked decision (c) per `docs/items-11-12-inspector-map.md`
 * §6 rec 2: foreground spawns keep `triggerTurn: true,
 * deliverAs: "followUp"` (current behavior; PRD line 614 v0.10 Q3
 * advisory pattern); background spawns flip to `triggerTurn: true`
 * ONLY (no `deliverAs`) per PRD line 257 contract.
 *
 * The witnessed 25-min idle bug (builder-rjpb 2026-05-27, item 11)
 * was a background spawn that did NOT wake the conductor under the
 * old "{ triggerTurn: true, deliverAs: 'followUp' }" call. On pi's
 * streaming branch, `deliverAs: "followUp"` queues via
 * `agent.followUp(...)` and `triggerTurn` is ignored — exactly the
 * witness symptom. `triggerTurn: true` alone hits the prompt branch
 * and fires a turn unconditionally.
 *
 * Pinned by direct assertion on the options arg, not via a stub-fires
 * counter (per inspector map §1.5 — the contract was untested before).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSendMessageOptions } from "../src/notifications.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  const base: Run = {
    id: "builder-test1",
    persona: "builder",
    task: "do the thing",
    mode: "background",
    status: "completed",
    startTime: Date.now(),
    finishedAt: Date.now(),
    lastEventAt: Date.now(),
    usage: emptyUsage(),
    cwd: "/work",
    recordPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    finalPath: "/tmp/f.md",
    messages: [],
  };
  return { ...base, ...overrides };
}

test("buildCompletionSendMessageOptions: background spawn → triggerTurn: true ONLY (no deliverAs)", () => {
  const run = makeRun({ mode: "background" });
  const opts = buildCompletionSendMessageOptions(run);
  assert.deepEqual(opts, { triggerTurn: true });
  assert.equal(opts.triggerTurn, true);
  // Critical: no deliverAs key. On pi's sendCustomMessage streaming
  // branch, deliverAs: "followUp" wins over triggerTurn — that's the
  // bug. Background completions must avoid that branch.
  assert.equal((opts as any).deliverAs, undefined);
});

test("buildCompletionSendMessageOptions: foreground spawn → triggerTurn: true + deliverAs: 'followUp' (preserves v0.4 inline-streaming behavior)", () => {
  const run = makeRun({ mode: "foreground" });
  const opts = buildCompletionSendMessageOptions(run);
  assert.deepEqual(opts, { triggerTurn: true, deliverAs: "followUp" });
});

test("buildCompletionSendMessageOptions: W1 mutation witness — dropping the background branch reds this test", () => {
  // W1 — pins the production formula directly. Mutating
  // `buildCompletionSendMessageOptions` to ignore `run.mode` and
  // always return the foreground-style options would red THIS test.
  // Pair with the foreground test above so both directions of the
  // mutation are killed.
  const run = makeRun({ mode: "background" });
  const opts = buildCompletionSendMessageOptions(run);
  // The background branch must NOT include deliverAs. If a mutation
  // collapses the function to the foreground default, deliverAs would
  // be "followUp" and this assertion reds.
  assert.notEqual((opts as any).deliverAs, "followUp",
    "background completions MUST NOT carry deliverAs: 'followUp' — that's the item-11 wake-failure bug");
  assert.ok(opts.triggerTurn, "background completions MUST trigger a turn");
});

test("buildCompletionSendMessageOptions: status field is irrelevant — 'failed' background still wakes", () => {
  // The wake contract is per-mode, not per-status. A failed
  // background sub-agent must still wake the conductor (it owes
  // the conductor a re-plan).
  const run = makeRun({ mode: "background", status: "failed" });
  assert.deepEqual(buildCompletionSendMessageOptions(run), { triggerTurn: true });
});

test("buildCompletionSendMessageOptions: foreground 'failed' preserves followUp queueing", () => {
  // Foreground failure is already visible inline; queueing the wake
  // matches the v0.10 Q3 advisory pattern (PRD line 614).
  const run = makeRun({ mode: "foreground", status: "failed" });
  assert.deepEqual(buildCompletionSendMessageOptions(run), {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});
