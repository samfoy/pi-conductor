/**
 * pi-conductor — Concurrency cap + FIFO queue.
 *
 * When `maxConcurrent` active sub-agents are running:
 *   - background spawns return `queued` and wait their turn
 *   - foreground spawns auto-downgrade to background and also queue
 *
 * The queue drains automatically on every run-state change. Each pending
 * entry holds the caller's spawn options, passed through unchanged.
 */

import {
  leafSpawnOptions,
  forceTerminate,
  failEffortLaunch,
  RunRegistry,
  spawnRun,
  prepareSpawnRuntime,
  prepareSpawnEvidence,
  prepareSpawnEffort,
  prepareSpawnMerger,
  writeRecord,
  type SpawnOptions,
} from "./runs.ts";
import { addEffortMember, listEfforts, readEffort, type EffortRecord } from "./effort/store.ts";
import { admitEffortWriter } from "./effort/admit.ts";
import { awaitingChildren, delegationLoad } from "./delegation.ts";
import type { Run, SpawnMode } from "./types.ts";
import { emptyUsage } from "./types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./runs.ts";
import { allocateRunId } from "./runs.ts";

/** Spawn options a queued entry hands to the spawner on drain. */
export type QueuedSpawnOptions = Omit<SpawnOptions, "registry" | "preAllocatedId">;

export interface PendingSpawn {
  /** Pre-allocated id, so the LLM has a stable id to reference even before spawn. */
  id: string;
  /** Original requested mode. Foreground requests are auto-downgraded to background when queued. */
  requestedMode: SpawnMode;
  /** Mode the run will actually start with after dequeue (always background once queued). */
  effectiveMode: SpawnMode;
  enqueuedAt: number;
  /**
   * The caller's options, captured at enqueue time and passed through
   * verbatim on drain (only `mode` becomes `effectiveMode`). The whole
   * object, not a field list: the list dropped `mergeStrategy` and a
   * queued builder's branch was deleted unmerged (v0.20 B1).
   */
  spawn: QueuedSpawnOptions;
}

export class SpawnQueue {
  private pending: PendingSpawn[] = [];
  private draining = false;

  constructor(
    private registry: RunRegistry,
    private maxConcurrent: number,
    /**
     * v0.9 Item 2(c) cap. Default 1. Independent of `maxConcurrent`.
     * When this cap is hit, write-capable spawns queue (or auto-downgrade
     * foreground) even if there are general slots free.
     */
    private maxConcurrentWriteCapable: number = 1,
    /** Spawner seam; tests inject a spy. */
    private spawn: (opts: SpawnOptions) => { run: Run; done: Promise<Run> } = spawnRun,
  ) {
    this.registry.admissionLimits = { maxConcurrent, maxConcurrentWriteCapable };
    this.registry.onChange(() => this.drain());
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    this.registry.admissionLimits!.maxConcurrent = this.maxConcurrent;
    this.drain();
  }

  setMaxConcurrentWriteCapable(n: number): void {
    this.maxConcurrentWriteCapable = Math.max(1, Math.floor(n));
    this.registry.admissionLimits!.maxConcurrentWriteCapable = this.maxConcurrentWriteCapable;
    this.drain();
  }

  list(): readonly PendingSpawn[] {
    return this.pending;
  }

  size(): number {
    return this.pending.length;
  }

  /**
   * Try to spawn now or enqueue.
   *
   * Returns:
   *   - { run, done }                            if spawned now
   *   - { queued: PendingSpawn, downgraded }     if queued (downgraded=true means foreground→background)
   */
  enqueueOrSpawn(
    opts: QueuedSpawnOptions & { registry?: RunRegistry },
  ): SpawnOrQueueResult {
    opts = prepareSpawnRuntime(leafSpawnOptions(opts));
    opts = prepareSpawnEvidence(opts, opts.registry ?? this.registry);
    prepareSpawnMerger(opts, opts.registry ?? this.registry, opts.mergerFor?.runId);
    const effort = prepareSpawnEffort(opts);
    if (opts.touches) opts = { ...opts, touches: [...opts.touches] };
    const { registry: callerRegistry, ...spawn } = opts;
    const registry = callerRegistry ?? this.registry;
    const waitReason = this.waitReason(spawn, registry, effort);
    const canSpawnNow = waitReason === undefined;

    if (canSpawnNow) {
      const result = this.spawn({ ...spawn, registry });
      return { kind: "spawned", run: result.run, done: result.done };
    }

    // Queue. Auto-downgrade foreground → background.
    const id = opts.mergerFor?.runId ?? allocateRunId(opts.persona.name, mapFromRegistry(registry));
    // Pre-create the run dir + a queued placeholder Run so /conductor status
    // and the panel can show the queued sub-agent immediately.
    if (effort) addEffortMember(effort, id);
    const dir = runDir(id);
    mkdirSync(dir, { recursive: true });
    const placeholder: Run = {
      id,
      runtime: opts.runtime as Run["runtime"],
      persona: opts.persona.name,
      task: opts.task,
      model: opts.model,
      thinking: opts.thinking,
      mode: "background", // queued runs are always background once they start
      status: "queued",
      // A broker leaf's lineage is visible while it waits, so cancel and status find it.
      ...(opts.delegation ? { depth: 2 as const, delegateAllow: [], parentRunId: opts.delegation.parentRunId, delegateToolCallId: opts.delegation.delegateToolCallId } : {}),
      waitReason,
      ...(effort ? { parentPid: effort.owner.pid, parentStartTime: effort.owner.startTime, parentSessionId: effort.owner.sessionId } : {}),
      ...(opts.mergerFor ? { mergerFor: opts.mergerFor, parentPid: process.pid, parentSessionId: opts.parentSessionId } : {}),
      effort: effort ? { owner: effort.owner, name: effort.name, gitRoot: effort.gitRoot, role: "writer", touches: opts.touches ? [...opts.touches] : undefined } : undefined,
      startTime: Date.now(),
      lastEventAt: Date.now(),
      messages: [],
      usage: emptyUsage(),
      cwd: opts.cwd,
      recordPath: join(dir, "record.json"),
      transcriptPath: join(dir, "transcript.jsonl"),
      finalPath: join(dir, "final.md"),
    };
    registry.register(placeholder);
    if (effort) void writeRecord(placeholder);

    const pending: PendingSpawn = {
      id,
      requestedMode: opts.mode,
      effectiveMode: "background",
      enqueuedAt: Date.now(),
      spawn,
    };
    // v0.16-S2: emit emitCreated at queue time (before the run actually starts).
    // emitStarted will fire in spawnRun when drain dequeues this entry.
    opts.events?.emitCreated({
      id,
      persona: opts.persona.name,
      description: opts.task,
      isBackground: true, // queued runs are always promoted as background
    });
    this.pending.push(pending);
    return {
      kind: "queued",
      pending,
      placeholderRun: placeholder,
      downgraded: opts.mode === "foreground",
      queuePosition: this.pending.length,
    };
  }

