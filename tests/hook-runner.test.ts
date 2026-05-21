/**
 * Tests for the v0.11 on_complete_hook enforcer (`src/hook-runner.ts`).
 *
 * Covers the slice-2 acceptance criteria for the helper itself:
 *   - spawn shape (`shell: true`, `detached: true`)
 *   - env contract (`CONDUCTOR_*` vars per design §3.5)
 *   - log capture to `runDir/hook.log`
 *   - tail capture (≤50 lines / ≤4 KB)
 *   - exit-0 → `passed: true`
 *   - exit non-zero → `passed: false` with `failureKind: "exited"`
 *   - timeout → SIGTERM → 2s SIGKILL via `process.kill(-pid, ...)` →
 *     `failureKind: "timeout"`
 *   - 10 MB cap → kill → `failureKind: "runaway_output"`
 *   - sync spawn error → `failureKind: "spawn_error"` (no rejected promise)
 *   - async spawn error → same
 *
 * No real subprocesses are forked here. Every test injects `deps.spawn`
 * with a fake `ChildProcess` we drive directly. Race tests use the
 * timer-injection seam (`deps.setTimer` / `deps.clearTimer`) to avoid
 * real wall-clock waits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runHook,
  DEFAULT_HOOK_MAX_LOG_BYTES,
  type RunHookOptions,
  type HookRunnerDeps,
} from "../src/hook-runner.ts";
import type { ResolvedHook } from "../src/types.ts";

// ── Fake child-process plumbing ───────────────────────────────────────

interface FakeProc extends EventEmitter {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  /** Test helper: emit a 'close' on the proc. */
  emitClose: (code: number | null, signal: string | null) => void;
  /** Test helper: emit a 'data' chunk on stdout. */
  emitStdout: (chunk: string | Buffer) => void;
  /** Test helper: emit a 'data' chunk on stderr. */
  emitStderr: (chunk: string | Buffer) => void;
  /** Test helper: emit an 'error' on the proc. */
  emitError: (e: Error) => void;
}

function fakeProc(pid = 12345): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.emitClose = (code, signal) => proc.emit("close", code, signal);
  proc.emitStdout = (chunk) => proc.stdout.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  proc.emitStderr = (chunk) => proc.stderr.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  proc.emitError = (e) => proc.emit("error", e);
  return proc;
}

interface FakeSpawnRecord {
  command: string;
  options: { shell?: boolean; detached?: boolean; env?: NodeJS.ProcessEnv; cwd?: string };
  proc: FakeProc;
}

function fakeSpawn(): { spawn: any; calls: FakeSpawnRecord[] } {
  const calls: FakeSpawnRecord[] = [];
  const spawn = (cmd: string, options: any) => {
    const proc = fakeProc();
    calls.push({ command: cmd, options, proc });
    return proc;
  };
  return { spawn, calls };
}

interface KillRecord {
  pid: number;
  signal: NodeJS.Signals;
}

function fakeKillGroup(): { killGroup: HookRunnerDeps["killGroup"]; calls: KillRecord[] } {
  const calls: KillRecord[] = [];
  return {
    killGroup: (pid, signal) => calls.push({ pid, signal }),
    calls,
  };
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  fired: boolean;
  cleared: boolean;
}

function fakeTimers(): {
  setTimer: HookRunnerDeps["setTimer"];
  clearTimer: HookRunnerDeps["clearTimer"];
  fire: (idx: number) => void;
  list: FakeTimer[];
} {
  const list: FakeTimer[] = [];
  return {
    setTimer: (fn, ms) => {
      const t: FakeTimer = { fn, ms, fired: false, cleared: false };
      list.push(t);
      return t;
    },
    clearTimer: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
    fire: (idx) => {
      const t = list[idx];
      if (!t) throw new Error(`no timer at index ${idx}`);
      if (t.cleared) throw new Error(`timer ${idx} was cleared before fire`);
      t.fired = true;
      t.fn();
    },
    list,
  };
}

const RESOLVED: ResolvedHook = {
  command: "echo hi",
  timeoutSeconds: 60,
  source: "per-call",
};

interface Fx {
  runDir: string;
}

function setup(): Fx {
  return { runDir: mkdtempSync(join(tmpdir(), "hook-runner-")) };
}

function teardown(fx: Fx): void {
  rmSync(fx.runDir, { recursive: true, force: true });
}

