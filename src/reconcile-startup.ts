/**
 * v0.9.x post-startup reconcile — slice 1 (classifier + liveness) +
 * slice 2 (filesystem scanner that composes the slice 1 building blocks).
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
 * Slice 2 adds:
 *
 *  - `reconcileOrphansAtStartup(deps)` — walks `runsRoot/*\/record.json`,
 *    composes `classifyRecord` per record, branches:
 *      readopt              → register a partial Run as `running`
 *      reclassify-killed    → flip status→killed on disk + register as `killed`
 *      reclassify-failed-queued → flip status→failed on disk + register
 *      reclassify-pre-schema    → flip status→killed on disk + register
 *      skip-terminal        → no-op (GC's territory)
 *    All disk writes carry an `errorMessage` with prefix `"orphaned: …"`
 *    so v0.9 GC's reconciled-records path and the v0.9.x doctor surface
 *    can distinguish post-startup orphans from user-killed runs.
 *
 *    Per-record try/catch around the whole branch — one corrupt
 *    record.json must not break the scan (design F2). Idempotent:
 *    records whose id is already in the in-memory registry are skipped
 *    (the original spawn-time register beat the reconcile pass; nothing
 *    to do).
 *
 * Pure-ish module: the slice 1 helpers do no I/O; the slice 2 scanner
 * uses `node:fs/promises`. No module-level state.
 *
 * Design: docs/v0.9.x-post-startup-reconcile-design.md §3 (algorithm),
 * §4 (lifecycle integration), §7 (slice tables and witnesses).
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Run, RunRecord, RunStatus } from "./types.ts";
import { TERMINAL_STATUSES, emptyUsage } from "./types.ts";

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

// ── Slice 2: filesystem scanner + integration ───────────────────

/**
 * Minimal subset of `RunRegistry` the scanner needs. Production wiring
 * (slice 3) passes the real `RunRegistry` instance; tests pass a tiny
 * `Map<string, Run>`-backed stub. We restrict to the three methods the
 * scanner actually uses so test stubs stay small and the interface
 * doesn't accidentally couple to the listener machinery.
 */
export interface RegistryLike {
  has(id: string): boolean;
  register(run: Run): void;
  get(id: string): Run | undefined;
}

/** Dependencies for `reconcileOrphansAtStartup`. All injectable for tests. */
export interface PostStartupReconcileDeps {
  /** Root containing per-run dirs (e.g. `~/.pi/agent/conductor/runs`). */
  runsRoot: string;
  /** Registry to mutate. */
  registry: RegistryLike;
  /** Liveness probe; production passes `defaultLivenessProbe`. */
  isAlive: (pid: number) => boolean;
  /**
   * Epoch ms used for `finishedAt` on reclassified records. Injectable
   * for deterministic tests.
   */
  now: number;
  /**
   * v0.9.x Slice 4: when true, the scanner walks + classifies + reports
   * but does NOT mutate disk and does NOT register orphans. The result
   * envelope is identical to a real run, so the same renderer can drive
   * both the doctor surface and the `/conductor reconcile --dry-run`
   * preview. Defaults to false (real reconcile) when omitted.
   */
  dryRun?: boolean;
}

/**
 * Outcome bookkeeping returned to the caller. Each list contains run ids;
 * lists are mutually exclusive except for `unresumable`, which is a flag
 * orthogonal to `readopted` / `reclassified` / `preSchema` (a reclassified
 * orphan whose sessionFile is gone shows up in BOTH `reclassified` AND
 * `unresumable`).
 */
