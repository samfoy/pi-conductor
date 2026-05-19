/**
 * pi-conductor — GC reclaim executor.
 *
 * Effectful counterpart to the policy engine's `cold-archive` and
 * `delete` actions. For each action:
 *
 *   - `cold-archive` — unlink `transcript.jsonl`, preserve everything
 *     else (record.json, final.md, session/, .pinned). Touch `.archived`
 *     sidecar with mtime = now. Per design D3, D7.
 *
 *   - `delete` — recursively remove the entire run directory.
 *
 *   - `keep` / `reconcile-orphan` — pass-through (other slices own them).
 *
 * Two-gate safety per design D8 + oracle review §R1:
 *
 *   1. Active-run gate: `registryActive: ReadonlySet<string>` lists
 *      agentIds with live `Run.proc !== undefined` per the live registry.
 *      Executor re-checks at action time (defensive — race window between
 *      plan and execute is short but not zero, since GC runs async).
 *
 *   2. Status gate: re-stat `record.json` and skip if `status` is
 *      non-terminal. The plan engine already filters but a SIGCONT or
 *      `ensemble_send` between plan and execute could re-flip a record
 *      to `running` before we touch its files.
 *
 * Both checks classify the action as `failed[]` rather than `archived[]`/
 * `deleted[]`. `failed[]` does NOT throw — best-effort, isolation per
 * action, matching `reconcile.ts:reconcileOrphans` semantics.
 *
 * Idempotency: re-archiving an already-archived run touches the sidecar
 * mtime and reports `bytesReclaimed: 0`. Deleting a missing dir reports
 * 0 bytes and is not an error.
 *
 * Spec: docs/v0.9-gc-design.md §2 D3 + D7 + D8; §5 R1, R8 (A2 resume UX);
 * docs/v0.9-gc-plan.md "Slice 3"; docs/v0.9-gc-oracle-review.md A2.
 */

import { readFile, rm, stat, unlink, utimes, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { isTerminal, type RunRecord } from "../types.ts";
import type { ReclaimAction } from "./policy.ts";

export interface ReclaimResult {
  /** Successfully cold-archived runs. `bytesReclaimed` is the size of the unlinked transcript. */
  archived: Array<{ agentId: string; bytesReclaimed: number }>;
  /** Successfully deleted runs. `bytesReclaimed` is the sum of all files in runDir before removal. */
  deleted: Array<{ agentId: string; bytesReclaimed: number }>;
  /** Per-action failures (active-run gate, non-terminal status, I/O error). */
  failed: Array<{ agentId: string; action: "cold-archive" | "delete"; error: string }>;
}

/**
 * Apply `cold-archive` and `delete` actions from a `ReclaimPlan` to disk.
 *
 * @param actions Full plan action list. `keep` and `reconcile-orphan`
 *   entries are ignored.
 * @param runsRoot Root directory containing `<agentId>/` run dirs.
 * @param registryActive Snapshot of live agent ids with running processes
 *   at execute-time. Defensive re-check of design D8's active-run gate.
 * @param now Epoch ms used for the `.archived` sidecar mtime.
 */
export async function executeReclaim(
  actions: readonly ReclaimAction[],
  runsRoot: string,
  registryActive: ReadonlySet<string>,
  now: number,
): Promise<ReclaimResult> {
  const archived: ReclaimResult["archived"] = [];
  const deleted: ReclaimResult["deleted"] = [];
  const failed: ReclaimResult["failed"] = [];

  for (const action of actions) {
    if (action.kind !== "cold-archive" && action.kind !== "delete") continue;

    const agentId = action.id;
    const runDir = join(runsRoot, agentId);
    const actionKind = action.kind;

    // Gate 1 — active in registry?
    if (registryActive.has(agentId)) {
      failed.push({
        agentId,
        action: actionKind,
        error: "active during reclaim (registry has live proc)",
      });
      continue;
    }

    // Gate 2 — re-stat record.json. Status must be terminal.
    // We tolerate ENOENT (race with another GC pass or manual rm); for
    // delete we proceed (target is gone anyway), for cold-archive we
    // also proceed (sidecar write is harmless).
    const recordPath = join(runDir, "record.json");
    let record: RunRecord | undefined;
    try {
      const raw = await readFile(recordPath, "utf-8");
      record = JSON.parse(raw) as RunRecord;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        // Record gone — delete is a no-op success; cold-archive is
        // weird-but-safe (caller passed an action for a vanished run).
        if (actionKind === "delete") {
          deleted.push({ agentId, bytesReclaimed: 0 });
          continue;
        }
        // cold-archive on missing record: classify as failed (the
        // .archived sidecar would have nowhere coherent to land).
        failed.push({
          agentId,
          action: actionKind,
          error: "runDir missing during cold-archive",
        });
        continue;
      }
      failed.push({
        agentId,
        action: actionKind,
        error: `record read/parse error: ${(e as Error)?.message ?? e}`,
      });
      continue;
    }

    if (!isTerminal(record.status)) {
      failed.push({
        agentId,
        action: actionKind,
        error: `non-terminal status ${record.status} (changed since plan)`,
      });
      continue;
    }

    if (actionKind === "cold-archive") {
      try {
        const bytes = await coldArchive(runDir, now);
        archived.push({ agentId, bytesReclaimed: bytes });
      } catch (e: unknown) {
        failed.push({
          agentId,
          action: actionKind,
          error: `cold-archive failed: ${(e as Error)?.message ?? e}`,
        });
      }
    } else {
      try {
        const bytes = await fullDelete(runDir);
        deleted.push({ agentId, bytesReclaimed: bytes });
      } catch (e: unknown) {
        failed.push({
          agentId,
          action: actionKind,
          error: `delete failed: ${(e as Error)?.message ?? e}`,
        });
      }
    }
  }

  return { archived, deleted, failed };
}

/**
 * Cold-archive: unlink `transcript.jsonl`, touch `.archived` sidecar.
 * Preserves `record.json`, `final.md`, `session/`, `.pinned`.
 * Returns bytes reclaimed (0 if transcript was already absent).
 */
async function coldArchive(runDir: string, now: number): Promise<number> {
  const transcriptPath = join(runDir, "transcript.jsonl");
  let bytes = 0;
  try {
    const s = await stat(transcriptPath);
    bytes = s.size;
  } catch {
    // missing transcript — already-archived or never-written. Continue.
  }

  if (bytes > 0) {
    try {
      await unlink(transcriptPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") throw e;
      // ENOENT race — fine.
      bytes = 0;
    }
  }

  // Sidecar: write empty file then utimes to `now`. `writeFile` truncates
  // any existing sidecar to size 0, which is what we want (advisory marker).
  const sidecarPath = join(runDir, ".archived");
  await writeFile(sidecarPath, "");
  // utimes wants seconds, not ms.
  const nowSec = now / 1000;
  await utimes(sidecarPath, nowSec, nowSec);

  return bytes;
}

/**
 * Walk runDir summing all file sizes BEFORE the recursive remove.
 * Returns bytes reclaimed; 0 if the dir is missing.
 */
async function fullDelete(runDir: string): Promise<number> {
  let bytes = 0;
  try {
    bytes = await walkSize(runDir);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return 0;
    throw e;
  }

  await rm(runDir, { recursive: true, force: true });
  return bytes;
}

async function walkSize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await walkSize(child);
    } else if (entry.isFile()) {
      try {
        const s = await stat(child);
        total += s.size;
      } catch {
        // skip — best-effort
      }
    }
  }
  return total;
}
