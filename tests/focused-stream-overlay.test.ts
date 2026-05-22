/**
 * Tests for the FocusedStreamOverlay Component layer.
 *
 * Most of the logic is in transcript.ts (rendering) and
 * focused-stream-model.ts (state). These tests verify the thin Component
 * wiring: handleInput dispatches to the right model methods, and render
 * produces lines from the model's current view.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FocusedStreamOverlay } from "../src/focused-stream-overlay.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import type { ThemeFg } from "../src/transcript-style.ts";

function makeRun(id: string): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
  };
}

function setup(): { reg: RunRegistry; model: FocusedStreamModel; overlay: FocusedStreamOverlay; closed: boolean } {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  reg.register(makeRun("b-2"));
  const model = new FocusedStreamModel(reg);
  let closed = false;
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {
      closed = true;
    },
    onKill: () => {},
  });
  return {
    reg,
    model,
    overlay,
    get closed() {
      return closed;
    },
  } as any;
}

// ── render ────────────────────────────────────────────────────────────

test("FocusedStreamOverlay.render: returns a header + (empty) transcript + footer for a fresh run", () => {
  const { overlay } = setup();
  const lines = overlay.render(80);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 4, "expected header + footer at minimum");
  // Header should mention the focused persona.
  const joined = lines.join("\n");
  assert.match(joined, /a-1|b-2/);
  // Footer should mention Esc.
  assert.match(joined, /Esc/);
});

test("FocusedStreamOverlay.render: empty registry shows a placeholder", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const lines = overlay.render(80);
  const joined = lines.join("\n");
  assert.match(joined, /no sub-agents/i);
});

// ── Slice 10: empty-state polish (O4) ───────────────────────────────────
// Slice 6 (overlay redesign) updated this to expect bordered chrome:
// the footer row sequence is now mid-rule + hint + bottom-border, and
// the body content sits inside side-walled rows. Pure `─{3,}` rulers
// no longer appear in the rendered output — they were replaced by
// `─`-with-corner glyphs (╭───╮ / ├───┤ / ╰───╯).

test("empty state: bottom border on last line + no pure rulers in body (chrome supplies all rules)", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 30,
  });
  const lines = overlay.render(80);
  // Last line is the bottom border.
  assert.match(lines[lines.length - 1]!, /^╰─+╯$/);
  // Body slice (between header and footer chrome): no pure `─+` line.
  const HEADER_ROWS = 4, FOOTER_ROWS = 3;
  const body = lines.slice(HEADER_ROWS, lines.length - FOOTER_ROWS);
  for (const line of body) {
    assert.equal(
      /^─{3,}$/.test(line),
      false,
      `unexpected pure ruler in empty-state body: ${JSON.stringify(line)}`,
    );
  }
});

test("empty state: heading styled muted, prose styled dim when theme is set", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const stub: ThemeFg = {
    fg: (slot, text) => `[${slot}]${text}[/]`,
  };
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    theme: stub,
  });
  const joined = overlay.render(80).join("\n");
  // Heading routed through `muted`.
  assert.match(joined, /\[muted\]\(no sub-agents running\)\[\/\]/);
  // Prose routed through `dim`.
  assert.match(joined, /\[dim\]Spawn one via ensemble_spawn[^[]*\[\/\]/);
  // Heading and prose use distinct slots (sanity — no muted-then-dim or
  // vice-versa overlap on the same content).
  assert.equal(joined.includes("[muted]Spawn"), false);
  assert.equal(joined.includes("[dim](no sub-agents"), false);
});

test("empty state: at viewport=20, heading lands inside body zone (loose: not in header chrome)", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 20,
  });
  const lines = overlay.render(80);
  const headingIdx = lines.findIndex((l) => l.includes("(no sub-agents running)"));
  // With viewport=20 and chrome HEADER=4, FOOTER=3, body occupies
  // rows 4..16 (13 rows). The heading must land inside that band
  // and roughly mid-body — budget = 13-3=10, topPad = max(1, 5) = 5,
  // absolute idx = 4 + 5 = 9.
  assert.ok(headingIdx >= 4 && headingIdx <= 16, `headingIdx=${headingIdx}`);
  assert.ok(headingIdx >= 7 && headingIdx <= 12, `expected near-mid body, got ${headingIdx}`);
});

test("empty state: total chrome rows == viewport (default fallback DEFAULT_VIEWPORT_ROWS=24)", () => {
  // Slice 6 (overlay redesign): with no `getViewportHeight` wired the
  // overlay falls back to a 24-row default and produces exactly that
  // many rows of bordered chrome — 4 header + 17 body + 3 footer.
  // Replaces the prior "body line count reduced vs pre-slice" sanity
  // check, which was a slice-10 artefact: body geometry is now driven
  // by the chrome budget rather than by the empty-state renderer.
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const lines = overlay.render(80);
  assert.equal(lines.length, 24);
  assert.match(lines[0]!, /^╭─+╮$/);
  assert.match(lines[lines.length - 1]!, /^╰─+╯$/);
});

test("FocusedStreamOverlay.render: lines never exceed the requested width", () => {
  const { overlay } = setup();
  const lines = overlay.render(40);
  for (const line of lines) {
    // Use visibleWidth (matches pi-tui's renderer) so this test stays
    // robust to any future ANSI styling — plain `.length` would count
    // ANSI escape bytes against the budget incorrectly.
    assert.ok(
      visibleWidth(line) <= 40,
      `line too long (${visibleWidth(line)}): "${line}"`,
    );
  }
});

// ── Slice 7: theme integration ────────────────────────────────────────

test("FocusedStreamOverlay.render: applies theme via classify+applyTheme when provided", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  // Sentinel-stub theme — wraps text in `[<slot>]…[/]` so we can assert
  // which slot the overlay routed each line through.
  const stub: ThemeFg = {
    fg: (slot, text) => `[${slot}]${text}[/]`,
  };
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    theme: stub,
  });
  const lines = overlay.render(80);
  const joined = lines.join("\n");
  // Header status row carries the running-status accent slot.
  assert.match(joined, /\[accent\][^[]*a-1[^[]*\[\/\]/);
  // Slice 6: chrome borders are themed via the `border` slot (not the
  // older `borderMuted` ruler slot which only applied to in-body rules).
  // Top border line goes through that slot.
  assert.match(joined, /\[border\]╭─+╮\[\/\]/);
  // Footer hint row styles each binding's key glyph with the accent slot.
  assert.match(joined, /\[accent\]Esc\[\/\] close/);
});

test("FocusedStreamOverlay.render: omitting theme returns plain (ANSI-free) lines", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    // theme intentionally omitted
  });
  const lines = overlay.render(80);
  for (const line of lines) {
    assert.equal(line.includes("\x1b["), false, `unexpected ANSI in: ${line}`);
  }
});

test("FocusedStreamOverlay.render: completed run colours header via success slot", () => {
  const reg = new RunRegistry();
  const completed = makeRun("a-1");
  completed.status = "completed";
  completed.finishedAt = Date.now();
  reg.register(completed);
  const model = new FocusedStreamModel(reg);
  const stub: ThemeFg = {
    fg: (slot, text) => `[${slot}]${text}[/]`,
  };
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    theme: stub,
  });
  const joined = overlay.render(80).join("\n");
  // Header for a completed run uses the success slot.
  assert.match(joined, /\[success\][^[]*completed[^[]*\[\/\]/);
});

// ── handleInput → model dispatch ──────────────────────────────────────

test("FocusedStreamOverlay.handleInput: Tab cycles to next agent", () => {
  const { overlay, model } = setup();
  model.focus("a-1");
  overlay.handleInput("\t"); // raw tab
  assert.equal(model.focused()?.id, "b-2");
});

test("FocusedStreamOverlay.handleInput: Esc fires onClose", () => {
  let closeCount = 0;
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {
      closeCount += 1;
    },
    onKill: () => {},
  });
  overlay.handleInput("\x1b"); // ESC
  assert.equal(closeCount, 1);
});

test("FocusedStreamOverlay.handleInput: 'c' toggles tool-call collapse", () => {
  const { overlay, model } = setup();
  const before = model.collapseToolCalls();
  overlay.handleInput("c");
  assert.notEqual(model.collapseToolCalls(), before);
});

test("FocusedStreamOverlay.handleInput: 't' toggles thinking visibility", () => {
  const { overlay, model } = setup();
  const before = model.showThinking();
  overlay.handleInput("t");
  assert.notEqual(model.showThinking(), before);
});

test("FocusedStreamOverlay.handleInput: arrow-down / arrow-up scroll the transcript", () => {
  const { overlay, model } = setup();
  model.focus("a-1");
  overlay.handleInput("\x1b[B"); // ESC[B = down arrow
  overlay.handleInput("\x1b[B");
  assert.equal(model.scrollOffset() > 0, true, "expected scroll offset > 0");
  overlay.handleInput("\x1b[A"); // ESC[A = up arrow
  // After two downs and one up, offset is non-zero but smaller.
  assert.ok(model.scrollOffset() < 2);
});

test("FocusedStreamOverlay.handleInput: 'k' fires onKill with focused agent id", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const killed: string[] = [];
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: (id: string) => killed.push(id),
  });
  model.focus("a-1");
  overlay.handleInput("k");
  assert.deepEqual(killed, ["a-1"]);
});

test("FocusedStreamOverlay.handleInput: 's' fires onSend with focused agent id", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const sends: string[] = [];
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: (id: string) => sends.push(id),
  });
  model.focus("a-1");
  overlay.handleInput("s");
  assert.deepEqual(sends, ["a-1"]);
});

test("FocusedStreamOverlay.handleInput: 's' is a no-op when onSend is not provided", () => {
  // Should not throw and should not move state.
  const { overlay, model } = setup();
  const focused = model.focused()?.id;
  overlay.handleInput("s");
  assert.equal(model.focused()?.id, focused);
});

test("FocusedStreamOverlay.handleInput: 's' is a no-op when no agent is focused", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const sends: string[] = [];
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: (id: string) => sends.push(id),
  });
  overlay.handleInput("s");
  assert.deepEqual(sends, []);
});

test("FocusedStreamOverlay.handleInput: unknown keys are no-ops", () => {
  const { overlay, model } = setup();
  const before = {
    focused: model.focused()?.id,
    collapse: model.collapseToolCalls(),
    thinking: model.showThinking(),
    scroll: model.scrollOffset(),
  };
  overlay.handleInput("z");
  overlay.handleInput("Z");
  overlay.handleInput("\x1bz");
  assert.deepEqual(
    {
      focused: model.focused()?.id,
      collapse: model.collapseToolCalls(),
      thinking: model.showThinking(),
      scroll: model.scrollOffset(),
    },
    before,
  );
});

// ── Slice 11: render purity + refresh-on-keystroke ────────────────────
//
// Pre-Slice-11, FocusedStreamOverlay.render() called model.refresh() as
// a side effect. That made render impure (a re-render shifted focus to
// the most recently started run when registry contents changed) AND
// pushed responsibility for "keep the model fresh" into the wrong
// layer. Slice 11 moves refresh to:
//   1. handleInput dispatch (every key press refreshes once before
//      dispatch), and
//   2. installFocusedOverlayShortcut's RunRegistry subscription
//      (covered in tests/focused-overlay-shortcut.test.ts).
//
// See docs/v0.8.3-item3-plan.md "### Slice 11" + design row O6.

test("FocusedStreamOverlay.render: does NOT call model.refresh (Slice 11 purity)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  let refreshCalls = 0;
  // Spy on refresh by replacing the bound method.
  const realRefresh = model.refresh.bind(model);
  (model as any).refresh = () => {
    refreshCalls += 1;
    realRefresh();
  };
  // Construction + setup may have called refresh; reset the counter
  // so we measure only what render() does.
  refreshCalls = 0;
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  overlay.render(80);
  overlay.render(80);
  overlay.render(80);
  assert.equal(
    refreshCalls,
    0,
    "render() must be a pure projection — no model.refresh() side effects",
  );
});

test("FocusedStreamOverlay.handleInput: calls model.refresh exactly once before dispatching", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  reg.register(makeRun("b-2"));
  const model = new FocusedStreamModel(reg);
  let refreshCalls = 0;
  let cycleCalls = 0;
  const realRefresh = model.refresh.bind(model);
  (model as any).refresh = () => {
    refreshCalls += 1;
    realRefresh();
  };
  const realCycleNext = model.cycleNext.bind(model);
  (model as any).cycleNext = () => {
    // Refresh must have been called BEFORE we get here so the dispatch
    // sees the fresh registry view.
    assert.ok(refreshCalls >= 1, "model.refresh must run before keystroke dispatch");
    cycleCalls += 1;
    realCycleNext();
  };
  refreshCalls = 0;
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  overlay.handleInput("\t");
  assert.equal(refreshCalls, 1, "refresh fires exactly once per keystroke");
  assert.equal(cycleCalls, 1, "dispatch still fires after refresh");
});

test(
  "FocusedStreamOverlay.handleInput: refresh fires even for unknown keys (defensive)",
  () => {
    const reg = new RunRegistry();
    reg.register(makeRun("a-1"));
    const model = new FocusedStreamModel(reg);
    let refreshCalls = 0;
    const realRefresh = model.refresh.bind(model);
    (model as any).refresh = () => {
      refreshCalls += 1;
      realRefresh();
    };
    refreshCalls = 0;
    const overlay = new FocusedStreamOverlay({
      model,
      onClose: () => {},
      onKill: () => {},
    });
    overlay.handleInput("z");
    overlay.handleInput("\x1bz");
    // Two keystrokes, two refreshes — independent of whether they
    // matched a binding. Keeping refresh unconditional avoids a drift
    // case where the registry mutated between renders and the user
    // pressed a binding that depends on the freshest list.
    assert.equal(refreshCalls, 2);
  },
);

// ── Slice 6: invalidate() clears the render cache ───────────────────────
//
// Per design §10, the overlay's render cache is the single mutation
// surface introduced by the chrome rewrite. The cache is written
// inside `render()` only and cleared inside `invalidate()` only.
// `getTranscriptLength()` reads from the cache; tests for the
// model's `getMetrics` closure (factory tests) depend on this
// contract.

test("invalidate() clears the slice cache (transcriptLength resets to 0)", () => {
  const reg = new RunRegistry();
  const longMessages: any[] = [];
  for (let i = 0; i < 50; i++) {
    longMessages.push({
      role: "assistant",
      content: [{ type: "text", text: `body line ${i}` }],
    });
  }
  reg.register({
    ...makeRun("a-1"),
    messages: longMessages,
  });
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });

  // Pre-render: cache empty, transcriptLength reports 0.
  assert.equal(overlay.getTranscriptLength(), 0, "pre-render cache is empty");

  // Render once — cache populates with the actual transcript line
  // count.
  overlay.render(80);
  const firstLength = overlay.getTranscriptLength();
  assert.ok(firstLength > 0, `expected populated cache after first render, got ${firstLength}`);

  // Invalidate — cache must be cleared back to its empty state. Read
  // the getter again WITHOUT re-rendering; the value must be 0 again.
  overlay.invalidate();
  assert.equal(
    overlay.getTranscriptLength(),
    0,
    "invalidate() must clear the slice cache so getTranscriptLength reports 0",
  );

  // Sanity: after a second render the cache rehydrates.
  overlay.render(80);
  assert.equal(
    overlay.getTranscriptLength(),
    firstLength,
    "cache rehydrates on the next render",
  );

  // Idempotent across consecutive invalidate calls.
  overlay.invalidate();
  overlay.invalidate();
  assert.equal(overlay.getTranscriptLength(), 0);
});

// ── Slice 4: Home/End/g/G key bindings ─────────────────────────
//
// `Home`/`g` jumps the offset to 0 and un-latches stickToTail.
// `End`/`G` snaps the offset to the renderable bottom and latches
// stickToTail. `Component.handleInput`'s signature is unchanged — the
// model reads the viewport via its injected `getMetrics` closure.

function setupWithMetrics(
  metrics: () => { bodyRows: number; transcriptLength: number },
): { reg: RunRegistry; model: FocusedStreamModel; overlay: FocusedStreamOverlay } {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg, { getMetrics: metrics });
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  return { reg, model, overlay };
}

test("FocusedStreamOverlay.handleInput: Home key dispatches model.scrollUp to top", () => {
  const { model, overlay } = setupWithMetrics(() => ({ bodyRows: 10, transcriptLength: 50 }));
  model.jumpToTail();
  assert.equal(model.scrollOffset(), 40);
  // xterm Home: ESC [ H
  overlay.handleInput("\x1b[H");
  assert.equal(model.scrollOffset(), 0, "Home resets offset to 0");
  assert.equal(model.stickToTail(), false, "Home un-latches");
});

test("FocusedStreamOverlay.handleInput: End key dispatches model.jumpToTail", () => {
  const { model, overlay } = setupWithMetrics(() => ({ bodyRows: 10, transcriptLength: 50 }));
  assert.equal(model.scrollOffset(), 0);
  // xterm End: ESC [ F
  overlay.handleInput("\x1b[F");
  assert.equal(model.scrollOffset(), 40, "End snaps to bottom");
  assert.equal(model.stickToTail(), true, "End latches stickToTail");
});

test("FocusedStreamOverlay.handleInput: g/G shortcuts mirror Home/End", () => {
  const a = setupWithMetrics(() => ({ bodyRows: 10, transcriptLength: 50 }));
  a.model.jumpToTail();
  a.overlay.handleInput("g");
  assert.equal(a.model.scrollOffset(), 0, "g mirrors Home");
  assert.equal(a.model.stickToTail(), false);
  const b = setupWithMetrics(() => ({ bodyRows: 10, transcriptLength: 50 }));
  b.overlay.handleInput("G");
  assert.equal(b.model.scrollOffset(), 40, "G mirrors End");
  assert.equal(b.model.stickToTail(), true);
});

// ── Slice 7: input pane wiring ─────────────────────────────────

import { InputPane, type EditorLike } from "../src/input-pane.ts";

function makeFakeEditor(initial = ""): EditorLike & { inputs: string[] } {
  let text = initial;
  const inputs: string[] = [];
  let _focused = false;
  return {
    get focused() { return _focused; },
    set focused(v: boolean) { _focused = v; },
    inputs,
    getText(): string { return text; },
    setText(t: string): void { text = t; },
    invalidate(): void {},
    handleInput(d: string): void { inputs.push(d); },
    render(_w: number): string[] { return [`<editor:${text}>`]; },
  };
}

function setupWithInputPane(): {
  reg: RunRegistry;
  model: FocusedStreamModel;
  overlay: FocusedStreamOverlay;
  editor: ReturnType<typeof makeFakeEditor>;
  inputPane: InputPane;
  submitted: { id: string | null; text: string | null };
} {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg, {
    getMetrics: () => ({ bodyRows: 20, transcriptLength: 100 }),
  });
  const editor = makeFakeEditor();
  const submitted: { id: string | null; text: string | null } = { id: null, text: null };
  const inputPane = new InputPane({
    editor,
    onSubmit: (t) => {
      const f = model.focused();
      submitted.id = f?.id ?? null;
      submitted.text = t;
    },
    onClose: () => model.closeInputPane(),
  });
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    inputPane,
  });
  return { reg, model, overlay, editor, inputPane, submitted };
}

test("FocusedStreamOverlay: s key opens pane in default mode", () => {
  const { model, overlay } = setupWithInputPane();
  assert.equal(model.inputPaneOpen(), false);
  overlay.handleInput("s");
  assert.equal(model.inputPaneOpen(), true);
});

test("FocusedStreamOverlay: s key is consumed by Editor when pane open (no second open)", () => {
  const { model, overlay, editor } = setupWithInputPane();
  model.openInputPane();
  overlay.handleInput("s");
  // Routed to editor as a literal 's' keystroke.
  assert.deepEqual(editor.inputs, ["s"]);
  // Still open (idempotent open already covered by model test).
  assert.equal(model.inputPaneOpen(), true);
});

test("FocusedStreamOverlay: pane open keys (↑↓ etc) passthrough to Editor", () => {
  const { model, overlay, editor } = setupWithInputPane();
  model.openInputPane();
  overlay.handleInput("\x1b[A"); // up
  overlay.handleInput("\x1b[B"); // down
  overlay.handleInput("x");
  assert.deepEqual(editor.inputs, ["\x1b[A", "\x1b[B", "x"]);
});

test("FocusedStreamOverlay: stickToTail re-anchors to new bottom on pane open", () => {
  const { model } = setupWithInputPane();
  // Get to bottom and latch.
  model.scrollDown(10_000);
  assert.equal(model.scrollOffset(), 80, "closed bottom");
  assert.equal(model.stickToTail(), true);
  model.openInputPane();
  // After open, effective bodyRows shrinks → bottom moves to 86 → stickToTail re-snaps.
  assert.equal(model.scrollOffset(), 86, "re-anchored to new bottom");
  assert.equal(model.stickToTail(), true, "sticky preserved");
});
