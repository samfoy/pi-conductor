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

import type { Run } from "./types.ts";

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
}

/**
 * Apply the side effects of a `session_shutdown` event.
 *
 * On reload: no-op. Caller is still responsible for releasing
 * runtime-scoped UI handles (widget, terminal-input listeners) — those
 * are tied to the OLD `ctx` whether we reload or quit.
 *
 * Otherwise: SIGTERM every running/paused run (best-effort, throws
 * swallowed) and reset the sanitizer dedup set.
 */
export function handleSessionShutdown(
  event: ShutdownEventLike,
  deps: ShutdownDeps,
): void {
  if (event.reason === "reload") return;
  for (const r of deps.runs) {
    if (r.status === "running" || r.status === "paused") {
      try {
        r.proc?.kill("SIGTERM");
      } catch {
        // already dead — non-fatal
      }
    }
  }
  deps.resetSanitizer();
}
