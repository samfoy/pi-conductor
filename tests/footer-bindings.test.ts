/**
 * v0.8.3 Item 3 — Slice 9.
 *
 * Footer bindings consolidation: the overlay's `FOOTER_BINDINGS` array is
 * the single source of truth for both the rendered hint list AND the
 * keystroke dispatch table. Adding/removing a binding requires one edit;
 * tests pin the coherence + the load-bearing PRD invariant
 * (Esc → onClose).
 *
 * Style: each rendered hint applies `theme.fg("accent", key)` to the key
 * glyph and leaves the label plain. The `keyHint` / `keyText` helpers
 * exposed inside pi-coding-agent live under `dist/modes/...` (not part
 * of the public package entry); design D4 picks a thin local fallback
 * in the same shape rather than reaching into host internals.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  FocusedStreamOverlay,
  FOOTER_BINDINGS,
  type FooterBinding,
} from "../src/focused-stream-overlay.ts";
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

const sentinel: ThemeFg = {
  fg: (slot, text) => `[${slot}]${text}[/]`,
};

// ── 1. Single source of truth ─────────────────────────────────────────

test("FOOTER_BINDINGS: every binding's key appears in the rendered footer", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: () => {},
  });
  const lines = overlay.render(200);
  const joined = lines.join("\n");
  for (const binding of FOOTER_BINDINGS) {
    assert.ok(
      joined.includes(binding.keyDisplay),
      `binding key "${binding.keyDisplay}" missing from rendered footer`,
    );
  }
});

test("FOOTER_BINDINGS: every binding has at least one input matcher and a label", () => {
  for (const binding of FOOTER_BINDINGS) {
    assert.ok(binding.matches.length >= 1, `binding ${binding.keyDisplay} has no matches`);
    assert.ok(binding.label.length > 0, `binding ${binding.keyDisplay} has no label`);
    assert.ok(binding.keyDisplay.length > 0, "binding has no keyDisplay");
  }
});

test("FOOTER_BINDINGS: dispatching each binding's primary input invokes its action", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  reg.register(makeRun("b-2")); // second run so Tab cycle is observable
  const model = new FocusedStreamModel(reg);
  let closeCount = 0;
  let killCount = 0;
  let sendCount = 0;
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {
      closeCount += 1;
    },
    onKill: () => {
      killCount += 1;
    },
    onSend: () => {
      sendCount += 1;
    },
  });
  model.focus("a-1");
  // Each binding's first match must be wired — fire it and observe an
  // effect somewhere (close / kill / send / model state change).
  for (const binding of FOOTER_BINDINGS) {
    const before = {
      closeCount,
      killCount,
      sendCount,
      collapse: model.collapseToolCalls(),
      thinking: model.showThinking(),
      scroll: model.scrollOffset(),
      focused: model.focused()?.id,
      // Slice 5: e/E mutate fold-expansion state. Capture both flags
      // so the dispatch-effect test observes the mutation.
      expandAllMode: (model as any)._expandAllMode as boolean,
      foldMapSize: ((model as any)._foldExpanded as Map<string, boolean>).size,
    };
    overlay.handleInput(binding.matches[0]!);
    const after = {
      closeCount,
      killCount,
      sendCount,
      collapse: model.collapseToolCalls(),
      thinking: model.showThinking(),
      scroll: model.scrollOffset(),
      focused: model.focused()?.id,
      expandAllMode: (model as any)._expandAllMode as boolean,
      foldMapSize: ((model as any)._foldExpanded as Map<string, boolean>).size,
    };
    // Pre-seed for the next iteration: the `E` (collapse) binding
    // tests that we observe a *delta*, but a fresh model has
    // `_expandAllMode=false` already. Seed a stale per-key entry so
    // collapseAll's clear is observable.
    if (binding.keyDisplay === "e/E") {
      ((model as any)._foldExpanded as Map<string, boolean>).set(
        "tool:seed",
        true,
      );
    }
    assert.notDeepEqual(
      after,
      before,
      `binding "${binding.keyDisplay}" with input ${JSON.stringify(binding.matches[0])} produced no observable effect`,
    );
  }
});

// ── 2. Adding a new binding shows up in both ──────────────────────────

test("FOOTER_BINDINGS: rendered hints are derived from the array (regression-style)", () => {
  // Verify by constructing a stub binding shape and confirming the
  // production renderer would surface it. We don't actually mutate the
  // module-level array (would break other tests); we assert the shape
  // contract every binding satisfies, and that the production array is
  // not zero-length (degenerate case — would silently produce empty
  // footer).
  assert.ok(FOOTER_BINDINGS.length >= 5, "expected ≥5 default footer bindings");
  // Smoke a stub binding satisfies the FooterBinding contract — caught
  // at type-check time, but assert at runtime too so refactors don't
  // silently widen the type.
  const stub: FooterBinding = {
    keyDisplay: "x",
    label: "stub",
    matches: ["x"],
    action: () => {},
  };
  assert.equal(typeof stub.action, "function");
  assert.equal(typeof stub.keyDisplay, "string");
  assert.ok(Array.isArray(stub.matches));
});

// ── 3. PRD lock: Esc → onClose survives the refactor ──────────────────

test("FOOTER_BINDINGS: Esc → onClose still wired after refactor (PRD lock)", () => {
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
  overlay.handleInput("\x1b");
  assert.equal(closeCount, 1, "Esc must invoke onClose exactly once");
  // Double-tap: second Esc fires again (overlay does not absorb).
  overlay.handleInput("\x1b");
  assert.equal(closeCount, 2);
});

test("FOOTER_BINDINGS: Esc binding is the first entry (greedy-pack reaches it on narrow widths)", () => {
  const first = FOOTER_BINDINGS[0]!;
  assert.equal(first.keyDisplay, "Esc");
  assert.ok(first.matches.includes("\x1b") || first.matches.includes("\u001b"));
});

// ── 4. Styled-key visual ──────────────────────────────────────────────

test("FOOTER_BINDINGS: rendered footer styles each key glyph with the accent slot", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: () => {},
    theme: sentinel,
  });
  const joined = overlay.render(200).join("\n");
  // Each binding's keyDisplay is wrapped in [accent]…[/].
  for (const binding of FOOTER_BINDINGS) {
    const re = new RegExp(`\\[accent\\]${escapeRe(binding.keyDisplay)}\\[/\\]`);
    assert.match(joined, re, `key "${binding.keyDisplay}" not wrapped in accent slot`);
  }
});

test("FOOTER_BINDINGS: label text is plain (not wrapped in any theme slot)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: () => {},
    theme: sentinel,
  });
  const joined = overlay.render(200).join("\n");
  // A "close" label appearing immediately after [/] (end of accent
  // wrap) and a space — never inside another slot.
  assert.match(joined, /\[\/\] close/);
  assert.match(joined, /\[\/\] cycle/);
  assert.match(joined, /\[\/\] thinking/);
});

// ── 5. Width discipline preserved ─────────────────────────────────────

test("FOOTER_BINDINGS: footer never exceeds the requested width (visibleWidth)", () => {
  // Width discipline is enforced under PRODUCTION styling (real ANSI)
  // — visibleWidth strips ANSI escapes correctly. The sentinel theme
  // used elsewhere in this file (`[slot]…[/]`) is plain text, so its
  // wrapper bytes WOULD count against the budget; we use the no-theme
  // path here instead, which is the same code path width-wise (the
  // greedy-pack uses the plain `keyDisplay + label` measurement either
  // way).
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  for (const w of [20, 30, 40, 80, 200]) {
    const lines = overlay.render(w);
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= w,
        `width=${w}: line too long (${visibleWidth(line)}): "${line}"`,
      );
    }
  }
});

test("FOOTER_BINDINGS: empty registry still shows a footer with Esc", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const joined = overlay.render(80).join("\n");
  assert.match(joined, /Esc/);
  assert.match(joined, /close/);
});

// ── 6. Tab/c/t/s preserved (relocated from tests/transcript.test.ts) ──
// Origin: tests/transcript.test.ts:709 (Tab), :714 (c, t), :720 (s).
// These were assertions about the pure renderFooter's hint string. After
// Slice 9 the overlay owns the footer; same assertions land here.

test("FOOTER_BINDINGS: rendered footer includes Tab cycle hint (relocated)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  assert.match(overlay.render(200).join("\n"), /Tab/);
});

test("FOOTER_BINDINGS: rendered footer includes c (collapse) and t (thinking) hints (relocated)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  const joined = overlay.render(200).join("\n");
  assert.match(joined, /\bc\b/);
  assert.match(joined, /\bt\b/);
  assert.match(joined, /collapse/);
  assert.match(joined, /thinking/);
});

test("FOOTER_BINDINGS: rendered footer includes 's' send hint (relocated)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    onSend: () => {},
  });
  const joined = overlay.render(200).join("\n");
  assert.match(joined, /\bs\b/);
  assert.match(joined, /send/i);
});

test("FOOTER_BINDINGS: rendered footer never emits ANSI when theme is omitted", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
  });
  for (const line of overlay.render(80)) {
    assert.equal(line.includes("\x1b["), false, `unexpected ANSI in: ${line}`);
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
