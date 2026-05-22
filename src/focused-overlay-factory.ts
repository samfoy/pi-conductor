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
import type { ThemeFg } from "./transcript-style.ts";

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
  /**
   * Slice 7: theme used by the overlay to colour rendered output. The
   * factory forwards this verbatim to the overlay's options. When omitted
   * (e.g. headless tests of the factory), the overlay returns plain
   * lines.
   */
  readonly theme?: ThemeFg;
  /**
   * Slice 1 (overlay redesign): viewport-height source forwarded to
   * the overlay's existing `getViewportHeight` slot. Production wires
   * this to `tui.terminal.rows` (TUI instance is in scope inside
   * `ctx.ui.custom`'s factory body) with `process.stdout.rows` as a
   * non-TTY fallback. Pre-slice the factory dropped this on the floor,
   * making `renderScrollHint` and `renderEmpty` centring dead code in
   * production. See docs/focused-overlay-redesign-plan.md §Slice 1.
   */
  readonly getViewportHeight?: () => number;
}

export function createFocusedOverlayComponent(
  deps: FocusedOverlayFactoryDeps,
): FocusedStreamOverlay {
  const overlay = new FocusedStreamOverlay({
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
    theme: deps.theme,
    getViewportHeight: deps.getViewportHeight,
  });

  // Slice 4 (overlay redesign): wire the live viewport-metrics closure
  // onto the model so `scrollDown` clamps at the renderable bottom and
  // `stickToTail` can latch. We compute `bodyRows` from the host's
  // injected `getViewportHeight()` (production: `tui.terminal.rows`)
  // less a CHROME_ROWS budget covering header (2) + footer (2) +
  // optional scroll hint (1). Slice 6's chrome rewrite will replace
  // this constant with computed zone heights.
  //
  // `transcriptLength` reads the overlay's render-side cache. Pre
  // first render the cache is 0 — which yields `bottom = 0` and the
  // model treats the agent as fully visible (no scroll needed). Once
  // the host renders, the closure picks up the real value.
  const CHROME_ROWS = 5;
  deps.model.setMetricsSource(() => {
    const viewport = deps.getViewportHeight?.() ?? 0;
    return {
      bodyRows: Math.max(0, viewport - CHROME_ROWS),
      transcriptLength: overlay.getTranscriptLength(),
    };
  });

  return overlay;
}
