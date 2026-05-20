/**
 * pi-conductor — v0.10 sub-agent watchdog (Slice 1: pure detector).
 *
 * Detects sub-agent runs that have stopped emitting events for too long.
 * The detector is a pure function of (run snapshot, prior state, config,
 * now) → (transition, next state). No I/O, no clock; `now` is injected
 * by the caller.
 *
 * Slice 1 ships ONLY this detector + the state types + Run.stalledSince.
 * The enforcer (interval ticker, registry hookup, kill path) lands in
 * Slice 2, per docs/v0.10-watchdog-design.md §6.
 */

import type { Run } from "./types.ts";
import type { TerminationReason, RunRegistry } from "./runs.ts";

// ── Public API ────────────────────────────────────────────────────────

/**
 * Configuration for the watchdog. All thresholds are seconds.
 *
 * - `softThresholdSeconds` — silent for ≥ this and we emit a `soft`
 *   transition the first time across. Advisory only; no kill.
 * - `hardThresholdSeconds` — silent for ≥ this and we emit a `hard`
 *   transition. Slice 2 escalates to `forceTerminate` when the spawn
 *   carries `kill_on_stall: true`.
 * - `graceSeconds` — suppress all transitions for runs younger than
 *   this. Cold-start latency budget.
 */
export interface WatchdogConfig {
  readonly softThresholdSeconds: number;
  readonly hardThresholdSeconds: number;
  readonly graceSeconds: number;
}

/**
 * Defaults match the design table at §2 of docs/v0.10-watchdog-design.md.
 *
 * 120s soft / 600s hard / 30s grace: chosen to fire well below the three
 * witnessed hangs (>5 min each) while staying above legitimate slow
 * tool calls (npm install, brazil-build, large npm test suites).
 */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

/**
 * Per-run state machine. Stored externally (the detector is pure); the
 * enforcer (Slice 2) holds a `Map<runId, WatchdogState>`.
 *
 * - `fresh` — never crossed any threshold (or recovered cleanly).
 * - `soft` — has crossed soft but not hard.
 * - `hard` — has crossed hard.
 *
 * `crossedAt` records the wall-clock at the transition into the state;
 * Slice 2 surfaces it via `Run.stalledSince` and the
 * `<sub-agent-stalled>` advisory envelope.
 */
export type WatchdogState =
  | { readonly kind: "fresh" }
  | { readonly kind: "soft"; readonly crossedAt: number }
  | { readonly kind: "hard"; readonly crossedAt: number };

/**
 * Discriminated union of detector outputs. `none` means "no advisory
 * needed; do nothing." The other three drive the enforcer.
 */
export type WatchdogTransition =
  | { readonly kind: "none" }
  | {
      readonly kind: "soft";
      readonly silentSeconds: number;
      readonly thresholdSeconds: number;
    }
  | {
      readonly kind: "hard";
      readonly silentSeconds: number;
      readonly thresholdSeconds: number;
    }
  | {
      readonly kind: "recovered";
      readonly previousKind: "soft" | "hard";
    };

/**
 * One detector tick. Pure: no I/O, no clock; `now` is injected.
 *
 * Returns the transition (possibly `{ kind: "none" }`) and the next
 * state for the caller to persist. The caller is responsible for
 * dispatching `transition` to side effects (advisory emit, optional
 * kill).
 *
 * Negative cases (return `{ kind: "none" }` and preserve state):
 *   1. `run.status` is not `"running"` (queued/paused/terminal/failed).
 *   2. `run.pausedAt` is set (paused — silence is expected).
 *   3. `now - run.startTime < graceSeconds * 1000` (cold-start grace).
 *   4. `now - run.lastEventAt < softThresholdSeconds * 1000` AND state
 *      is `fresh` (still healthy).
 *
 * Recovery: if state was `soft` or `hard` and `lastEventAt` advanced
 * back inside the soft window, emit `recovered` and reset to `fresh`.
 *
 * Boundary semantics: `>=` for both thresholds (an event at exactly
 * `T - softThresholdSeconds` is considered crossed).
 */