export interface PostStartupReconcileResult {
  /** Number of `record.json` files the scan attempted to read. */
  scanned: number;
  /** Run ids re-registered as `running` (live `/reload` survivors). */
  readopted: string[];
  /**
   * Run ids whose status was flipped to `killed` (dead orphan with pid)
   * or `failed` (queued orphan). Each gets a writeBack with an
   * `errorMessage` carrying the `orphaned:` prefix.
   */
  reclassified: string[];
  /**
   * Run ids reclassified specifically due to a missing `pid` field
   * (records written before slice 1 landed). Subset of `reclassified`'s
   * conceptual scope but tracked separately so doctor and dogfood can
   * see the migration tail.
   */
  preSchema: string[];
  /**
   * Run ids whose sessionFile is gone on disk. `ensemble_send` resume
   * will fail for these; doctor surfaces them so the user knows. May
   * overlap with `reclassified` or `preSchema`.
   */
  unresumable: string[];
  /** Per-record errors (parse, ENOENT-on-record-but-not-on-dir, write fails). */
  errors: Array<{ id: string; message: string }>;
}

/**
 * Walk `deps.runsRoot/*\/record.json`, classify each record, mutate the
 * in-memory registry and on-disk records per `classifyRecord`'s verdict.
 *
 * Best-effort: a missing `runsRoot` (fresh install) returns the empty
 * result without throwing (design F1). One corrupt record is logged in
 * `errors[]` and the scan continues (design F2).
 *
 * Idempotent: an id already present in `registry` is skipped — either
 * the run is live (live spawn beat the reconcile pass) or a previous
 * reconcile already registered it.
 */
export async function reconcileOrphansAtStartup(
  deps: PostStartupReconcileDeps,
): Promise<PostStartupReconcileResult> {
  const result: PostStartupReconcileResult = {
    scanned: 0,
    readopted: [],
    reclassified: [],
    preSchema: [],
    unresumable: [],
    errors: [],
  };

  // F1: runsRoot may not exist yet on a fresh install.
  let entries: string[];
  try {
    entries = await readdir(deps.runsRoot);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return result;
    // Any other readdir failure (EACCES, ENOTDIR) is also non-fatal:
    // bootstrap continues, doctor reports a single top-level error.
    result.errors.push({
      id: "<runsRoot>",
      message: `readdir failed: ${(e as Error)?.message ?? String(e)}`,
    });
    return result;
  }

  for (const id of entries) {
    const recordPath = join(deps.runsRoot, id, "record.json");

    // Per-record try/catch (W6): one bad record can't break the scan.
    try {
      let raw: string;
      try {
        raw = await readFile(recordPath, "utf-8");
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          // Directory entry without a record.json (e.g. `dist`, a stray
          // file, or an in-flight spawn). Not an error — the dir simply
          // doesn't represent a run we know about.
          continue;
        }
        throw e;
      }

      result.scanned++;

      let record: RunRecord;
      try {
        record = JSON.parse(raw) as RunRecord;
      } catch (e: unknown) {
        result.errors.push({
          id,
          message: `JSON parse error: ${(e as Error)?.message ?? String(e)}`,
        });
        continue;
      }

      // Idempotency (W4): if the registry already has this id, skip.
      // The live entry (or a prior reconcile pass) wins.
      if (deps.registry.has(record.id ?? id)) {
        continue;
      }

      const verdict = classifyRecord(record, deps.isAlive, deps.now);
      const dryRun = deps.dryRun === true;

      switch (verdict) {
        case "skip-terminal":
          // GC owns these; reconcile is a no-op.
          break;

        case "readopt": {
          // Live `/reload` survivor. Register a partial Run; do NOT
          // mutate disk — the original pi process owns the file.
          const orphan = buildOrphanRun(record, "running");
          if (!dryRun) deps.registry.register(orphan);
          result.readopted.push(record.id);
          await checkSessionResumability(record, result);
          break;
        }

        case "reclassify-killed":
        case "reclassify-pre-schema": {
          const errorMessage =
            verdict === "reclassify-pre-schema"
              ? "orphaned: pre-pid-schema record (post-startup reconcile)"
              : "orphaned: process gone (post-startup reconcile)";
          if (!dryRun) {
            await reclassifyOnDisk({
              recordPath,
              record,
              nextStatus: "killed",
              errorMessage,
              now: deps.now,
            });
          }
          const orphan = buildOrphanRun({
            ...record,
            status: "killed",
            finishedAt: deps.now,
            errorMessage,
          }, "killed");
          if (!dryRun) deps.registry.register(orphan);
          result.reclassified.push(record.id);
          if (verdict === "reclassify-pre-schema") {
            result.preSchema.push(record.id);
          }
          await checkSessionResumability(record, result);
          break;
        }

        case "reclassify-failed-queued": {
          const errorMessage =
            "orphaned: queue entry abandoned at startup (post-startup reconcile)";
          if (!dryRun) {
            await reclassifyOnDisk({
              recordPath,
              record,
              nextStatus: "failed",
              errorMessage,
              now: deps.now,
            });
          }
          const orphan = buildOrphanRun({
            ...record,
            status: "failed",
            finishedAt: deps.now,
            errorMessage,
          }, "failed");
          if (!dryRun) deps.registry.register(orphan);
          result.reclassified.push(record.id);
          // Queued orphans never had a session, so unresumable check is
          // moot — sessionPath is undefined either way.
          break;
        }
      }
    } catch (e: unknown) {
      // Catch-all for anything escaped above (writeFile, sessionPath
      // stat) so one bad record can't break the scan.
      result.errors.push({
        id,
        message: (e as Error)?.message ?? String(e),
      });
    }
  }

  return result;
}

