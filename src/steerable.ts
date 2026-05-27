/**
 * v0.12 steering — `resolveSteerable` cascade resolver.
 *
 * Mirrors `src/watchdog.ts:287` `resolveKillOnStall` shape exactly
 * (oracle gate 2 ADJUST: cascade-shape isomorphism so a future PRD
 * entry can upgrade both cascades together).
 *
 * Layer collapse (per-call > project > user > built-in default `false`)
 * happens UPSTREAM at spawn time onto `run.steerable` (boolean |
 * undefined) before this resolver runs. The resolver is a one-line
 * `run.steerable ?? defaultSteerable`. Slice 4 wires the upstream
 * collapse via the spawn pipeline (`src/runs.ts: spawnRun` reads the
 * cascade inputs, merges them, and stamps `run.steerable`).
 *
 * NO persona-frontmatter layer in v0.12 (`PRD.md:517` —
 * "persona-frontmatter layer deferred"). Mirrors v0.10
 * `kill_on_stall`'s deferred shape exactly. Critic gate 2 for slice 1
 * greps `src/` for "steerable" and rejects if `src/personas.ts`
 * surfaces.
 *
 * Pure: no I/O, deterministic on (run, defaultSteerable). Exposed for
 * tests so the W1 mutation witness in `tests/steerable.test.ts` can
 * pin the formula directly per `docs/wdd.md` parallel-formula rule.
 */

import type { Run } from "./types.ts";

/**
 * @param run               The run whose steerable flag was stamped at
 *                          spawn time by the upstream cascade collapse
 *                          (slice 4). `undefined` falls through to the
 *                          default; explicit `true`/`false` short-
 *                          circuits the cascade.
 * @param defaultSteerable  Built-in default. Slice 1 ships `false`
 *                          (mirrors `defaultKillOnStall: false` per
 *                          `PRD.md:517`).
 * @returns                 The resolved boolean. Production code in
 *                          slice 2 dispatches `--mode rpc` vs
 *                          `--mode json -p` on this value.
 */
export function resolveSteerable(run: Run, defaultSteerable: boolean): boolean {
  return run.steerable ?? defaultSteerable;
}

/**
 * v0.12 slice 4 — 4-layer cascade collapse. Pure helper invoked at
 * `ensemble_spawn` time to fold the per-call / project / user / built-in
 * default layers into a single boolean which is then stamped onto
 * `Run.steerable` before the spawn pipeline runs.
 *
 * Layer order, highest to lowest:
 *   1. perCall      — `ensemble_spawn`'s `steerable` LLM tool arg.
 *   2. project      — `<project>/.pi/conductor.json` `defaultSteerable`.
 *   3. user         — `~/.pi/agent/extensions/conductor/config.json`.
 *   4. defaultValue — built-in (`DEFAULT_CONFIG.defaultSteerable`, `false`).
 *
 * Each layer is `boolean | undefined`. `undefined` falls through to
 * the next layer; explicit `true`/`false` short-circuits below.
 *
 * Pinned by `tests/steerable-spawn-cascade.test.ts` (8 cases unskipped
 * by slice 4). The scaffold lives in slice 1; this helper makes those
 * cases pass against a real production import. Mirrors the cascade
 * shape from oracle gate 2 ADJUST + design §4.1 lines 282–340.
 *
 * Pure: no I/O, deterministic on the four inputs.
 */
export interface SteerableCascadeInputs {
  perCall: boolean | undefined;
  project: boolean | undefined;
  user: boolean | undefined;
  defaultValue: boolean;
}

export function collapseSteerableCascade(inputs: SteerableCascadeInputs): boolean {
  return inputs.perCall ?? inputs.project ?? inputs.user ?? inputs.defaultValue;
}
