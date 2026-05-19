/**
 * pi-conductor — GC id-reuse log helper.
 *
 * Tiny standalone module (no fs, no other deps) so `runs.ts` can import
 * it without pulling in the full GC subsystem and creating an import
 * cycle with `gc/index.ts`. Per oracle review R10 — defensive log line
 * when the allocator picks an id that GC just freed; tools that cite
 * run ids by name (vault notes, dashboards) can flag the reuse.
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 5"; docs/v0.9-gc-design.md §R10.
 */

const recentlyDeletedIds = new Set<string>();

/** Called by the GC executor when a run dir is unlinked. */
export function noteDeletedId(id: string): void {
  recentlyDeletedIds.add(id);
}

/**
 * Called by `allocateRunId` after picking a fresh id. If the id was
 * previously freed by GC, log to stderr (default) for tooling. NOT a
 * collision check — the allocator's existsSync already rules out
 * physical collisions.
 */
export function noteAllocatedId(
  id: string,
  log: (line: string) => void = (l) => console.error(l),
): void {
  if (recentlyDeletedIds.has(id)) {
    log(`gc.id_reused: ${id}`);
  }
}

/** Test hook. */
export function _resetRecentlyDeletedIdsForTest(): void {
  recentlyDeletedIds.clear();
}

/** Test/inspection hook. */
export function _peekRecentlyDeletedForTest(): ReadonlySet<string> {
  return recentlyDeletedIds;
}
