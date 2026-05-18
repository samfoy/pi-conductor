/**
 * Tests for renderTranscript — the pure renderer that turns a Run's message
 * history into the line array that the focused-stream overlay displays.
 *
 * Pure: takes a Run + view options, returns string[]. No TUI imports, no
 * theme dependency at this layer. Styling happens in the Component layer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderTranscript,
  renderHeader,
  type TranscriptOptions,
} from "../src/transcript.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "tester-abcd",
    persona: "tester",
    task: "test task",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

const DEFAULT_OPTS: TranscriptOptions = {
  width: 80,
  collapseToolCalls: true,
  showThinking: false,
};

// ── renderTranscript ───────────────────────────────────────────────────

test("renderTranscript: empty messages renders empty array", () => {
  const lines = renderTranscript(makeRun(), DEFAULT_OPTS);
  assert.deepEqual(lines, []);
});

test("renderTranscript: a single assistant text message becomes its text lines", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  // Slice 4: single-turn transcripts emit no separator. The text lines are
  // the entire output.
  const joined = lines.join("\n");
  assert.match(joined, /Hello world/);
  // No `· turn N` marker when there's only one assistant turn.
  assert.doesNotMatch(joined, /· turn /);
  // No legacy ruler-style separator either.
  assert.doesNotMatch(joined, /── turn /);
});

test("renderTranscript: long assistant text wraps to width", () => {
  const longText = "abcdef ".repeat(40); // ~280 chars
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: longText }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, width: 40 });
  // No line may exceed the width (measured by terminal columns, not chars).
  for (const line of lines) {
    assert.equal(visibleWidth(line) <= 40, true, `line too long: "${line}"`);
  }
});

test("renderTranscript: text containing tabs wraps to width (regression: pi-tui counts \\t as 3 cols)", () => {
  // Each \t counts as 3 visible columns. The previous wrap() used .length
  // which counted \t as 1, producing lines with visibleWidth > target and
  // crashing pi-tui's renderer with "exceeds terminal width".
  const tabbed =
    "34892\tCDK CLI will collect telemetry data on command usage\n" +
    "\tOverview: We do not collect customer content\n" +
    "\t\t\tdeeply\tindented\tstuff";
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: tabbed }],
      } as any,
    ],
  });
  for (const w of [20, 40, 80, 213]) {
    const lines = renderTranscript(run, { ...DEFAULT_OPTS, width: w });
    for (const line of lines) {
      assert.equal(
        visibleWidth(line) <= w,
        true,
        `line too long at width=${w}: visibleWidth=${visibleWidth(line)} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test("renderTranscript: collapsed toolCall renders as a single chevron line", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "running it…" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true });
  const joined = lines.join("\n");
  // Collapsed marker + tool name visible; the args should be summarized,
  // not fully expanded as JSON.
  assert.match(joined, /▸ bash/);
  assert.match(joined, /running it/);
});

test("renderTranscript: expanded toolCall shows arguments", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "ls /tmp" } },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: false });
  const joined = lines.join("\n");
  assert.match(joined, /▾ bash/);
  // Arguments should appear in the expanded view.
  assert.match(joined, /ls \/tmp/);
});

test("renderTranscript: hidden thinking renders a one-line summary by default", () => {
  const text = "I should check the auth flow first";
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          { type: "text", text: "Let me investigate." },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: false });
  const joined = lines.join("\n");
  // Body is hidden
  assert.doesNotMatch(joined, /I should check the auth flow/);
  // But a summary line is emitted instead, with exact char + line counts
  assert.match(joined, new RegExp(`· thinking \\(${text.length} chars / 1 line\\)`));
  assert.match(joined, /Let me investigate/);
});

test("renderTranscript: hidden thinking summary uses 'lines' (plural) for multi-line text", () => {
  const text = "line one\nline two\nline three";
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: false });
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /line one/);
  assert.match(joined, new RegExp(`· thinking \\(${text.length} chars / 3 lines\\)`));
});

test("renderTranscript: hidden thinking with empty body still summarizes", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "" }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: false });
  const joined = lines.join("\n");
  assert.match(joined, /· thinking \(0 chars \/ 0 lines\)/);
});

test("renderTranscript: thinking blocks visible when showThinking is true", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deliberating about X" },
          { type: "text", text: "decision: X" },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: true });
  const joined = lines.join("\n");
  assert.match(joined, /deliberating about X/);
  assert.match(joined, /decision: X/);
});

// ── Slice 2: tool-call outcome line `↳ ✓/✗/…` in collapsed mode ─────

test("renderTranscript: collapsed toolCall + success result emits a ↳ ✓ outcome line", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        isError: false,
        content: [
          { type: "toolResult", toolUseId: "call-1", text: "hello world" },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true });
  const joined = lines.join("\n");
  assert.match(joined, /▸ bash/);
  // Outcome line follows: ↳ ✓ <preview>
  assert.match(joined, /↳ ✓ hello world/);
  // Must NOT show ✗ for a success.
  assert.doesNotMatch(joined, /↳ ✗/);
});

test("renderTranscript: collapsed toolCall + isError result emits ↳ ✗", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-2",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        isError: true,
        content: [
          { type: "toolResult", toolUseId: "call-2", text: "exit 1" },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true });
  const joined = lines.join("\n");
  assert.match(joined, /▸ bash/);
  assert.match(joined, /↳ ✗ exit 1/);
  assert.doesNotMatch(joined, /↳ ✓/);
});

test("renderTranscript: collapsed toolCall with id but no result emits pending ↳ …", () => {
  // Pending state — call landed but result hasn't yet. Render `↳ …` so the
  // user has a stable visual cue the tool is mid-flight (prevents the
  // half-second flash described in plan §7 throttle interaction).
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-pending",
            name: "bash",
            arguments: { command: "sleep 5" },
          },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true });
  const joined = lines.join("\n");
  assert.match(joined, /▸ bash/);
  assert.match(joined, /↳ …/);
  assert.doesNotMatch(joined, /↳ ✓/);
  assert.doesNotMatch(joined, /↳ ✗/);
});

test("renderTranscript: non-collapsed mode does NOT add a ↳ ✓/✗ outcome line", () => {
  // collapseToolCalls=false renders the full body (existing behavior); the
  // ↳ ✓/✗ glyph layer is collapsed-mode-only because the body itself shows
  // the outcome.
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-3",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        isError: false,
        content: [
          { type: "toolResult", toolUseId: "call-3", text: "hi" },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: false });
  const joined = lines.join("\n");
  assert.match(joined, /▾ bash/);
  // Body still renders the result text (existing behavior).
  assert.match(joined, /hi/);
  // No ✓/✗ outcome glyph in expanded mode.
  assert.doesNotMatch(joined, /↳ ✓/);
  assert.doesNotMatch(joined, /↳ ✗/);
});

test("renderTranscript: outcome preview takes only the first line of the result", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-multiline",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        isError: false,
        content: [
          { type: "toolResult", toolUseId: "call-multiline", text: "line one\nline two\nline three" },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true });
  const joined = lines.join("\n");
  assert.match(joined, /↳ ✓ line one/);
  // Only the first line of the result appears in the outcome preview;
  // subsequent lines are not surfaced (use Ctrl+G + expand for full body).
  assert.doesNotMatch(joined, /line two/);
});

test("renderTranscript: outcome line respects the width budget", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-wide",
            name: "bash",
            arguments: { command: "cat huge.log" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        isError: false,
        content: [
          {
            type: "toolResult",
            toolUseId: "call-wide",
            text: "x".repeat(500),
          },
        ],
      } as any,
    ],
  });
  for (const w of [20, 40, 80]) {
    const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: true, width: w });
    for (const line of lines) {
      assert.equal(
        visibleWidth(line) <= w,
        true,
        `outcome line exceeded width=${w}: visibleWidth=${visibleWidth(line)} line=${JSON.stringify(line)}`,
      );
    }
  }
});

test("renderTranscript: toolResult message renders indented under the call", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "abc",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
      } as any,
      {
        role: "toolResult",
        content: [{ type: "toolResult", toolUseId: "abc", text: "hi" }],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, collapseToolCalls: false });
  const joined = lines.join("\n");
  assert.match(joined, /hi/);
});

test("renderTranscript: user-role messages do NOT render (parent's prompt is internal)", () => {
  // The very first user message is the prompt we sent to the sub-agent —
  // it's not part of "the sub-agent's transcript" from the user's POV.
  // We can revisit this; for now, hide user messages from the rendered transcript.
  const run = makeRun({
    messages: [
      { role: "user", content: [{ type: "text", text: "INTERNAL PROMPT" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "got it" }] } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /INTERNAL PROMPT/);
  assert.match(joined, /got it/);
});

test("renderTranscript: multiple assistant turns are separated by a single-line `· turn N` marker", () => {
  const run = makeRun({
    messages: [
      { role: "assistant", content: [{ type: "text", text: "first" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "second" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "third" }] } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  // Slice 4: 3 assistant turns → 2 separators (between turns 1↔2 and 2↔3).
  // Each separator is exactly one line, left-aligned `· turn N`, no flanking rules.
  const sepLines = lines.filter((l: string) => /^· turn \d+$/.test(l));
  assert.equal(sepLines.length, 2, "expected exactly 2 separators between 3 turns");
  assert.equal(sepLines[0], "· turn 2");
  assert.equal(sepLines[1], "· turn 3");
  // Each separator line is ≤ the requested width.
  for (const s of sepLines) {
    assert.equal(s.length <= DEFAULT_OPTS.width, true, `separator '${s}' exceeds width`);
  }
  // No legacy ruler-style separator (`── turn N ──…`) anywhere in output.
  for (const l of lines) {
    assert.doesNotMatch(l, /── turn /);
  }
});

// ── renderHeader ──────────────────────────────────────────────────────

test("renderHeader: shows persona, id, status, elapsed", () => {
  const run = makeRun({
    persona: "oracle",
    id: "oracle-7f3a",
    status: "running",
    startTime: Date.now() - 65_000,
    lastEventAt: Date.now() - 65_000,
  });
  const lines = renderHeader(run, 80);
  const joined = lines.join("\n");
  assert.match(joined, /oracle/);
  assert.match(joined, /oracle-7f3a/);
  assert.match(joined, /running/);
  assert.match(joined, /1\.[01]m|65s/); // elapsed format
});

test("renderHeader: status reflects terminal states distinctly", () => {
  const completed = renderHeader(makeRun({ status: "completed" }), 80).join("\n");
  const failed = renderHeader(makeRun({ status: "failed" }), 80).join("\n");
  const killed = renderHeader(makeRun({ status: "killed" }), 80).join("\n");
  assert.match(completed, /completed/);
  assert.match(failed, /failed/);
  assert.match(killed, /killed/);
});

test("renderHeader: never exceeds the requested width", () => {
  const run = makeRun({
    persona: "an-extremely-long-persona-name-that-will-definitely-overflow",
    id: "oracle-7f3a",
  });
  const lines = renderHeader(run, 30);
  for (const line of lines) {
    assert.equal(visibleWidth(line) <= 30, true, `header line exceeded width: "${line}"`);
  }
});

// ── renderHeader: derived activity field (Slice 5b) ───────────────────

test("renderHeader: running run with last message thinking shows '· thinking'", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· thinking/);
});

test("renderHeader: running run with last toolCall shows '· $ <cmd>' for bash", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "echo hi" } },
        ],
      } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· \$ echo hi/);
});

test("renderHeader: running run with last toolCall for read shows '· read <path>'", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { file_path: "x.ts" } }],
      } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· read x\.ts/);
});

test("renderHeader: running run with last text message shows '· responding'", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hello" }] } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· responding/);
});

test("renderHeader: running run idle ≥5s shows '· idle Ns' in seconds", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 6000,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hi" }] } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· idle 6s/);
});

test("renderHeader: running run idle ≥60s shows '· idle Nm' in minutes", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 65_000,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hi" }] } as any,
    ],
  });
  const joined = renderHeader(run, 120).join("\n");
  assert.match(joined, /· idle 1m/);
});

test("renderHeader: idle threshold — 4999ms ago shows activity, 5001ms ago shows idle", () => {
  const justBeforeThreshold = makeRun({
    status: "running",
    lastEventAt: Date.now() - 4999,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hi" }] } as any,
    ],
  });
  const justAfterThreshold = makeRun({
    status: "running",
    lastEventAt: Date.now() - 5001,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hi" }] } as any,
    ],
  });
  const beforeJoined = renderHeader(justBeforeThreshold, 120).join("\n");
  const afterJoined = renderHeader(justAfterThreshold, 120).join("\n");
  assert.match(beforeJoined, /· responding/);
  assert.doesNotMatch(beforeJoined, /· idle/);
  assert.match(afterJoined, /· idle 5s/);
  assert.doesNotMatch(afterJoined, /· responding/);
});

test("renderHeader: completed/failed/killed/timeout/queued/paused show NO activity field", () => {
  const lastEvent = Date.now() - 100_000; // would-be 'idle 1m' if running
  const last = [{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any];
  for (const status of ["completed", "failed", "killed", "timeout", "queued", "paused"] as const) {
    const run = makeRun({ status, lastEventAt: lastEvent, messages: last });
    const joined = renderHeader(run, 120).join("\n");
    assert.doesNotMatch(
      joined,
      /· (idle|thinking|responding|\$ |read |write |edit |grep )/,
      `non-running status "${status}" leaked an activity segment: ${joined}`,
    );
  }
});

test("renderHeader: width discipline — activity is truncated/dropped, persona stays", () => {
  const run = makeRun({
    persona: "an-extremely-long-persona-name-that-will-overflow",
    id: "oracle-7f3a",
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            arguments: { command: "a-very-long-command-tail-that-would-not-fit-anywhere" },
          },
        ],
      } as any,
    ],
  });
  const lines = renderHeader(run, 50);
  for (const line of lines) {
    assert.equal(visibleWidth(line) <= 50, true, `header line exceeded width: "${line}"`);
  }
  const joined = lines.join("\n");
  // Persona name fully present (or at minimum its head is preserved).
  assert.match(joined, /an-extremely-long-persona-name/);
});

test("renderHeader: activity respects width at width=50/80/120/213", () => {
  const run = makeRun({
    status: "running",
    lastEventAt: Date.now() - 100,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "echo hello" } },
        ],
      } as any,
    ],
  });
  for (const width of [50, 80, 120, 213]) {
    const lines = renderHeader(run, width);
    for (const line of lines) {
      assert.equal(
        visibleWidth(line) <= width,
        true,
        `width=${width}: header line exceeded width: "${line}"`,
      );
    }
  }
});

// ── renderFooter ──────────────────────────────────────────────────────
//
// v0.8.3 Item 3 — Slice 9: footer rendering moved to the overlay.
// The hint-list / dispatch tests (Esc/Tab/c/t/s/width) now live in
// tests/footer-bindings.test.ts (relocated, not rewritten). The pure
// renderer no longer exports a renderFooter helper.

// ── Slice 7 invariant: pure renderers stay monochrome ─────────────────
//
// The Component layer is the only place ANSI is introduced (see
// src/transcript-style.ts + tests/transcript-style.test.ts). The pure
// renderers below MUST emit no ANSI escape bytes — if they do, the
// snapshot baselines below silently rot and the wrap/truncate helpers
// will mis-measure widths (they expect plain input from the renderer).

test("renderHeader emits no ANSI escape sequences", () => {
  const run = makeRun({ status: "running", lastEventAt: Date.now() });
  for (const line of renderHeader(run, 80)) {
    assert.equal(line.includes("\x1b["), false, `unexpected ANSI in header: ${line}`);
  }
});

test("renderTranscript emits no ANSI escape sequences", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "weighing options" },
          { type: "toolCall", id: "c-1", name: "bash", arguments: { command: "ls" } },
        ],
      } as any,
      {
        role: "toolResult",
        isError: false,
        content: [{ type: "toolResult", toolUseId: "c-1", text: "ok" }],
      } as any,
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      } as any,
    ],
  });
  for (const line of renderTranscript(run, DEFAULT_OPTS)) {
    assert.equal(line.includes("\x1b["), false, `unexpected ANSI in transcript: ${line}`);
  }
});

test("renderHeader emits exactly 2 lines (top ruler + status), no trailing ruler", () => {
  const run = makeRun({ status: "running", lastEventAt: Date.now() });
  const lines = renderHeader(run, 80);
  assert.equal(lines.length, 2, "D3: bottom-header ruler dropped in Slice 7");
  assert.match(lines[0]!, /^─+$/, "first line is the top ruler");
  assert.doesNotMatch(lines[1]!, /^─+$/, "second line is NOT a ruler");
});