function baseOpts(fx: Fx, deps: HookRunnerDeps, override: Partial<RunHookOptions> = {}): RunHookOptions {
  return {
    resolved: RESOLVED,
    runId: "builder-test",
    persona: "builder",
    runDir: fx.runDir,
    finalPath: join(fx.runDir, "final.md"),
    transcriptPath: join(fx.runDir, "transcript.jsonl"),
    parentCwd: "/tmp",
    deps,
    ...override,
  };
}

// ── Spawn shape ───────────────────────────────────────────────────────

test("runHook: spawns child_process with shell=true and detached=true", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "echo hi");
    assert.equal(calls[0]!.options.shell, true);
    assert.equal(calls[0]!.options.detached, true);
    calls[0]!.proc.emitClose(0, null);
    await promise;
  } finally {
    teardown(fx);
  }
});

// ── Env injection ─────────────────────────────────────────────────────

test("runHook: injects CONDUCTOR_* env vars per design §3.5", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(
      baseOpts(fx, { spawn }, {
        runId: "builder-abc",
        persona: "builder",
        finalPath: "/run/final.md",
        transcriptPath: "/run/transcript.jsonl",
        parentCwd: "/work",
      }),
    );
    const env = calls[0]!.options.env!;
    assert.equal(env["CONDUCTOR_RUN_ID"], "builder-abc");
    assert.equal(env["CONDUCTOR_PERSONA"], "builder");
    assert.equal(env["CONDUCTOR_FINAL_TEXT_PATH"], "/run/final.md");
    assert.equal(env["CONDUCTOR_TRANSCRIPT_PATH"], "/run/transcript.jsonl");
    assert.equal(env["CONDUCTOR_RUN_DIR"], fx.runDir);
    assert.equal(env["CONDUCTOR_HOOK_LOG"], `${fx.runDir}/hook.log`);
    assert.equal(env["CONDUCTOR_PARENT_CWD"], "/work");
    calls[0]!.proc.emitClose(0, null);
    await promise;
  } finally {
    teardown(fx);
  }
});

// ── onProc callback ───────────────────────────────────────────────────

test("runHook: invokes onProc with the spawned ChildProcess", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    let captured: any = null;
    const promise = runHook(baseOpts(fx, { spawn }, { onProc: (p) => { captured = p; } }));
    assert.ok(captured, "onProc not called");
    assert.equal(captured, calls[0]!.proc);
    calls[0]!.proc.emitClose(0, null);
    await promise;
  } finally {
    teardown(fx);
  }
});

// ── Exit 0 → passed (W1) ─────────────────────────────────────────────

test("runHook: exit 0 → passed=true, failureKind undefined", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    calls[0]!.proc.emitClose(0, null);
    const result = await promise;
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failureKind, undefined);
    assert.equal(result.command, "echo hi");
  } finally {
    teardown(fx);
  }
});

// ── Exit non-zero → hook_failed (W2) ─────────────────────────────────

test("runHook: exit 1 → passed=false, failureKind=exited", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    calls[0]!.proc.emitClose(1, null);
    const result = await promise;
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.failureKind, "exited");
  } finally {
    teardown(fx);
  }
});

// ── Log capture ───────────────────────────────────────────────────────

test("runHook: stdout and stderr written to runDir/hook.log", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    calls[0]!.proc.emitStdout("line one\n");
    calls[0]!.proc.emitStderr("line two\n");
    calls[0]!.proc.emitClose(0, null);
    await promise;
    const logPath = join(fx.runDir, "hook.log");
    assert.ok(existsSync(logPath), `expected ${logPath} to exist`);
    const content = readFileSync(logPath, "utf-8");
    assert.match(content, /line one/);
    assert.match(content, /line two/);
  } finally {
    teardown(fx);
  }
});

// ── Tail (last 50 lines / 4 KB) ───────────────────────────────────────

test("runHook: tail caps at 50 lines", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    for (let i = 0; i < 80; i++) calls[0]!.proc.emitStdout(`line-${i}\n`);
    calls[0]!.proc.emitClose(0, null);
    const result = await promise;
    assert.ok(result.tailLines <= 50, `expected ≤50 tail lines, got ${result.tailLines}`);
    assert.match(result.tailText, /line-79/, "tail should include the last line");
    assert.doesNotMatch(result.tailText, /line-0\b/, "tail should NOT include the first line");
  } finally {
    teardown(fx);
  }
});

// ── Timeout → SIGTERM → SIGKILL via process-group (W3) ────────────────

