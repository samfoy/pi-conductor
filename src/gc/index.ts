/**
 * pi-conductor — GC orchestrator.
 *
 * Stitches the slice-1/2/3 building blocks into a single entry point.
 * Pipeline:
 *
 *   1. walkInventory(runsRoot, registry)             slice 1
 *   2. planReclaim(inventory, config, now)            slice 1
 *   3. (dry-run? bail with summary derived from plan only.)
 *   4. reconcileOrphans(plan.actions, runsRoot, now)  slice 2
 *   5. executeReclaim(plan.actions, runsRoot, ...)    slice 3
 *   6. Aggregate into a `RunGcResult`.
 *
 * Two-gate safety (D8) is enforced by the executor itself; we just
 * project the registry's active-id set into a `ReadonlySet<string>` and
 * pass it through.
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 5"; docs/v0.9-gc-design.md §3.
 */

import { walkInventory } from "./inventory.ts";
import { planReclaim, type ReclaimAction } from "./policy.ts";
import { reconcileOrphans } from "./reconcile.ts";
import { executeReclaim } from "./executor.ts";
import { readLastGcMtime, writeLastGcMtime } from "./last-gc.ts";
import { noteDeletedId } from "./id-reuse.ts";
import type { GcConfig } from "../types.ts";
import type { RunRegistry } from "../runs.ts";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Snapshot of agent ids whose live `Run` has a process handle. Drives
 * design D8's gate-1 active-run check in policy + executor.
 */
function activeIdSet(registry: RunRegistry): Set<string> {
  const out = new Set<string>();
  for (const r of registry.list()) {
    if (r.proc !== undefined) out.add(r.id);
  }
  return out;
}

export interface RunGcOptions {
  runsRoot: string;
  config: GcConfig;
  registry: RunRegistry;
  /** Injected for testability; defaults to `Date.now`. */
  now?: number | (() => number);
  /** When true, plan only — no reconcile, no archive, no delete. */
  dryRun?: boolean;
  /**
   * Optional persona filter. When set, inventory entries are filtered
   * to those whose `record.persona === persona` BEFORE planning runs.
   * Used by the `/conductor gc --persona=<name>` slash command. Slice 5
   * critic-yjsn flagged the missing API.
   */
  persona?: string;
}

export interface RunGcResult {
  /** Total inventory entries surveyed. */
  scanned: number;
  /** Counts of plan actions, regardless of execution. */
  planSummary: {
    archive: number;
    delete: number;
    reconcile: number;
    keep: number;
  };
  /** Reconciled orphan ids (from `reconcileOrphans`). Empty on dry-run. */
  reconciled: string[];
  /** Successfully cold-archived runs. Empty on dry-run. */
  archived: Array<{ agentId: string; bytesReclaimed: number }>;
  /** Successfully deleted runs. Empty on dry-run. */
  deleted: Array<{ agentId: string; bytesReclaimed: number }>;
  /** Per-action failures aggregated from reconcile + executor. */
  failed: Array<{ agentId: string; action: string; error: string }>;
  /** Sum of bytesReclaimed across `archived` + `deleted`. */
  totalBytesReclaimed: number;
  /** Count of runs whose delete will sever resume (`session/` present). */
  runsLoseResume: number;
  /** Wall-clock duration in ms. Always > 0 (even for empty inventories). */
  durationMs: number;
}

function resolveNow(now: RunGcOptions["now"]): number {
  if (typeof now === "function") return now();
  if (typeof now === "number") return now;
  return Date.now();
}

/** Recently-deleted ids surfaced for the R10 id-reuse log. */
// State lives in `./id-reuse.ts` so `runs.ts` can import without a
// cycle through this orchestrator file. We just push deletes here.
export { noteDeletedId, noteAllocatedId, _resetRecentlyDeletedIdsForTest } from "./id-reuse.ts";

/**
 * Run a single GC pass. Idempotent across active runs (the active gate
 * keeps in-flight transcripts intact). Best-effort: per-action errors
 * land in `result.failed[]`; the function does not throw on I/O issues
 * unless the bug is structural (e.g. invalid config).
 */
