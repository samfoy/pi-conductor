/**
 * Tests for handleSessionShutdown — the pure side-effect helper extracted
 * from the `pi.on("session_shutdown", …)` handler in src/index.ts.
 *
 * On `reason === "reload"` the host's `/reload` slash command (and the
 * `ctx.reload()` API) swap only the extension runtime. The chat history,
 * scratchpad, and conductor brief are preserved by the host. We must NOT
 * kill running sub-agents on reload — child processes are siblings of
 * the parent OS process and keep running across the runtime swap; their
 * final.md / record.json land on disk regardless. Killing them on reload
 * loses all in-flight work for what should be a developer-loop primitive.
 *
 * On any other reason (quit, new, resume, fork) we preserve current
 * behavior: SIGTERM all running/paused sub-agents and reset the
 * sanitizer warning dedup set.
 *
 * Spec: oracle-3l2e Step 1 (v0.8.2 backlog P0 #1).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { handleSessionShutdown } from "../src/shutdown.ts";
import type { Run, RunStatus } from "../src/types.ts";

interface KillRecord {
  id: string;
  signal: NodeJS.Signals | number | undefined;
}

function makeRun(id: string, status: RunStatus, killSink: KillRecord[]): Run {
  return {
    id,
    persona: "tester",
    task: "test",
    mode: "background",
    status,
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    proc: {
      kill: (signal?: NodeJS.Signals | number) => {
        killSink.push({ id, signal });
        return true;
      },
    } as unknown as Run["proc"],
  };
}

test("handleSessionShutdown: reason=reload does NOT kill running sub-agents", () => {
  const kills: KillRecord[] = [];
  let resetCalls = 0;
  const runs: Run[] = [
    makeRun("a", "running", kills),
    makeRun("b", "paused", kills),
  ];
  handleSessionShutdown(
    { reason: "reload" },
    { runs, resetSanitizer: () => resetCalls++ },
  );
  assert.equal(kills.length, 0, "no proc.kill calls on reload");
  assert.equal(resetCalls, 0, "sanitizer.reset NOT called on reload");
});

test("handleSessionShutdown: reason=reload preserves run records (no mutation)", () => {
  const kills: KillRecord[] = [];
  const runs: Run[] = [makeRun("a", "running", kills), makeRun("b", "paused", kills)];
  const beforeIds = runs.map((r) => r.id);
  const beforeStatuses = runs.map((r) => r.status);
  handleSessionShutdown(
    { reason: "reload" },
    { runs, resetSanitizer: () => {} },
  );
  assert.deepEqual(
    runs.map((r) => r.id),
    beforeIds,
    "run identities preserved",
  );
  assert.deepEqual(
    runs.map((r) => r.status),
    beforeStatuses,
    "run statuses unchanged on reload",
  );
});

test("handleSessionShutdown: reason=quit kills running and paused sub-agents with SIGTERM", () => {
  const kills: KillRecord[] = [];
  let resetCalls = 0;
  const runs: Run[] = [
    makeRun("a", "running", kills),
    makeRun("b", "paused", kills),
    makeRun("c", "completed", kills),
    makeRun("d", "failed", kills),
    makeRun("e", "queued", kills),
  ];
  handleSessionShutdown(
    { reason: "quit" },
    { runs, resetSanitizer: () => resetCalls++ },
  );
  // Only running + paused get killed; terminal and queued are skipped.
  const killedIds = kills.map((k) => k.id).sort();
  assert.deepEqual(killedIds, ["a", "b"]);
  for (const k of kills) {
    assert.equal(k.signal, "SIGTERM");
  }
  assert.equal(resetCalls, 1, "sanitizer.reset called exactly once on quit");
});

test("handleSessionShutdown: kill-throws are swallowed (already-dead procs are non-fatal)", () => {
  const kills: KillRecord[] = [];
  const run: Run = {
    ...makeRun("a", "running", kills),
    proc: {
      kill: () => {
        throw new Error("ESRCH: already dead");
      },
    } as unknown as Run["proc"],
  };
  assert.doesNotThrow(() =>
    handleSessionShutdown(
      { reason: "quit" },
      { runs: [run], resetSanitizer: () => {} },
    ),
  );
});

test("handleSessionShutdown: missing proc handle on a running run is non-fatal", () => {
  // Defensive: a run can be in 'running' status briefly before proc is wired.
  const run: Run = { ...makeRun("a", "running", []), proc: undefined };
  let resetCalls = 0;
  assert.doesNotThrow(() =>
    handleSessionShutdown(
      { reason: "quit" },
      { runs: [run], resetSanitizer: () => resetCalls++ },
    ),
  );
  assert.equal(resetCalls, 1, "reset still runs even if a proc was missing");
});

// Regression coverage for the other lifecycle reasons. Each of these tears
// the extension runtime down; only "reload" preserves it. Keep them on the
// kill-and-reset path.
for (const reason of ["new", "resume", "fork"] as const) {
  test(`handleSessionShutdown: reason=${reason} kills running sub-agents and resets sanitizer`, () => {
    const kills: KillRecord[] = [];
    let resetCalls = 0;
    const runs: Run[] = [makeRun("a", "running", kills)];
    handleSessionShutdown(
      { reason },
      { runs, resetSanitizer: () => resetCalls++ },
    );
    assert.equal(kills.length, 1, `kill called for reason=${reason}`);
    assert.equal(resetCalls, 1, `sanitizer reset for reason=${reason}`);
  });
}
