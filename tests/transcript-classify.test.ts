/**
 * Tests for `src/transcript-classify.ts`.
 *
 * Slice 6 of v0.8.3 Item 3. Exhaustively pin every line shape that
 * `renderTranscript`, `renderHeader`, and `renderFooter` actually emit
 * after slices 0–5b, plus edge cases for the `text` fallback.
 *
 * Cross-reference with `src/transcript.ts` if a new line shape is
 * added; this file should grow alongside.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLine, type ClassifiedLine } from "../src/transcript-classify.ts";
import { STATUS_GLYPH } from "../src/status-glyph.ts";

// ── ruler ─────────────────────────────────────────────────────────────

test("classifyLine: ruler — single ─ char", () => {
  const r: ClassifiedLine = classifyLine("─");
  assert.equal(r.kind, "ruler");
});

test("classifyLine: ruler — repeated ─ chars (typical header/footer)", () => {
  assert.equal(classifyLine("─".repeat(80)).kind, "ruler");
});

test("classifyLine: ruler — does NOT match mixed line containing ─", () => {
  assert.equal(classifyLine("foo ─── bar").kind, "text");
  assert.equal(classifyLine("─x").kind, "text");
});

// ── header ────────────────────────────────────────────────────────────

test("classifyLine: header — running glyph + persona prefix", () => {
  const line = "● inspector (abc123) — running 5s [4t ↑9 ↓80 $0.001]";
  const r = classifyLine(line);
  assert.equal(r.kind, "header");
  assert.equal(r.glyph, "●");
});

test("classifyLine: header — every STATUS_GLYPH char classifies", () => {
  for (const [status, glyph] of Object.entries(STATUS_GLYPH)) {
    const line = `${glyph} persona (id) — ${status} 1s`;
    const r = classifyLine(line);
    assert.equal(r.kind, "header", `glyph ${glyph} (status ${status}) misclassified`);
    assert.equal(r.glyph, glyph);
  }
});

test("classifyLine: header — completed glyph ✓ at column 0 is header, not outcome", () => {
  // ✓ doubles as STATUS_GLYPH.completed AND outcome glyph; disambiguated
  // by leading whitespace (header has none, outcome has ≥1 space + ↳).
  const r = classifyLine("✓ persona (id) — completed 12s");
  assert.equal(r.kind, "header");
  assert.equal(r.glyph, "✓");
});

test("classifyLine: header — bare glyph with no trailing space falls through", () => {
  // Defensive: if a renderer emits just "●" (no trailing space), we'd
  // rather fall through to text than mis-style.
  assert.equal(classifyLine("●").kind, "text");
});

// ── footer ────────────────────────────────────────────────────────────

test("classifyLine: footer — `Esc close · Tab/Sh-Tab cycle …` pattern", () => {
  const line = "Esc close · Tab/Sh-Tab cycle · ↑↓ scroll · s send · c collapse · t thinking · k kill";
  const r = classifyLine(line);
  assert.equal(r.kind, "footer");
  assert.equal(r.glyph, undefined);
});

test("classifyLine: footer — narrow-width truncated still starts with Esc", () => {
  // Greedy packing keeps "Esc close" as the first hint at any width that
  // can fit it; widths that can't fit even the first hint emit "" or
  // partially-truncated text.
  assert.equal(classifyLine("Esc close").kind, "footer");
  assert.equal(classifyLine("Esc close · Tab/Sh-Tab cycle").kind, "footer");
});

// ── turnSep ───────────────────────────────────────────────────────────

test("classifyLine: turnSep — `· turn N`", () => {
  const r = classifyLine("· turn 1");
  assert.equal(r.kind, "turnSep");
  assert.equal(r.glyph, "·");
});

test("classifyLine: turnSep — multi-digit", () => {
  assert.equal(classifyLine("· turn 42").kind, "turnSep");
});

test("classifyLine: turnSep — `· turn` without digit is NOT turnSep", () => {
  // Defensive: distinguish from a hypothetical body line beginning `· turn `
  // with no digit. classifies to text since the regex requires a digit.
  assert.equal(classifyLine("· turn x").kind, "text");
});

// ── tool ──────────────────────────────────────────────────────────────

test("classifyLine: tool — collapsed `▸ name` form", () => {
  const r = classifyLine("▸ bash echo hi");
  assert.equal(r.kind, "tool");
  assert.equal(r.glyph, "▸");
});

test("classifyLine: tool — expanded `▾ name` form", () => {
  const r = classifyLine("▾ bash");
  assert.equal(r.kind, "tool");
  assert.equal(r.glyph, "▾");
});

test("classifyLine: tool — chevron without trailing space falls through", () => {
  assert.equal(classifyLine("▸").kind, "text");
  assert.equal(classifyLine("▾x").kind, "text");
});

// ── outcome ───────────────────────────────────────────────────────────

test("classifyLine: outcome — collapsed ` ↳ ✓ preview`", () => {
  const r = classifyLine(" ↳ ✓ hello world");
  assert.equal(r.kind, "outcome");
  assert.equal(r.glyph, "↳");
});

test("classifyLine: outcome — collapsed ` ↳ ✗ preview`", () => {
  assert.equal(classifyLine(" ↳ ✗ exit 1").kind, "outcome");
});

test("classifyLine: outcome — pending ` ↳ …`", () => {
  assert.equal(classifyLine(" ↳ …").kind, "outcome");
});

test("classifyLine: outcome — expanded body `  ↳ preview`", () => {
  const r = classifyLine("  ↳ stdout text");
  assert.equal(r.kind, "outcome");
  assert.equal(r.glyph, "↳");
});

// ── thinking ──────────────────────────────────────────────────────────

test("classifyLine: thinking — summary line `· thinking (N chars / M lines)`", () => {
  const r = classifyLine("· thinking (123 chars / 4 lines)");
  assert.equal(r.kind, "thinking");
  assert.equal(r.glyph, "·");
});

test("classifyLine: thinking — summary 0-chars edge", () => {
  assert.equal(classifyLine("· thinking (0 chars / 0 lines)").kind, "thinking");
});

test("classifyLine: thinking — expanded body `  ┃ thinking` heading", () => {
  const r = classifyLine("  ┃ thinking");
  assert.equal(r.kind, "thinking");
  assert.equal(r.glyph, "┃");
});

test("classifyLine: thinking — expanded body `  ┃ <text>` continuation", () => {
  const r = classifyLine("  ┃ Let me reason about this carefully.");
  assert.equal(r.kind, "thinking");
  assert.equal(r.glyph, "┃");
});

// ── text fallback + edge cases ────────────────────────────────────────

test("classifyLine: text — empty string", () => {
  assert.equal(classifyLine("").kind, "text");
});

test("classifyLine: text — whitespace-only", () => {
  assert.equal(classifyLine("   ").kind, "text");
  assert.equal(classifyLine("\t").kind, "text");
});

test("classifyLine: text — wrapped assistant body", () => {
  assert.equal(classifyLine("This is a normal sentence of body text.").kind, "text");
});

test("classifyLine: text — line containing `· turn 1` mid-string is NOT turnSep", () => {
  // The kind is decided by leading characters, not substring.
  assert.equal(classifyLine("see · turn 1 above").kind, "text");
});

test("classifyLine: text — expanded tool-call JSON arg line falls through", () => {
  // `renderToolCall` (collapseToolCalls=false) emits `  "key": value` lines
  // which have a 2-space indent but no ┃ or ↳ marker. They are not styled
  // separately by the upcoming Slice 7 layer; classify as text.
  assert.equal(classifyLine('  "command": "echo hi"').kind, "text");
  assert.equal(classifyLine("  {").kind, "text");
});

test("classifyLine: text — `Esc` not at column 0 is NOT footer", () => {
  // Defensive: prevent body text containing the word "Esc" from being
  // mis-styled as a footer hint line.
  assert.equal(classifyLine("Press Esc to close.").kind, "text");
  assert.equal(classifyLine(" Esc close").kind, "text");
});

test("classifyLine: text — line whose first char happens to be `·` but isn't a known prefix", () => {
  assert.equal(classifyLine("·").kind, "text");
  assert.equal(classifyLine("· something else").kind, "text");
});
