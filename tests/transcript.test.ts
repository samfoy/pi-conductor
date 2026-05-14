/**
 * Tests for renderTranscript — the pure renderer that turns a Run's message
 * history into the line array that the focused-stream overlay displays.
 *
 * Pure: takes a Run + view options, returns string[]. No TUI imports, no
 * theme dependency at this layer. Styling happens in the Component layer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  renderTranscript,
  renderHeader,
  renderFooter,
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
  // First line should be a turn header, then the text body.
  assert.equal(lines.length >= 2, true, "should have at least a header + body");
  const joined = lines.join("\n");
  assert.match(joined, /Hello world/);
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
  // No line may exceed the width.
  for (const line of lines) {
    assert.equal(line.length <= 40, true, `line too long: "${line}"`);
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

test("renderTranscript: thinking blocks are hidden by default", () => {
  const run = makeRun({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should check the auth flow first" },
          { type: "text", text: "Let me investigate." },
        ],
      } as any,
    ],
  });
  const lines = renderTranscript(run, { ...DEFAULT_OPTS, showThinking: false });
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /I should check the auth flow/);
  assert.match(joined, /Let me investigate/);
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

test("renderTranscript: multiple assistant turns are separated by a turn header", () => {
  const run = makeRun({
    messages: [
      { role: "assistant", content: [{ type: "text", text: "first" }] } as any,
      { role: "assistant", content: [{ type: "text", text: "second" }] } as any,
    ],
  });
  const lines = renderTranscript(run, DEFAULT_OPTS);
  // Look for at least two turn separators (e.g. "── turn 1 ──", "── turn 2 ──")
  const headerCount = lines.filter((l: string) => /turn\s+\d+/i.test(l)).length;
  assert.equal(headerCount >= 2, true, "expected at least two turn headers");
});

// ── renderHeader ──────────────────────────────────────────────────────

test("renderHeader: shows persona, id, status, elapsed", () => {
  const run = makeRun({
    persona: "oracle",
    id: "oracle-7f3a",
    status: "running",
    startTime: Date.now() - 65_000,
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
    assert.equal(line.length <= 30, true, `header line exceeded width: "${line}"`);
  }
});

// ── renderFooter ──────────────────────────────────────────────────────

test("renderFooter: includes the Esc-to-close hint", () => {
  const lines = renderFooter(80);
  const joined = lines.join("\n");
  assert.match(joined, /Esc/);
  assert.match(joined, /close|return|back/i);
});

test("renderFooter: includes Tab-to-cycle hint", () => {
  const joined = renderFooter(80).join("\n");
  assert.match(joined, /Tab/);
});

test("renderFooter: includes c (collapse) and t (thinking) hints", () => {
  const joined = renderFooter(80).join("\n");
  assert.match(joined, /\bc\b/);
  assert.match(joined, /\bt\b/);
});

test("renderFooter: includes 's' send hint", () => {
  const joined = renderFooter(80).join("\n");
  assert.match(joined, /\bs\b/);
  assert.match(joined, /send/i);
});

test("renderFooter: never exceeds the requested width", () => {
  const lines = renderFooter(30);
  for (const line of lines) {
    assert.equal(line.length <= 30, true, `footer line too long: "${line}"`);
  }
});
