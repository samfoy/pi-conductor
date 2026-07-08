/**
 * v0.16 Event bus adapter.
 *
 * Owns all conductor lifecycle channel names and payload shapes.
 * Accepts `pi.events` as a constructor argument (injected from `src/index.ts`).
 * Each `emit*` method is a no-op when `events` is absent, so the conductor
 * works identically on older pi versions that don't expose `pi.events`.
 *
 * Usage by companion extensions:
 *   pi.events.on("conductor:agent:completed", (data) => { ... });
 *
 * Channel names follow the `conductor:agent:*` namespace.
 */

import type { RunStatus } from "./types.ts";

// ── Payload interfaces ──────────────────────────────────────────────────────

export interface AgentCreatedPayload {
  id: string;
  persona: string;
  description: string;
  isBackground: boolean;
}

export interface AgentStartedPayload {
  id: string;
  persona: string;
  description: string;
}

export interface AgentCompletedPayload {
  id: string;
  persona: string;
  durationMs: number;
  /** mirrors run.usage.turns — named toolUses for gotgenes API familiarity */
  toolUses: number;
  tokens: { input: number; output: number; cost: number };
}

export interface AgentFailedPayload {
  id: string;
  persona: string;
  durationMs: number;
  /** mirrors run.usage.turns */
  toolUses: number;
  tokens: { input: number; output: number; cost: number };
  /**
   * Failure-class terminal status. Current values: "failed" | "killed" |
   * "hook_failed" | "merge_conflict" | "timeout".
   * Forward-compat note: v0.17 adds "aborted" (graceful turn-limit
   * exhaustion) — typed as RunStatus so subscribers handle unknown values.
   */
  status: RunStatus;
  errorMessage: string | undefined;
  /**
   * v0.18 failure classification bucket (syntax | logic | test |
   * environment | permission | timeout | stall | turns | unknown).
   * Undefined for runs finalized before v0.18. Typed loosely as string
   * to avoid a hard import cycle with failure-classify.
   */
  failureClass?: string;
}

export interface AgentSteeredPayload {
  id: string;
  message: string;
}

export interface AgentCompactedPayload {
  id: string;
  persona: string;
  description: string;
  /** monotone counter per run */
  compactionCount: number;
  /** run.usage.input + output snapped at compaction time */
  tokensBefore: number;
}

// ── Hook lifecycle payload interfaces (v0.17-S5) ──────────────────────────

export interface HookStartedPayload {
  id: string;
  persona: string;
  command: string;
}

export interface HookCompletedPayload {
  id: string;
  persona: string;
  command: string;
  exitCode: number;
  durationMs: number;
}

export interface HookFailedPayload {
  id: string;
  persona: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  failureKind: string;
}

// ── Channel name constants ──────────────────────────────────────────────────

export const CHANNEL = {
  created: "conductor:agent:created",
  started: "conductor:agent:started",
  completed: "conductor:agent:completed",
  failed: "conductor:agent:failed",
  steered: "conductor:agent:steered",
  compacted: "conductor:agent:compacted",
  hookStarted: "conductor:agent:hook:started",
  hookCompleted: "conductor:agent:hook:completed",
  hookFailed: "conductor:agent:hook:failed",
} as const;

// ── EventBus interface (matches pi.events shape) ────────────────────────────

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Thin typed adapter over `pi.events`. All methods are no-ops when `events`
 * is absent — conductor works identically; companion extensions simply
 * receive nothing.
 */
export class ConductorEventEmitter {
  private readonly events: EventBus | undefined;

  constructor(events: EventBus | undefined) {
    this.events = events;
  }

  emitCreated(payload: AgentCreatedPayload): void {
    this.events?.emit(CHANNEL.created, payload);
  }

  emitStarted(payload: AgentStartedPayload): void {
    this.events?.emit(CHANNEL.started, payload);
  }

  emitCompleted(payload: AgentCompletedPayload): void {
    this.events?.emit(CHANNEL.completed, payload);
  }

  emitFailed(payload: AgentFailedPayload): void {
    this.events?.emit(CHANNEL.failed, payload);
  }

  emitSteered(payload: AgentSteeredPayload): void {
    this.events?.emit(CHANNEL.steered, payload);
  }

  emitCompacted(payload: AgentCompactedPayload): void {
    this.events?.emit(CHANNEL.compacted, payload);
  }

  emitHookStarted(payload: HookStartedPayload): void {
    this.events?.emit(CHANNEL.hookStarted, payload);
  }

  emitHookCompleted(payload: HookCompletedPayload): void {
    this.events?.emit(CHANNEL.hookCompleted, payload);
  }

  emitHookFailed(payload: HookFailedPayload): void {
    this.events?.emit(CHANNEL.hookFailed, payload);
  }
}
