/**
 * Ctrl+G focused-overlay shortcut, routed through ctx.ui.onTerminalInput.
 *
 * Pi reserves Ctrl+G as a built-in shortcut and silently drops the
 * conflicting extension binding at extension-load with a warning like:
 *
 *     Extension shortcut 'ctrl+g' from .../src/index.ts conflicts with
 *     built-in shortcut. Skipping.
 *
 * The same lesson was already learned for Esc — see the comment block
 * in src/index.ts and the registerForegroundDetach helper. We use the
 * same workaround here: subscribe to raw terminal input for the
 * lifetime of the session, intercept Ctrl+G, and return
 * `{ consume: true }` so pi's reserved handler doesn't also fire.
 *
 * Idempotent: when the focused-stream overlay is already open, the
 * keystroke is passed through (`return undefined`) so the overlay's
 * own bindings see it. This mirrors the overlayOpen guard in
 * registerForegroundDetach.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
  RerenderCoalescer,
  DEFAULT_RERENDER_WINDOW_MS,
  type CoalescerDeps,
} from "./rerender-coalescer.ts";

/** Raw terminal input handler shape (same as pi's TerminalInputHandler). */
export type TerminalInputHandler = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;

export interface FocusedOverlayShortcutCtx {
  readonly hasUI: boolean;
  readonly ui: {
    onTerminalInput(handler: TerminalInputHandler): () => void;
  };
}

