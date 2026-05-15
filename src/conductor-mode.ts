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
 * Resolve whether conductor mode is on at extension load. Default: ON.
 * Conductor is the whole point of this extension; if a user has loaded
 * it, they almost always want the system-prompt addendum active.
 *
 * The PI_CONDUCTOR_MODE env var is preserved as an explicit override:
 *   - 0 / false / off / no  → OFF (disables the addendum without
 *     unloading the extension; tools and slash commands still work)
 *   - 1 / true / on / yes   → ON (redundant under the new default but
 *     accepted for backward compatibility)
 *   - unset, empty, garbage → ON (default)
 *
 * Per-session toggling lives on /conductor on | off.
 */
export function resolveInitialConductorMode(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_CONDUCTOR_MODE;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  if (OFF_TOKENS.has(v)) return false;
  if (ON_TOKENS.has(v)) return true;
  return true;
}
