/**
 * pi-conductor — Concurrency cap + FIFO queue.
 *
 * When `maxConcurrent` active sub-agents are running:
 *   - background spawns return `queued` and wait their turn
 *   - foreground spawns auto-downgrade to background and also queue
 *
 * The queue drains automatically on every run-state change. Each pending
 * entry holds enough metadata to spawn when a slot opens.
 */

import {
  forceTerminate,
  RunRegistry,
  spawnRun,
  type SpawnOptions,
} from "./runs.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Persona, Run, SpawnMode, ThinkingLevel } from "./types.ts";
import { emptyUsage } from "./types.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./runs.ts";
import { allocateRunId } from "./runs.ts";
import { WRITE_CAPABLE_PERSONAS } from "./personas.ts";

export interface PendingSpawn {
  /** Pre-allocated id, so the LLM has a stable id to reference even before spawn. */
  id: string;
  persona: Persona;
  task: string;
  /** Original requested mode. Foreground requests are auto-downgraded to background when queued. */
  requestedMode: SpawnMode;
  /** Mode the run will actually start with after dequeue (always background once queued). */
  effectiveMode: SpawnMode;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMs: number;
  enqueuedAt: number;
  /**
   * Snapshot of the parent conductor's messages at enqueue time. Plumbed
   * through to the eventual spawnRun so a queued sub-agent inherits the
   * conductor's intent at the moment it was queued, not at drain time.
   */
  parentMessages?: AgentMessage[];
  /** Non-foreground onComplete plumbed through from the spawner. */
  onComplete?: (run: Run) => void;
  /** v0.10 watchdog (Slice 3) per-spawn override; threaded to spawnRun. */
  killOnStall?: boolean;
  /** v0.10 watchdog (Slice 3) per-spawn soft-threshold (seconds). */
  softStallSeconds?: number;
  /**
   * v0.12 slice 4 — cascade-collapsed steerable boolean threaded
   * through to spawnRun on dequeue. See `SpawnOptions.steerable`.
   */
  steerable?: boolean;
}

export class SpawnQueue {
  private pending: PendingSpawn[] = [];

  constructor(
    private registry: RunRegistry,
    private maxConcurrent: number,
    /**
     * v0.9 Item 2(c) cap. Default 1. Independent of `maxConcurrent`.
     * When this cap is hit, write-capable spawns queue (or auto-downgrade
     * foreground) even if there are general slots free.
     */
    private maxConcurrentWriteCapable: number = 1,
  ) {
    this.registry.onChange(() => this.drain());
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    this.drain();
  }

  setMaxConcurrentWriteCapable(n: number): void {
    this.maxConcurrentWriteCapable = Math.max(1, Math.floor(n));
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
    opts: Omit<SpawnOptions, "registry" | "preAllocatedId"> & { registry?: RunRegistry },
  ): SpawnOrQueueResult {
    const registry = opts.registry ?? this.registry;
    const slotsFree = this.maxConcurrent - registry.countActive();
    const writeCapable = WRITE_CAPABLE_PERSONAS.has(opts.persona.name);
    const writeSlotsFree =
      this.maxConcurrentWriteCapable - registry.countActiveBy(WRITE_CAPABLE_PERSONAS);
    const canSpawnNow = slotsFree > 0 && (!writeCapable || writeSlotsFree > 0);

    if (canSpawnNow) {
      const result = spawnRun({ ...opts, registry });
      return { kind: "spawned", run: result.run, done: result.done };
    }

    // Queue. Auto-downgrade foreground → background.
    const id = allocateRunId(opts.persona.name, mapFromRegistry(registry));
    // Pre-create the run dir + a queued placeholder Run so /conductor status
    // and the panel can show the queued sub-agent immediately.
    const dir = runDir(id);
    mkdirSync(dir, { recursive: true });
    const placeholder: Run = {
      id,
      persona: opts.persona.name,
      task: opts.task,
      model: opts.model,
      thinking: opts.thinking,
      mode: "background", // queued runs are always background once they start
      status: "queued",
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

    const pending: PendingSpawn = {
      id,
      persona: opts.persona,
      task: opts.task,
      requestedMode: opts.mode,
      effectiveMode: "background",
      cwd: opts.cwd,
      model: opts.model,
      thinking: opts.thinking,
      timeoutMs: opts.timeoutMs,
      enqueuedAt: Date.now(),
      parentMessages: opts.parentMessages,
      onComplete: opts.onComplete,
      killOnStall: opts.killOnStall,
      softStallSeconds: opts.softStallSeconds,
      steerable: opts.steerable,
    };
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

  /** Try to start as many queued spawns as possible. Idempotent. */
  drain(): void {
    // Walk pending in FIFO order; only spawn those whose caps allow it.
    // A blocked write-capable entry does NOT block a later read-only entry,
    // because the two caps are independent.
    let i = 0;
    while (i < this.pending.length) {
      const next = this.pending[i]!;
      const slotsFree = this.maxConcurrent - this.registry.countActive();
      if (slotsFree <= 0) return;
      const writeCapable = WRITE_CAPABLE_PERSONAS.has(next.persona.name);
      const writeSlotsFree =
        this.maxConcurrentWriteCapable -
        this.registry.countActiveBy(WRITE_CAPABLE_PERSONAS);
      if (writeCapable && writeSlotsFree <= 0) {
        // This write-capable spawn must wait; try the next pending entry.
        i++;
        continue;
      }

      // Promote: remove from pending and spawn.
      this.pending.splice(i, 1);
      const placeholder = this.registry.get(next.id);
      if (!placeholder || placeholder.status !== "queued") {
        // It was cancelled while waiting; skip without advancing i (we already spliced).
        continue;
      }

      spawnRun({
        registry: this.registry,
        persona: next.persona,
        task: next.task,
        mode: next.effectiveMode,
        cwd: next.cwd,
        model: next.model,
        thinking: next.thinking,
        timeoutMs: next.timeoutMs,
        preAllocatedId: next.id,
        parentMessages: next.parentMessages,
        onComplete: next.onComplete,
        killOnStall: next.killOnStall,
        softStallSeconds: next.softStallSeconds,
        steerable: next.steerable,
      });
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
