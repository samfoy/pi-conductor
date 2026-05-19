/**
 * pi-conductor — GC last-run marker.
 *
 * Tracks when the auto-on-session_start GC last ran via the mtime of
 * an empty file at `<conductorRoot>/.last-gc`. Lives in the conductor
 * root (parent of `runs/`) NOT under `runs/`, so it doesn't pollute
 * the inventory walk and isn't treated as a malformed run dir. Per
 * oracle review R11.
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 5"; docs/v0.9-gc-design.md §D6.
 */

import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the marker path from a `runsRoot`.
 *
 * @example
 *   lastGcMarkerPath("/home/u/.pi/agent/conductor/runs")
 *   // => "/home/u/.pi/agent/conductor/.last-gc"
 */
export function lastGcMarkerPath(runsRoot: string): string {
  return join(dirname(runsRoot), ".last-gc");
}

/**
 * Read the marker mtime in epoch ms, or `null` if the marker doesn't
 * exist. Errors (permission, race) reduce to `null` — callers treat
 * "no marker" as "GC has never run, fire away".
 */
export function readLastGcMtime(runsRoot: string): number | null {
  const path = lastGcMarkerPath(runsRoot);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Write the marker with mtime = `now`. Creates the file if missing.
 * Best-effort; errors are swallowed. The auto-trigger uses the marker
 * for debounce, not for correctness, so a write failure just means
 * the next session_start MAY re-fire GC slightly early.
 */
export function writeLastGcMtime(runsRoot: string, now: number): void {
  const path = lastGcMarkerPath(runsRoot);
  try {
    if (!existsSync(path)) writeFileSync(path, "");
    const t = new Date(now);
    utimesSync(path, t, t);
  } catch {
    // best-effort; debounce is advisory
  }
}
