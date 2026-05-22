/**
 * Slice 7 (overlay redesign): InputPane unit tests.
 *
 * The InputPane wraps a multi-line Editor inside the focused-stream
 * overlay's body zone. It owns its separator row (top) and hint row
 * (bottom) so opening/closing is atomic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InputPane, INPUT_PANE_ROWS, type EditorLike } from "../src/input-pane.ts";

function makeFakeEditor(initial = ""): EditorLike & {
  inputs: string[];
  invalidated: number;
  focusedHistory: boolean[];
} {
  let text = initial;
  const inputs: string[] = [];
  let invalidated = 0;
  const focusedHistory: boolean[] = [];
  return {
    get focused() {
      return focusedHistory.length === 0 ? false : focusedHistory[focusedHistory.length - 1]!;
    },
    set focused(v: boolean) {
      focusedHistory.push(v);
    },
    inputs,
    get invalidated() {
      return invalidated;
    },
    focusedHistory,
    getText(): string {
      return text;
    },
    setText(t: string): void {
      text = t;
    },
    invalidate(): void {
      invalidated += 1;
    },
    handleInput(d: string): void {
      inputs.push(d);
    },
    render(_w: number): string[] {
      return [`<editor:${text}>`];
    },
  };
}

test("InputPane: renders separator + prompt + Editor + hint", () => {
  const editor = makeFakeEditor("hi");
  const pane = new InputPane({ editor, onSubmit: () => {}, onClose: () => {} });
  const lines = pane.render(20);
  // Spec: 6 rows (separator + 4 editor + hint).
  assert.equal(lines.length, INPUT_PANE_ROWS);
  assert.equal(INPUT_PANE_ROWS, 6);
  // Row 0: separator (─-class glyph).
  assert.match(lines[0]!, /─/);
  // Editor content visible somewhere in the middle rows.
  assert.ok(lines.slice(1, 5).some((l) => l.includes("<editor:hi>")), `editor row missing: ${JSON.stringify(lines)}`);
  // Last row: hint contains Enter / Esc.
  assert.match(lines[lines.length - 1]!, /Enter/);
  assert.match(lines[lines.length - 1]!, /Esc/);
});

test("InputPane: Esc closes pane and restores focus", () => {
  const editor = makeFakeEditor();
  let closed = 0;
  const pane = new InputPane({ editor, onSubmit: () => {}, onClose: () => { closed += 1; } });
  pane.focused = true;
  pane.handleInput("\x1b");
  assert.equal(closed, 1);
  // Editor should NOT have received the Esc.
  assert.deepEqual(editor.inputs, []);
});

test("InputPane: Enter submits buffer then closes", () => {
  const editor = makeFakeEditor("hello world");
  let submitted: string | null = null;
  let closed = 0;
  const pane = new InputPane({
    editor,
    onSubmit: (t) => { submitted = t; },
    onClose: () => { closed += 1; },
  });
  pane.handleInput("\r");
  assert.equal(submitted, "hello world");
  assert.equal(closed, 1);
});

test("InputPane: Ctrl-Enter inserts newline (Editor passthrough)", () => {
  const editor = makeFakeEditor("a");
  let submitted: string | null = null;
  let closed = 0;
  const pane = new InputPane({
    editor,
    onSubmit: (t) => { submitted = t; },
    onClose: () => { closed += 1; },
  });
  // Ctrl-Enter (alt-enter style) — passthrough to Editor; NOT a submit.
  pane.handleInput("\x1b\r");
  assert.equal(submitted, null);
  assert.equal(closed, 0);
  assert.deepEqual(editor.inputs, ["\x1b\r"]);
});

test("InputPane: whitespace-only Enter no-ops then closes", () => {
  const editor = makeFakeEditor("   \t  ");
  let submitted: string | null = null;
  let closed = 0;
  const pane = new InputPane({
    editor,
    onSubmit: (t) => { submitted = t; },
    onClose: () => { closed += 1; },
  });
  pane.handleInput("\r");
  assert.equal(submitted, null, "whitespace-only must not submit");
  assert.equal(closed, 1, "still closes the pane");
});

test("InputPane: pane disposed on overlay close (no leak)", () => {
  const editor = makeFakeEditor("x");
  const pane = new InputPane({ editor, onSubmit: () => {}, onClose: () => {} });
  pane.focused = true;
  pane.dispose();
  // After dispose: handleInput is a no-op (editor MUST NOT receive further keys).
  pane.handleInput("a");
  assert.deepEqual(editor.inputs, [], "no input forwarded after dispose");
  // Editor invalidated at least once on dispose so any internal timers/state release.
  assert.ok(editor.invalidated >= 1, `editor invalidated on dispose; got ${editor.invalidated}`);
  // Focus released.
  assert.equal(pane.focused, false);
});
