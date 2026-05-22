/**
 * v0.9.x post-startup reconcile — slice 1 classifier + liveness-probe witnesses.
 *
 * Pure-function tests for `classifyRecord` and `defaultLivenessProbe` from
 * `src/reconcile-startup.ts`. No filesystem scanning, no registry mutation,
 * no `session_start` wiring — those land in slices 2 and 3.
 *
 * WDD witnesses pinned in `docs/v0.9.x-post-startup-reconcile-design.md` §7
 * slice 1 table:
 *   W1 — defaultLivenessProbe sends signal 0, never SIGKILL
 *   W2 — EPERM treated as alive
 *   W3 — undefined pid → reclassify-pre-schema
 *   W4 — queued orphan → reclassify-failed-queued
 *   W5 — alive pid → readopt; dead pid → reclassify-killed
 *
 * Real-subprocess discipline (per personas/builder.md after commit 85ee77f):
 * the W1 test passes an explicit per-test timeout because it spawns a real
 * `bash -c "sleep …"` child. Without `{ timeout }`, a probe bug that
 * accidentally sent SIGKILL would still pass this test (child is dead, but
 * we never asserted on the return); the per-test timeout is a defense
 * against unrelated hangs in the helper.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  classifyRecord,
  defaultLivenessProbe,
} from "../src/reconcile-startup.ts";
import type { RunRecord } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

function record(over: Partial<RunRecord>): RunRecord {
  return {
    id: "test-aaaa",
    persona: "builder",
    task: "stub",
    mode: "background",
    status: "running",
    startTime: 1_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...over,
  };
}

// ── W1 ────────────────────────────────────────────────────────────────

test(
  "W1 defaultLivenessProbe sends signal 0, never SIGKILL",
  { timeout: 5_000 },
  async () => {
    // Spawn a real child that sleeps long enough to cover the probe.
    // We then assert via signalCode + an exit listener that the probe
    // did NOT terminate the child. (`child.killed` is only set when
    // OUR code calls subprocess.kill(), not when the OS kills the
    // child via process.kill(pid, sig); `child.exitCode` stays null
    // even after a signal kill. Both are unsafe assertion targets.)
    const child = spawn("bash", ["-c", "sleep 3"], { stdio: "ignore" });
    let exited = false;
    let exitSignal: string | null = null;
    let exitCode: number | null = null;
    child.on("exit", (c, s) => {
      exited = true;
      exitCode = c;
      exitSignal = s;
    });
    try {
      assert.ok(child.pid, "child should have pid");
      const alive = defaultLivenessProbe(child.pid!);
      assert.equal(alive, true, "probe should report alive");
      // Give the OS a beat to deliver any (incorrect) signal the probe
      // might have sent. 100ms is generous; SIGKILL is synchronous-ish.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        exited,
        false,
        `child exited during probe (code=${exitCode}, signal=${exitSignal}) — probe must use signal 0, never a real termination signal`,
      );
      assert.equal(
        child.signalCode,
        null,
        `child received signal ${child.signalCode} — probe must use signal 0, never a real termination signal`,
      );
    } finally {
      child.kill("SIGKILL");
    }
  },
);

// ── W2 ────────────────────────────────────────────────────────────────

test("W2 defaultLivenessProbe treats EPERM as alive", () => {
  // Stub process.kill to throw EPERM — pid exists but caller lacks
  // permission. The probe must report alive: a process we cannot signal
  // is still a process.
  const realKill = process.kill;
  try {
    (process as { kill: (...args: unknown[]) => boolean }).kill = () => {
      const err: NodeJS.ErrnoException = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    };
    assert.equal(defaultLivenessProbe(42), true);
  } finally {
    (process as { kill: typeof realKill }).kill = realKill;
  }
});

test("W2b defaultLivenessProbe treats ESRCH as dead", () => {
  // Symmetric companion to W2: pid does not exist.
  const realKill = process.kill;
  try {
    (process as { kill: (...args: unknown[]) => boolean }).kill = () => {
      const err: NodeJS.ErrnoException = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    };
    assert.equal(defaultLivenessProbe(42), false);
  } finally {
    (process as { kill: typeof realKill }).kill = realKill;
  }
});

test("W2c defaultLivenessProbe treats unknown errno conservatively (dead)", () => {
  const realKill = process.kill;
  try {
    (process as { kill: (...args: unknown[]) => boolean }).kill = () => {
      const err: NodeJS.ErrnoException = new Error("weird");
      err.code = "EUNKNOWN";
      throw err;
    };
    assert.equal(defaultLivenessProbe(42), false);
  } finally {
    (process as { kill: typeof realKill }).kill = realKill;
  }
});

// ── W3 ────────────────────────────────────────────────────────────────

test("W3 classifyRecord: running record without pid → reclassify-pre-schema", () => {
  const r = record({ status: "running", pid: undefined });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "reclassify-pre-schema");
});

// ── W4 ────────────────────────────────────────────────────────────────

test("W4 classifyRecord: queued status → reclassify-failed-queued", () => {
  const r = record({ status: "queued", pid: undefined });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "reclassify-failed-queued");
});

test("W4b classifyRecord: queued ignores pid liveness (always failed-queued)", () => {
  // A queued run never spawned, so even if a pid is somehow recorded,
  // the classification must still be failed-queued. Defensive but cheap.
  const r = record({ status: "queued", pid: 99999 });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "reclassify-failed-queued");
});

// ── W5 ────────────────────────────────────────────────────────────────

test("W5 classifyRecord: running pid alive → readopt", () => {
  const r = record({ status: "running", pid: 12345 });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "readopt");
});

test("W5b classifyRecord: running pid dead → reclassify-killed", () => {
  const r = record({ status: "running", pid: 12345 });
  const result = classifyRecord(r, () => false, 0);
  assert.equal(result, "reclassify-killed");
});

// ── Boundary: terminal statuses are skipped ──────────────────────────

for (const status of [
  "completed",
  "failed",
  "killed",
  "timeout",
  "hook_failed",
] as const) {
  test(`classifyRecord: terminal status ${status} → skip-terminal`, () => {
    const r = record({ status, pid: 12345 });
    const result = classifyRecord(r, () => true, 0);
    assert.equal(result, "skip-terminal");
  });
}

// ── Boundary: paused-as-running (Q-3 design note) ────────────────────
// Paused without a live process is a contradiction. Per design §3 we
// resolve toward dead — treat like running and let liveness decide.
test("classifyRecord: paused with alive pid → readopt", () => {
  const r = record({ status: "paused", pid: 12345 });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "readopt");
});

test("classifyRecord: paused with dead pid → reclassify-killed", () => {
  const r = record({ status: "paused", pid: 12345 });
  const result = classifyRecord(r, () => false, 0);
  assert.equal(result, "reclassify-killed");
});

test("classifyRecord: paused without pid → reclassify-pre-schema", () => {
  const r = record({ status: "paused", pid: undefined });
  const result = classifyRecord(r, () => true, 0);
  assert.equal(result, "reclassify-pre-schema");
});

// ── Ownership scoping (sibling-pi-session foreign-adoption fix) ───────

test("classifyRecord: parentPid === self with matching startTime → readopt (legitimate /reload survivor)", () => {
  const r = record({
    status: "running",
    pid: 12345,
    parentPid: process.pid,
    parentStartTime: 999,
  });
  const result = classifyRecord(
    r,
    () => true,
    0,
    process.pid,
    () => true,
  );
  assert.equal(result, "readopt", "our own /reload survivor must still readopt");
});

test("classifyRecord: parentPid !== self AND foreign parent alive → skip-foreign", () => {
  const r = record({
    status: "running",
    pid: 12345,
    parentPid: process.pid + 1, // different host
    parentStartTime: 7777,
  });
  const result = classifyRecord(
    r,
    () => true, // child alive
    0,
    process.pid,
    (_pid, _st) => true, // foreign parent alive
  );
  assert.equal(result, "skip-foreign");
});

test("classifyRecord: parentPid !== self but foreign parent gone → falls through to liveness (genuine orphan readopt)", () => {
  const r = record({
    status: "running",
    pid: 12345,
    parentPid: process.pid + 1,
    parentStartTime: 7777,
  });
  const result = classifyRecord(
    r,
    () => true, // child alive
    0,
    process.pid,
    (_pid, _st) => false, // foreign parent gone (genuine orphan)
  );
  assert.equal(
    result,
    "readopt",
    "when the original parent is gone, we are responsible for the orphan",
  );
});

test("classifyRecord: parentPid undefined (legacy record) → falls through to liveness (back-compat)", () => {
  // Records written before the ownership-scoping fix have no parentPid.
  // Migration rule: treat as if the foreign-check did not apply, i.e.
  // existing readopt-if-alive behavior. They age out as records get
  // rewritten or GC'd.
  const r = record({
    status: "running",
    pid: 12345,
    parentPid: undefined,
    parentStartTime: undefined,
  });
  const result = classifyRecord(
    r,
    () => true,
    0,
    process.pid,
    () => {
      throw new Error("parent probe must not be called for legacy records");
    },
  );
  assert.equal(result, "readopt");
});
