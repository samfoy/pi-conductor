/**
 * pi invalidates `pi.events` on reload or session replacement: its `emit`
 * then throws "This extension ctx is stale". A run that outlives a
 * `/reload` finalizes in the old extension instance, and the throw from
 * `emitCompleted` inside the close handler's `.finally()` was uncaught and
 * crashed pi (crashes.json, 2026-10-08, critic-rwzn). Lifecycle events are
 * fire-and-forget, so a dead bus must be a no-op.
 *
 * Killing mutation: drop the try/catch in ConductorEventEmitter's emit
 * helper → every case below throws STALE.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConductorEventEmitter } from "../src/conductor-events.ts";
import { emitFinalizeEvent } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

const staleBus = {
  emit(): void {
    throw new Error(STALE);
  },
  on(): () => void {
    throw new Error(STALE);
  },
};

const base = { id: "r", persona: "critic", durationMs: 1, toolUses: 0, tokens: { input: 0, output: 0, cost: 0 } };
const hook = { id: "r", persona: "critic", command: "true" };

const calls: Array<[string, (e: ConductorEventEmitter) => void]> = [
  ["emitCreated", (e) => e.emitCreated({ id: "r", persona: "critic", description: "d", isBackground: true })],
  ["emitStarted", (e) => e.emitStarted({ id: "r", persona: "critic", description: "d" })],
  ["emitCompleted", (e) => e.emitCompleted(base)],
  ["emitFailed", (e) => e.emitFailed({ ...base, status: "failed", errorMessage: undefined })],
  ["emitSteered", (e) => e.emitSteered({ id: "r", message: "m" })],
  ["emitCompacted", (e) => e.emitCompacted({ id: "r", persona: "critic", description: "d", compactionCount: 1, tokensBefore: 0 })],
  ["emitHookStarted", (e) => e.emitHookStarted(hook)],
  ["emitHookCompleted", (e) => e.emitHookCompleted({ ...hook, exitCode: 0, durationMs: 1 })],
  ["emitHookFailed", (e) => e.emitHookFailed({ ...hook, exitCode: 1, durationMs: 1, failureKind: "exit" })],
];

for (const [name, call] of calls) {
  test(`${name} is a no-op on a stale pi.events`, () => {
    assert.doesNotThrow(() => call(new ConductorEventEmitter(staleBus)));
  });
}

test("emitFinalizeEvent survives a run that finishes after /reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-events-stale-"));
  try {
    for (const status of ["completed", "failed"] as const) {
      const run: Run = {
        id: "critic-rwzn",
        persona: "critic",
        task: "t",
        mode: "background",
        status,
        startTime: Date.now() - 1000,
        finishedAt: Date.now(),
        lastEventAt: Date.now(),
        messages: [],
        usage: emptyUsage(),
        cwd: dir,
        recordPath: join(dir, "record.json"),
        transcriptPath: join(dir, "transcript.jsonl"),
        finalPath: join(dir, "final.md"),
      };
      assert.doesNotThrow(() => emitFinalizeEvent(run, new ConductorEventEmitter(staleBus)), status);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