export interface FocusedOverlayShortcutOptions {
  readonly openFocusedOverlay: () => void;
  /** Returns true while a focused-stream overlay is already open. */
  readonly isOverlayOpen: () => boolean;
  /**
   * Slice 11: optional installer for a RunRegistry-change subscription.
   * Called once at install time; the returned unsub fires once when
   * the shortcut's unsub fires. Use this to keep the focus model
   * fresh as runs mutate, without coupling the overlay's render() to
   * a refresh side effect.
   *
   * The shortcut is the right scope for this subscription because it
   * is session-scoped (installed in session_start, unsub'd in
   * session_shutdown), unlike the focused-overlay-factory which is
   * built afresh on every overlay open and must NOT register
   * listeners (see `focused-overlay-factory.ts` invariant comment).
   *
   * Headless contexts (hasUI=false) skip this entirely — there's no
   * overlay to render so nothing to keep fresh.
   */
  /**
   * Slice 11 + Slice 3 (overlay redesign): the shortcut owns a
   * RerenderCoalescer whose `schedule()` is exposed to this callback
   * as `scheduleRender`. Production wires this to:
   *
   *   subscribeToRegistry: (scheduleRender) =>
   *     registry.onChange(() => {
   *       focusModel.refresh();
   *       scheduleRender();
   *     });
   *
   * Owning the coalescer here (not at the callsite) means re-opening
   * the overlay does NOT stack coalescers, mirroring the rule that
   * the overlay factory MUST NOT register listeners (see
   * focused-overlay-factory.ts invariant comment).
   *
   * The `scheduleRender` parameter is optional from the consumer's
   * point of view — older zero-arg implementations remain compatible
   * via TypeScript's contravariant function parameter rule.
   */
  readonly subscribeToRegistry?: (scheduleRender: () => void) => () => void;
  /**
   * Slice 3 (overlay redesign): render trigger called by the
   * coalescer. Production: `() => tui.requestRender()`. When omitted
   * (e.g. headless tests, or the slice 11 baseline before slice 3),
   * `scheduleRender` becomes a no-op so existing wiring keeps
   * working.
   */
  readonly requestRender?: () => void;
  /**
   * Slice 3 (overlay redesign): coalescer window in milliseconds.
   * Defaults to {@link DEFAULT_RERENDER_WINDOW_MS} (50ms) — the
   * design-locked window. Tests inject smaller/larger values via
   * this knob; production accepts the default.
   */
  readonly rerenderWindowMs?: number;
  /**
   * Slice 3 (overlay redesign): test-only injection point for the
   * coalescer's clock + timer primitives. Production omits this and
   * the coalescer falls back to `Date.now`/`globalThis.setTimeout`.
   */
  readonly coalescerDeps?: CoalescerDeps;
  /**
   * Slice 1 (overlay redesign): terminal-size source consulted at
   * keystroke time to decide whether the terminal is large enough to
   * host the overlay. When omitted, the threshold is skipped (overlay
   * always opens). When supplied AND `notify` is supplied, the helper
   * declines to open the overlay (and notifies the user) when the
   * terminal is below the locked 80×20 minimum.
   *
   * Production wires this to `process.stdout.columns/rows` (the TUI
   * instance is not exposed on `ExtensionAPI`/`ExtensionUIContext`
   * outside `custom`/`setWidget` factory bodies). The threshold is
   * encoded inside this helper so callers cannot drift.
   */
  readonly getTerminalSize?: () => { columns: number; rows: number };
  /**
   * Slice 1 (overlay redesign): notify callback used when declining
   * the overlay due to insufficient terminal size. Wired to
   * `ctx.ui.notify` in production.
   */
  readonly notify?: (
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
}

// Slice 1 (overlay redesign): minimum terminal size for the focused
// overlay. Locked to 80×20 by user decision (oracle review of design
// preferred this over the designer's 70×18 proposal as it matches the
// Brazil terminal default and the chrome math: header 4 + footer 3 +
// min body 6 + margin 2 = 15 rows, leaving 5 rows of slack at 20).
const MIN_COLUMNS = 80;
const MIN_ROWS = 20;
const TOO_SMALL_MESSAGE = `Focused overlay needs ≥${MIN_COLUMNS}×${MIN_ROWS} terminal`;

/**
 * Wire a session-scoped Ctrl+G handler. Returns an idempotent unsub
 * function — call it from session_shutdown (and any other teardown
 * path) to stop listening.
 *
 * Headless contexts (hasUI=false, e.g. RPC mode) get a no-op unsub —
 * the shortcut simply has no effect there, which is the correct
 * behavior since there's no TUI to overlay onto.
 */
export function installFocusedOverlayShortcut(
  ctx: FocusedOverlayShortcutCtx,
  options: FocusedOverlayShortcutOptions,
): () => void {
  if (!ctx.hasUI) {
    return () => {};
  }
  // Slice 3 (overlay redesign): own a single coalescer for the
  // session. The shortcut hands its `schedule()` to subscribeToRegistry
  // so the consumer can fire it from the registry change callback
  // without each callsite needing to know about coalescing.
  // Component.invalidate() in src/focused-stream-overlay.ts remains a
  // no-op for now (no per-component cache yet) — slice 6's chrome
  // rewrite is where invalidate() must clear caches per design §10.
  const coalescer: RerenderCoalescer | null = options.requestRender
    ? new RerenderCoalescer(
        options.requestRender,
        options.rerenderWindowMs ?? DEFAULT_RERENDER_WINDOW_MS,
        options.coalescerDeps,
      )
    : null;
  const scheduleRender: () => void = coalescer
    ? () => coalescer.schedule()
    : () => {};
  let unsubInput: (() => void) | null = ctx.ui.onTerminalInput((data) => {
    // Don't hijack Ctrl+G when an overlay is already open — let the
    // overlay's own bindings see the keystroke.
    if (options.isOverlayOpen()) return undefined;
    if (matchesKey(data, Key.ctrl("g"))) {
      // Slice 1 (overlay redesign): too-small-terminal guard. When the
      // caller supplied both `getTerminalSize` and `notify`, refuse to
      // open the overlay below the locked 80×20 minimum and notify
      // the user instead. We still consume the keystroke so pi's
      // built-in Ctrl+G handler doesn't also fire — the user already
      // got an explanation.
      const size = options.getTerminalSize?.();
      if (
        size &&
        options.notify &&
        (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS)
      ) {
        options.notify(TOO_SMALL_MESSAGE, "warning");
        return { consume: true };
      }
      options.openFocusedOverlay();
      return { consume: true };
    }
    return undefined;
  });
  // Slice 11: register the registry-change subscription here so the
  // focus model stays fresh as runs mutate. Doing it in the shortcut
  // (session-scoped, idempotent unsub) instead of the overlay factory
  // (built per-open, MUST NOT register listeners — see
  // focused-overlay-factory.ts) means re-opening the overlay does NOT
  // stack listeners on the registry. See docs/v0.8.3-item3-plan.md §A8.
  let unsubRegistry: (() => void) | null = options.subscribeToRegistry
    ? options.subscribeToRegistry(scheduleRender)
    : null;
  return () => {
    if (unsubInput) {
      unsubInput();
      unsubInput = null;
    }
    if (unsubRegistry) {
      unsubRegistry();
      unsubRegistry = null;
    }
    // Cancel any pending trailing-edge render so a post-shutdown
    // stray fire can't land on a torn-down TUI.
    if (coalescer) coalescer.cancel();
  };
}
