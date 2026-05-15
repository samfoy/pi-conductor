/**
 * Pure helpers for the conductor-mode flag (whether the system-prompt
 * addendum is injected at every turn).
 *
 * Kept in its own module so the resolver can be unit-tested without
 * pulling in pi's runtime, which would drag in @earendil-works/pi-coding-agent
 * (CJS-only with no exports field, fails to load under tsx --test).
 */

const OFF_TOKENS = new Set(["0", "false", "off", "no"]);
const ON_TOKENS = new Set(["1", "true", "on", "yes"]);

/**
 * Resolve whether conductor mode is on at extension load.
 *
 * v0.8 defaults to **OFF**: conductor is now opt-in. The strict-overseer
 * §1 addendum is intentionally prescriptive ("you are not the
 * implementer"), so injecting it without an explicit signal would
 * change every loaded session's behavior in surprising ways. Users who
 * relied on v0.7's ON-by-default can pin it via the new
 * `config.defaultMode = "on"` field, the `PI_CONDUCTOR_MODE=1` env
 * var, or `/conductor on` per-session.
 *
 * Precedence (highest to lowest):
 *   1. `config.defaultMode` ("on" | "off") from
 *      ~/.pi/agent/extensions/conductor/config.json (project layer
 *      already won the merge before we get here).
 *   2. `PI_CONDUCTOR_MODE` env var:
 *        - 1 / true / on / yes  → ON
 *        - 0 / false / off / no → OFF
 *   3. Built-in default → OFF.
 *
 * Unrecognized config or env values fall through to the next layer
 * (and then to the OFF default). Per-session toggling lives on
 * `/conductor on | off`.
 */
export function resolveInitialConductorMode(
  env: Record<string, string | undefined>,
  config?: { defaultMode?: "on" | "off" | string },
): boolean {
  // Layer 1: pinned in config.
  if (config && typeof config.defaultMode === "string") {
    if (config.defaultMode === "on") return true;
    if (config.defaultMode === "off") return false;
    // Unknown value → fall through to env-var path.
  }

  // Layer 2: env var override.
  const raw = env.PI_CONDUCTOR_MODE;
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (ON_TOKENS.has(v)) return true;
    if (OFF_TOKENS.has(v)) return false;
    // Empty / unrecognized → fall through to default.
  }

  // Layer 3: built-in default.
  return false;
}
