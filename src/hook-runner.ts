/**
 * pi-conductor — `on_complete_hook` enforcer (v0.11 slice 2).
 *
 * Spawns a resolved hook command after a sub-agent's pi subprocess has
 * cleanly closed (exit-0 natural close), pipes stdout+stderr into
 * `runDir/hook.log` with a 10 MB byte cap, enforces a configurable
 * timeout, and returns a structured {@link HookResult}.
 *
 * Design invariants (from `docs/v0.11-on-complete-hook-design.md` §3-5):
 *   - **Detached process group** (`detached: true` on `spawn`). All
 *     kill-the-hook paths signal the *process group*, not the shell —
 *     `process.kill(-pid, sig)` — so the hook plus any descendants
 *     it forked die together (R3: surviving daemon).
 *   - **Timeout escalation**: SIGTERM at the configured timeout, SIGKILL
 *     2 s later if the group is still alive.
 *   - **10 MB stream cap**: stdout+stderr bytes counted; on overshoot
 *     the helper kills the group with `failureKind: "runaway_output"`.
 *     Test-injectable via `deps.maxLogBytes` (slice 2 oracle plan-edit).
 *   - **Sync spawn errors** (binary not found, EACCES) are caught and
 *     surfaced as a `HookResult` with `failureKind: "spawn_error"` and
 *     `exitCode: null` rather than thrown — the caller never sees a
 *     rejected promise, so the close-handler's flow stays linear.
 *   - **Tail capture**: last 50 lines OR 4 KB of combined output,
 *     whichever boundary the streamed data hits first. Used by the
 *     `<hook>` envelope renderer (slice 5).
 *
 * Pure-ish: `runHook` performs file I/O (the hook.log writer) and
 * spawns a subprocess, but every external dependency is injectable
 * (`deps.spawn`, `deps.maxLogBytes`, `deps.killGroup`, `deps.now`,
 * `deps.timer`). Tests pass deterministic stubs and never fork real
 * subprocesses for the race tests — the helper's behavior is fully
 * exercised through the dependency surface.
 *
 * Slice 2 ships the helper plus its wiring into the close handler in
 * `src/runs.ts`. Slice 3 extends the per-call args; slice 4 wires the
 * persona-frontmatter layer; slice 5 adds the UX surfaces (doctor row,
 * widget glyph, completion-envelope `<hook>` block).
 */

import {
  spawn as childProcessSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import type { HookResult, ResolvedHook } from "./types.ts";

/** Default per-stream byte cap (10 MB). Mirrors the design §4.4 invariant. */
export const DEFAULT_HOOK_MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Soft kill grace before SIGKILL escalation, in ms. Mirrors `forceTerminate`. */
const SIGKILL_GRACE_MS = 2_000;

/** Tail capture caps. Used to populate `HookResult.tailText`. */
const TAIL_MAX_LINES = 50;
const TAIL_MAX_BYTES = 4 * 1024;

/**
 * Inputs to {@link runHook}. The shape is intentionally flat — every
 * field the hook helper needs is plumbed by the caller; nothing comes
 * out of a registry or global.
 */
export interface RunHookOptions {
  /** Resolved cascade output. The empty-string disable sentinel never reaches here. */
  resolved: ResolvedHook;
  /** Sub-agent run id, surfaced as `CONDUCTOR_RUN_ID`. */
  runId: string;
  /** Persona name, surfaced as `CONDUCTOR_PERSONA`. */
  persona: string;
  /** Absolute path to `runDir(id)/`. Surfaced as `CONDUCTOR_RUN_DIR`. */
  runDir: string;
  /** Absolute path to the run's `final.md` (already written by `writeFinal`). */
  finalPath: string;
  /** Absolute path to the run's `transcript.jsonl`. */
  transcriptPath: string;
  /** Parent process cwd at spawn time. Surfaced as `CONDUCTOR_PARENT_CWD`. */
  parentCwd: string;
  /**
   * Called synchronously after the child process is created so the caller
   * can stash the handle on `Run.hookProc` for `forceTerminate`. The
   * helper itself does not mutate `Run`.
   */
  onProc?: (proc: ChildProcess) => void;
  /** Test injection seam. */
  deps?: HookRunnerDeps;
}

export interface HookRunnerDeps {
  spawn?: typeof childProcessSpawn;
  /** Override for {@link DEFAULT_HOOK_MAX_LOG_BYTES} (test injection seam). */
  maxLogBytes?: number;
  /**
   * Override for `process.kill(-pid, sig)`. Tests pass a recorder; production
   * uses `process.kill` directly. Default implementation swallows ESRCH/EPERM.
   */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Override for `Date.now()`. Used to compute `durationMs`. */
  now?: () => number;
  /**
   * Override for `setTimeout` so race tests can use fake timers. Returned
   * handle is opaque; the helper only uses it for `clearTimeout`.
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Default group-signal sender. Wraps `process.kill(-pid, sig)` to swallow
 * ESRCH (already-dead group) and EPERM. Exported for tests that want the
 * production behavior without the test stub.
 */
export function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return;
    // Other errors are unexpected — surface via stderr but don't throw;
    // a hook kill failure should never crash the lifecycle.
    try {
      console.error(`[hook-runner] unexpected kill error: ${(e as Error).message}`);
    } catch {
      // never crash
    }
  }
}

