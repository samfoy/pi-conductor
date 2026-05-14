/**
 * Tests for filterParentContext — the pure filter that decides what slice
 * of the parent conductor's conversation should be inherited by a sub-agent
 * spawned with `inherit_context: filtered`.
 *
 * Spec (PRD §"Context inheritance"):
 *   Include: user prose, assistant prose, file reads/writes, the explicit task.
 *   Exclude: ensemble_* tool calls + results, subagent tool calls,
 *            ensemble-notification CustomMessages, BashExecutionMessages
 *            with excludeFromContext=true.
 *   Preserve: BranchSummary / CompactionSummary (they are the prose abridgement).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { filterParentContext } from "../src/context-filter.ts";

// ── Builders ──────────────────────────────────────────────────────────

function user(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: 0,
  } as AgentMessage;
}

function assistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

function assistantToolCall(
  toolName: string,
  toolCallId: string,
  preface?: string,
): AgentMessage {
  const content: any[] = [];
  if (preface) content.push({ type: "text", text: preface });
  content.push({
    type: "toolCall",
    id: toolCallId,
    name: toolName,
    arguments: {},
  });
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
}

function bashExec(command: string, exclude = false): AgentMessage {
  return {
    role: "bashExecution",
    command,
    output: "",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext: exclude,
    timestamp: 0,
  } as AgentMessage;
}

function customMsg(customType: string, content = ""): AgentMessage {
  return {
    role: "custom",
    customType,
    content,
    display: true,
    timestamp: 0,
  } as AgentMessage;
}

function assistantThinking(thinking: string, text?: string): AgentMessage {
  const content: any[] = [{ type: "thinking", thinking }];
  if (text) content.push({ type: "text", text });
  return {
    role: "assistant",
    content,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

function branchSummary(summary: string): AgentMessage {
  return {
    role: "branchSummary",
    summary,
    fromId: "abc",
    timestamp: 0,
  } as AgentMessage;
}

function compactionSummary(summary: string): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore: 1000,
    timestamp: 0,
  } as AgentMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────

test("filterParentContext: empty input → empty output", () => {
  assert.deepEqual(filterParentContext([]), []);
});

test("filterParentContext: user prose passes through", () => {
  const msgs = [user("hello world")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: assistant text-only message passes through unchanged", () => {
  const msgs = [assistantText("here's an explanation")];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "assistant");
  assert.deepEqual((out[0] as any).content, [{ type: "text", text: "here's an explanation" }]);
});

test("filterParentContext: tool-call-only assistant message is dropped (excluded tool)", () => {
  const msgs = [assistantToolCall("ensemble_spawn", "tc1")];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: assistant message with prose + excluded tool call → keeps prose, drops call", () => {
  const msgs = [assistantToolCall("ensemble_spawn", "tc1", "I'll spawn an inspector")];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 1);
  assert.deepEqual((out[0] as any).content, [
    { type: "text", text: "I'll spawn an inspector" },
  ]);
});

test("filterParentContext: toolResult for excluded tool call is dropped (no orphan results)", () => {
  const msgs = [
    assistantToolCall("ensemble_spawn", "tc1", "spawning"),
    toolResult("tc1", "ensemble_spawn", "agent_id=oracle-7f3a"),
    user("ok thanks"),
  ];
  const out = filterParentContext(msgs);
  // Only the prose preface from the assistant + the user follow-up survive.
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[1].role, "user");
});

test("filterParentContext: read tool call + result pass through (file knowledge is useful)", () => {
  const msgs = [
    assistantToolCall("read", "tc1", "let me look"),
    toolResult("tc1", "read", "file contents"),
  ];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "assistant");
  // The toolCall block is preserved on the assistant message.
  const blocks = (out[0] as any).content;
  assert.ok(blocks.some((b: any) => b.type === "toolCall" && b.name === "read"));
  assert.equal(out[1].role, "toolResult");
  assert.equal((out[1] as any).toolName, "read");
});

test("filterParentContext: write tool call + result pass through", () => {
  const msgs = [
    assistantToolCall("write", "tc2"),
    toolResult("tc2", "write", "ok"),
  ];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 2);
});

test("filterParentContext: bash tool call passes through", () => {
  const msgs = [
    assistantToolCall("bash", "tc3"),
    toolResult("tc3", "bash", "stdout"),
  ];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 2);
});

test("filterParentContext: BashExecutionMessage passes through by default", () => {
  const msgs = [bashExec("ls -la", false)];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: BashExecutionMessage with excludeFromContext=true is dropped", () => {
  const msgs = [bashExec("cat secret", true)];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: subagent tool call + result are dropped", () => {
  const msgs = [
    assistantToolCall("subagent", "tc4"),
    toolResult("tc4", "subagent", "spawned"),
  ];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: ensemble_* tool calls (all variants) are dropped", () => {
  const msgs = [
    assistantToolCall("ensemble_spawn", "a"),
    assistantToolCall("ensemble_send", "b"),
    assistantToolCall("ensemble_list", "c"),
    assistantToolCall("ensemble_status", "d"),
    assistantToolCall("ensemble_pause", "e"),
    assistantToolCall("ensemble_resume", "f"),
    assistantToolCall("ensemble_focus", "g"),
    toolResult("a", "ensemble_spawn", ""),
    toolResult("b", "ensemble_send", ""),
  ];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: ensemble-notification CustomMessages are dropped", () => {
  const msgs = [
    customMsg("ensemble-notification", "<sub-agent-completed>oracle-7f3a finished</sub-agent-completed>"),
  ];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: unrelated CustomMessages pass through", () => {
  const msgs = [customMsg("auto-work-logger", "logged daily note")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: BranchSummaryMessage is preserved", () => {
  const msgs = [branchSummary("we explored approach A and abandoned it")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: CompactionSummaryMessage is preserved", () => {
  const msgs = [compactionSummary("earlier the user discussed X and Y")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: realistic mixed sequence — keeps prose & file ops, drops orchestration", () => {
  const msgs = [
    user("read foo.txt and tell me what it does"),
    assistantToolCall("read", "r1", "looking now"),
    toolResult("r1", "read", "// hello\nexport const x = 1;"),
    assistantText("foo.txt exports a constant x"),
    user("now spawn an inspector to audit it"),
    assistantToolCall("ensemble_spawn", "es1", "spawning inspector"),
    toolResult("es1", "ensemble_spawn", "agent_id=inspector-1234"),
    customMsg("ensemble-notification", "<sub-agent-completed>inspector-1234 done</sub-agent-completed>"),
    assistantText("inspector says it's fine"),
  ];
  const out = filterParentContext(msgs);
  // Expected: user, assistant(read+preface), toolResult(read), assistant("exports..."),
  //           user("now spawn..."), assistant("spawning inspector" prose only),
  //           assistant("inspector says...")
  assert.equal(out.length, 7);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.ok(((out[1] as any).content as any[]).some((b) => b.type === "toolCall" && b.name === "read"));
  assert.equal(out[2].role, "toolResult");
  assert.equal((out[2] as any).toolName, "read");
  assert.equal(out[3].role, "assistant");
  assert.deepEqual((out[3] as any).content, [{ type: "text", text: "foo.txt exports a constant x" }]);
  assert.equal(out[4].role, "user");
  assert.equal(out[5].role, "assistant");
  // The 'spawning inspector' assistant message should retain prose, drop the toolCall.
  const blocks5 = (out[5] as any).content as any[];
  assert.ok(blocks5.every((b) => b.type !== "toolCall"));
  assert.ok(blocks5.some((b) => b.type === "text" && b.text === "spawning inspector"));
  assert.equal(out[6].role, "assistant");
});

test("filterParentContext: custom excludeToolPrefixes overrides defaults", () => {
  // With an empty exclude list, ensemble_spawn now passes through.
  const msgs = [
    assistantToolCall("ensemble_spawn", "x"),
    toolResult("x", "ensemble_spawn", "ok"),
  ];
  const out = filterParentContext(msgs, { excludeToolPrefixes: [] });
  assert.equal(out.length, 2);
});

test("filterParentContext: dropBashExcludeFromContext=false retains excluded bash entries", () => {
  const msgs = [bashExec("cat secret", true)];
  const out = filterParentContext(msgs, { dropBashExcludeFromContext: false });
  assert.equal(out.length, 1);
});

test("filterParentContext: orphan toolResult (no matching call in input) is preserved", () => {
  // Defensive: if the parent's first user-visible message is a toolResult
  // because earlier messages were already pruned, we don't want to drop it.
  // It only gets dropped when its toolCallId belongs to an excluded call we
  // also saw in this same filter pass.
  const msgs = [toolResult("xyz", "read", "leftover")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});

test("filterParentContext: thinking blocks are dropped from assistant messages by default", () => {
  // Thinking is the parent's internal reasoning. It often contains
  // orchestration plans ("I'll spawn an inspector then a redteam...") and
  // can quote the conductor system-prompt addendum verbatim. Drop it.
  const msgs = [assistantThinking("I should spawn an inspector to find bugs", "On it.")];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 1);
  const blocks = (out[0] as any).content as any[];
  assert.ok(blocks.every((b) => b.type !== "thinking"), "thinking must be filtered out");
  assert.ok(blocks.some((b) => b.type === "text" && b.text === "On it."));
});

test("filterParentContext: thinking-only assistant message is dropped entirely", () => {
  const msgs = [assistantThinking("internal reasoning only")];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: thinking + excluded toolCall → message dropped (no remaining content)", () => {
  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I'll spawn an inspector" },
      { type: "toolCall", id: "tc1", name: "ensemble_spawn", arguments: {} },
    ] as any,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
  assert.deepEqual(filterParentContext([msg]), []);
});

test("filterParentContext: subagent-* CustomMessages are dropped (pi-essentials/subagent leak)", () => {
  // pi-essentials/subagent emits subagent-notify, subagent_control_notice,
  // and subagent-slash-result CustomMessages when both extensions are
  // loaded in the same parent session. None of those should reach a
  // pi-conductor sub-agent.
  const msgs = [
    customMsg("subagent-notify", "subagent X completed"),
    customMsg("subagent_control_notice", "subagent paused"),
    customMsg("subagent-slash-result", "slash command output"),
  ];
  assert.deepEqual(filterParentContext(msgs), []);
});

test("filterParentContext: unrelated CustomMessage types still pass through", () => {
  const msgs = [customMsg("sub-task-progress", "50%"), customMsg("auto-work-logger", "x")];
  assert.deepEqual(filterParentContext(msgs), msgs);
});