export function evaluateRun(
  run: Run,
  state: WatchdogState | undefined,
  config: WatchdogConfig,
  now: number,
): { transition: WatchdogTransition; nextState: WatchdogState } {
  const current: WatchdogState = state ?? { kind: "fresh" };

  // (1) Non-running statuses never stall.
  if (run.status !== "running") {
    return { transition: { kind: "none" }, nextState: current };
  }

  // (2) Paused runs do not stall — silence is expected. Preserve state
  // unchanged; when resumed, the next tick will re-evaluate.
  if (run.pausedAt !== undefined) {
    return { transition: { kind: "none" }, nextState: current };
  }

  // (3) Cold-start grace. Suppress all transitions for runs younger than
  // graceSeconds. Subtle: this also suppresses recovery emission while
  // still inside grace; that's fine because we wouldn't have transitioned
  // into soft/hard inside grace either.
  const ageMs = now - run.startTime;
  if (ageMs < config.graceSeconds * 1000) {
    return { transition: { kind: "none" }, nextState: current };
  }

  const silentMs = now - run.lastEventAt;
  const silentSeconds = Math.floor(silentMs / 1000);
  const softMs = config.softThresholdSeconds * 1000;
  const hardMs = config.hardThresholdSeconds * 1000;

  // Recovery — was stalled, now silent < soft. Emit one recovery
  // transition and reset to fresh.
  if (current.kind !== "fresh" && silentMs < softMs) {
    return {
      transition: { kind: "recovered", previousKind: current.kind },
      nextState: { kind: "fresh" },
    };
  }

  // Hard crossing.
  if (silentMs >= hardMs) {
    if (current.kind === "hard") {
      // Already in hard — dedupe.
      return { transition: { kind: "none" }, nextState: current };
    }
    return {
      transition: {
        kind: "hard",
        silentSeconds,
        thresholdSeconds: config.hardThresholdSeconds,
      },
      nextState: { kind: "hard", crossedAt: now },
    };
  }

  // Soft crossing.
  if (silentMs >= softMs) {
    if (current.kind === "soft") {
      // Already soft — dedupe until either hard or recovery.
      return { transition: { kind: "none" }, nextState: current };
    }
    return {
      transition: {
        kind: "soft",
        silentSeconds,
        thresholdSeconds: config.softThresholdSeconds,
      },
      nextState: { kind: "soft", crossedAt: now },
    };
  }

  // Healthy and was already fresh — no transition.
  return { transition: { kind: "none" }, nextState: current };
}

// ── Enforcer (Slice 2) ────────────────────────────────────────────────

/**
 * Logger used by the enforcer for soft/hard advisories and recovery.
 * Production wires this to `console.error` (matching the GC pattern);
 * tests pass a fake to capture calls.
 */
