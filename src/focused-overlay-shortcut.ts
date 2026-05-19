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
  readonly subscribeToRegistry?: () => () => void;
}

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
  let unsubInput: (() => void) | null = ctx.ui.onTerminalInput((data) => {
    // Don't hijack Ctrl+G when an overlay is already open — let the
    // overlay's own bindings see the keystroke.
    if (options.isOverlayOpen()) return undefined;
    if (matchesKey(data, Key.ctrl("g"))) {
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
    ? options.subscribeToRegistry()
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
  };
}
