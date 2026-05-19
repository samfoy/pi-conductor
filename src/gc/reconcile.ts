/**
 * pi-conductor — GC orphan reconciler.
 *
 * Effectful counterpart to the policy engine's `reconcile-orphan` actions.
 * For each such action, mutate the on-disk `record.json` from
 * `status: "running"` to `status: "killed"` with a marker errorMessage and
 * `finishedAt = now`. The function is best-effort and idempotent:
 *
 *   - missing dir / file → silently skipped (race with another GC pass or
 *     a manual `rm -rf`)
 *   - record already non-running → silently skipped (someone else
 *     reconciled it; running this pass twice is safe)
 *   - JSON parse / I/O error → reported in `failed`, not thrown
 *
 * Does NOT touch the in-memory `RunRegistry`. The `inMemory === undefined`
 * gate is enforced upstream by the policy engine; if a record is in the
 * registry, the policy never emits a `reconcile-orphan` for it.
 *
 * Spec: docs/v0.9-gc-design.md §D5; docs/v0.9-gc-plan.md "Slice 2".
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunRecord } from "../types.ts";
import type { ReclaimAction } from "./policy.ts";

export interface ReconcileResult {
  /** Agent ids that were successfully flipped from running → killed on disk. */
  reconciled: string[];
  /** Agent ids whose reconcile attempt errored (corrupt JSON, I/O failure, etc.). */
  failed: Array<{ agentId: string; error: string }>;
}

/**
 * Apply `reconcile-orphan` actions from a `ReclaimPlan` to disk.
 *
 * @param actions Full plan action list. Non-`reconcile-orphan` entries are
 *   ignored so callers can pass `plan.actions` directly.
 * @param runsRoot Root directory that contains `<agentId>/record.json`.
 * @param now Epoch ms used for `finishedAt`.
 */
export async function reconcileOrphans(
  actions: readonly ReclaimAction[],
  runsRoot: string,
  now: number,
): Promise<ReconcileResult> {
  const reconciled: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];

  for (const action of actions) {
    if (action.kind !== "reconcile-orphan") continue;

    const agentId = action.id;
    const recordPath = join(runsRoot, agentId, "record.json");

    let raw: string;
    try {
      raw = await readFile(recordPath, "utf-8");
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        // Race: dir or file gone. Not an error; just skip.
        continue;
      }
      failed.push({ agentId, error: String((e as Error)?.message ?? e) });
      continue;
    }

    let record: RunRecord;
    try {
      record = JSON.parse(raw) as RunRecord;
    } catch (e: unknown) {
      failed.push({ agentId, error: `parse error: ${(e as Error)?.message ?? e}` });
      continue;
    }

    // Defensive: if it's already not running, skip (idempotent re-run, or
    // forceTerminate beat us to it).
    if (record.status !== "running") {
      continue;
    }

    const updated: RunRecord = {
      ...record,
      status: "killed",
      finishedAt: now,
      errorMessage: `${action.reason} (reconciled by GC)`,
    };

    try {
      await writeFile(recordPath, JSON.stringify(updated, null, 2));
      reconciled.push(agentId);
    } catch (e: unknown) {
      failed.push({ agentId, error: String((e as Error)?.message ?? e) });
    }
  }

  return { reconciled, failed };
}
