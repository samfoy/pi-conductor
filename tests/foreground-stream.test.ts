/**
 * Tests for renderForegroundStream + renderForegroundSummary — the pure
 * helpers that turn a Run into the live transcript text shown in the
 * parent's tool-call card while a foreground sub-agent runs (slice 1) and
 * the compact summary block shown after it completes (slice 2).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  renderForegroundStream,
  renderForegroundSummary,
} from "../src/foreground-stream.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "test task",
    mode: "foreground",
    status: "running",
    startTime: Date.now() - 14_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

// ── renderForegroundStream ────────────────────────────────────────────

test("renderForegroundStream: empty messages renders just the header", () => {
  const out = renderForegroundStream(makeRun(), 80);
  // Header is always present (3 lines: top rule, header line, bottom rule).
  assert.match(out, /oracle/);
  assert.match(out, /oracle-7f3a/);
  assert.match(out, /running/);
  // No transcript body when no messages.
  assert.doesNotMatch(out, /turn 1/);
});

test("renderForegroundStream: single assistant text turn renders header + that text", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Looking at the auth flow now." }],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 80);
  assert.match(out, /oracle-7f3a/);
  assert.match(out, /Looking at the auth flow now/);
  // Turn separator should appear since renderTranscript adds one per turn.
  assert.match(out, /turn 1/);
});

test("renderForegroundStream: tool call renders collapsed (single chevron line)", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check…" },
          { type: "toolCall", name: "bash", arguments: { command: "git status" } },
        ],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 80);
  assert.match(out, /Let me check/);
  // Collapsed marker; not the expanded ▾.
  assert.match(out, /▸ bash/);
  assert.doesNotMatch(out, /▾ bash/);
});

test("renderForegroundStream: status reflected in header for terminal states", () => {
  for (const status of ["running", "completed", "failed", "killed", "timeout"] as const) {
    const out = renderForegroundStream(makeRun({ status }), 80);
    assert.match(out, new RegExp(status), `status ${status} should appear in header`);
  }
});

test("renderForegroundStream: usage is interpolated when present", () => {
  const run = makeRun({
    usage: { ...emptyUsage(), turns: 3, input: 1200, output: 800 },
  });
  const out = renderForegroundStream(run, 100);
  // formatUsage produces e.g. "3t ↑1.2k ↓800".
  assert.match(out, /3t/);
  assert.match(out, /1\.2k/);
  assert.match(out, /800/);
});

test("renderForegroundStream: width respected — no line exceeds it", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "abcdefghij ".repeat(40) },
        ],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 50);
  for (const line of out.split("\n")) {
    assert.equal(
      line.length <= 50,
      true,
      `line exceeds width 50 (len=${line.length}): ${JSON.stringify(line)}`,
    );
  }
});

test("renderForegroundStream: thinking blocks are hidden", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "visible reply" },
        ],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 80);
  assert.doesNotMatch(out, /secret reasoning/);
  assert.match(out, /visible reply/);
});

test("renderForegroundStream: tail-truncates when output exceeds 32KB", () => {
  // Build a run with one giant assistant text part. renderTranscript
  // wraps it to width=200 lines; total output should easily exceed 32KB.
  const huge = "abcdefghij ".repeat(20_000); // ~220KB raw
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: huge }],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 200);
  // Cap is ~32K chars plus the truncation marker line; assert reasonably bounded.
  assert.ok(
    out.length < 64 * 1024,
    `output should be tail-truncated near 32K chars, got ${out.length}`,
  );
  assert.match(out, /transcript truncated/);
});

// ── renderForegroundSummary ───────────────────────────────────────────

test("renderForegroundSummary: success with final text shows ✓ + quote + transcript", () => {
  const run = makeRun({
    status: "completed",
    finishedAt: Date.now(),
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "JWT auth design looks solid; recommend rotating keys quarterly." }],
      } as any,
    ],
  });
  const out = renderForegroundSummary(run);
  assert.match(out, /✓/);
  assert.match(out, /oracle:oracle-7f3a/);
  assert.match(out, /completed/);
  assert.match(out, /JWT auth design looks solid/);
  assert.match(out, /transcript\.jsonl/i);
});

test("renderForegroundSummary: success with empty final text omits the quote line", () => {
  const run = makeRun({
    status: "completed",
    finishedAt: Date.now(),
    messages: [],
  });
  const out = renderForegroundSummary(run);
  assert.match(out, /✓/);
  assert.match(out, /completed/);
  // No leading quote/arrow line for missing final text.
  assert.doesNotMatch(out, /^\s*→ "/m);
});

test("renderForegroundSummary: failure with error message shows ✗ + error", () => {
  const run = makeRun({
    status: "failed",
    finishedAt: Date.now(),
    errorMessage: "context overflow at turn 12",
  });
  const out = renderForegroundSummary(run);
  assert.match(out, /✗/);
  assert.match(out, /failed/);
  assert.match(out, /context overflow at turn 12/);
  // Should not include a fake quote when there's no final text.
  assert.doesNotMatch(out, /^\s*→ "/m);
});

test("renderForegroundSummary: killed status renders ■ glyph", () => {
  const run = makeRun({ status: "killed", finishedAt: Date.now() });
  const out = renderForegroundSummary(run);
  assert.match(out, /■|killed/);
});

test("renderForegroundSummary: timeout status renders ⏱ glyph or 'timeout' word", () => {
  const run = makeRun({ status: "timeout", finishedAt: Date.now() });
  const out = renderForegroundSummary(run);
  assert.match(out, /⏱|timeout|timed out/);
});

test("renderForegroundSummary: long final text excerpt is truncated with ellipsis", () => {
  const longText = "x".repeat(500);
  const run = makeRun({
    status: "completed",
    finishedAt: Date.now(),
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: longText }],
      } as any,
    ],
  });
  const out = renderForegroundSummary(run);
  // Excerpt line should not contain the full 500 chars; should be truncated.
  const excerptLine = out.split("\n").find((l) => l.includes("→"));
  assert.ok(excerptLine, "expected an excerpt line");
  assert.equal(excerptLine!.length < 200, true, `excerpt too long: ${excerptLine}`);
  assert.match(excerptLine!, /…|\.\.\./);
});

test("renderForegroundSummary: usage and elapsed appear in the headline", () => {
  const run = makeRun({
    status: "completed",
    finishedAt: Date.now(),
    startTime: Date.now() - 14_000,
    usage: { ...emptyUsage(), turns: 3, input: 1200, output: 800, cost: 0.012 },
  });
  const out = renderForegroundSummary(run);
  assert.match(out, /14s/);
  assert.match(out, /3t/);
  assert.match(out, /1\.2k/);
});
