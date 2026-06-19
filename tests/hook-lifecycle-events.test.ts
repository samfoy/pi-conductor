/**
 * Tests for v0.17-S5: Hook lifecycle events.
 *
 * WDD witnesses:
 *   W1: onStart called when hook spawn succeeds (after onProc fires, before exit)
 *   W2: onEnd called with passed=true for exit-0 hook
 *   W3: onEnd called with passed=false + exitCode for non-zero exit
 *   W4: onStart NOT called when spawn fails (failureKind === "spawn_error")
 *
 * Killing mutation for W1:
 *   Remove the `if (opts.onStart)` call site in hook-runner.ts.
 *   → W1 assertion `onStartCalls === 1` fails.
 *
 * Killing mutation for W2:
 *   Change `onEnd(result)` call to only fire when `!result.passed`.
 *   → W2 assertion fails.
 *
 * Killing mutation for W3:
 *   Change `onEnd` call to only fire when `result.passed === true`.
 *   → W3 assertion fails.
 *
 * Killing mutation for W4:
 *   Move `onStart` call inside the `new Promise` block (after the catch path).
 *   → W4 assertion `onStartCalls === 0` fails for sync spawn errors.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook, type RunHookOptions, type HookRunnerDeps } from "../src/hook-runner.ts";
import type { ResolvedHook } from "../src/types.ts";

// ── Fake child-process helpers ────────────────────────────────────────

interface FakeProc extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitClose: (code: number | null, signal: string | null) => void;
}

function fakeProc(pid = 99999): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.emitClose = (code, signal) => proc.emit("close", code, signal);
  return proc;
}

function fakeSpawn(overrideProc?: FakeProc): { spawn: any; proc: FakeProc } {
  const p = overrideProc ?? fakeProc();
  const spawn = (_cmd: string, _opts: any) => p;
  return { spawn, proc: p };
}

const RESOLVED: ResolvedHook = {
  command: "echo hi",
  timeoutSeconds: 30,
  source: "per-call",
};

function setup(): { runDir: string } {
  return { runDir: mkdtempSync(join(tmpdir(), "hlc-events-")) };
}

function teardown(fx: { runDir: string }): void {
  rmSync(fx.runDir, { recursive: true, force: true });
}

function baseOpts(
  fx: { runDir: string },
  deps: HookRunnerDeps,
  override: Partial<RunHookOptions> = {},
): RunHookOptions {
  return {
    resolved: RESOLVED,
    runId: "test-run",
    persona: "builder",
    runDir: fx.runDir,
    finalPath: join(fx.runDir, "final.md"),
    transcriptPath: join(fx.runDir, "transcript.jsonl"),
    parentCwd: "/tmp",
    deps,
    ...override,
  };
}

// ── W1: onStart called after spawn succeeds ───────────────────────────

test("runHook lifecycle: W1 — onStart called once when spawn succeeds", async () => {
  const fx = setup();
  try {
    const { spawn, proc } = fakeSpawn();
    let onStartCalls = 0;
    let onProcCalls = 0;
    const onProcOrder: string[] = [];

    const promise = runHook(baseOpts(fx, { spawn }, {
      onProc: () => {
        onProcCalls++;
        onProcOrder.push("onProc");
      },
      onStart: () => {
        onStartCalls++;
        onProcOrder.push("onStart");
      },
    }));

    // Drive to completion
    proc.emitClose(0, null);
    await promise;

    assert.equal(onStartCalls, 1, "onStart should be called exactly once");
    assert.equal(onProcCalls, 1, "onProc should be called");
    // onProc fires before onStart (onStart fires after onProc)
    assert.deepStrictEqual(onProcOrder, ["onProc", "onStart"],
      "onProc must fire before onStart");
  } finally {
    teardown(fx);
  }
});

// ── W2: onEnd called with passed=true for exit-0 ─────────────────────

test("runHook lifecycle: W2 — onEnd called with passed=true for exit-0", async () => {
  const fx = setup();
  try {
    const { spawn, proc } = fakeSpawn();
    let endResult: { passed: boolean; exitCode?: number | null } | undefined;

    const promise = runHook(baseOpts(fx, { spawn }, {
      onEnd: (r) => {
        endResult = { passed: r.passed, exitCode: r.exitCode };
      },
    }));

    proc.emitClose(0, null);
    const result = await promise;

    assert.ok(endResult !== undefined, "onEnd should have been called");
    assert.equal(endResult!.passed, true, "passed should be true for exit-0");
    assert.equal(endResult!.exitCode, 0, "exitCode should be 0");
    assert.equal(result.passed, true);
  } finally {
    teardown(fx);
  }
});

// ── W3: onEnd called with passed=false + exitCode for non-zero ────────

test("runHook lifecycle: W3 — onEnd called with passed=false + exitCode for non-zero exit", async () => {
  const fx = setup();
  try {
    const { spawn, proc } = fakeSpawn();
    let endResult: { passed: boolean; exitCode?: number | null } | undefined;

    const promise = runHook(baseOpts(fx, { spawn }, {
      onEnd: (r) => {
        endResult = { passed: r.passed, exitCode: r.exitCode };
      },
    }));

    proc.emitClose(2, null);
    await promise;

    assert.ok(endResult !== undefined, "onEnd should have been called");
    assert.equal(endResult!.passed, false, "passed should be false for non-zero exit");
    assert.equal(endResult!.exitCode, 2, "exitCode should be 2");
  } finally {
    teardown(fx);
  }
});

// ── W4: onStart NOT called on sync spawn error ────────────────────────

test("runHook lifecycle: W4 — onStart not called when spawn fails (sync spawn_error)", async () => {
  const fx = setup();
  try {
    let onStartCalls = 0;
    let onEndCalls = 0;

    const throwingSpawn = () => {
      throw new Error("ENOENT: binary not found");
    };

    const result = await runHook(baseOpts(fx, { spawn: throwingSpawn }, {
      onStart: () => { onStartCalls++; },
      onEnd: () => { onEndCalls++; },
    }));

    assert.equal(result.failureKind, "spawn_error", "should be spawn_error");
    assert.equal(result.passed, false);
    assert.equal(onStartCalls, 0, "onStart must NOT be called for spawn_error");
    assert.equal(onEndCalls, 0, "onEnd must NOT be called for spawn_error");
  } finally {
    teardown(fx);
  }
});
