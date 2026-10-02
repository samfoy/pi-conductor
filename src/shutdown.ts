/**
 * Pure side-effect helper for `pi.on("session_shutdown", …)`.
 *
 * The host's `/reload` slash command (and the `ctx.reload()` API) tear
 * down the extension runtime and re-import `dist/index.js` while
 * preserving the session manager's chat history, scratchpad, and
 * conductor brief. The lifecycle event distinguishes the cases via
 * `reason`:
 *
 *   reason === "reload"  → developer reload; spare the children.
 *   reason === "quit"    → user is exiting pi; tear everything down.
 *   reason === "new" |   → session is being replaced; tear down our
 *     "resume" | "fork"    runtime-scoped state for a clean handoff.
 *
 * On reload we MUST NOT SIGTERM running/paused sub-agents: child
 * processes are siblings of the parent OS process (not detached, but
 * their lifecycle is not tied to the extension runtime swap), and
 * killing them on every developer reload defeats the entire point of
 * having a hot-reload loop. Their final.md / record.json land on disk
 * regardless; a future Step 2 may rehydrate them in the new runtime's
 * registry, but Step 1 simply leaves them alone.
 *
 * Spec: oracle-3l2e (v0.8.2 backlog P0 #1 — parent-reload contract).
 */

import { ownsHerdrRun } from "./herdr/ownership.ts";
import { runtimeFor } from "./runtime.ts";
import { isDelegatedLeaf, type Run } from "./types.ts";
import { writeRecord } from "./runs.ts";

/**
 * Subset of the upstream `SessionShutdownEvent` we actually consume.
 * Mirrors the local-minimal-type pattern used in `sanitizer-hook.ts`
 * so this helper is unit-testable without booting the host TUI.
 *
 * The full set of `reason` values per
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
 * is `"quit" | "reload" | "new" | "resume" | "fork"`.
 */
