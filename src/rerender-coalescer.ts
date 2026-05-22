/**
 * RerenderCoalescer — pure timer helper for collapsing a burst of
 * registry-change events into at most two `tui.requestRender()`
 * calls per quiet window:
 *
 *   1. Leading edge: the first `schedule()` outside the cooldown
 *      window fires the callback synchronously. Snappy first paint.
 *   2. Trailing edge: any `schedule()` calls that land inside the
 *      cooldown window arm a single trailing fire timed for the
 *      window boundary. The trailing fire observes the most-recent
 *      state, so under stickToTail the user sees the final frame of
 *      the burst (design §15).
 *
 * Slice 3 of the focused-stream overlay redesign — see
 * docs/focused-overlay-redesign-design.md §10 (re-render contract)
 * and docs/focused-overlay-redesign-plan.md §Slice 3.
 *
 * Pure module: no globals, no listeners. The clock and timer
 * primitives are injectable so tests can drive deterministic
 * leading/trailing semantics without real timers.
 */

export interface CoalescerDeps {
  /** Monotonic-ish "now" in ms. Production: `Date.now`. */
  readonly now: () => number;
  /**
   * Schedules `cb` to fire after `ms` milliseconds. Returns an
   * opaque handle accepted by `clearTimeout`. Production: a thin
   * wrapper over `globalThis.setTimeout`.
   */
  readonly setTimeout: (cb: () => void, ms: number) => unknown;
  /** Cancels a previously-scheduled timer. */
  readonly clearTimeout: (handle: unknown) => void;
}

const DEFAULT_DEPS: CoalescerDeps = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Default coalescer window in milliseconds. */
export const DEFAULT_RERENDER_WINDOW_MS = 50;

export class RerenderCoalescer {
  private readonly cb: () => void;
  private readonly windowMs: number;
  private readonly deps: CoalescerDeps;
  private lastFiredAt: number | null = null;
  private trailingHandle: unknown = null;

  constructor(
    cb: () => void,
    windowMs: number = DEFAULT_RERENDER_WINDOW_MS,
    deps: CoalescerDeps = DEFAULT_DEPS,
  ) {
    this.cb = cb;
    this.windowMs = windowMs;
    this.deps = deps;
  }

  /**
   * Record an event. Fires the callback immediately if outside the
   * cooldown window (leading edge), otherwise arms a single trailing
   * fire for when the window quiesces. Repeated calls inside the
   * window collapse into the same trailing fire — at most 2 fires
   * per burst.
   */
  schedule(): void {
    const now = this.deps.now();
    if (this.lastFiredAt === null || now - this.lastFiredAt >= this.windowMs) {
      // Leading-edge: fire synchronously and reset the window.
      this.lastFiredAt = now;
      this.cb();
      return;
    }
    // Inside the window. Arm trailing-edge if not already armed; the
    // first event inside the window is the one that decides "trailing
    // is needed" — subsequent events are absorbed by the same timer.
    if (this.trailingHandle !== null) return;
    const remaining = this.windowMs - (now - this.lastFiredAt);
    this.trailingHandle = this.deps.setTimeout(() => {
      this.trailingHandle = null;
      this.lastFiredAt = this.deps.now();
      this.cb();
    }, remaining);
  }

  /**
   * Cancel any pending trailing-edge fire. Called from teardown to
   * avoid lingering timers / a post-shutdown stray render. Idempotent.
   */
  cancel(): void {
    if (this.trailingHandle !== null) {
      this.deps.clearTimeout(this.trailingHandle);
      this.trailingHandle = null;
    }
  }
}
