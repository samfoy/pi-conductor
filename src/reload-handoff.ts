/**
 * `/reload` handoff for ordinary subprocess runs.
 *
 * On reload conductor spares running children (src/shutdown.ts), but their
 * close handlers stay in the old extension instance, and pi invalidates that
 * instance's API right after session_shutdown. The old instance's card for a
 * survivor would throw "ctx is stale" and be lost. Instead the old instance
 * hands the ids it still owes a card to its successor in the same process,
 * and stops posting them itself. The successor readopts each survivor
 * (never treating it as an orphan), watches its record, and posts the card
 * once the old close handler has written the outcome.
 *
 * herdr runs (owner-generation fenced readopt), effort runs and mergers
 * (effort recovery) and delegated leaves (no lead card) keep their own paths.
 */

import { readFileSync, statSync } from "node:fs";
import { buildOrphanRun } from "./reconcile-startup.ts";
import { isDelegatedLeaf, isSettled, type Run, type RunRecord, type RunStatus } from "./types.ts";

const SLOT = Symbol.for("pi-conductor.reload-survivors.v1");

/** What a successor gets per survivor. `terminate` runs the holder's own forceTerminate: only it has the process. */
export interface Survivor {
  terminate?: () => void;
}

/** Session id → survivors. Process-global: it must outlive the old module instance. */
function slot(): Map<string, Map<string, Survivor>> {
  const g = globalThis as { [SLOT]?: Map<string, Map<string, Survivor>> };
  return (g[SLOT] ??= new Map());
}

export function handOffCandidate(run: Run): boolean {
  return (run.status === "running" || run.status === "paused")
    && (run.runtime ?? "subprocess") === "subprocess"
    && !run.effort && !run.integration && !run.mergerFor && !isDelegatedLeaf(run);
}

export function publishReloadSurvivors(sessionId: string, survivors: ReadonlyMap<string, Survivor>): void {
  if (survivors.size) slot().set(sessionId, new Map(survivors));
  else slot().delete(sessionId);
}

export function claimReloadSurvivors(sessionId: string): Map<string, Survivor> {
  const survivors = slot().get(sessionId) ?? new Map<string, Survivor>();
  slot().delete(sessionId);
  return survivors;
}

export interface SurvivorWatchDeps {
  registry: { get(id: string): Run | undefined; register(run: Run): void; notify(run: Run): void };
  /** Posts the card (and lifecycle event) for the settled run. Called at most once. */
  deliver: (run: Run) => void;
}

const POLL_MS = 1_000;
/** How long a settled record may wait for this invocation's final.md before the card goes without it. */
const FINAL_WAIT_MS = 5_000;

/**
 * Poll `recordPath` until the run settles (terminal or blocked), then update
 * the registry entry from the record and deliver once. A run this instance
 * settled itself first (e.g. ensemble_kill, which stays silent) is left alone.
 * Returns an idempotent stop.
 */
export function watchSurvivor(id: string, recordPath: string, deps: SurvivorWatchDeps): () => void {
  const initialStatus = deps.registry.get(id)?.status;
  let settledSeenAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  const check = () => {
    if (stopped) return;
    const existing = deps.registry.get(id);
    if (existing && existing.status !== initialStatus) return stop();
    let record: RunRecord;
    try { record = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecord; } catch { return; } // absent or mid-write
    if (record.id !== id || !isSettled(record.status as RunStatus)) return;
    settledSeenAt ??= Date.now();
    const text = invocationFinal(record);
    if (text === undefined && Date.now() - settledSeenAt < FINAL_WAIT_MS) return;
    stop();
    const run = buildOrphanRun(record, record.status);
    if (text) run.messages = [{ role: "assistant", content: [{ type: "text", text }] } as never];
    if (existing) {
      Object.assign(existing, run);
      deps.registry.notify(existing);
    } else deps.registry.register(run);
    deps.deliver(existing ?? run);
  };
  check();
  if (!stopped) {
    timer = setInterval(check, POLL_MS);
    timer.unref?.();
  }
  return stop;
}

/** final.md written by this invocation; an older invocation's file is not this result. */
function invocationFinal(record: RunRecord): string | undefined {
  try {
    if (statSync(record.finalPath).mtimeMs < (record.thisInvocationStartedAt ?? record.startTime)) return undefined;
    return readFileSync(record.finalPath, "utf8");
  } catch {
    return undefined;
  }
}
