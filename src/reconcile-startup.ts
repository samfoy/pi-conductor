/**
 * v0.9.x post-startup reconcile — slice 1: pure detector + liveness probe.
 *
 * Slice 1 lands the building blocks the rest of v0.9.x depends on:
 *
 *  - `classifyRecord(record, isAlive, now) → ClassifyResult` — pure
 *    decision function. Given an on-disk RunRecord and a liveness
 *    oracle, returns one of five enum values describing how
 *    post-startup reconcile should treat the record.
 *
 *  - `defaultLivenessProbe(pid) → boolean` — production liveness oracle
 *    using `process.kill(pid, 0)`. ESRCH means dead; EPERM means alive
 *    (we cannot signal but the process exists); any other errno is
 *    treated conservatively as dead. **Never sends an actual termination
 *    signal** — signal 0 is the kernel's permission/existence check.
 *
 * Slice 2 will add `reconcileOrphansAtStartup(deps)` which composes
 * these two functions with a filesystem walk over `runsRoot/*\/record.json`.
 *
 * Pure module — no I/O, no module-level state, no side effects beyond
 * `process.kill(pid, 0)` (and even that's a no-op kernel check).
 *
 * Design: docs/v0.9.x-post-startup-reconcile-design.md §3 (algorithm)
 * and §7 slice 1 (witnesses).
 */

import type { RunRecord } from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";

/**
 * Outcome of classifying a single on-disk record at startup.
 *
 *  - `readopt` — record is `running` and `kill(pid, 0)` says the
 *    process is alive. Slice 2 will register a partial Run for this
 *    record (no proc handle, no message stream); its in-memory state
 *    is degraded but `ensemble_send` resume will work once it reaches
 *    a terminal status.
 *  - `reclassify-killed` — record is `running` (or `paused`-as-running)
 *    with a pid, but the process is gone (pi-dashboard restart, OOM,
 *    OS reboot). Slice 2 flips status → `killed` with an
 *    `errorMessage` prefix of `"orphaned: process gone …"`.
 *  - `reclassify-failed-queued` — record is `queued` but the runtime
 *    is fresh (no in-memory queue entry). The run never started.
 *    Slice 2 flips status → `failed` with `errorMessage` of
 *    `"orphaned: queue entry abandoned …"`.
 *  - `reclassify-pre-schema` — record is `running` (or
 *    `paused`-as-running) but has no `pid` field (predates the slice 1
 *    schema bump). We can't liveness-check, so reclassify
 *    conservatively to `killed` with `"orphaned: pre-pid-schema …"`.
 *  - `skip-terminal` — record is already in a terminal status
 *    (`completed`, `failed`, `killed`, `timeout`, `hook_failed`). The
 *    GC path owns these; reconcile is a no-op.
 */
export type ClassifyResult =
  | "readopt"
  | "reclassify-killed"
  | "reclassify-failed-queued"
  | "reclassify-pre-schema"
  | "skip-terminal";

/**
 * Decide what post-startup reconcile should do with a record.
 *
 * Pure: no I/O, no clock reads (the `now` parameter is reserved for
 * future use; slice 1 ignores it). The `isAlive` oracle is injected
 * for testability — production wiring passes `defaultLivenessProbe`.
 *
 * The decision tree (mirrors design §3):
 *
 *   if status is terminal              → skip-terminal
 *   if status === "queued"              → reclassify-failed-queued
 *   if status is `running` or `paused`:
 *     if pid is undefined              → reclassify-pre-schema
 *     if isAlive(pid)                  → readopt
 *     else                             → reclassify-killed
 *
 * `paused` is treated like `running` because a paused record without a
 * live process is a contradiction — `paused` is intended to be in-memory
 * state only — and the safest resolution is to let the liveness probe
 * make the call.
 */
export function classifyRecord(
  record: RunRecord,
  isAlive: (pid: number) => boolean,
  _now: number,
): ClassifyResult {
  const status = record.status;

  // Terminal statuses are the GC's territory.
  if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
    return "skip-terminal";
  }

  // A queued run never spawned. Status → failed regardless of any
  // (defensive) pid the record might carry.
  if (status === "queued") {
    return "reclassify-failed-queued";
  }

  // status is now `running` or `paused`. Both want liveness-driven
  // resolution.
  if (record.pid === undefined) {
    return "reclassify-pre-schema";
  }

  return isAlive(record.pid) ? "readopt" : "reclassify-killed";
}

/**
 * Production liveness probe: does a process with this pid exist that
 * the current user can address?
 *
 * Uses `process.kill(pid, 0)` — Node's wrapper for the POSIX `kill`
 * syscall. Signal 0 is the standard kernel idiom for permission +
 * existence checks; it is **never** delivered to the target process.
 *
 * Errno handling:
 *   - success (no throw)         → alive
 *   - `ESRCH` (no such process)  → dead
 *   - `EPERM` (process exists,
 *     caller cannot signal it)   → alive (count as live; we just can't
 *                                  control it)
 *   - any other errno            → dead (conservative; better to
 *                                  reclassify a live ghost than re-adopt
 *                                  a phantom process)
 *
 * The conservative-on-unknown branch is deliberate. A reclassify is
 * recoverable (`/conductor reconcile --force` re-checks); a phantom
 * re-adopt leaves the orphan stuck and confuses `ensemble_send`.
 */
export function defaultLivenessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}
