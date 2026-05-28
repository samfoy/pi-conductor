/**
 * Item 11 dead-man-switch (defensive).
 *
 * Belt-and-braces for the witnessed completion-wake bug. The primary
 * fix lives in `src/notifications.ts` `buildCompletionSendMessageOptions`
 * (background spawns now ship `triggerTurn: true` only). The dead-man-
 * switch covers the residual case: pi's host or extension stack drops
 * a wake on the floor for any reason (state-dependent swallow, dashboard
 * downgrades the user-message to info, a future regression in
 * `sendCustomMessage`'s streaming branch). If a tracked completion
 * goes unanswered for `STALE_THRESHOLD_MS`, we re-fire it with extra
 * emphasis. After `MAX_REFIRES_PER_RUN` re-fires, we give up and
 * surface a warning so the user knows to check manually.
 *
 * Pure invariants:
 *   - `track(runId, now)`           records a sent wake.
 *   - `clearOnTurnStart()`          drops every pending entry (a turn
 *                                   fired; the wake clearly worked).
 *   - `tick(now)`                   returns the list of `runId`s whose
 *                                   wake is `> STALE_THRESHOLD_MS` old
 *                                   AND not yet at the re-fire cap.
 *                                   Updates per-run sentAt + refireCount.
 *                                   At the cap, returns the runId in
 *                                   `expired` instead.
 *
 * Pattern parallel to v0.10 watchdog soft-advisory injection
 * (`src/index.ts` watchdog branch). Tick interval, threshold, and
 * cap are configurable but default to documented values.
 */

/** Default delay before re-firing a wake. 30s — long enough to avoid
 *  preempting a normal in-flight turn-start latency, short enough that
 *  the user-visible idle is bounded. */
export const DEFAULT_STALE_THRESHOLD_MS = 30_000;

/** Default re-fire cap per run. Two re-fires = three total wake attempts.
 *  After that, we surface an "I gave up" warning so a human notices
 *  and reaches into the registry directly. */
export const DEFAULT_MAX_REFIRES_PER_RUN = 2;

/** Default tick interval — half the threshold so a stale wake fires
 *  inside one cycle of the threshold window. */
export const DEFAULT_TICK_INTERVAL_MS = 15_000;

interface PendingEntry {
  /** ms since epoch — last time we sent (or re-sent) the wake. */
  sentAt: number;
  /** Number of re-fires already issued. 0 means only the original. */
  refireCount: number;
}

/** What `tick` returns to the caller. */
export interface TickResult {
  /** Run IDs whose wake should be re-fired this tick. */
  refire: readonly string[];
  /** Run IDs whose wake hit the cap; caller surfaces a warning. */
  expired: readonly string[];
}

/** Constructor options. All fields have defaults; tests pass overrides. */
export interface CompletionWakeTrackerOptions {
  staleThresholdMs?: number;
  maxRefiresPerRun?: number;
}

/**
 * In-memory tracker for completion-wake bookkeeping. Pure: no I/O,
 * no timers; the host wires `tick()` into a `setInterval` and
 * `clearOnTurnStart()` into the `turn_start` event.
 *
 * Item 11 (2026-05-28). See `docs/items-11-12-inspector-map.md` §6 rec 3.
 */
export class CompletionWakeTracker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly staleThresholdMs: number;
  private readonly maxRefiresPerRun: number;

  constructor(options: CompletionWakeTrackerOptions = {}) {
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.maxRefiresPerRun = options.maxRefiresPerRun ?? DEFAULT_MAX_REFIRES_PER_RUN;
  }

  /** Record that a wake notification has been sent for `runId` at `now`. */
  track(runId: string, now: number): void {
    this.pending.set(runId, { sentAt: now, refireCount: 0 });
  }

  /** A turn fired — clear every pending entry. The notification chain is
   *  proven to be working for the host. */
  clearOnTurnStart(): void {
    this.pending.clear();
  }

  /** True iff there is at least one pending wake. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Test-only: read pending state without mutating. */
  inspectPending(): ReadonlyMap<string, Readonly<PendingEntry>> {
    return this.pending;
  }

  /**
   * Drive one tick. Identifies entries that are stale (> threshold old)
   * and either schedules them for re-fire (if under the cap) or marks
   * them expired (if at the cap). The caller is responsible for actually
   * sending the re-fire `pi.sendMessage` call AND for surfacing the
   * expired warning to the user.
   *
   * Side effect: pending entries returned in `refire` get their
   * `sentAt` reset to `now` and `refireCount` incremented. Entries
   * returned in `expired` are removed from the map (the wake is
   * abandoned).
   */
  tick(now: number): TickResult {
    const refire: string[] = [];
    const expired: string[] = [];
    for (const [runId, entry] of this.pending) {
      const age = now - entry.sentAt;
      if (age <= this.staleThresholdMs) continue;
      if (entry.refireCount >= this.maxRefiresPerRun) {
        expired.push(runId);
        this.pending.delete(runId);
        continue;
      }
      entry.sentAt = now;
      entry.refireCount += 1;
      refire.push(runId);
    }
    return { refire, expired };
  }

  /** Drop a specific run (used when the host learns the run was killed
   *  or the registry no longer knows about it). */
  drop(runId: string): void {
    this.pending.delete(runId);
  }
}