export interface WatchdogLog {
  warn(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
}

/**
 * Dependencies for the {@link Watchdog} class. Everything is injectable
 * to keep the enforcer testable without real clocks, intervals, or
 * subprocess kills.
 */
export interface WatchdogDeps {
  readonly registry: Pick<RunRegistry, "list" | "onChange">;
  /** Detector config (thresholds + grace). Tick interval is separate. */
  readonly config: WatchdogConfig;
  readonly log: WatchdogLog;
  /** Current wall-clock time in ms. Production: `Date.now`. */
  readonly now: () => number;
  /** Force-terminate a stalled run. Production: `forceTerminate(run, reason, registry)`. */
  readonly kill: (run: Run, reason: TerminationReason) => void;
  /**
   * Per-spawn `kill_on_stall` policy. Default off (advisory-only). Slice
   * 3 will plumb per-spawn overrides through SpawnOptions; until then
   * this returns the conductor-wide default.
   */
  readonly isKillOnStall: (run: Run) => boolean;
  /**
   * Master enable switch. Mirrors the v0.9 GC pattern: `enabled=false`
   * makes every code path a no-op without changing wiring. Defaults to
   * `true` when omitted.
   */
  readonly isEnabled?: () => boolean;
  /** Detector tick interval in ms. Default 30 000 (30s). */
  readonly tickIntervalMs?: number;
  /** Injectable for tests. Default: globalThis.setInterval. */
  readonly setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  /** Injectable for tests. Default: globalThis.clearInterval. */
  readonly clearInterval?: (t: NodeJS.Timeout) => void;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * v0.10 Slice 3: derive the effective {@link WatchdogConfig} for a
 * single run. When the run carries a `softStallSeconds` override
 * (set at spawn or send time), compute matching thresholds at the
 * same hard:soft ratio as the conductor defaults so a longer soft
 * also implies a proportionally longer hard.
 *
 * Pure: no I/O, deterministic on (run, defaults). Exposed for tests.
 */
export function effectiveConfig(run: Run, defaults: WatchdogConfig): WatchdogConfig {
  const overrideSoft = run.softStallSeconds;
  if (overrideSoft === undefined) return defaults;
  const ratio =
    defaults.softThresholdSeconds > 0
      ? defaults.hardThresholdSeconds / defaults.softThresholdSeconds
      : 5;
  // Hard stays a multiple of soft (default 5× — 600/120). Floor at
  // soft + 60s so a tight soft override never collapses hard onto it.
  const scaledHard = Math.max(
    Math.round(overrideSoft * ratio),
    overrideSoft + 60,
  );
  return {
    softThresholdSeconds: overrideSoft,
    hardThresholdSeconds: scaledHard,
    graceSeconds: defaults.graceSeconds,
  };
}

/**
 * Resolve `kill_on_stall` for a single run. Per-run override (set by
 * the spawn/send pipeline from the LLM tool arg) wins over the
 * conductor-wide default. Returns `false` only when both the run's
 * `killOnStall` is explicitly `false` or the default is `false` and
 * the run's value is `undefined`.
 *
 * Pure: no I/O, deterministic on (run, defaultKillOnStall). Exposed
 * for tests so the W1 mutation witness can pin the formula directly
 * (see `personas/critic.md`'s mutation-test rule and `docs/wdd.md`).
 * Imported by `src/index.ts`'s session_start watchdog wiring.
 */
export function resolveKillOnStall(run: Run, defaultKillOnStall: boolean): boolean {
  return run.killOnStall ?? defaultKillOnStall;
}

/**
 * Sub-agent stall enforcer. Wraps the pure {@link evaluateRun} with:
 *   - registry subscription (wake on state change)
 *   - interval ticker (catch silent runs that never fire registry events)
 *   - per-run `WatchdogState` map
 *   - dispatch of soft/hard/recovered transitions to log + kill
 *   - **A2 pre-kill recheck** so a recovered run is not killed by a
 *     stale verdict
 *   - **R7 sub-agent skip**: when running inside a sub-agent
 *     (`CONDUCTOR_SUBAGENT === "1"`), `start()` is a no-op so the
 *     sub-agent's pi instance does not spawn a phantom watchdog that
 *     would kill its siblings on the parent's behalf.
 *
 * Lifecycle: `start()` returns a dispose function. The dispose unsubs
 * from the registry and clears the interval. Idempotent.
 */
export class Watchdog {
  private readonly states = new Map<string, WatchdogState>();
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private disposed = false;
  private readonly setIntervalFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (t: NodeJS.Timeout) => void;
  private readonly tickIntervalMs: number;

