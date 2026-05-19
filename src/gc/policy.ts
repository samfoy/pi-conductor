/**
 * pi-conductor — GC policy engine.
 *
 * Pure synchronous function: `(InventoryEntry[], GcConfig, nowMs) => ReclaimPlan`.
 *
 * Acceptance pin (slice 1): zero imports from `node:fs`, `node:fs/promises`,
 * `runs.ts`, or any clock source. The active-run gate keys on
 * `entry.inMemory` (which the inventory walker populated from the live
 * `RunRegistry`). The `now` parameter is the only time signal.
 *
 * Spec: docs/v0.9-gc-design.md §2 (D1\u2013D8); docs/v0.9-gc-plan.md "Slice 1".
 */

import { isTerminal, type GcConfig } from "../types.ts";
import type { InventoryEntry } from "./inventory.ts";

/** One action per inventory entry. */
export type ReclaimAction =
  | { kind: "keep"; id: string; reason: string }
  | { kind: "cold-archive"; id: string; reason: string; bytesReclaimed: number }
  | { kind: "delete"; id: string; reason: string; bytesReclaimed: number; losesResume: boolean }
  | { kind: "reconcile-orphan"; id: string; reason: string };

export interface ReclaimPlan {
  actions: ReclaimAction[];
  /** Sum of `totalSizeBytes` across all entries before any action runs. */
  totalBytesBefore: number;
  /** Sum of `bytesReclaimed` across `cold-archive` + `delete` actions. */
  totalBytesReclaimed: number;
  /** Bytes locked behind pinned entries (kept regardless of budget). */
  pinnedBytes: number;
  /** Number of `delete` actions whose run had a live pi `session/` dir at inventory time. */
  runsLoseResume: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ttlDaysFor(entry: InventoryEntry, config: GcConfig): number {
  const personaOverride = config.perPersonaTtlDays[entry.persona];
  if (typeof personaOverride === "number" && personaOverride > 0) {
    return personaOverride;
  }
  return entry.status === "completed" ? config.completedTtlDays : config.failedTtlDays;
}

function transcriptCapFor(_entry: InventoryEntry, config: GcConfig): number {
  return config.transcriptSizeCapBytes;
}

/**
 * Decide one action per entry, then post-pass enforce the total-size budget.
 *
 * Rule order (first-match wins):
 *   1. `inMemory` is set AND (proc !== undefined OR status non-terminal) \u2192 keep ("active in registry").
 *   2. status === "running" AND no `inMemory` AND stale (mtime older than orphan TTL) \u2192 reconcile-orphan.
 *   3. status === "running" AND no `inMemory` AND not yet stale \u2192 keep ("running but fresh; awaiting orphan TTL").
 *   4. malformed AND not pinned \u2192 keep ("malformed; surface only, do not reclaim").
 *   5. pinned AND terminal \u2192 keep ("pinned").
 *   6. archived AND age > full TTL AND unpinned \u2192 delete ("archived past TTL").
 *   7. archived \u2192 keep ("archived; within TTL").
 *   8. terminal AND transcriptSizeBytes > per-cap \u2192 cold-archive ("transcript-cap exceeded").
 *   9. default for terminal \u2192 keep ("within thresholds").
 *
 * Post-pass: if total bytes-after-actions > totalSizeBudgetBytes, cold-archive
 * largest-remaining-non-pinned-non-archived terminal entries (descending size,
 * tie-break oldest finishedAt) until under budget.
 */
export function planReclaim(
  inventory: readonly InventoryEntry[],
  config: GcConfig,
  now: number,
): ReclaimPlan {
  // Special-case: if `enabled === false`, every entry is kept.
  if (!config.enabled) {
    const totalBytes = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
    return {
      actions: inventory.map<ReclaimAction>((e) => ({
        kind: "keep",
        id: e.id,
        reason: "gc disabled",
      })),
      totalBytesBefore: totalBytes,
      totalBytesReclaimed: 0,
      pinnedBytes: inventory.filter((e) => e.pinned).reduce((s, e) => s + e.totalSizeBytes, 0),
      runsLoseResume: 0,
    };
  }

  const orphanThresholdMs = now - config.orphanReconcileAfterHours * HOUR_MS;

  const actions: ReclaimAction[] = [];
  // Track which entries are still live for the size-budget post-pass.
  // null = entry already-decided; not eligible for budget eviction.
  const eligibleForBudget: InventoryEntry[] = [];

  for (const entry of inventory) {
    const action = decideForEntry(entry, config, now, orphanThresholdMs);
    actions.push(action);

    if (action.kind === "keep" && action.reason === "within thresholds") {
      eligibleForBudget.push(entry);
    }
  }

  // Post-pass: total size budget.
  const totalBytesBefore = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
  let projectedBytes = totalBytesBefore;
  for (const a of actions) {
    if (a.kind === "cold-archive" || a.kind === "delete") projectedBytes -= a.bytesReclaimed;
  }

  if (projectedBytes > config.totalSizeBudgetBytes && eligibleForBudget.length > 0) {
    const ranked = [...eligibleForBudget].sort((a, b) => {
      if (b.transcriptSizeBytes !== a.transcriptSizeBytes) {
        return b.transcriptSizeBytes - a.transcriptSizeBytes;
      }
      return (a.finishedAt ?? a.startTime) - (b.finishedAt ?? b.startTime);
    });
    for (const entry of ranked) {
      if (projectedBytes <= config.totalSizeBudgetBytes) break;
      // Replace the prior `keep` with a `cold-archive`.
      const idx = actions.findIndex((a) => a.id === entry.id);
      if (idx === -1) continue;
      const reclaim = entry.transcriptSizeBytes;
      actions[idx] = {
        kind: "cold-archive",
        id: entry.id,
        reason: "size-budget eviction (largest-first)",
        bytesReclaimed: reclaim,
      };
      projectedBytes -= reclaim;
    }
  }

  let totalBytesReclaimed = 0;
  let runsLoseResume = 0;
  let pinnedBytes = 0;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    const e = inventory[i]!;
    if (a.kind === "cold-archive" || a.kind === "delete") {
      totalBytesReclaimed += a.bytesReclaimed;
    }
    if (a.kind === "delete" && e.sessionPathPresent) runsLoseResume++;
    if (e.pinned) pinnedBytes += e.totalSizeBytes;
  }

