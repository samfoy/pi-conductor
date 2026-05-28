/**
 * Item 12 candidate #3 — `resolveInheritContext` cascade resolver.
 *
 * Per-call > persona-frontmatter (∪ project/user `personaOverrides`)
 * cascade for `inherit_context`. Mirrors `src/watchdog.ts:287`
 * `resolveKillOnStall` and `src/steerable.ts` `resolveSteerable` shape
 * exactly so a future PRD entry can upgrade all three resolvers
 * together (oracle gate 2 ADJUST, PRD.md:517).
 *
 * Layer collapse already happens upstream in two places:
 *   - project / user `personaOverrides[name].inheritContext` is folded
 *     into `persona.inheritContext` by `resolvePersonas` at
 *     `src/personas.ts:369`.
 *   - The per-call layer is provided here by the `ensemble_spawn`
 *     LLM tool arg.
 *
 * The resolver itself is therefore a one-liner — `perCall ??
 * persona.inheritContext`. This is intentional: the W1 mutation
 * witness in `tests/inherit-context-resolver.test.ts` pins the
 * formula directly per `docs/wdd.md` parallel-formula rule.
 *
 * See `docs/backlog.md` item 12 for the witnessed builder-4gsl
 * parent-identity-bleed failure mode this candidate defends against,
 * and `docs/items-11-12-inspector-map.md` §5.3 for the design sketch.
 */

import type { ContextInheritance, Persona } from "./types.ts";

/**
 * @param perCall   `inherit_context` arg from `ensemble_spawn`'s LLM
 *                  tool invocation. Explicit `"none"` / `"filtered"` /
 *                  `"filtered_compact"` / `"full"` short-circuits the
 *                  cascade; `undefined` falls through to the persona.
 * @param persona   Persona record with merged frontmatter ∪ project /
 *                  user `personaOverrides[name].inheritContext`. The
 *                  resolver only sees the post-collapse value at
 *                  `persona.inheritContext`.
 * @returns         The effective `ContextInheritance` mode for this
 *                  spawn. Threaded into `planSpawnPiArgs` to drive the
 *                  filter selection (`filterParentContext` /
 *                  `filterParentContextCompact` / pass-through / fresh).
 */
export function resolveInheritContext(
  perCall: ContextInheritance | undefined,
  persona: Persona,
): ContextInheritance {
  return perCall ?? persona.inheritContext;
}
