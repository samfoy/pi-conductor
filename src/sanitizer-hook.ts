/**
 * Hook wiring for the v0.8.2 (B-4) `toolUse.name` sanitizer.
 *
 * Owns the session-scoped `warnedToolCallIds` dedup set so the same
 * sanitization on the same `toolCallId` doesn't spam logs across every
 * subsequent turn that re-runs the hook over the same wedged history.
 *
 * Extracted from `src/index.ts` so it can be exercised in
 * `tests/sanitizer-hook.test.ts` without booting the full extension
 * (which transitively imports `@earendil-works/pi-coding-agent`'s TUI
 * surface and isn't loadable from a `node:test` process).
 *
 * Mirrors the layering of `installFocusedOverlayShortcut`: small
 * pure-ish factory tested in isolation, wired once from
 * `src/index.ts`.
 *
 * Spec: ./design.md (designer-w2a5, oracle-eur8 PASS-WITH-NOTES revised).
 */

import { sanitizeToolNames, type SanitizeReport } from "./sanitizer.ts";

export interface InstallSanitizerHookOpts {
  /**
   * Returns the live `ExtensionContext` (or null if no UI / between
   * session lifecycle events). The hook calls `ctx.ui.notify(...)` on
   * each fresh sanitization for TUI surfacing.
   */
  getCtx: () => { ui: { notify: (msg: string, level: "warning") => void } } | null;
  /**
   * Override `console.warn` for tests. Defaults to the real `console.warn`.
   */
  warn?: (line: string) => void;
}

export interface InstalledSanitizerHook {
  /**
   * Clear the dedup set. Called from `session_shutdown` so a fresh
   * session re-warns about pre-existing wedges on its first turn.
   */
  reset: () => void;
}

/**
 * Register the sanitizer hook on `pi.on("context", …)`. Returns a small
 * handle whose `reset()` should be called from `session_shutdown` to
 * clear the dedup set.
 *
 * Design invariants pinned by `tests/sanitizer-hook.test.ts`:
 *   - Exactly ONE `pi.on("context", …)` handler is added per call.
 *   - Each invocation returns a `{ messages }` object whose array is
 *     the (possibly identical) sanitized payload — never undefined.
 *   - The same `toolCallId` warns at most once across turns until
 *     `reset()` is called.
 *   - Notify-throws are swallowed (stale ctx is non-fatal).
 */
export function installSanitizerHook(
  pi: { on: (event: "context", handler: any) => void },
  opts: InstallSanitizerHookOpts,
): InstalledSanitizerHook {
  const warnedToolCallIds = new Set<string>();
  const warn = opts.warn ?? ((line: string) => console.warn(line));

  pi.on("context", async (event: { messages: any[] }) => {
    const reports: SanitizeReport[] = [];
    const messages = sanitizeToolNames(event.messages, {
      onSanitize: (r) => reports.push(r),
    });
    for (const r of reports) {
      if (warnedToolCallIds.has(r.toolCallId)) continue;
      warnedToolCallIds.add(r.toolCallId);
      // JSON.stringify on the original preserves \n / \" / control chars
      // verbatim in the log line so the operator sees the byte-precise
      // wedge for debugging. The TUI notify omits the original (could
      // carry unprintables that mangle the renderer).
      warn(
        `[pi-conductor] sanitized malformed toolUse.name ${JSON.stringify(
          r.originalName,
        )} → ${r.sanitizedName} (id=${r.toolCallId})`,
      );
      const ctx = opts.getCtx();
      if (ctx) {
        try {
          ctx.ui.notify(
            `pi-conductor: sanitized malformed tool name → ${r.sanitizedName}`,
            "warning",
          );
        } catch {
          // ctx may have gone stale between the on("context") emit and now
        }
      }
    }
    return { messages };
  });

  return {
    reset: () => warnedToolCallIds.clear(),
  };
}
