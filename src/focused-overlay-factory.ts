/**
 * Factory that builds a FocusedStreamOverlay from session-scoped
 * dependencies. Extracted from src/index.ts `openFocusedOverlay`'s
 * `.custom(...)` factory body so the wiring is testable without a
 * real ExtensionAPI runtime.
 *
 * Key invariant: this factory MUST NOT register any listener on the
 * RunRegistry. The previous in-line implementation registered a no-op
 * listener (its body was literally `void unsub;`) that was never
 * disposed, leaking one entry per overlay open. The overlay's own
 * invalidate / request-render plumbing (Component.invalidate, the TUI
 * scheduler) is sufficient for live re-renders. See the deleted code
 * block in `openFocusedOverlay` for the original (incorrect)
 * reasoning.
 */

import { FocusedStreamOverlay } from "./focused-stream-overlay.ts";
import type { FocusedStreamModel } from "./focused-stream-model.ts";
import type { RunRegistry, TerminationReason } from "./runs.ts";
import type { Run } from "./types.ts";

export interface FocusedOverlayFactoryDeps {
  /** The focus model the overlay reads from. */
  readonly model: FocusedStreamModel;
  /** Registry used to look up the targeted run on a kill request. */
  readonly registry: RunRegistry;
  /**
   * Termination function. Same signature as the exported
   * `forceTerminate` in runs.ts; injected here for testability.
   */
  readonly forceTerminate: (
    run: Run,
    reason: TerminationReason,
    registry: RunRegistry,
  ) => void;
  /**
   * Callback fired by the 's' send-keybinding. Mirrors the LLM-callable
   * ensemble_send tool but driven from the TUI. Wired to
   * `promptAndSendToRun` in index.ts.
   */
  readonly promptAndSendToRun: (agentId: string) => void;
  /**
   * The `done(value)` callback from `ctx.ui.custom(...)`. Calling it
   * tears down the overlay; the resulting promise from `custom()`
   * resolves with `value`.
   */
  readonly done: (value: undefined) => void;
}

export function createFocusedOverlayComponent(
  deps: FocusedOverlayFactoryDeps,
): FocusedStreamOverlay {
  return new FocusedStreamOverlay({
    model: deps.model,
    onClose: () => deps.done(undefined),
    onKill: (id: string) => {
      const run = deps.registry.get(id);
      if (run) deps.forceTerminate(run, "killed", deps.registry);
      // Refresh the model so the next render reflects the kill.
      deps.model.refresh();
    },
    onSend: (id: string) => {
      deps.promptAndSendToRun(id);
    },
  });
}