/**
 * Construct a degraded `Run` representing an orphan we re-adopted or
 * reclassified. Mirrors the shape `spawnRun` produces minus the
 * runtime-only fields (no `proc`, no streamed messages). The first
 * `ensemble_send` resume rebuilds the message stream via
 * `pi --session <path>`.
 */
function buildOrphanRun(record: RunRecord, status: RunStatus): Run {
  return {
    id: record.id,
    persona: record.persona,
    task: record.task,
    model: record.model,
    thinking: record.thinking,
    mode: record.mode,
    status,
    startTime: record.startTime,
    finishedAt: record.finishedAt,
    pausedAt: record.pausedAt,
    pid: record.pid,
    exitCode: record.exitCode,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    lastEventAt: record.finishedAt ?? record.startTime,
    messages: [],
    usage: record.usage ?? emptyUsage(),
    cwd: record.cwd,
    recordPath: record.recordPath,
    transcriptPath: record.transcriptPath,
    finalPath: record.finalPath,
    sessionPath: record.sessionPath,
    systemPrompt: record.systemPrompt,
    hookResult: record.hookResult,
    // proc intentionally undefined: we have no handle.
  };
}

/**
 * Persist a reclassified record back to disk. Full-file rewrite via
 * `JSON.stringify` — last-write-wins is acceptable per design F5
 * (concurrent GC pass is sequenced via `setImmediate` ordering).
 */
async function reclassifyOnDisk(opts: {
  recordPath: string;
  record: RunRecord;
  nextStatus: RunStatus;
  errorMessage: string;
  now: number;
}): Promise<void> {
  const updated: RunRecord = {
    ...opts.record,
    status: opts.nextStatus,
    finishedAt: opts.now,
    errorMessage: opts.errorMessage,
  };
  await writeFile(opts.recordPath, JSON.stringify(updated, null, 2));
}

/**
 * If the record has a `sessionPath`, check whether the file still exists
 * on disk. Missing session file → add to `unresumable`. The orphan still
 * lands in the registry (so `ensemble_status` shows it); `validateSendable`
 * downstream rejects the resume attempt with a clear error.
 */
async function checkSessionResumability(
  record: RunRecord,
  result: PostStartupReconcileResult,
): Promise<void> {
  if (!record.sessionPath) {
    // No session at all — not resumable, but also not the case the
    // user expects to recover from. Don't surface in unresumable.
    return;
  }
  try {
    await stat(record.sessionPath);
  } catch {
    result.unresumable.push(record.id);
  }
}
