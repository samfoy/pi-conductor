/**
 * Shared deterministic fake clock + scheduler for unit tests.
 *
 * Slice-3 critic flagged the same fake-clock harness duplicated across
 * `tests/rerender-coalescer.test.ts` (`makeFakeDeps`) and
 * `tests/focused-overlay-shortcut.test.ts` (inline). Slice 4's
 * stickToTail-during-burst tests want the same harness, so we extract
 * it here.
 *
 * Surface (intentionally minimal — keep <60 LOC):
 * - `now()` — monotonic-ish wall-clock substitute.
 * - `setTimeout(cb, ms)` / `clearTimeout(handle)` — same shapes used by
 *   `RerenderCoalescer`'s `CoalescerDeps`.
 * - `advance(ms)` — fast-forward time, firing any due timers in order.
 * - `setNow(n)` — jump the clock without firing timers (for tests that
 *   want to manually control fire ordering).
 * - `pendingCount()` — number of armed timers (cancelled timers are
 *   excluded).
 *
 * Intentionally NOT covered: re-entrant scheduling (a timer cb calling
 * setTimeout again). The production class never does this; tests that
 * need it should build a bespoke harness.
 */

interface ScheduledTimer {
  readonly fireAt: number;
  readonly cb: () => void;
  cancelled: boolean;
}

export interface FakeClock {
  /** Stable accessor for the deps shape `RerenderCoalescer` consumes. */
  readonly deps: {
    readonly now: () => number;
    readonly setTimeout: (cb: () => void, ms: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
  setNow: (n: number) => void;
  advance: (ms: number) => void;
  pendingCount: () => number;
}

export function makeFakeClock(initialNow = 1000): FakeClock {
  let now = initialNow;
  const timers: ScheduledTimer[] = [];
  return {
    deps: {
      now: () => now,
      setTimeout: (cb, ms) => {
        const t: ScheduledTimer = { fireAt: now + ms, cb, cancelled: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (handle) => {
        (handle as ScheduledTimer).cancelled = true;
      },
    },
    setNow: (n) => {
      now = n;
    },
    advance: (ms) => {
      const target = now + ms;
      while (true) {
        const due = timers
          .filter((t) => !t.cancelled && t.fireAt <= target)
          .sort((a, b) => a.fireAt - b.fireAt)[0];
        if (!due) break;
        now = due.fireAt;
        due.cancelled = true;
        due.cb();
      }
      now = target;
    },
    pendingCount: () => timers.filter((t) => !t.cancelled).length,
  };
}