  return {
    actions,
    totalBytesBefore,
    totalBytesReclaimed,
    pinnedBytes,
    runsLoseResume,
  };
}

function decideForEntry(
  entry: InventoryEntry,
  config: GcConfig,
  now: number,
  orphanThresholdMs: number,
): ReclaimAction {
  // Rule 1: active-in-memory gate (load-bearing per slice 1 acceptance).
  if (entry.inMemory) {
    const mem = entry.inMemory;
    const proc = (mem as unknown as { proc?: unknown }).proc;
    if (proc !== undefined || !isTerminal(mem.status)) {
      return { kind: "keep", id: entry.id, reason: "active in registry" };
    }
  }

  // Rules 2/3: orphan vs fresh-running.
  if (entry.status === "running" && !entry.inMemory) {
    const ageBasis = entry.transcriptMtime ?? entry.startTime;
    if (ageBasis < orphanThresholdMs) {
      return {
        kind: "reconcile-orphan",
        id: entry.id,
        reason: `orphaned: status=running, no live process, stale > ${config.orphanReconcileAfterHours}h`,
      };
    }
    return {
      kind: "keep",
      id: entry.id,
      reason: "running but fresh; awaiting orphan TTL",
    };
  }

  // Rule 4: malformed records — surface, don't reclaim.
  if (entry.malformed) {
    return {
      kind: "keep",
      id: entry.id,
      reason: "malformed record; surfaced for manual review",
    };
  }

  // Rule 5: pinned + terminal.
  if (entry.pinned && isTerminal(entry.status)) {
    return { kind: "keep", id: entry.id, reason: "pinned" };
  }

  // Rules 6/7: already-archived.
  if (entry.archived) {
    if (entry.pinned) {
      return { kind: "keep", id: entry.id, reason: "pinned (archived)" };
    }
    const archivedAt = entry.archivedAt ?? entry.startTime;
    const ageMs = now - archivedAt;
    const ttlDays = ttlDaysFor(entry, config);
    if (ageMs > ttlDays * DAY_MS) {
      return {
        kind: "delete",
        id: entry.id,
        reason: `archived for > ${ttlDays}d`,
        bytesReclaimed: entry.totalSizeBytes,
        losesResume: entry.sessionPathPresent,
      };
    }
    return { kind: "keep", id: entry.id, reason: "archived; within TTL" };
  }

  // Rule 8: per-transcript size cap.
  if (isTerminal(entry.status) && entry.transcriptSizeBytes > transcriptCapFor(entry, config)) {
    return {
      kind: "cold-archive",
      id: entry.id,
      reason: `transcript-cap exceeded (${entry.transcriptSizeBytes} > ${transcriptCapFor(entry, config)})`,
      bytesReclaimed: entry.transcriptSizeBytes,
    };
  }

  // Default: keep terminal runs that are within thresholds; budget post-pass may still evict.
  return { kind: "keep", id: entry.id, reason: "within thresholds" };
}
