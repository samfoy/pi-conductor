/**
 * pi-conductor — `on_complete_hook` cascade resolver (v0.11 slice 1b).
 *
 * Pure 4-layer resolver for the `on_complete_hook` configuration. Mirrors
 * the v0.10 watchdog cascade (`resolveKillOnStall` in `src/watchdog.ts`)
 * in spirit: a single pure function that takes crafted inputs and returns
 * the resolved value or `undefined`. No I/O, no side effects, no clock.
 *
 * Layer precedence (highest wins, first non-undefined non-empty stops):
 *   1. per-call               (ensemble_spawn / ensemble_send tool arg)
 *   2. project config         (<project>/.pi/conductor/config.json
 *                              :: personaOverrides[name].onCompleteHook)
 *   3. user config            (~/.pi/agent/extensions/conductor/config.json
 *                              :: personaOverrides[name].onCompleteHook)
 *   4. persona frontmatter    (personas/<name>.md :: on_complete_hook)
 *   5. built-in default       (none — no shipped persona declares a hook)
 *
 * Empty string at any layer is the **explicit-disable sentinel**. It
 * short-circuits the entire cascade and returns `undefined`. Undefined
 * means "fall through to next layer". This is a stronger contract than
 * the v0.10 watchdog cascade (boolean-only, no explicit-disable) — string
 * hooks need a cancel path that the per-call layer can express.
 *
 * **R7 — explicit-disable does not persist.** A per-call empty string
 * disables the hook *for that one spawn only*. The next spawn (without
 * the per-call override) cascades normally and may pick up project / user
 * / frontmatter values. The cascade is recomputed per spawn from the
 * input layers; the resolver holds no state. Documented as design risk
 * R7 (`docs/v0.11-on-complete-hook-design.md` §8).
 *
 * **Timeout resolution.** `timeoutSeconds` is resolved from the *same
 * layer the command came from*. If the winning layer omits `timeoutSeconds`
 * the resolver falls back to {@link DEFAULT_HOOK_TIMEOUT_SECONDS} — never
 * pulling timeout from a lower layer. This avoids surprising recombinations
 * (e.g. project's command paired with user's much-longer timeout).
 *
 * **Signature note (slice 1b deviation from plan).** The plan specifies
 * `(perCall, cfg: ConductorConfig, persona)` but `ConductorConfig` is the
 * *merged* result of user+project (see `src/config.ts` `mergeConfig`),
 * which collapses the two layers — making witnesses for "user wins" vs
 * "project wins" indistinguishable. We instead take a structured
 * {@link HookCascadeInput} carrying all four layers explicitly. Slice 2's
 * wiring will extract project + user from `loadConfigWithErrors` (or an
 * upgrade thereto) and persona from the resolved `Persona`, then call
 * this resolver. This keeps the 4-value `HookSource` enum (declared in
 * slice 1a) meaningful and lets WDD witnesses fire deterministically.
 */

import type { HookSource, HookSpec, ResolvedHook } from "./types.ts";

/** Default timeout applied when the winning layer omits `timeoutSeconds`. */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 300;

/**
 * Crafted cascade input for {@link resolveOnCompleteHook}. Each layer is
 * independently optional. Slice 2 will populate this from the live
 * conductor config + persona at the call site; slice 1b ships the
 * resolver cold (no production callers).
 */
export interface HookCascadeInput {
  /** Per-call override (highest priority). Empty `command` = disable. */
  perCall?: HookSpec;
  /** Project config personaOverrides for the persona name. */
  project?: HookSpec;
  /** User config personaOverrides for the persona name. */
  user?: HookSpec;
  /** Persona frontmatter (`on_complete_hook`). */
  persona?: HookSpec;
}

/**
 * Resolve the on_complete_hook for a single sub-agent run. Returns
 * `undefined` when no hook should run (either no layer supplied a value,
 * or some layer supplied the empty-string disable sentinel).
 *
 * Pure: deterministic on `input`, no I/O, no clock. Exposed for tests so
 * WDD mutation witnesses can pin the cascade arithmetic directly (parallel-
 * formula rule, `docs/wdd.md`).
 *
 * See module-level JSDoc for layer precedence, the empty-string sentinel,
 * and the timeout-resolution rule.
 */
export function resolveOnCompleteHook(
  input: HookCascadeInput,
): ResolvedHook | undefined {
  // Walk layers in priority order. Each iteration: if the layer is set,
  // it wins (either with a command, or with empty-string-as-disable that
  // short-circuits the cascade). Undefined falls through.
  const layers: Array<{ source: HookSource; spec: HookSpec | undefined }> = [
    { source: "per-call", spec: input.perCall },
    { source: "project", spec: input.project },
    { source: "user", spec: input.user },
    { source: "persona", spec: input.persona },
  ];

  for (const { source, spec } of layers) {
    if (spec === undefined) continue;
    if (spec.command === undefined) continue;
    if (spec.command === "") {
      // Explicit-disable sentinel: short-circuit the cascade.
      return undefined;
    }
    return {
      command: spec.command,
      timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
      source,
    };
  }

  // No layer supplied a command — no hook to run.
  return undefined;
}