test("runHook: timeout fires SIGTERM via process.kill(-pid, ...) and SIGKILL after 2s grace", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const { killGroup, calls: killCalls } = fakeKillGroup();
    const timers = fakeTimers();
    const promise = runHook(
      baseOpts(fx, {
        spawn,
        killGroup,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      }),
    );
    // Two timers should be queued — the timeout (escalation), and any
    // future kill-grace timer is queued only after timeout fires.
    assert.equal(timers.list.length, 1);
    // Fire the timeout timer.
    timers.fire(0);
    assert.equal(killCalls.length, 1, "expected SIGTERM after timeout");
    assert.equal(killCalls[0]!.signal, "SIGTERM");
    assert.equal(killCalls[0]!.pid, 12345);
    // 2-second grace timer queued.
    assert.equal(timers.list.length, 2);
    assert.equal(timers.list[1]!.ms, 2000);
    // Hook still hasn't closed; fire the SIGKILL escalation.
    timers.fire(1);
    assert.equal(killCalls.length, 2);
    assert.equal(killCalls[1]!.signal, "SIGKILL");
    // Now simulate the close that the SIGKILL caused.
    calls[0]!.proc.emitClose(null, "SIGKILL");
    const result = await promise;
    assert.equal(result.passed, false);
    assert.equal(result.failureKind, "timeout");
  } finally {
    teardown(fx);
  }
});

// ── Runaway output cap (W4) ───────────────────────────────────────────

test("runHook: deps.maxLogBytes=1024 → kills hook with failureKind=runaway_output", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const { killGroup, calls: killCalls } = fakeKillGroup();
    const timers = fakeTimers();
    const promise = runHook(
      baseOpts(fx, {
        spawn,
        killGroup,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        maxLogBytes: 1024,
      }),
    );
    // Push >1024 bytes through stdout.
    for (let i = 0; i < 50; i++) {
      calls[0]!.proc.emitStdout("x".repeat(50) + "\n"); // 51 bytes per chunk
    }
    // Group SIGTERM should have fired by now.
    assert.ok(killCalls.length >= 1, "expected SIGTERM after runaway output");
    assert.equal(killCalls[0]!.signal, "SIGTERM");
    // Simulate the kill-induced close.
    calls[0]!.proc.emitClose(null, "SIGKILL");
    const result = await promise;
    assert.equal(result.passed, false);
    assert.equal(result.failureKind, "runaway_output");
  } finally {
    teardown(fx);
  }
});

// ── Default cap is 10 MB ──────────────────────────────────────────────

test("runHook: DEFAULT_HOOK_MAX_LOG_BYTES is 10 MB", () => {
  assert.equal(DEFAULT_HOOK_MAX_LOG_BYTES, 10 * 1024 * 1024);
});

// ── Sync spawn error ──────────────────────────────────────────────────

test("runHook: synchronous spawn error → failureKind=spawn_error, no throw", async () => {
  const fx = setup();
  try {
    const spawn = (() => {
      throw new Error("ENOENT: no such file");
    }) as any;
    const result = await runHook(baseOpts(fx, { spawn }));
    assert.equal(result.passed, false);
    assert.equal(result.failureKind, "spawn_error");
    assert.equal(result.exitCode, null);
    assert.match(result.tailText, /ENOENT/);
  } finally {
    teardown(fx);
  }
});

// ── Async error event ─────────────────────────────────────────────────

test("runHook: async error event on proc → failureKind=spawn_error", async () => {
  const fx = setup();
  try {
    const { spawn, calls } = fakeSpawn();
    const promise = runHook(baseOpts(fx, { spawn }));
    calls[0]!.proc.emitError(new Error("EACCES: permission denied"));
    const result = await promise;
    assert.equal(result.passed, false);
    assert.equal(result.failureKind, "spawn_error");
    assert.match(result.tailText, /EACCES/);
  } finally {
    teardown(fx);
  }
});

// ── Real-subprocess smoke test (single, opt-in via real spawn) ────────

test("runHook smoke: real `bash -c \"exit 0\"` resolves passed=true", async () => {
  const fx = setup();
  try {
    const result = await runHook({
      resolved: { command: "exit 0", timeoutSeconds: 5, source: "per-call" },
      runId: "smoke",
      persona: "builder",
      runDir: fx.runDir,
      finalPath: join(fx.runDir, "final.md"),
      transcriptPath: join(fx.runDir, "transcript.jsonl"),
      parentCwd: "/tmp",
    });
    assert.equal(result.passed, true);
    assert.equal(result.exitCode, 0);
  } finally {
    teardown(fx);
  }
});
