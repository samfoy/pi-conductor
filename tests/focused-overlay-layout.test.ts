/**
 * Slice 6 of focused-overlay redesign — three-zone bordered chrome.
 *
 * These tests pin the layout shape produced by FocusedStreamOverlay
 * once the chrome rewrite lands: a Container with three zones
 * (HeaderZone 4 rows, BodyZone computed, FooterZone 3 rows), borders
 * drawn via `╭─...─╮` / `├─...─┤` / `╰─...─╯` glyphs, and side walls
 * `│ ... │` on every content row.
 *
 * The body fits exactly within `viewport - HEADER_ROWS - FOOTER_ROWS`,
 * the breadcrumb (when content is clipped) lives on the bottom row of
 * the body zone, and the empty-state polish from v0.8.3 is preserved
 * (heading still appears, no flanking pure-ruler lines bleed into the
 * body — the chrome supplies all the rules now).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FocusedStreamOverlay } from "../src/focused-stream-overlay.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

const VIEWPORT_ROWS = 30;
const VIEWPORT_COLS = 100;
const HEADER_ROWS = 4;
const FOOTER_ROWS = 3;

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
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
    ...overrides,
  };
}

function setupOverlayWithFocus(): {
  reg: RunRegistry;
  model: FocusedStreamModel;
  overlay: FocusedStreamOverlay;
} {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => VIEWPORT_ROWS,
  });
  return { reg, model, overlay };
}

function setupOverlayEmpty(viewport = VIEWPORT_ROWS): {
  reg: RunRegistry;
  model: FocusedStreamModel;
  overlay: FocusedStreamOverlay;
} {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => viewport,
  });
  return { reg, model, overlay };
}

// ── Borders ────────────────────────────────────────────────────────────

test("renders top border ╭…╮ on row 0", () => {
  const { overlay } = setupOverlayWithFocus();
  const lines = overlay.render(VIEWPORT_COLS);
  const top = lines[0]!;
  assert.match(top, /^╭─+╮$/, `expected top border, got ${JSON.stringify(top)}`);
  assert.equal(visibleWidth(top), VIEWPORT_COLS, "top border must span full width");
});

test("renders bottom border ╰…╯ on last row", () => {
  const { overlay } = setupOverlayWithFocus();
  const lines = overlay.render(VIEWPORT_COLS);
  const bottom = lines[lines.length - 1]!;
  assert.match(bottom, /^╰─+╯$/, `expected bottom border, got ${JSON.stringify(bottom)}`);
  assert.equal(visibleWidth(bottom), VIEWPORT_COLS, "bottom border must span full width");
});

// ── Body geometry ──────────────────────────────────────────────────────

test("body rows == overlayRows - HEADER_ROWS - FOOTER_ROWS", () => {
  const { overlay } = setupOverlayWithFocus();
  const lines = overlay.render(VIEWPORT_COLS);
  // Total rows always equal viewport size — the chrome budget is
  // dictated by the host's viewport, not by transcript length.
  assert.equal(
    lines.length,
    VIEWPORT_ROWS,
    `expected ${VIEWPORT_ROWS} total rows, got ${lines.length}`,
  );
  // Body slice = everything except the 4-row header and 3-row footer.
  const body = lines.slice(HEADER_ROWS, lines.length - FOOTER_ROWS);
  assert.equal(
    body.length,
    VIEWPORT_ROWS - HEADER_ROWS - FOOTER_ROWS,
    "body row count must equal viewport - header - footer",
  );
});

test("body line count fits viewport exactly when transcript longer", () => {
  // Build a run whose transcript has many more lines than fit.
  const reg = new RunRegistry();
  const longMessages: any[] = [];
  for (let i = 0; i < 200; i++) {
    longMessages.push({
      role: "assistant",
      content: [{ type: "text", text: `body line ${i}` }],
    });
  }
  reg.register(makeRun("a-1", { messages: longMessages }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => VIEWPORT_ROWS,
  });
  const lines = overlay.render(VIEWPORT_COLS);
  // Total still equals viewport — body cannot escape its zone budget.
  assert.equal(lines.length, VIEWPORT_ROWS);
  const body = lines.slice(HEADER_ROWS, lines.length - FOOTER_ROWS);
  assert.equal(body.length, VIEWPORT_ROWS - HEADER_ROWS - FOOTER_ROWS);
  // Every body row is a side-walled content row.
  for (const row of body) {
    assert.match(row, /^│ .* │$/, `body row must be wrapped: ${JSON.stringify(row)}`);
    assert.equal(visibleWidth(row), VIEWPORT_COLS, "body rows full-width");
  }
});

test("body shows breadcrumb on bottom row when clipped", () => {
  // Many transcript lines → content is clipped → breadcrumb fires.
  const reg = new RunRegistry();
  const longMessages: any[] = [];
  for (let i = 0; i < 200; i++) {
    longMessages.push({
      role: "assistant",
      content: [{ type: "text", text: `body line ${i}` }],
    });
  }
  reg.register(makeRun("a-1", { messages: longMessages }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => VIEWPORT_ROWS,
  });
  const lines = overlay.render(VIEWPORT_COLS);
  const body = lines.slice(HEADER_ROWS, lines.length - FOOTER_ROWS);
  const lastBody = body[body.length - 1]!;
  // Breadcrumb mentions hidden-line counts. With a 200-line transcript
  // and ~23 visible body rows, ↓ N hidden is guaranteed.
  assert.match(
    lastBody,
    /hidden/,
    `expected breadcrumb on bottom body row, got ${JSON.stringify(lastBody)}`,
  );
});

// ── Empty state preserved (v0.8.3 polish carry-forward) ───────────────

test("empty state preserved when no focused run", () => {
  const { overlay } = setupOverlayEmpty();
  const lines = overlay.render(VIEWPORT_COLS);
  // Total rows still equal viewport (chrome shrinks to nothing only
  // when viewport is silly small; here we have plenty of room).
  assert.equal(lines.length, VIEWPORT_ROWS);
  // Top/bottom border still present.
  assert.match(lines[0]!, /^╭─+╮$/);
  assert.match(lines[lines.length - 1]!, /^╰─+╯$/);
  // Empty-state heading + prose still surface inside the body zone.
  const body = lines.slice(HEADER_ROWS, lines.length - FOOTER_ROWS);
  const joined = body.join("\n");
  assert.match(joined, /\(no sub-agents running\)/);
  assert.match(joined, /Spawn one via ensemble_spawn/);
});
