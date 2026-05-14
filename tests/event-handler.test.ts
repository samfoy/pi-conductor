/**
 * Tests for applyEvent — the pure event handler extracted from spawnRun.
 *
 * applyEvent takes a Run and a parsed JSON event, mutates the Run state in
 * place, and returns an intent telling the caller what to do next:
 *   - { kind: "none" }             — unknown event, ignore
 *   - { kind: "updated" }          — run state changed, notify listeners
 *   - { kind: "finalize", status, exitCode } — caller must finalize the run
 *
 * applyEvent is pure with respect to I/O: it does NOT touch disk, network,
 * subprocesses, or the registry. The caller (processLine inside spawnRun)
 * is responsible for I/O and listener notification.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyEvent, type EventEffect } from "../src/event-handler.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(): Run {
  return {
    id: "tester-abcd",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
  };
}

test("applyEvent: unknown event type returns kind=none", () => {
  const run = makeRun();
  const before = JSON.stringify(run);
  const r = applyEvent(run, { type: "something_we_dont_know_about" });
  assert.deepEqual(r satisfies EventEffect, { kind: "none" });
  assert.equal(JSON.stringify(run), before, "run state must be unchanged");
});

test("applyEvent: malformed event (null) returns kind=none", () => {
  const run = makeRun();
  const r = applyEvent(run, null);
  assert.deepEqual(r, { kind: "none" });
});

test("applyEvent: malformed event (no type field) returns kind=none", () => {
  const run = makeRun();
  const r = applyEvent(run, { hello: "world" });
  assert.deepEqual(r, { kind: "none" });
});

test("applyEvent: agent_end finalizes with completed/0", () => {
  const run = makeRun();
  const r = applyEvent(run, { type: "agent_end" });
  assert.deepEqual(r, { kind: "finalize", status: "completed", exitCode: 0 });
});

test("applyEvent: turn_end with no tool calls and stopReason=stop finalizes", () => {
  const run = makeRun();
  const event = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
      stopReason: "stop",
    },
  };
  const r = applyEvent(run, event);
  assert.deepEqual(r, { kind: "finalize", status: "completed", exitCode: 0 });
});

test("applyEvent: turn_end with tool calls does NOT finalize", () => {
  const run = makeRun();
  const event = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "running…" },
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
      ],
      stopReason: "tool_use",
    },
  };
  const r = applyEvent(run, event);
  // turn_end is just a marker; the caller does not finalize.
  // The actual message is pushed by message_end, not turn_end.
  assert.notEqual(r.kind, "finalize");
});

test("applyEvent: turn_end with stopReason=error does NOT finalize as completed", () => {
  // The stop-reason guard inside turn_end is meant to keep us from
  // claiming "completed" when the model errored. It still doesn't
  // finalize as completed; the caller will see a process exit instead.
  const run = makeRun();
  const event = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
    },
  };
  const r = applyEvent(run, event);
  assert.notDeepEqual(r, { kind: "finalize", status: "completed", exitCode: 0 });
});

test("applyEvent: turn_end with stopReason=aborted does NOT finalize as completed", () => {
  const run = makeRun();
  const event = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "aborted",
    },
  };
  const r = applyEvent(run, event);
  assert.notDeepEqual(r, { kind: "finalize", status: "completed", exitCode: 0 });
});

test("applyEvent: turn_end with no message returns kind=none", () => {
  const run = makeRun();
  const r = applyEvent(run, { type: "turn_end" });
  assert.deepEqual(r, { kind: "none" });
});

test("applyEvent: message_end pushes the assistant message and updates usage", () => {
  const run = makeRun();
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, cost: { total: 0.001 } },
      model: "anthropic/claude-sonnet-4",
      stopReason: "stop",
    },
  };
  const r = applyEvent(run, event);
  assert.deepEqual(r, { kind: "updated" });
  assert.equal(run.messages.length, 1);
  assert.equal(run.usage.turns, 1);
  assert.equal(run.usage.input, 100);
  assert.equal(run.usage.output, 20);
  assert.equal(run.usage.cacheRead, 50);
  assert.equal(run.usage.cacheWrite, 5);
  assert.equal(run.usage.cost, 0.001);
  assert.equal(run.model, "anthropic/claude-sonnet-4");
  assert.equal(run.stopReason, "stop");
});

test("applyEvent: message_end accumulates usage across multiple assistant turns", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      usage: { input: 100, output: 20, cost: { total: 0.001 } },
    },
  });
  applyEvent(run, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      usage: { input: 50, output: 30, cost: { total: 0.002 } },
    },
  });
  assert.equal(run.usage.turns, 2);
  assert.equal(run.usage.input, 150);
  assert.equal(run.usage.output, 50);
  assert.equal(run.usage.cost, 0.003);
});

test("applyEvent: message_end with no usage field doesn't crash", () => {
  const run = makeRun();
  const r = applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  assert.deepEqual(r, { kind: "updated" });
  assert.equal(run.usage.turns, 1);
  assert.equal(run.usage.input, 0);
});

test("applyEvent: message_end model is set only on first assistant message (sticky)", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], model: "first/model" },
  });
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], model: "second/model" },
  });
  assert.equal(run.model, "first/model", "first model wins");
});

test("applyEvent: message_end errorMessage is sticky on first occurrence", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], errorMessage: "first error" },
  });
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], errorMessage: "second error" },
  });
  assert.equal(run.errorMessage, "first error");
});

test("applyEvent: message_end stopReason is overwritten on every assistant message", () => {
  // stopReason reflects the LATEST assistant turn, so it should overwrite.
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "tool_use" },
  });
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "stop" },
  });
  assert.equal(run.stopReason, "stop");
});

test("applyEvent: message_end derives lastToolCall from a bash toolCall part", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "toolCall", name: "bash", arguments: { command: "ls /tmp" } },
      ],
    },
  });
  assert.equal(run.lastToolCall, "$ ls /tmp");
});

test("applyEvent: message_end derives lastToolCall from a read toolCall part", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x.md" } }],
    },
  });
  assert.equal(run.lastToolCall, "read /tmp/x.md");
});

test("applyEvent: message_end with multiple tool calls keeps the last one", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", name: "grep", arguments: { pattern: "TODO" } },
      ],
    },
  });
  assert.equal(run.lastToolCall, "grep TODO");
});

test("applyEvent: message_end with non-assistant role pushes message, no usage change", () => {
  const run = makeRun();
  applyEvent(run, {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
  assert.equal(run.messages.length, 1);
  assert.equal(run.usage.turns, 0);
});

test("applyEvent: message_end with no message field returns kind=none", () => {
  const run = makeRun();
  const r = applyEvent(run, { type: "message_end" });
  assert.deepEqual(r, { kind: "none" });
  assert.equal(run.messages.length, 0);
});

test("applyEvent: tool_result_end pushes the message and reports updated", () => {
  const run = makeRun();
  const event = {
    type: "tool_result_end",
    message: {
      role: "toolResult",
      content: [{ type: "toolResult", toolUseId: "abc", text: "OK" }],
    },
  };
  const r = applyEvent(run, event);
  assert.deepEqual(r, { kind: "updated" });
  assert.equal(run.messages.length, 1);
});

test("applyEvent: tool_result_end with no message field returns kind=none", () => {
  const run = makeRun();
  const r = applyEvent(run, { type: "tool_result_end" });
  assert.deepEqual(r, { kind: "none" });
});

test("applyEvent: messages array is mutated in place (caller sees updates without re-fetch)", () => {
  const run = makeRun();
  const messagesRef = run.messages;
  applyEvent(run, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  });
  assert.equal(messagesRef, run.messages, "messages array identity preserved");
  assert.equal(messagesRef.length, 1);
});