/**
 * Spawn the resolved hook, await its termination (or timeout / runaway-
 * output kill), and return a structured {@link HookResult}. Never throws —
 * all error paths produce a `HookResult` with `passed: false` and a
 * `failureKind` discriminator.
 *
 * The caller is responsible for:
 *   - writing `final.md` BEFORE invoking this helper (so
 *     `CONDUCTOR_FINAL_TEXT_PATH` resolves);
 *   - wiring the returned `HookResult` into `Run.hookResult` and
 *     branching the close terminal between `completed` and `hook_failed`;
 *   - calling `onProc` to stash the handle on `Run.hookProc` so
 *     `forceTerminate` can SIGTERM the group.
 */
export function runHook(opts: RunHookOptions): Promise<HookResult> {
  const deps = opts.deps ?? {};
  const spawn = deps.spawn ?? childProcessSpawn;
  const maxLogBytes = deps.maxLogBytes ?? DEFAULT_HOOK_MAX_LOG_BYTES;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  const startedAt = now();
  const logPath = `${opts.runDir}/hook.log`;

  // Best-effort directory ensure; runDir always exists by the time the
  // close handler runs but we don't want to crash if a test fixture
  // forgot to create it.
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // best-effort
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONDUCTOR_RUN_ID: opts.runId,
    CONDUCTOR_PERSONA: opts.persona,
    CONDUCTOR_FINAL_TEXT_PATH: opts.finalPath,
    CONDUCTOR_TRANSCRIPT_PATH: opts.transcriptPath,
    CONDUCTOR_RUN_DIR: opts.runDir,
    CONDUCTOR_HOOK_LOG: logPath,
    CONDUCTOR_PARENT_CWD: opts.parentCwd,
  };

  const spawnOpts: SpawnOptions = {
    shell: true,
    detached: true,
    cwd: opts.parentCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  };

  // Sync spawn errors (binary missing on PATH, EACCES, ENOENT) bubble
  // up here. We surface them as a HookResult rather than rejecting; the
  // close-handler's flow stays linear.
  let proc: ChildProcess;
  try {
    proc = spawn(opts.resolved.command, spawnOpts);
  } catch (e) {
    return Promise.resolve({
      passed: false,
      command: opts.resolved.command,
      exitCode: null,
      durationMs: now() - startedAt,
      logPath,
      tailText: `(spawn error) ${(e as Error).message}`,
      tailBytes: 0,
      tailLines: 0,
      failureKind: "spawn_error",
    });
  }

  if (opts.onProc) {
    try {
      opts.onProc(proc);
    } catch {
      // listener errors must not abort the hook — the process is already alive
    }
  }

  return new Promise<HookResult>((resolve) => {
    let resolved = false;
    let killReason: "timeout" | "runaway_output" | undefined;
    let timeoutHandle: unknown | undefined;
    let killEscalationHandle: unknown | undefined;
    let totalBytes = 0;
    const tailLines: string[] = [];
    let tailLineBuffer = "";
    let tailByteCount = 0;

    const logStream = createWriteStream(logPath, { flags: "w" });
    logStream.on("error", () => {
      // best-effort log file; never crash the hook resolution path
    });

    const finalize = (exitCode: number | null, signal: string | null): void => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle !== undefined) clearTimer(timeoutHandle);
      if (killEscalationHandle !== undefined) clearTimer(killEscalationHandle);
      // Flush any tail buffer into the line list.
      if (tailLineBuffer.length > 0) {
        appendTailLine(tailLines, tailLineBuffer);
        tailLineBuffer = "";
      }
      const tailText = renderTail(tailLines);
      const tailBytes = Buffer.byteLength(tailText, "utf8");
      const tailLineCount = tailText.length === 0 ? 0 : tailText.split("\n").length;
      let failureKind: HookResult["failureKind"];
      let passed = false;
      if (killReason === "runaway_output") {
        failureKind = "runaway_output";
      } else if (killReason === "timeout") {
        failureKind = "timeout";
      } else if (signal !== null) {
        failureKind = "signal";
      } else if (exitCode === 0) {
        passed = true;
      } else {
        failureKind = "exited";
      }
      // End the log stream and wait for it to flush before resolving so
      // callers (and tests) can synchronously read hook.log after await.
      const finishStream = new Promise<void>((res) => {
        logStream.once("finish", () => res());
        logStream.once("error", () => res());
        try {
          logStream.end();
        } catch {
          res();
        }
      });
      void finishStream.then(() => {
        resolve({
          passed,
          command: opts.resolved.command,
          exitCode,
          durationMs: now() - startedAt,
          logPath,
          tailText,
          tailBytes,
          tailLines: tailLineCount,
          failureKind,
        });
      });
    };

    const escalateToSigkill = (): void => {
      if (resolved) return;
      if (proc.pid === undefined) return;
      killGroup(proc.pid, "SIGKILL");
    };

    const beginGroupKill = (reason: "timeout" | "runaway_output"): void => {
      if (killReason !== undefined) return; // already escalating
      killReason = reason;
      if (proc.pid === undefined) return;
      killGroup(proc.pid, "SIGTERM");
      killEscalationHandle = setTimer(escalateToSigkill, SIGKILL_GRACE_MS);
    };

    const onChunk = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      // Stream the chunk to the log file (best-effort).
      try {
        logStream.write(buf);
      } catch {
        // ignore
      }
      // Append to tail accumulator (text-decoded).
      const text = buf.toString("utf8");
      const merged = tailLineBuffer + text;
      const lines = merged.split("\n");
      tailLineBuffer = lines.pop() ?? "";
      for (const line of lines) appendTailLine(tailLines, line);
      // Maintain per-byte cap on the buffered tail text so a single huge
      // line doesn't balloon memory.
      tailByteCount = capTailBytes(tailLines, tailByteCount, line_length(tailLineBuffer));
      // Runaway output cap.
      if (totalBytes >= maxLogBytes && killReason === undefined) {
        beginGroupKill("runaway_output");
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);

    proc.on("error", (e) => {
      // Async spawn errors land here.
      if (resolved) return;
      resolved = true;
      if (timeoutHandle !== undefined) clearTimer(timeoutHandle);
      if (killEscalationHandle !== undefined) clearTimer(killEscalationHandle);
      try {
        logStream.end();
      } catch {
        // best-effort
      }
      resolve({
        passed: false,
        command: opts.resolved.command,
        exitCode: null,
        durationMs: now() - startedAt,
        logPath,
        tailText: `(spawn error) ${e.message}`,
        tailBytes: 0,
        tailLines: 0,
        failureKind: "spawn_error",
      });
    });

    proc.on("close", (code, signal) => {
      finalize(code, signal);
    });

    // Schedule the timeout. On fire, group-SIGTERM then 2 s SIGKILL.
    timeoutHandle = setTimer(() => {
      beginGroupKill("timeout");
    }, opts.resolved.timeoutSeconds * 1000);
  });
}

// ── Tail helpers ──────────────────────────────────────────────────────

function appendTailLine(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > TAIL_MAX_LINES) {
    lines.splice(0, lines.length - TAIL_MAX_LINES);
  }
}

/**
 * Cap the joined tail bytes at TAIL_MAX_BYTES by trimming the oldest
 * lines. Returns the new running byte count (informational; the
 * authoritative tail is the array, the count is just to skip heavy
 * computations on the hot path).
 */
function capTailBytes(lines: string[], _currentBytes: number, _pendingBytes: number): number {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += Buffer.byteLength(lines[i] ?? "", "utf8") + 1; // +1 for the newline
    if (total > TAIL_MAX_BYTES) {
      lines.splice(0, i + 1);
      return total - (Buffer.byteLength(lines[0] ?? "", "utf8") + 1);
    }
  }
  return total;
}

function line_length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function renderTail(lines: string[]): string {
  if (lines.length === 0) return "";
  return lines.join("\n");
}
