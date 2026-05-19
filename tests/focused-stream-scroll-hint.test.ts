/**
 * Tests for the overlay scroll-hint helper (Slice 8).
 *
 * Pure unit tests against `renderScrollHint`, plus integration coverage
 * verifying the hint is rendered between the transcript body and footer
 * by `FocusedStreamOverlay`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderScrollHint, FocusedStreamOverlay } from "../src/focused-stream-overlay.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { classifyLine } from "../src/transcript-classify.ts";
import { applyTheme, type ThemeFg } from "../src/transcript-style.ts";

// ── renderScrollHint pure helper ─────────────────────────────────────

test("renderScrollHint: offset=0 and transcript fits → no hint emitted", () => {
  // viewport ≥ transcript and we're at the top: nothing to hint at.
  assert.equal(renderScrollHint(0, 5, 10), null);
  assert.equal(renderScrollHint(0, 10, 10), null);
  assert.equal(renderScrollHint(0, 0, 10), null);
});

test("renderScrollHint: offset>0 and more below → both arrows", () => {
  // 100 transcript lines, viewport 20, scrolled down 30.
  // hidden above = 30; hidden below = 100 - 30 - 20 = 50.
  const hint = renderScrollHint(30, 100, 20);
  assert.equal(hint, "↑ 30 hidden  ·  ↓ 50 hidden");
});

test("renderScrollHint: at tail (offset = lines - viewport) → only up arrow", () => {
  // 100 transcript lines, viewport 20, scrolled to the very bottom.
  // hidden above = 80; hidden below = 0.
  const hint = renderScrollHint(80, 100, 20);
  assert.equal(hint, "↑ 80 hidden");
});

test("renderScrollHint: at head + transcript exceeds viewport → only down arrow", () => {
  // 100 transcript lines, viewport 20, no scroll.
  // hidden above = 0; hidden below = 80.
  const hint = renderScrollHint(0, 100, 20);
  assert.equal(hint, "↓ 80 hidden");
});

test("renderScrollHint: scroll past tail clamps `below` to 0 (no negative numbers)", () => {
  // Pathological: scrolled past the last line. We should not show "↓ -10 hidden".
  const hint = renderScrollHint(120, 100, 20);
  // hidden above clamps to lines (120 → 100); hidden below clamps to 0.
  assert.equal(hint, "↑ 100 hidden");
});

test("renderScrollHint: viewportHeight 0 or undefined → suppressed defensively", () => {
  // No viewport → can't reason about what's hidden below; suppress.
  assert.equal(renderScrollHint(0, 100, 0), null);
  assert.equal(renderScrollHint(5, 100, 0), null);
});

test("renderScrollHint: scrolled but viewport >= remaining → only up arrow", () => {
  // 100 transcript lines, viewport 80, scrolled 25.
  // hidden above = 25; hidden below = 100 - 25 - 80 = -5 → 0.
  const hint = renderScrollHint(25, 100, 80);
  assert.equal(hint, "↑ 25 hidden");
});

// ── v0.9 deferral 1: per-agent scroll-cycle annotation ────────────────

test("renderScrollHint: single agent + no scroll → null (existing behavior preserved)", () => {
  // agentContext supplied but agentCount=1: no breadcrumb needed.
  assert.equal(
    renderScrollHint(0, 5, 10, { id: "only-agent", agentCount: 1 }),
    null,
  );
});

test("renderScrollHint: multi-agent + no scroll → agent-only breadcrumb", () => {
  const hint = renderScrollHint(0, 30, 100, {
    id: "builder-x7k2",
    agentCount: 3,
  });
  assert.equal(hint, "builder-x7k2 (line 1/30)");
});

test("renderScrollHint: multi-agent + scrolled → combined hint with breadcrumb", () => {
  // 100 transcript lines, viewport 20, scrolled 30.
  const hint = renderScrollHint(30, 100, 20, {
    id: "oracle-9k7r",
    agentCount: 4,
  });
  assert.equal(hint, "↑ 30 hidden  ·  ↓ 50 hidden  ·  oracle-9k7r (line 31/100)");
});

test("renderScrollHint: multi-agent + tail-only scroll → up arrow + breadcrumb", () => {
  const hint = renderScrollHint(80, 100, 20, {
    id: "critic-bcjg",
    agentCount: 2,
  });
  assert.equal(hint, "↑ 80 hidden  ·  critic-bcjg (line 81/100)");
});

test("renderScrollHint: multi-agent + empty transcript → null (line 0/0 is noise)", () => {
  // Edge: agent has zero rendered lines yet (just spawned). No breadcrumb.
  assert.equal(
    renderScrollHint(0, 0, 20, { id: "fresh", agentCount: 5 }),
    null,
  );
});

test("renderScrollHint: multi-agent + scroll past tail clamps line number", () => {
  // scrollOffset (120) past transcript length (100); line should clamp to 100.
  const hint = renderScrollHint(120, 100, 20, {
    id: "runaway",
    agentCount: 2,
  });
  assert.equal(hint, "↑ 100 hidden  ·  runaway (line 100/100)");
});

test("classifyLine: scrollHint kind detected for agent-only breadcrumb line", () => {
  assert.equal(classifyLine("builder-x7k2 (line 27/55)").kind, "scrollHint");
});

test("applyTheme: agent-only breadcrumb → dim slot via theme.fg", () => {
  const stub: ThemeFg = { fg: (slot, text) => `[${slot}]${text}[/]` };
  const line = "builder-x7k2 (line 27/55)";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

// ── classifier coverage ──────────────────────────────────────────────

test("classifyLine: scrollHint kind detected for `↑ N hidden` line", () => {
  assert.equal(classifyLine("↑ 5 hidden").kind, "scrollHint");
});

test("classifyLine: scrollHint kind detected for `↓ N hidden` line", () => {
  assert.equal(classifyLine("↓ 12 hidden").kind, "scrollHint");
});

test("classifyLine: scrollHint kind detected for combined `↑ … ·  ↓ …` line", () => {
  assert.equal(classifyLine("↑ 30 hidden  ·  ↓ 50 hidden").kind, "scrollHint");
});

// ── styling coverage ─────────────────────────────────────────────────

test("applyTheme: scrollHint → dim slot via theme.fg", () => {
  const stub: ThemeFg = { fg: (slot, text) => `[${slot}]${text}[/]` };
  const line = "↑ 30 hidden  ·  ↓ 50 hidden";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

// ── overlay integration ──────────────────────────────────────────────

function makeRun(id: string, opts: { messageCount?: number } = {}): Run {
  // Each message becomes 1+ rendered lines; we just need *something* with
  // bulk so the transcript outlives the viewport.
  const count = opts.messageCount ?? 0;
  const messages = Array.from({ length: count }, (_, i) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: `body line ${i + 1}` }],
  })) as any;
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
  };
}

test("overlay.render: scroll hint appears between transcript body and footer when transcript overflows", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1", { messageCount: 50 }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 10,
  });
  const lines = overlay.render(80);
  // Find the hint line index and verify it sits before the footer.
  const hintIdx = lines.findIndex((l) => /^↓ \d+ hidden/.test(l) || /^↑ \d+ hidden/.test(l));
  assert.ok(hintIdx >= 0, "expected a scroll hint line in overlay output");
  // Footer (`Esc …`) should follow the hint.
  const footerIdx = lines.findIndex((l) => l.startsWith("Esc "));
  assert.ok(footerIdx > hintIdx, "scroll hint must appear before the footer");
});

test("overlay.render: scroll hint suppressed when transcript fits and offset=0", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1", { messageCount: 0 }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 100,
  });
  const lines = overlay.render(80);
  // No hint line shape anywhere.
  assert.equal(
    lines.findIndex((l) => /^↑ \d+ hidden/.test(l) || /^↓ \d+ hidden/.test(l)),
    -1,
    "expected no scroll hint when transcript fits",
  );
});

test("overlay.render: multi-agent overlay shows breadcrumb even when content fits", () => {
  // v0.9 deferral 1: when there are 2+ agents, the overlay annotates which
  // agent the user is currently viewing so Tab cycles have a navigation cue.
  const reg = new RunRegistry();
  reg.register(makeRun("a-1", { messageCount: 4 }));
  reg.register(makeRun("b-1", { messageCount: 4 }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 100,
  });
  const lines = overlay.render(80);
  // Should contain a breadcrumb for the focused agent (most recently started).
  const focusedId = model.focused()!.id;
  const breadcrumb = lines.find((l) =>
    new RegExp(`${focusedId} \\(line \\d+/\\d+\\)`).test(l),
  );
  assert.ok(breadcrumb, `expected agent breadcrumb for ${focusedId} in overlay output`);
});

test("overlay.render: single-agent overlay shows NO breadcrumb (avoids redundant chrome)", () => {
  // v0.9 deferral 1: with one agent the breadcrumb would just repeat the
  // header. Suppress to keep the overlay clean.
  const reg = new RunRegistry();
  reg.register(makeRun("solo-1", { messageCount: 4 }));
  const model = new FocusedStreamModel(reg);
  const overlay = new FocusedStreamOverlay({
    model,
    onClose: () => {},
    onKill: () => {},
    getViewportHeight: () => 100,
  });
  const lines = overlay.render(80);
  const breadcrumb = lines.find((l) => /\(line \d+\/\d+\)$/.test(l));
  assert.equal(
    breadcrumb,
    undefined,
    "single-agent overlay should not include the breadcrumb",
  );
});
