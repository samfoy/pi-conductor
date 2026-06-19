/**
 * pi-conductor — turn-limit cascade resolvers (v0.17-S2).
 *
 * Pure 4-layer cascade resolvers for `maxTurns` and `graceTurns`.
 * Models the hook-cascade.ts / watchdog.ts resolver patterns — single pure
 * functions with no I/O, no side effects, no clock.
 *
 * Layer precedence (highest wins, first defined value stops):
 *   1. per-call     (ensemble_spawn / ensemble_send tool arg)
 *   2. project      (<project>/.pi/conductor/config.json
 *                    :: personaOverrides[name].maxTurns / graceTurns)
 *   3. user         (~/.pi/agent/extensions/conductor/config.json
 *                    :: personaOverrides[name].maxTurns / graceTurns)
 *   4. persona      (personas/<name>.md :: max_turns / grace_turns frontmatter)
 *   5. built-in     (undefined for maxTurns — no limit;
 *                    DEFAULT_GRACE_TURNS for graceTurns)
 *
 * Unlike the hook cascade, there is no empty-string sentinel.  A numeric 0
 * for `graceTurns` is an explicit valid value meaning "hard-abort immediately
 * at the turn limit with no grace period".  Undefined means "fall through to
 * next layer".
 *
 * Both resolvers are independently cascaded so a per-call `maxTurns` override
 * does NOT force the caller to also specify `graceTurns`.  Each field walks
 * its own cascade independently.
 */

/** Built-in default for the grace-turn count when no layer specifies it. */
export const DEFAULT_GRACE_TURNS = 5;

/**
 * Per-layer turn-limit specification.  Both fields are optional — a layer
 * may override only one of the two values without forcing the caller to
 * re-specify the other.
 */
export interface TurnLimitSpec {
  /** Maximum turns before a wrap-up grace message is sent (steerable) or
   *  the run is force-aborted (non-steerable).  Undefined = no limit. */
  maxTurns?: number;
  /** Number of extra turns to allow after the wrap-up grace message is sent
   *  before force-aborting a steerable run.  0 = immediate abort.  Default 5. */
  graceTurns?: number;
}

/**
 * Crafted cascade input for {@link resolveMaxTurns} and
 * {@link resolveGraceTurns}.  Each layer is independently optional.
 * Production callers will populate this from the live conductor config +
 * persona at spawn time; S2 ships the resolvers cold (no production callers).
 * S3 wires the stamp at spawn time.
 */
export interface TurnLimitCascadeInput {
  /** Per-call override (highest priority). */
  perCall?: TurnLimitSpec;
  /** Project config personaOverrides for the persona name. */
  project?: TurnLimitSpec;
  /** User config personaOverrides for the persona name. */
  user?: TurnLimitSpec;
  /** Persona frontmatter (`max_turns` / `grace_turns`). */
  persona?: TurnLimitSpec;
}

/**
 * Resolve the `maxTurns` limit for a single sub-agent run.
 *
 * Returns `undefined` when no layer specifies a value (built-in default:
 * no turn limit).
 *
 * Pure: deterministic on `input`, no I/O, no clock.
 */
export function resolveMaxTurns(
  input: TurnLimitCascadeInput,
): number | undefined {
  const layers: Array<TurnLimitSpec | undefined> = [
    input.perCall,
    input.project,
    input.user,
    input.persona,
  ];
  for (const spec of layers) {
    if (spec === undefined) continue;
    if (spec.maxTurns !== undefined) return spec.maxTurns;
  }
  return undefined;
}

/**
 * Resolve the `graceTurns` count for a single sub-agent run.
 *
 * Returns {@link DEFAULT_GRACE_TURNS} (5) when no layer specifies a value.
 * A layer value of `0` is valid and resolves to `0` (immediate hard abort
 * at the limit without a grace period).
 *
 * Pure: deterministic on `input`, no I/O, no clock.
 */
export function resolveGraceTurns(input: TurnLimitCascadeInput): number {
  const layers: Array<TurnLimitSpec | undefined> = [
    input.perCall,
    input.project,
    input.user,
    input.persona,
  ];
  for (const spec of layers) {
    if (spec === undefined) continue;
    if (spec.graceTurns !== undefined) return spec.graceTurns;
  }
  return DEFAULT_GRACE_TURNS;
}