  constructor(private readonly deps: WatchdogDeps) {
    this.setIntervalFn =
      deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearIntervalFn =
      deps.clearInterval ?? ((t) => globalThis.clearInterval(t));
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /**
   * Start the watchdog: subscribe to registry changes + arm interval.
   * Returns a dispose function. R7: when `CONDUCTOR_SUBAGENT=1`, this
   * is a no-op so a sub-agent's conductor extension does not run a
   * watchdog that would race the parent's. Same pattern as the v0.9
   * auto-GC sub-agent skip.
   */
  start(): () => void {
    if (process.env.CONDUCTOR_SUBAGENT === "1") {
      // No subscription, no timer; dispose is a no-op.
      return () => {};
    }
    if (this.disposed) {
      // Treat re-start after dispose as a fresh subscription.
      this.disposed = false;
    }

    // Wake up on any registry change so we observe new runs and status
    // transitions promptly (between interval ticks).
    this.unsub = this.deps.registry.onChange(() => {
      // Cheap: just runs the detector pass. No kill happens here unless
      // a run somehow crossed hard between ticks — same dispatch path.
      this.tick();
    });

    this.timer = this.setIntervalFn(() => this.tick(), this.tickIntervalMs);
    if (typeof (this.timer as { unref?: () => void } | null)?.unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref();
    }

    return () => {
      if (this.disposed) return;
      this.disposed = true;
      if (this.unsub) {
        this.unsub();
        this.unsub = null;
      }
      if (this.timer) {
        this.clearIntervalFn(this.timer);
        this.timer = null;
      }
      this.states.clear();
    };
  }

  /**
   * Run one detector pass over every run in the registry. Public so
   * tests can drive deterministic ticks; production triggers via
   * `setInterval` and registry change notifications.
   *
   * In sub-agent context this is a guarded no-op (R7) so test
   * environments that flip the env var for a single test don't leak
   * ticks into other tests.
   */
  tick(): void {
    if (process.env.CONDUCTOR_SUBAGENT === "1") return;
    if (this.deps.isEnabled && !this.deps.isEnabled()) return;

    const now = this.deps.now();
    for (const run of this.deps.registry.list()) {
      const prev = this.states.get(run.id);
      // v0.10 Slice 3: per-run effective config so a spawn that overrode
      // `stall_threshold_seconds` gets its own thresholds. Pure helper;
      // the detector itself stays config-driven.
      const effective = effectiveConfig(run, this.deps.config);
      const { transition, nextState } = evaluateRun(run, prev, effective, now);

      // Persist state so the next tick can dedupe + detect recovery.
      this.states.set(run.id, nextState);

      // Garbage-collect terminal runs so the map doesn't grow unbounded.
      // (For the regular case we set then delete — cheap; the alternative
      // is to skip the set, but writing first keeps the ordering simple.)
      if (run.status !== "running") {
        this.states.delete(run.id);
      }

      this.dispatch(run, transition, effective);
    }
  }

  /**
   * Side-effect dispatcher for one transition. Soft/recovered are pure
   * advisories. Hard either kills (`kill_on_stall` true) or warns and
   * leaves the run alive. The kill path performs the **A2 pre-kill
   * recheck**: re-read `now() - run.lastEventAt` and abort the kill if
   * the run recovered between the detector verdict and the dispatch.
   */
  private dispatch(run: Run, transition: WatchdogTransition, effective: WatchdogConfig): void {
    switch (transition.kind) {
      case "none":
        return;
      case "soft": {
        run.stalledSince = this.deps.now();
        this.deps.log.warn(
          `watchdog: soft-stall on ${run.id} (silent ${transition.silentSeconds}s)`,
          {
            agentId: run.id,
            persona: run.persona,
            silentSeconds: transition.silentSeconds,
            severity: "soft",
          },
        );
        return;
      }
      case "hard": {
        run.stalledSince = this.deps.now();
        const killOnStall = this.deps.isKillOnStall(run);
        if (!killOnStall) {
          this.deps.log.warn(
            `watchdog: hard-stall on ${run.id} (silent ${transition.silentSeconds}s) — kill_on_stall=false; leaving alive`,
            {
              agentId: run.id,
              persona: run.persona,
              silentSeconds: transition.silentSeconds,
              severity: "hard",
            },
          );
          return;
        }

        // A2 pre-kill recheck. The detector verdict was computed with
        // some (possibly stale by a few ms) `now`; before we actually
        // pull the trigger, re-read `now()` and `run.lastEventAt`. If
        // the run recovered (event landed between detector and kill),
        // emit a recovery info and bail. Without this guard, a run
        // that just emitted its first event after a long bash hang
        // would still die. Mutation-witness: deleting the recheck makes
        // the corresponding test flip from "recovered" to "killed".
        const nowAfter = this.deps.now();
        const stillStaleMs = nowAfter - run.lastEventAt;
        if (stillStaleMs < effective.hardThresholdSeconds * 1000) {
          // Recovered between detector and kill. Treat as recovered:
          // clear stalledSince, reset state, log info.
          run.stalledSince = undefined;
          this.states.set(run.id, { kind: "fresh" });
          this.deps.log.info(
            `watchdog: kill aborted for ${run.id} — recovered before kill (A2)`,
            {
              agentId: run.id,
              persona: run.persona,
              recoveredFrom: "hard",
            },
          );
          return;
        }

        this.deps.log.warn(
          `watchdog: hard-stall on ${run.id} (silent ${transition.silentSeconds}s) — killing (kill_on_stall=true)`,
          {
            agentId: run.id,
            persona: run.persona,
            silentSeconds: transition.silentSeconds,
            severity: "hard",
          },
        );
        this.deps.kill(run, "stalled");
        return;
      }
      case "recovered": {
        run.stalledSince = undefined;
        this.deps.log.info(
          `watchdog: ${run.id} recovered from ${transition.previousKind}-stall`,
          {
            agentId: run.id,
            persona: run.persona,
            previousKind: transition.previousKind,
          },
        );
        return;
      }
    }
  }
}
