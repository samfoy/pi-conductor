/**
 * v0.11 slice 2 integration — hook enforcer wired into the close handler.
 *
 * These tests pin the contract between `runs.ts` and `hook-runner.ts`:
 *   - The exported helper `applyHookToTerminal` writes `final.md` BEFORE
 *     spawning the hook (so `CONDUCTOR_FINAL_TEXT_PATH` resolves), sets
 *     `run.hookExecuting`/`run.hookProc` for the duration, and overrides
 *     the close terminal to `hook_failed` on hook failure.
 *   - `forceTerminate` SIGTERMs the hook process group via the injected
 *     `killGroup` seam (`process.kill(-pid, sig)` in production, swallowing
 *     ESRCH/EPERM) and clears `run.hookProc` so the hook helper's close
 *     listener doesn't double-finalize.
 *   - The hook-exit idempotency guard drops the hook result when
 *     `forceTerminate` already flipped the run to a terminal status,
 *     preserving the forceTerminate-set status.
 *
 * Slice 2 WDD witnesses verified here: W5 (forceTerminate hook kill),
 * W7 (hook-exit idempotency). W1–W4 + W8 live in `tests/hook-runner.test.ts`;
 * W6 lives in `tests/watchdog-hook.test.ts`. The mutation→test red mapping
 * is pinned in `docs/v0.11-on-complete-hook-plan.md` slice 2.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  RunRegistry,
  forceTerminate,
  applyHookToTerminal,
} from "../src/runs.ts";
import {
  emptyUsage,
  type HookResult,
  type ResolvedHook,
  type Run,
} from "../src/types.ts";

function tmpRunPaths(): { dir: string; recordPath: string; transcriptPath: string; finalPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-runs-hook-"));
  return {
    dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const paths = tmpRunPaths();
  return {
    id: "builder-test",
    persona: "builder",
    task: "test slice",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    ...paths,
    ...overrides,
  };
}

function fakeChildProcess(pid: number): ChildProcess {
  // Just enough surface for forceTerminate's kill branch to read .pid and call .kill().
  return {
    pid,
    kill: () => true,
    killed: false,
  } as unknown as ChildProcess;
}

// ── W5: forceTerminate during in-flight hook ──────────────────────────

test("forceTerminate during in-flight hook: SIGTERMs process group via killGroup(pid, SIGTERM) and clears hookProc (W5 LOAD-BEARING)", () => {
  const reg = new RunRegistry();
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const stubKillGroup = (pid: number, signal: NodeJS.Signals) => {
    calls.push({ pid, signal });
  };
  const stubProc = fakeChildProcess(54321);
  const run = makeRun({
    status: "running",
    hookProc: stubProc,
    hookExecuting: true,
  });
  try {
    reg.register(run);
    forceTerminate(run, "killed", reg, undefined, stubKillGroup);
    // The killGroup contract: receive the (positive) pid; the production
    // implementation negates it for `process.kill(-pid, sig)`. Tests
    // observe at the seam, so they see the positive pid.
    assert.deepEqual(
      calls.find((c) => c.signal === "SIGTERM"),
      { pid: 54321, signal: "SIGTERM" },
      "killGroup must be called with hookProc.pid and SIGTERM",
    );
    assert.equal(run.hookProc, undefined, "hookProc cleared after kill");
    assert.equal(run.status, "killed", "forceTerminate flips status to killed; not hook_failed");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

test("forceTerminate during in-flight hook: 2s SIGKILL fallback escalates the process group", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const reg = new RunRegistry();
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const stubKillGroup = (pid: number, signal: NodeJS.Signals) => {
    calls.push({ pid, signal });
  };
  const stubProc = fakeChildProcess(99999);
  const run = makeRun({
    status: "running",
    hookProc: stubProc,
    hookExecuting: true,
  });
  try {
    reg.register(run);
    forceTerminate(run, "killed", reg, undefined, stubKillGroup);
    assert.equal(calls.length, 1, "only SIGTERM has fired so far");
    mock.timers.tick(2000);
    assert.equal(calls.length, 2, "SIGKILL fires after 2s grace");
    assert.deepEqual(calls[1], { pid: 99999, signal: "SIGKILL" });
  } finally {
    mock.timers.reset();
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

test("forceTerminate without hookProc: killGroup must NOT be called (regression-pin)", () => {
  const reg = new RunRegistry();
  let killGroupCalls = 0;
  const stubKillGroup = () => {
    killGroupCalls++;
  };
  const run = makeRun({ status: "running" }); // no hookProc
  try {
    reg.register(run);
    forceTerminate(run, "killed", reg, undefined, stubKillGroup);
    assert.equal(killGroupCalls, 0, "no hookProc → no killGroup call");
    assert.equal(run.status, "killed");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

// ── W7: hook-exit idempotency guard ───────────────────────────────────

test("applyHookToTerminal: when forceTerminate flipped status during hook flight, hookResult is dropped and terminal preserved (W7 LOAD-BEARING)", async () => {
  const run = makeRun({ status: "running" });
  try {
    // Inject a stub runHook that flips run.status to "killed" *before* it
    // resolves — mirrors a forceTerminate happening mid-flight.
    const stubRunHook = async (opts: { onProc?: (p: ChildProcess) => void }) => {
      // Caller publishes the proc handle synchronously.
      opts.onProc?.(fakeChildProcess(11111));
      // Simulate forceTerminate firing during the hook's life.
      run.status = "killed";
      run.hookProc = undefined; // forceTerminate clears it
      const result: HookResult = {
        passed: false, // hook would have classified as failure if we honored it
        command: "echo 'late'",
        exitCode: 1,
        durationMs: 10,
        logPath: join(run.recordPath, "..", "hook.log"),
        tailText: "",
        tailBytes: 0,
        tailLines: 0,
        failureKind: "exited",
      };
      return result;
    };

    const resolved: ResolvedHook = {
      command: "echo 'never sees this'",
      timeoutSeconds: 30,
      source: "per-call",
    };
    const finalTerminal = await applyHookToTerminal(
      run,
      resolved,
      "completed",
      { runHookImpl: stubRunHook },
    );

    assert.equal(finalTerminal, "killed", "must honor forceTerminate-set terminal, NOT flip to hook_failed");
    assert.equal(
      run.hookResult,
      undefined,
      "hook result must be dropped — preserves forceTerminate's lifecycle",
    );
    assert.equal(run.hookExecuting, false, "hookExecuting always cleared");
    assert.equal(run.hookProc, undefined, "hookProc always cleared");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

// ── Hook integration: happy + sad paths ───────────────────────────────

test("applyHookToTerminal: hook passes (passed=true) → terminal stays 'completed', hookResult stored", async () => {
  const run = makeRun({ status: "running" });
  try {
    const stubRunHook = async () => {
      const r: HookResult = {
        passed: true,
        command: "true",
        exitCode: 0,
        durationMs: 5,
        logPath: "/tmp/never",
        tailText: "ok",
        tailBytes: 2,
        tailLines: 1,
      };
      return r;
    };
    const resolved: ResolvedHook = {
      command: "true",
      timeoutSeconds: 30,
      source: "per-call",
    };
    const finalTerminal = await applyHookToTerminal(
      run,
      resolved,
      "completed",
      { runHookImpl: stubRunHook },
    );
    assert.equal(finalTerminal, "completed");
    assert.ok(run.hookResult, "hookResult must be stored on the Run");
    assert.equal(run.hookResult?.passed, true);
    assert.equal(run.hookExecuting, false);
    assert.equal(run.hookProc, undefined);
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

test("applyHookToTerminal: hook fails (passed=false) → terminal flips to 'hook_failed', hookResult stored", async () => {
  const run = makeRun({ status: "running" });
  try {
    const stubRunHook = async () => {
      const r: HookResult = {
        passed: false,
        command: "false",
        exitCode: 1,
        durationMs: 5,
        logPath: "/tmp/never",
        tailText: "boom",
        tailBytes: 4,
        tailLines: 1,
        failureKind: "exited",
      };
      return r;
    };
    const resolved: ResolvedHook = {
      command: "false",
      timeoutSeconds: 30,
      source: "per-call",
    };
    const finalTerminal = await applyHookToTerminal(
      run,
      resolved,
      "completed",
      { runHookImpl: stubRunHook },
    );
    assert.equal(finalTerminal, "hook_failed");
    assert.equal(run.hookResult?.passed, false);
    assert.equal(run.hookResult?.failureKind, "exited");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

// ── Ordering: writeFinal must be called before the hook spawn ─────────

test("applyHookToTerminal: writes final.md BEFORE invoking runHook (so CONDUCTOR_FINAL_TEXT_PATH resolves)", async () => {
  const run = makeRun({
    status: "running",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "the final report from the persona" }],
      } as any,
    ],
  });
  try {
    let finalContentAtHookCall: string | undefined;
    let finalExistedAtHookCall = false;
    const stubRunHook = async (opts: { finalPath: string }) => {
      finalExistedAtHookCall = existsSync(opts.finalPath);
      if (finalExistedAtHookCall) {
        finalContentAtHookCall = readFileSync(opts.finalPath, "utf8");
      }
      const r: HookResult = {
        passed: true,
        command: "noop",
        exitCode: 0,
        durationMs: 1,
        logPath: "/tmp/never",
        tailText: "",
        tailBytes: 0,
        tailLines: 0,
      };
      return r;
    };
    const resolved: ResolvedHook = {
      command: "noop",
      timeoutSeconds: 30,
      source: "per-call",
    };
    await applyHookToTerminal(run, resolved, "completed", {
      runHookImpl: stubRunHook,
    });
    assert.equal(finalExistedAtHookCall, true, "final.md must exist at the moment runHook runs");
    assert.match(
      finalContentAtHookCall ?? "",
      /the final report from the persona/,
      "final.md must contain the run's final assistant message",
    );
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

// ── hookExecuting flag bookkeeping ────────────────────────────────────

test("applyHookToTerminal: sets run.hookExecuting=true while runHook is in flight; clears in finally", async () => {
  const run = makeRun({ status: "running" });
  try {
    const seenStates: Array<{ executing: boolean | undefined }> = [];
    const stubRunHook = async () => {
      seenStates.push({ executing: run.hookExecuting });
      const r: HookResult = {
        passed: true,
        command: "noop",
        exitCode: 0,
        durationMs: 1,
        logPath: "/tmp/never",
        tailText: "",
        tailBytes: 0,
        tailLines: 0,
      };
      return r;
    };
    const resolved: ResolvedHook = {
      command: "noop",
      timeoutSeconds: 30,
      source: "per-call",
    };
    await applyHookToTerminal(run, resolved, "completed", {
      runHookImpl: stubRunHook,
    });
    assert.deepEqual(seenStates, [{ executing: true }], "hookExecuting must be true during the hook");
    assert.equal(run.hookExecuting, false, "hookExecuting must be cleared after");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});

test("applyHookToTerminal: clears hookExecuting + hookProc even when runHook throws", async () => {
  const run = makeRun({ status: "running" });
  try {
    const stubRunHook = async (opts: { onProc?: (p: ChildProcess) => void }) => {
      opts.onProc?.(fakeChildProcess(31337));
      throw new Error("synthetic blow-up");
    };
    const resolved: ResolvedHook = {
      command: "noop",
      timeoutSeconds: 30,
      source: "per-call",
    };
    await assert.rejects(
      applyHookToTerminal(run, resolved, "completed", { runHookImpl: stubRunHook }),
      /synthetic blow-up/,
    );
    assert.equal(run.hookExecuting, false, "must clear in finally");
    assert.equal(run.hookProc, undefined, "must clear in finally");
  } finally {
    rmSync(run.recordPath, { force: true });
    rmSync(run.transcriptPath, { force: true });
    rmSync(run.finalPath, { force: true });
  }
});