export interface ShutdownEventLike {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface ShutdownDeps {
  /**
   * All currently-tracked runs (typically `registry.list()`). The
   * helper iterates this list once and SIGTERMs anything in
   * `running`/`paused`. Terminal and `queued` runs are skipped.
   */
  runs: Run[];
  /**
   * Clear the sanitizer hook's warning dedup set. Called only on
   * non-reload reasons so the next session re-warns about pre-existing
   * wedges; on reload the OLD hook's set is GC'd with the runtime
   * anyway, so calling reset() would be a no-op — we skip it for
   * symmetry with the "leave reload alone" invariant.
   */
  resetSanitizer: () => void;
  terminateHerdr?: (run: Run) => void;
  /**
   * Reconcile the on-disk `record.json` of each running/paused run
   * after SIGTERM. Closes the orphan-creation window flagged by
   * inspector surprise #1 and oracle amendment A1: without this,
   * `session_shutdown` reason="quit" leaves records frozen at
   * `status: "running"` until the next session_start runs the GC
   * orphan sweep. With this hook, the record flips to `killed` with a
   * shutdown-reason marker before the runtime tears down.
   *
   * Best-effort, awaited before shutdown completes. Skipped on reason="reload" so the
   * v0.8.2 lifecycle preservation feature (commit 1c72856) keeps its
   * "don't touch records on developer reload" invariant.
   *
   * Optional so existing test fixtures and the unit-tests don't need
   * to wire it; production sites in src/index.ts always provide it.
   */
  reconcileRunning?: (runs: Run[], reason: ShutdownEventLike["reason"]) => void | Promise<void>;
  /** N2 broker; on reload it stops subprocess parents with outstanding calls, leaves first (R6 fallback). */
  delegation?: { close(): Promise<void> };
  /** N4: cancel a queued leaf before quit signals anything, so no slot a stopping leaf frees can launch it. */
  removeQueued?: (id: string) => void;
}

/**
 * Apply the side effects of a `session_shutdown` event.
 *
 * On reload: preserve live children and await post-integration settlement.
 * Caller is still responsible for releasing
 * runtime-scoped UI handles (widget, terminal-input listeners) — those
 * are tied to the OLD `ctx` whether we reload or quit.
 *
 * Otherwise: SIGTERM every running/paused run (best-effort, throws
 * swallowed) and reset the sanitizer dedup set.
 */
export async function handleSessionShutdown(
  event: ShutdownEventLike,
  deps: ShutdownDeps,
): Promise<void> {
  if (event.reason === "reload") for (const run of deps.runs) run.herdrPipeline?.suspend();
  for (const run of deps.runs) if (run.effort) run.integrationSuspended = true;
  const integrations = deps.runs.flatMap(run => {
    const transition = run.integrationSuspension ?? run.integrationControl?.suspend();
    return transition ? [transition] : [];
  });
  if (integrations.length) {
    const results = await Promise.allSettled(integrations);
    const failure = results.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  // A failed final write is quiescent too: recovery inspects its WAL, without a surviving finalizer.
  const settlements = deps.runs.flatMap(run => run.integrationSettlement ? [run.integrationSettlement] : []);
  if (settlements.length) await Promise.allSettled(settlements);
  const uncertain = deps.runs.find(run => run.status === "integrating" && run.integration?.teardownError);
  if (uncertain) throw new Error(uncertain.integration!.teardownError);
  if (event.reason === "reload") {
    await deps.delegation?.close();
    await Promise.all(deps.runs.filter(run => run.runtime === "herdr").map(detachHerdrRun));
    return;
  }
  const stillActive: Run[] = [];
  for (const r of deps.runs) if (isDelegatedLeaf(r) && r.status === "queued") deps.removeQueued?.(r.id);
  // N4: leaves before the parents that own them.
  for (const r of [...deps.runs.filter(isDelegatedLeaf), ...deps.runs.filter(r => !isDelegatedLeaf(r))]) {
    if (ownsHerdrRun(r) && (r.status === "running" || r.status === "paused")) {
      stillActive.push(r);
      try {
        if (r.runtime === "herdr") deps.terminateHerdr?.(r);
        else runtimeFor(r).stopProcess(r);
      } catch {
        // already dead — non-fatal
      }
    }
  }
  // The pane budget starts only after verifier suspension and terminal I/O are quiescent.
  const panes = deps.runs.filter(run => run.runtime === "herdr" && ownsHerdrRun(run));
  if (panes.length) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(); }, 5000); });
    const cleanup = Promise.allSettled(panes.map(async run => {
      const transport = run.transport;
      if (transport?.kind === "herdr" && transport.shutdown) await transport.shutdown(abort.signal);
    }));
    try { await Promise.race([cleanup, expired]); } finally { clearTimeout(timer); }
    for (const run of panes) {
      if (run.transport?.kind !== "herdr" || !run.transport.childExited) run.herdrExitUnconfirmed = true;
      if (abort.signal.aborted) run.worktreeKept = "pane shutdown budget expired; pane/worktree and ownership evidence preserved";
      else if (run.transport?.stderr) run.worktreeKept = run.transport.stderr;
      else if (run.transport?.kind !== "herdr") run.worktreeKept = "pane shutdown unavailable: unattached herdr run; ownership evidence preserved";
    }
    await Promise.all(panes.map(run => writeRecord(run)));
  }
  let reconciliation: void | Promise<void> = undefined;
  if (stillActive.length > 0 && deps.reconcileRunning) {
    try {
      reconciliation = deps.reconcileRunning(stillActive.filter(run => run.status !== "integrating" && run.status !== "completed"), event.reason);
    } catch {
      // best-effort — orphan sweep on next session_start picks up
      // anything we missed
    }
  }
  deps.resetSanitizer();
  try { await reconciliation; } catch { /* next startup retries best-effort reconciliation */ }
  for (const run of panes) run.herdrPipeline?.suspend();
  await Promise.all(panes.map(detachHerdrRun));
}

function detachHerdrRun(run: Run): Promise<void> {
  return run.herdrShutdown ??= (async () => {
    if (run.herdrPipeline) await run.herdrPipeline.quiesce();
    else if (run.transport?.kind === "herdr") await run.transport.detach?.();
    await run.recordWrite;
    run.herdrOwnership?.release();
  })();
}