export async function runGc(opts: RunGcOptions): Promise<RunGcResult> {
  const startedAt = Date.now();
  const now = resolveNow(opts.now);

  const inventory = await walkInventory(opts.runsRoot, opts.registry);
  const filteredInventory = opts.persona
    ? inventory.filter((e) => e.persona === opts.persona)
    : inventory;
  const plan = planReclaim(filteredInventory, opts.config, now);

  const summary = countActions(plan.actions);

  if (opts.dryRun) {
    return {
      scanned: filteredInventory.length,
      planSummary: summary,
      reconciled: [],
      archived: [],
      deleted: [],
      failed: [],
      totalBytesReclaimed: 0,
      runsLoseResume: plan.runsLoseResume,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }

  // Reconcile orphan record.json files BEFORE the executor runs. The
  // executor's gate-2 status check would skip records still flagged
  // running; reconcile flips those to killed first so they can be
  // archive/delete-eligible in subsequent passes.
  const reconcileResult = await reconcileOrphans(plan.actions, opts.runsRoot, now);

  const reclaimResult = await executeReclaim(
    plan.actions,
    opts.runsRoot,
    activeIdSet(opts.registry),
    now,
  );

  // R10: track ids that were just freed so the next allocator can warn.
  for (const d of reclaimResult.deleted) noteDeletedId(d.agentId);

  const totalBytesReclaimed =
    reclaimResult.archived.reduce((s, a) => s + a.bytesReclaimed, 0) +
    reclaimResult.deleted.reduce((s, a) => s + a.bytesReclaimed, 0);

  const failed: RunGcResult["failed"] = [
    ...reconcileResult.failed.map((f) => ({
      agentId: f.agentId,
      action: "reconcile",
      error: f.error,
    })),
    ...reclaimResult.failed.map((f) => ({
      agentId: f.agentId,
      action: f.action,
      error: f.error,
    })),
  ];

  return {
    scanned: filteredInventory.length,
    planSummary: summary,
    reconciled: [...reconcileResult.reconciled],
    archived: [...reclaimResult.archived],
    deleted: [...reclaimResult.deleted],
    failed,
    totalBytesReclaimed,
    runsLoseResume: plan.runsLoseResume,
    durationMs: Math.max(1, Date.now() - startedAt),
  };
}

function countActions(actions: readonly ReclaimAction[]): RunGcResult["planSummary"] {
  let archive = 0;
  let del = 0;
  let reconcile = 0;
  let keep = 0;
  for (const a of actions) {
    if (a.kind === "cold-archive") archive++;
    else if (a.kind === "delete") del++;
    else if (a.kind === "reconcile-orphan") reconcile++;
    else keep++;
  }
  return { archive, delete: del, reconcile, keep };
}

export interface MaybeAutoRunGcOptions extends RunGcOptions {
  /**
   * When true, bypass the auto-debounce check. Only meaningful for
   * `maybeAutoRunGc` — `runGc` itself never debounces. Slash-command
   * users get debounce-bypass for free since manual runs skip the
   * debounce gate by construction.
   */
  force?: boolean;
  /** Logger for the one-line completion summary. Defaults to `console.error`. */
  log?: (line: string) => void;
}

export interface MaybeAutoRunGcResult {
  ran: boolean;
  /** Reason the pass was skipped (debounced / disabled). Set when ran=false. */
  reason?: "disabled" | "debounced" | "auto-disabled" | "subagent-context";
  /** Result when ran=true. */
  result?: RunGcResult;
}

/**
 * Auto-trigger entry point. Honors `config.enabled` + `config.autoOnSessionStart`
 * + the debounce window. Writes the marker on completion.
 *
 * Caller (typically `pi.on("session_start", …)`) must invoke this in
 * fire-and-forget shape so session bootstrap doesn't block on disk I/O.
 */
export async function maybeAutoRunGc(
  opts: MaybeAutoRunGcOptions,
): Promise<MaybeAutoRunGcResult> {
  // v0.10 A1: skip when this process is a conductor sub-agent. Otherwise
  // every sub-agent's pi subprocess loads the conductor extension on its
  // own session_start and runs auto-GC, wasting work and (worse) leaking
  // its `gc auto: …` log line into the parent's captured stderr — which
  // ends up assigned to `run.errorMessage` on the sub-agent's record
  // (witnessed in dogfood: critic-yjsn carried a GC summary as its error
  // string). The marker env var is set on every sub-agent spawn in
  // `src/runs.ts` (see `buildSubagentEnv`).
  if (process.env.CONDUCTOR_SUBAGENT === "1") {
    return { ran: false, reason: "subagent-context" };
  }
  if (!opts.config.enabled) return { ran: false, reason: "disabled" };
  if (!opts.config.autoOnSessionStart) return { ran: false, reason: "auto-disabled" };

  const now = resolveNow(opts.now);
  const last = readLastGcMtime(opts.runsRoot);
  const debounceMs = Math.max(0, opts.config.autoDebounceHours * HOUR_MS);
  if (!opts.force && last !== null && now - last < debounceMs) {
    return { ran: false, reason: "debounced" };
  }

  const result = await runGc({ ...opts, now });
  writeLastGcMtime(opts.runsRoot, now);

  const log = opts.log ?? ((line: string) => console.error(line));
  const sumPlan = result.planSummary;
  const failedCount = result.failed.length;
  const mb = (result.totalBytesReclaimed / (1024 * 1024)).toFixed(1);
  log(
    `gc auto: scanned=${result.scanned} archive=${sumPlan.archive} ` +
      `delete=${sumPlan.delete} reconcile=${sumPlan.reconcile} ` +
      `reclaimedMB=${mb} failed=${failedCount} dur=${result.durationMs}ms`,
  );

  return { ran: true, result };
}
