/**
 * Slice 7 (overlay redesign): InputPane.
 *
 * A thin Container-style component that hosts a multi-line `Editor`
 * inside the focused-stream overlay's body zone. The pane owns its
 * own separator (top) and hint (bottom) rows so opening / closing is
 * atomic with respect to the surrounding chrome.
 *
 * Sizing contract (design §9):
 *   row 0       — separator
 *   rows 1..4   — Editor (capped at 4 visible rows)
 *   row 5       — hint
 * Total = INPUT_PANE_ROWS = 6.
 *
 * Input dispatch:
 *   Esc            → onClose(); editor never sees it
 *   Enter (\r/\n)  → if buffer non-empty after trim → onSubmit(trimmed); always onClose()
 *   anything else  → editor.handleInput(data) (Ctrl-Enter / Alt-Enter
 *                    sequences fall through here so the Editor can
 *                    insert a newline per its own bindings)
 *
 * Tested against a fake editor (see tests/input-pane.test.ts);
 * production wires a real `@earendil-works/pi-tui` Editor instance.
 */

import type { Component, Focusable } from "@earendil-works/pi-tui";

/** Total rows owned by the pane: separator + 4 editor rows + hint. */
export const INPUT_PANE_ROWS = 6;
const EDITOR_ROWS = 4;
const SEPARATOR_CHAR = "─";
const HINT_TEXT = "Esc:cancel · Enter:send · Ctrl-Enter:newline";

/**
 * Minimal slice of `pi-tui`'s `Editor` that the InputPane needs. Keeps
 * this module testable without instantiating a real TUI / theme.
 */
export interface EditorLike extends Component, Focusable {
  getText(): string;
  setText(text: string): void;
  invalidate(): void;
  handleInput(data: string): void;
}

export interface ThemeFgLike {
  fg(slot: string, text: string): string;
}

export interface InputPaneOptions {
  readonly editor: EditorLike;
  readonly onSubmit: (text: string) => void;
  readonly onClose: () => void;
  readonly theme?: ThemeFgLike;
}

export class InputPane implements Component, Focusable {
  private _focused = false;
  private _disposed = false;

  constructor(private readonly opts: InputPaneOptions) {}

  /**
   * Focusable: propagate focused-state to the inner editor so its
   * cursor marker (used for IME positioning per docs/tui.md:64-82)
   * paints correctly.
   */
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.opts.editor.focused = v;
  }

  render(width: number): string[] {
    const sepGlyph = this.opts.theme
      ? this.opts.theme.fg("border", SEPARATOR_CHAR.repeat(Math.max(0, width)))
      : SEPARATOR_CHAR.repeat(Math.max(0, width));
    const editorRaw = this.opts.editor.render(width);
    const editorRows: string[] = editorRaw.slice(0, EDITOR_ROWS);
    while (editorRows.length < EDITOR_ROWS) editorRows.push("");
    const hint = this.opts.theme ? this.opts.theme.fg("dim", HINT_TEXT) : HINT_TEXT;
    return [sepGlyph, ...editorRows, hint];
  }

  invalidate(): void {
    this.opts.editor.invalidate();
  }

  handleInput(data: string): void {
    if (this._disposed) return;
    // Esc → cancel.
    if (data === "\x1b") {
      this.opts.onClose();
      return;
    }
    // Plain Enter (CR or LF) → submit, then close.
    // Ctrl-Enter / Alt-Enter sequences (e.g. "\x1b\r", "\x1b\n") fall
    // through to the editor and are NOT matched here.
    if (data === "\r" || data === "\n") {
      const buf = this.opts.editor.getText();
      const trimmed = buf.trim();
      if (trimmed.length > 0) this.opts.onSubmit(trimmed);
      this.opts.onClose();
      return;
    }
    // Everything else → editor passthrough.
    this.opts.editor.handleInput(data);
  }

  /**
   * Release any state the pane is holding so closing the overlay
   * cannot leak listeners. After `dispose()` the pane is inert:
   * `handleInput` is a no-op and `focused=false` is propagated to
   * the underlying editor.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.opts.editor.focused = false;
    this._focused = false;
    this.opts.editor.invalidate();
  }
}
