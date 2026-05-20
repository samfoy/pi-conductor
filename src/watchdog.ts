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
