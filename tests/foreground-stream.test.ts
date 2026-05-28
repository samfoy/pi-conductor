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
    lastEventAt: Date.now() - 14_000,
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
  // Slice 7: header is 2 lines (top ruler + status line). The bottom
  // ruler was dropped per design D3.
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
  // Slice 4: single-turn transcripts emit no `· turn N` separator (separators
  // appear only between consecutive assistant turns).
  assert.doesNotMatch(out, /· turn /);
  assert.doesNotMatch(out, /── turn /);
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

test("renderForegroundStream: hidden thinking emits summary line unconditionally", () => {
  const text = "secret reasoning across\ntwo lines";
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          { type: "text", text: "visible reply" },
        ],
      } as any,
    ],
  });
  const out = renderForegroundStream(run, 80);
  // Body never rendered in foreground (no overlay model to consult)
  assert.doesNotMatch(out, /secret reasoning/);
  // Summary line is always emitted
  assert.match(out, new RegExp(`· thinking \\(${text.length} chars / 2 lines\\)`));
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
    lastEventAt: Date.now() - 14_000,
    usage: { ...emptyUsage(), turns: 3, input: 1200, output: 800, cost: 0.012 },
  });
  const out = renderForegroundSummary(run);
  assert.match(out, /14s/);
  assert.match(out, /3t/);
  assert.match(out, /1\.2k/);
});

// ── Item 15 — inline status line per-send / lifetime split ──
//
// Witness: `builder-501r`'s inline status line
// `✓ builder:builder-501r completed in 1.2h [N t ↑X ↓Y $Z]` reported
// cumulative-since-original-spawn rather than per-most-recent-send.
// Locked design (`docs/backlog.md` item 15): per-send numbers in the
// brackets; optional ` · lifetime <duration> $<cost>` suffix when the
// run has been resumed at least once.

test("renderForegroundSummary: initial spawn (no resumes) omits ' · lifetime' suffix", () => {
  const now = Date.now();
  const run = makeRun({
    status: "completed",
    startTime: now - 14_000,
    finishedAt: now,
    usage: { ...emptyUsage(), turns: 3, input: 1200, output: 800, cost: 0.012 },
    // No resumeCount / thisInvocationStartedAt set.
  });
  const out = renderForegroundSummary(run);
  assert.doesNotMatch(out, /· lifetime/);
});

test(
  "renderForegroundSummary: after a resume, brackets carry per-send numbers and ' · lifetime' suffix is appended",
  () => {
    const now = Date.now();
    const run = makeRun({
      status: "completed",
      startTime: now - 3_600_000, // original spawn 1h ago
      thisInvocationStartedAt: now - 720_000, // most-recent send started 12m ago
      finishedAt: now,
      resumeCount: 5,
      thisInvocationUsageBaseline: { turns: 20, input: 5000, output: 4000, cost: 12.79 },
      // Cumulative usage post-most-recent-send: 28t, 6.4k input, 7.2k output, $16.19
      usage: { ...emptyUsage(), turns: 28, input: 6400, output: 7200, cost: 16.19 },
    });
    const out = renderForegroundSummary(run);
    // Headline first line
    const headline = out.split("\n")[0]!;
    // Per-send brackets: 8t ↑1.4k ↓3.2k $3.400
    assert.match(headline, /completed in 12\.0m/);
    assert.match(headline, /\[8t/);
    assert.match(headline, /\$3\.400/);
    // Lifetime suffix
    assert.match(headline, /· lifetime 1\.0h/);
    assert.match(headline, /\$16\.190/);
    // Cumulative numbers must NOT appear before the lifetime split.
    const [perSendHalf] = headline.split(" · lifetime ");
    assert.doesNotMatch(perSendHalf!, /1\.0h/);
    assert.doesNotMatch(perSendHalf!, /28t/);
    assert.doesNotMatch(perSendHalf!, /\$16\.190/);
  },
);
