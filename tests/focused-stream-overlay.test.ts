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

test("empty state: no flanking rulers in the body (only the footer ruler remains)", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const lines = overlay.render(80);
  // Footer is the last 2 lines: [ruler, hintLine]. Anything before that
  // is the empty-state body — no ─-only lines should appear there.
  assert.ok(lines.length >= 2, "expected at least footer");
  const body = lines.slice(0, lines.length - 2);
  for (const line of body) {
    assert.equal(
      /^─{3,}$/.test(line),
      false,
      `unexpected ruler in empty-state body: ${JSON.stringify(line)}`,
    );
  }
  // Footer ruler still present at index length-2.
  assert.match(lines[lines.length - 2]!, /^─+$/);
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

test("empty state: at viewport=20, heading lands ~mid (loose: index 5..12)", () => {
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
  assert.ok(headingIdx >= 5 && headingIdx <= 12, `headingIdx=${headingIdx}`);
});

test("empty state: body line count reduced vs pre-slice (default viewport)", () => {
  // Pre-slice: 1 leading ruler + 5 placeholder rows = 6 body lines.
  // Post-slice (default viewport=0): 1 spacer + heading + spacer + prose = 4.
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const lines = overlay.render(80);
  const body = lines.slice(0, lines.length - 2);
  assert.ok(body.length < 6, `expected body < 6, got ${body.length}`);
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
  // Header line carries the running-status accent slot.
  assert.match(joined, /\[accent\][^[]*a-1[^[]*\[\/\]/);
  // The header's top ruler is borderMuted.
  assert.match(joined, /\[borderMuted\]─+\[\/\]/);
  // Footer hint line: Slice 9 styles each binding's key glyph with the
  // accent slot (label is plain). Earlier slices had the whole footer
  // dimmed via classifyLine; that's gone — the overlay now owns its
  // footer entirely and styles it itself.
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
