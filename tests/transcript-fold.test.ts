/**
 * Slice 5 — Fold caps for expanded tool-call JSON walls and expanded
 * thinking blocks.
 *
 * Behaviour pinned here:
 *   - Tool-call expanded mode (`collapseToolCalls=false`) caps the
 *     emitted block at 12 lines + 1 fold marker when it would exceed
 *     the limit. ≤12 → emit as-is.
 *   - Thinking expanded mode (`showThinking=true`) caps at 20 lines +
 *     1 fold marker. ≤20 → emit as-is.
 *   - The fold marker line shape is exactly:
 *       `  ⋯ N more lines  (e expand all · E collapse all)`
 *     — two leading spaces, U+22EF "midline horizontal ellipsis"
 *     glyph, two-space gap before the parenthetical hint. Width-clip
 *     can truncate the tail on narrow terminals.
 *   - When `isExpanded(key, false)` returns true, the cap is bypassed
 *     and the block is emitted in full.
 *   - Block keys use the toolCall `id` field when present
 *     (`tool:<id>`), else fall back to `tool:<msgIdx>:<partIdx>`.
 *     Thinking always uses `thinking:<msgIdx>:<partIdx>`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderTranscript } from "../src/transcript.ts";
import { emptyUsage, type Run } from "../src/types.ts";

const FOLD_MARKER_RE =
  /^ {2}⋯ \d+ more lines {2}\(e expand all · E collapse all\)$/;

const DEFAULT_OPTS = {
  width: 200,
  collapseToolCalls: false,
  showThinking: false,
};

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "r1",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/r1/record.json",
    transcriptPath: "/tmp/r1/transcript.jsonl",
    finalPath: "/tmp/r1/final.md",
    ...overrides,
  };
}

// ── tool-call fold caps ───────────────────────────────────────────────

test("tool-call JSON < 12 lines emits no fold line", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-small",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  // No line matches the fold marker shape.
  for (const ln of lines) {
    assert.doesNotMatch(ln, FOLD_MARKER_RE, `unexpected fold marker: ${ln}`);
  }
});

test("tool-call JSON > 12 lines emits exact fold line shape", () => {
  // Build args that JSON.stringify-pretty-prints into >>12 lines.
  const lots: Record<string, number> = {};
  for (let i = 0; i < 200; i++) lots[`k${i}`] = i;
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t-big", name: "bash", arguments: lots },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  // Exactly one fold marker line, with a positive count.
  const folds = lines.filter((l) => FOLD_MARKER_RE.test(l));
  assert.equal(folds.length, 1, `expected one fold marker, got ${folds.length}`);
  // Capped count: emitted block (everything renderTranscript produced
  // for this part) is exactly 12 + 1 fold = 13 lines.
  assert.equal(lines.length, 13, `tool-call cap shape: expected 13 lines, got ${lines.length}`);
  // The fold marker is the LAST line of the block.
  assert.match(lines[lines.length - 1]!, FOLD_MARKER_RE);
});

test("tool-call cap counts >0 hidden lines", () => {
  // Defensive — make sure the "N" in the marker reflects the real
  // count of dropped lines, not a constant.
  const lots: Record<string, number> = {};
  for (let i = 0; i < 50; i++) lots[`k${i}`] = i;
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t-mid", name: "bash", arguments: lots },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  const fold = lines.find((l) => FOLD_MARKER_RE.test(l));
  assert.ok(fold, "fold marker present");
  const m = /^ {2}⋯ (\d+) more lines/.exec(fold!);
  assert.ok(m, "fold marker count parses");
  assert.ok(Number(m![1]) > 0, "fold count must be positive");
});

// ── thinking fold caps ────────────────────────────────────────────────

test("thinking < 20 lines no fold", () => {
  const text = "tiny thought\nover\na few\nlines";
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: true });
  for (const ln of lines) {
    assert.doesNotMatch(ln, FOLD_MARKER_RE, `unexpected fold marker: ${ln}`);
  }
});

test("thinking > 20 lines fold present", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: true });
  const folds = lines.filter((l) => FOLD_MARKER_RE.test(l));
  assert.equal(folds.length, 1);
  // Capped count: block is exactly 20 + 1 fold = 21 lines.
  assert.equal(lines.length, 21, `thinking cap shape: expected 21 lines, got ${lines.length}`);
  assert.match(lines[lines.length - 1]!, FOLD_MARKER_RE);
});

// ── isExpanded override ───────────────────────────────────────────────

test("expanded override bypasses cap", () => {
  const lots: Record<string, number> = {};
  for (let i = 0; i < 200; i++) lots[`k${i}`] = i;
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t-big", name: "bash", arguments: lots },
        ],
      } as any,
    ],
  });
  const expanded = renderTranscript(run, {
    ...DEFAULT_OPTS,
    isExpanded: () => true,
  });
  // No fold marker — full block emitted.
  for (const ln of expanded) {
    assert.doesNotMatch(ln, FOLD_MARKER_RE, "no fold when expanded");
  }
  // Block is ≫13 lines (200-key JSON pretty-prints to ~600 lines).
  assert.ok(expanded.length > 50, `expanded should be ≫13 lines, got ${expanded.length}`);
});

test("collapse override re-applies cap", () => {
  // When isExpanded explicitly returns false (default-false honoured),
  // the fold cap still fires.
  const lots: Record<string, number> = {};
  for (let i = 0; i < 200; i++) lots[`k${i}`] = i;
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t-big", name: "bash", arguments: lots },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, {
    ...DEFAULT_OPTS,
    isExpanded: () => false,
  });
  assert.equal(lines.length, 13);
  assert.match(lines[lines.length - 1]!, FOLD_MARKER_RE);
});

// ── block-key contract ────────────────────────────────────────────────

test("tool-call block key uses part.id when present", () => {
  // Verify isExpanded receives the documented key shape so a model
  // implementation can target a specific block by id.
  const lots: Record<string, number> = {};
  for (let i = 0; i < 200; i++) lots[`k${i}`] = i;
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-abc", name: "bash", arguments: lots },
        ],
      } as any,
    ],
  });
  const seenKeys: string[] = [];
  renderTranscript(run, {
    ...DEFAULT_OPTS,
    isExpanded: (key) => {
      seenKeys.push(key);
      return false;
    },
  });
  assert.ok(
    seenKeys.includes("tool:tc-abc"),
    `expected key "tool:tc-abc" in ${JSON.stringify(seenKeys)}`,
  );
});

test("thinking block key uses msgIdx:partIdx composite", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "preamble" },
          { type: "thinking", thinking: text },
        ],
      } as any,
    ],
  });
  const seenKeys: string[] = [];
  renderTranscript(run, {
    ...DEFAULT_OPTS,
    showThinking: true,
    isExpanded: (key) => {
      seenKeys.push(key);
      return false;
    },
  });
  // The thinking part is partIdx=1 of msgIdx=0. Key shape:
  // `thinking:0:1`.
  assert.ok(
    seenKeys.includes("thinking:0:1"),
    `expected "thinking:0:1" in ${JSON.stringify(seenKeys)}`,
  );
});