  removeQueued(id: string): boolean {
    const idx = this.pending.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.pending.splice(idx, 1);
    const placeholder = this.registry.get(id);
    if (placeholder && placeholder.status === "queued") {
      // Force-terminate the placeholder so listeners see the cancellation.
      forceTerminate(placeholder, "killed", this.registry);
    }
    return true;
  }

  /** N3: the awaiting delegator a broker leaf may borrow from; anything else takes the lead-level rules. */
  private lender(opts: QueuedSpawnOptions, registry: RunRegistry): Run | undefined {
    const parent = opts.delegation && registry.get(opts.delegation.parentRunId);
    return parent && awaitingChildren(parent, registry.list()) > 0 ? parent : undefined;
  }

  /** One predicate for immediate enqueue and drain alike. */
  private waitReason(opts: QueuedSpawnOptions, registry: RunRegistry, effort?: EffortRecord, id?: string): string | undefined {
    // Leaves are read-only and no effort members: only executing work (A - W) bounds them.
    const members = registry.list();
    const parent = this.lender(opts, registry);
    if (parent) {
      const { active, lending } = delegationLoad(members, parent);
      return active - lending < this.maxConcurrent ? undefined : `waits for a lent slot (${active - lending} executing or exiting, maxConcurrent ${this.maxConcurrent})`;
    }
    // Earlier waiters reserve scope, not slots; independent work may pass them.
    const preceding = new Set(this.pending.slice(0, id ? this.pending.findIndex(p => p.id === id) : undefined).map(p => p.id));
    const waitingBehind = new Set(members.filter(r => r.status === "queued" && !preceding.has(r.id)).map(r => r.id));
    return admitEffortWriter({ id, persona: opts.persona.name, effort: effort ? { owner: effort.owner, name: effort.name, gitRoot: effort.gitRoot, role: "writer", touches: opts.touches } : undefined }, members, { maxConcurrent: this.maxConcurrent, maxConcurrentWriteCapable: this.maxConcurrentWriteCapable }, effort, effort ? listEfforts(effort.gitRoot) : [], waitingBehind);
  }

  /** Revalidation and synchronous running registration precede any asynchronous launch effects. */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // N3: lent-lane leaves first, so earlier lead-level work cannot take the slot a leaf would get.
      this.drainPass(true);
      this.drainPass(false);
    } finally { this.draining = false; }
  }

  private drainPass(leavesOnly: boolean): void {
    let i = 0;
    while (i < this.pending.length) {
      const next = this.pending[i]!;
      const placeholder = this.registry.get(next.id);
      if (!placeholder || placeholder.status !== "queued") { this.pending.splice(i, 1); continue; }
      if (leavesOnly && !this.lender(next.spawn, this.registry)) { i++; continue; }
      try {
        const effort = placeholder.effort ? readEffort(placeholder.effort.gitRoot, placeholder.effort.name) : undefined;
        if (placeholder.effort && !effort) throw new Error("effort record missing");
        placeholder.waitReason = this.waitReason(next.spawn, this.registry, effort, next.id);
        if (placeholder.waitReason) { i++; continue; }
        this.pending.splice(i, 1);
        this.spawn({ ...next.spawn, mode: next.effectiveMode, registry: this.registry, preAllocatedId: next.id });
      } catch (e) {
        // A leaf left queued outside the queue would keep its parent awaiting after the call is answered.
        if (!placeholder.effort && !next.spawn.delegation && !next.spawn.mergerFor) throw e;
        if (this.pending[i]?.id === next.id) this.pending.splice(i, 1);
        const current = this.registry.get(next.id)!;
        void failEffortLaunch(current, this.registry, `${placeholder.effort ? "effort" : next.spawn.mergerFor ? "merger" : "delegated leaf"} launch refused: ${(e as Error).message}`, next.spawn.onComplete).done;
      }
    }
  }
}

function mapFromRegistry(r: RunRegistry): Map<string, Run> {
  const m = new Map<string, Run>();
  for (const x of r.list()) m.set(x.id, x);
  return m;
}

export type SpawnOrQueueResult =
  | { kind: "spawned"; run: Run; done: Promise<Run> }
  | {
      kind: "queued";
      pending: PendingSpawn;
      placeholderRun: Run;
      downgraded: boolean;
      queuePosition: number;
    };
