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
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  filterParentContext,
  filterParentContextCompact,
} from "../src/context-filter.ts";

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

test("filterParentContext: (a') drops assistant message containing excluded tool call (prose included)", () => {
  // v0.8.1 contract: any assistant message whose content array contains an
  // excluded toolCall is dropped whole — the surviving text block IS the
  // orchestration narration leak we're closing. See design §3.
  const msgs = [assistantToolCall("ensemble_spawn", "tc1", "I'll spawn an inspector")];
  const out = filterParentContext(msgs);
  assert.deepEqual(out, []);
});

test("filterParentContext: toolResult for excluded tool call is dropped (no orphan results)", () => {
  const msgs = [
    assistantToolCall("ensemble_spawn", "tc1", "spawning"),
    toolResult("tc1", "ensemble_spawn", "agent_id=oracle-7f3a"),
    user("ok thanks"),
  ];
  const out = filterParentContext(msgs);
  // Under (a'), the entire assistant orchestration turn (prose + toolCall)
  // is dropped along with its toolResult. Only the user follow-up survives.
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
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
  // Under (a') v0.8.1: the "spawning inspector" assistant turn is dropped
  // whole (prose + toolCall + matching toolResult + completion card).
  // Surviving: user, assistant(read+preface), toolResult(read),
  //            assistant("exports..."), user("now spawn..."),
  //            assistant("inspector says...").
  assert.equal(out.length, 6);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.ok(((out[1] as any).content as any[]).some((b) => b.type === "toolCall" && b.name === "read"));
  assert.equal(out[2].role, "toolResult");
  assert.equal((out[2] as any).toolName, "read");
  assert.equal(out[3].role, "assistant");
  assert.deepEqual((out[3] as any).content, [{ type: "text", text: "foo.txt exports a constant x" }]);
  assert.equal(out[4].role, "user");
  assert.equal(out[5].role, "assistant");
  // No surviving assistant message contains the dropped "spawning inspector" prose.
  for (const m of out) {
    if ((m as any).role !== "assistant") continue;
    const blocks = (m as any).content as any[];
    for (const b of blocks) {
      if (b?.type === "text") assert.doesNotMatch(b.text, /spawning inspector/i);
    }
  }
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

// ── v0.8.1 Item 1: (a') structural drop — assistant turns whose content
//    array contains any excluded toolCall are dropped whole (prose included).
//    See docs/v0.8.1-item1-design.md §3 + §6.1 A.

test("filterParentContext: (a') drops whole assistant message when prose co-occurs with excluded toolCall (regression: 2026-05-15 dogfood)", () => {
  // Witnessed bug: parent narrated "Spawning critic-X..." in the same
  // assistant turn as the ensemble_spawn toolCall; the rewrite path kept
  // the prose, the spawned critic read it as part of its brief and
  // meta-commented instead of executing.
  // Fix: any assistant message whose content contained an excluded toolCall
  // is dropped whole — prose and all.
  const msgs = [
    user("Please review the diff."),
    assistantToolCall(
      "ensemble_spawn",
      "tc1",
      "Spawning critic-X to gate the diff. 3/4 slots in use, holding the turn.",
    ),
    toolResult("tc1", "ensemble_spawn", "agent_id=critic-X"),
    customMsg(
      "ensemble-notification",
      "<sub-agent-completed>critic-X done</sub-agent-completed>",
    ),
    user("ok thanks, here is the actual brief: ..."),
  ];
  const out = filterParentContext(msgs);
  // Expected: original user, then user follow-up. Assistant orchestration
  // turn is dropped whole; toolResult dropped (excluded id); customMsg
  // dropped (ensemble-notification).
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "user");
  // Belt-and-suspenders: no surviving assistant message anywhere mentions
  // the persona id by name.
  for (const m of out) {
    if ((m as any).role !== "assistant") continue;
    const blocks = (m as any).content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "text") assert.doesNotMatch(b.text, /critic-X/i);
    }
  }
});

test("filterParentContext: (a') drops thinking + prose + excluded toolCall whole", () => {
  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should spawn an oracle now" },
      { type: "text", text: "Spawning oracle to gate." },
      { type: "toolCall", id: "tc1", name: "ensemble_spawn", arguments: {} },
    ] as any,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
  assert.deepEqual(filterParentContext([msg]), []);
});

test("filterParentContext: (a') drops mixed excluded + non-excluded toolCall + prose whole", () => {
  // Decision: any excluded toolCall in the same message ⇒ orchestration turn ⇒ drop.
  // See design §3.4. Both choices (preserve non-excluded toolCall vs. drop
  // whole turn) leave a dangling toolResult later in the slice — the
  // excluded call's result is dropped by the toolResult-of-excluded-call
  // branch in either case, and dropping the whole turn additionally orphans
  // the SURVIVING (non-excluded) call's result. We accept that orphan and
  // pick whole-turn drop because it keeps orchestration prose out of the
  // slice (the load-bearing requirement per design §3.1) and keeps the
  // rewrite path simple. Orphan toolResults are tolerated by the harness.

  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Spawning inspector and reading foo.txt." },
      { type: "toolCall", id: "tc1", name: "read", arguments: {} },
      { type: "toolCall", id: "tc2", name: "ensemble_spawn", arguments: {} },
    ] as any,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
  assert.deepEqual(filterParentContext([msg]), []);
});

test("filterParentContext: (a') does not drop assistant messages with non-excluded toolCalls (read+prose preserved)", () => {
  // Sanity: read toolCall + prose should still survive — (a') only fires
  // when an excluded toolCall is in the content array.
  const msgs = [assistantToolCall("read", "tc1", "let me look at foo.txt")];
  const out = filterParentContext(msgs);
  assert.equal(out.length, 1);
  const blocks = (out[0] as any).content as any[];
  assert.ok(blocks.some((b) => b.type === "text"));
  assert.ok(blocks.some((b) => b.type === "toolCall" && b.name === "read"));
});

test("filterParentContext: (a') applies symmetrically to subagent prefix (not just ensemble_*)", () => {
  // Same drop semantics for the legacy `subagent` extension's tool calls —
  // the trigger dispatches on the configured excludeToolPrefixes set, no
  // hard-coded ensemble_* special case.
  const msgs = [
    assistantToolCall("subagent", "tc1", "Backgrounding subagent X."),
  ];
  assert.deepEqual(filterParentContext(msgs), []);
});

// ── v0.8.1 follow-up (design §3.5): when the dropThinking-only rewrite
//    path strips a thinking block from a turn whose original stopReason
//    was "toolUse" but whose filtered content no longer contains a
//    toolCall, the message ships with a stale stopReason that doesn't
//    match its shape. Recompute conservatively: only mutate when
//    "toolUse" → no toolCall remains.

test("filterParentContext: dropThinking [thinking,text] with stopReason='toolUse' clears stale stopReason (design §3.5)", () => {
  // Latent shape-correctness bug: original [thinking, text] tagged
  // stopReason: "toolUse" gets dropThinking → [text] but the spread-copy
  // rewrite preserved "toolUse" even though no toolCall remains. After
  // the fix, stopReason is recomputed to a non-toolUse value ("stop").
  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "weighing tool options" },
      { type: "text", text: "Decided not to call a tool after all." },
    ] as any,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
  const out = filterParentContext([msg]);
  assert.equal(out.length, 1);
  const survivor = out[0] as any;
  // Pin the specific neutral value so future edits can't regress to
  // "toolUse" or to undefined (StopReason is a required field upstream).
  assert.equal(survivor.stopReason, "stop",
    "stale stopReason='toolUse' must be recomputed to 'stop' when no toolCall remains");
  // Sanity: the text block did survive.
  const blocks = survivor.content as any[];
  assert.ok(blocks.some((b) => b.type === "text" && b.text === "Decided not to call a tool after all."));
  assert.ok(blocks.every((b) => b.type !== "thinking"), "thinking must be filtered out");
});

test("filterParentContext: dropThinking [thinking,toolCall] with stopReason='toolUse' preserves justified stopReason", () => {
  // Counterpart pin: when the surviving content STILL contains a toolCall,
  // "toolUse" is justified and must NOT be over-corrected. Prevents the
  // §3.5 fix from regressing into shape (B) ("always recompute") which
  // would erase legitimate stopReason signal on the common case.
  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I'll read foo.txt" },
      { type: "toolCall", id: "tc1", name: "read", arguments: {} },
    ] as any,
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
  const out = filterParentContext([msg]);
  assert.equal(out.length, 1);
  const survivor = out[0] as any;
  assert.equal(survivor.stopReason, "toolUse",
    "stopReason='toolUse' must be preserved when a toolCall survives in the rewritten content");
  const blocks = survivor.content as any[];
  assert.ok(blocks.some((b) => b.type === "toolCall" && b.name === "read"));
  assert.ok(blocks.every((b) => b.type !== "thinking"));
});

// ── v0.10: orphan-toolResult bug fix (long conductor sessions) ─────
// Bug: when a parent assistant turn fires both ensemble_spawn AND a non-
// excluded tool (note/bash/read), the v0.8.1 design section 3 "drop whole
// message" rule discards the assistant turn but only excluded the
// ensemble_spawn callId — sibling toolResults survived as orphans,
// breaking Bedrock's invariant "every toolResult must have a preceding
// toolUse with the same id". See
// docs/bugs/ensemble-spawn-validation-error-long-conductor-sessions.md.
function assistantMixedToolCalls(
  calls: Array<{ name: string; id: string }>,
  preface?: string,
): AgentMessage {
  const content: any[] = [];
  if (preface) content.push({ type: "text", text: preface });
  for (const c of calls) {
    content.push({ type: "toolCall", id: c.id, name: c.name, arguments: {} });
  }
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

test("filterParentContext: dropped assistant turn excludes ALL sibling toolCall ids (mixed ensemble_spawn + note -> no orphan note result)", () => {
  // Reproduction of
  // docs/bugs/ensemble-spawn-validation-error-long-conductor-sessions.md.
  // Parent fires ensemble_spawn alongside `note` in the same assistant
  // turn — common in long conductor sessions juggling state saves
  // and spawns. Pre-fix, the assistant message was dropped (correct)
  // but the `note` toolResult survived as an orphan (Bedrock rejects).
  const msgs = [
    user("plan: spawn an inspector and remember that we're mid-design"),
    assistantMixedToolCalls(
      [
        { name: "ensemble_spawn", id: "es-1" },
        { name: "note", id: "note-1" },
      ],
      "Spawning inspector and saving state",
    ),
    toolResult("es-1", "ensemble_spawn", "agent_id=inspector-7f3a"),
    toolResult("note-1", "note", "saved"),
    user("ok"),
  ];
  const out = filterParentContext(msgs);
  // Both toolResults must be excluded along with the dropped assistant turn.
  // Survivors: the two user messages only.
  const toolResults = out.filter((m: any) => m.role === "toolResult");
  assert.equal(
    toolResults.length,
    0,
    "no toolResult should survive a fully-dropped assistant turn — the `note` result has no preceding toolUse",
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "user");
});

test("filterParentContext: no orphan toolResult invariant — every surviving toolResult has a preceding toolUse with the same id", () => {
  // Generalized invariant the bug-fix must preserve. Build a varied transcript
  // including: a non-dropped read+result, a dropped ensemble_spawn+bash pair,
  // and a final user message. Filter, then for every toolResult in the
  // output, assert there is a toolCall in some prior assistant message with
  // the same id.
  const msgs = [
    assistantToolCall("read", "r-1", "let me look"),
    toolResult("r-1", "read", "contents"),
    assistantMixedToolCalls(
      [
        { name: "ensemble_spawn", id: "es-2" },
        { name: "bash", id: "b-1" },
      ],
      "spawn + remember",
    ),
    toolResult("es-2", "ensemble_spawn", "agent_id=designer-4"),
    toolResult("b-1", "bash", "stdout"),
    user("continue"),
  ];
  const out = filterParentContext(msgs);
  const seenCallIds = new Set<string>();
  for (const m of out) {
    if ((m as any).role === "assistant") {
      const blocks = (m as any).content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b?.type === "toolCall" && typeof b.id === "string") {
            seenCallIds.add(b.id);
          }
        }
      }
    } else if ((m as any).role === "toolResult") {
      const callId = (m as any).toolCallId;
      assert.ok(
        typeof callId === "string" && seenCallIds.has(callId),
        `orphan toolResult callId=${callId} has no preceding toolUse — would break Bedrock`,
      );
    }
  }
});

// ── filterParentContextCompact ─────────────────────────────────────────
//
// Compact mode strips assistant TEXT blocks from the inherited transcript
// while keeping tool_use blocks, user messages, tool results, branch
// summaries and compaction summaries intact. Motivation: the parent
// conductor's narration about a failed sub-agent ("Builder X is
// auto-aborting — interpreting briefs as inherited parent narration")
// gets inhaled by the next sub-agent under `inherit_context: filtered`
// and copied as a behavioral template, producing a self-perpetuating
// refusal cascade. Compact mode breaks the cascade for builder-shaped
// personas without losing the file-ops / user-prose context they need.

test("filterParentContextCompact: empty input → empty output (no synthetic header)", () => {
  assert.deepEqual(filterParentContextCompact([]), []);
});

test("filterParentContextCompact: user prose passes through unchanged", () => {
  const msgs = [user("hello world")];
  assert.deepEqual(filterParentContextCompact(msgs), msgs);
});

test("filterParentContextCompact: no header prepended when nothing was elided", () => {
  // Only user msgs + tool ops — no assistant prose to strip → no header.
  const msgs = [
    user("read context.md"),
    assistantToolCall("read", "tc1"),
    toolResult("tc1", "read", "file contents"),
  ];
  const out = filterParentContextCompact(msgs);
  for (const m of out) {
    if ((m as any).role === "assistant" && Array.isArray((m as any).content)) {
      const hasText = ((m as any).content as any[]).some((b) => b.type === "text");
      assert.ok(!hasText, "no assistant text block should appear");
    }
  }
});

test("filterParentContextCompact: assistant text-only message → dropped, header prepended", () => {
  const msgs = [
    user("hi"),
    assistantText("here's some narration the parent emitted"),
    user("now do the work"),
  ];
  const out = filterParentContextCompact(msgs);
  // Output: [synthetic header, user, user]. The text-only assistant
  // message is dropped entirely.
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "assistant");
  const headerContent = (out[0] as any).content;
  assert.ok(Array.isArray(headerContent), "header content must be array");
  assert.equal(headerContent[0].type, "text");
  assert.match(headerContent[0].text, /\[conductor narration elided/);
  assert.match(headerContent[0].text, /1 prose block/);
  assert.equal(out[1].role, "user");
  assert.equal(out[2].role, "user");
  // Verify no leak of the parent's narration text.
  for (const m of out.slice(1)) {
    const c = (m as any).content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text") {
          assert.ok(
            !b.text.includes("here's some narration"),
            "narration leaked",
          );
        }
      }
    }
  }
});

test("filterParentContextCompact: assistant text + tool call → text stripped, tool call preserved", () => {
  const msgs = [
    user("read it"),
    assistantToolCall("read", "tc1", "I'll read the file now to understand."),
    toolResult("tc1", "read", "file contents"),
  ];
  const out = filterParentContextCompact(msgs);
  // Header (1 elided text block) + user + assistant-with-toolcall-only + toolResult.
  assert.equal(out.length, 4);
  assert.equal(out[0].role, "assistant");
  assert.match((out[0] as any).content[0].text, /1 prose block/);
  assert.equal(out[1].role, "user");
  assert.equal(out[2].role, "assistant");
  const kept = (out[2] as any).content;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, "toolCall");
  assert.equal(kept[0].name, "read");
  assert.equal(out[3].role, "toolResult");
});

test("filterParentContextCompact: tool results, bash exec, summaries pass through", () => {
  const msgs = [
    branchSummary("checkpoint A"),
    bashExec("ls -la"),
    compactionSummary("compacted prior turns"),
    assistantToolCall("read", "tc1"),
    toolResult("tc1", "read", "data"),
  ];
  const out = filterParentContextCompact(msgs);
  // No assistant prose → no header.
  assert.equal(out.length, 5);
  assert.equal(out[0].role, "branchSummary");
  assert.equal(out[1].role, "bashExecution");
  assert.equal(out[2].role, "compactionSummary");
  assert.equal((out[3] as any).role, "assistant");
  assert.equal((out[4] as any).role, "toolResult");
});

test("filterParentContextCompact: bare-string assistant content is dropped (counts as 1 elided block)", () => {
  // Defensive path — pi-agent-core normally emits arrays, but legacy
  // fixtures may have bare-string content.
  const bareString = {
    ...assistantText("anything"),
    content: "bare string narration",
  } as unknown as AgentMessage;
  const msgs = [user("hi"), bareString, user("brief")];
  const out = filterParentContextCompact(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "assistant");
  assert.match((out[0] as any).content[0].text, /1 prose block/);
});

test("filterParentContextCompact: header count reflects multiple elided blocks", () => {
  const msgs = [
    assistantText("narration A"),
    user("u1"),
    assistantText("narration B"),
    assistantToolCall("read", "tc1", "narration C"),
    toolResult("tc1", "read", "ok"),
  ];
  const out = filterParentContextCompact(msgs);
  assert.equal(out[0].role, "assistant");
  assert.match((out[0] as any).content[0].text, /3 prose block/);
});

test("filterParentContextCompact: thinking blocks already stripped by inner filter (no double-count)", () => {
  // filterParentContext drops thinking blocks; compact doesn't re-count
  // them as elided narration. Only text blocks count.
  const msgs = [
    assistantThinking("my private thinking", "visible narration"),
    user("brief"),
  ];
  const out = filterParentContextCompact(msgs);
  // Inner filter strips thinking → leaves just text → compact strips text.
  // Net elided: 1 text block.
  assert.equal(out[0].role, "assistant");
  assert.match((out[0] as any).content[0].text, /1 prose block/);
});

test("filterParentContextCompact: ensemble_* / subagent calls still dropped (delegates to inner filter)", () => {
  const msgs = [
    user("brief"),
    assistantToolCall("ensemble_spawn", "es1", "spawning a sub-agent"),
    toolResult("es1", "ensemble_spawn", "{}"),
    assistantToolCall("read", "rd1", "reading the file"),
    toolResult("rd1", "read", "data"),
  ];
  const out = filterParentContextCompact(msgs);
  // ensemble_spawn message + result both dropped by inner filter.
  for (const m of out) {
    if ((m as any).role === "assistant" && Array.isArray((m as any).content)) {
      for (const b of (m as any).content as any[]) {
        if (b.type === "toolCall") {
          assert.notEqual(b.name, "ensemble_spawn", "ensemble_spawn leaked");
        }
      }
    }
    if ((m as any).role === "toolResult") {
      assert.notEqual(
        (m as any).toolName,
        "ensemble_spawn",
        "ensemble_spawn result leaked",
      );
    }
  }
  // 'read' tool call should survive.
  const sawRead = out.some(
    (m: any) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "toolCall" && b.name === "read"),
  );
  assert.ok(sawRead, "read tool call should be preserved");
});

test(
  "filterParentContextCompact: self-perpetuating refusal cascade — verbatim parent narration is elided",
  () => {
    // Regression pin. Verbatim snippets from a witnessed seeded.jsonl
    // (~/.pi/agent/conductor/runs/builder-p66e/session/seeded.jsonl,
    // 2026-05-22) that caused builder auto-abort cascades. The parent
    // conductor's narration about a *previous* sub-agent's behavior
    // must NOT be inherited verbatim by the next sub-agent.
    const cascadeQuote =
      "Investigator nailed it. Root cause is reconcileOrphansAtStartup, not the watchdog.";
    const oracleQuote =
      "Oracle: APPROVE WITH FIXES. 4 blockers (all in-scope corrections, not redesign)";
    const inspectorQuote =
      'Inspector mapped it. The "ugly + scrolls off page" complaint maps to concrete code defects';
    const msgs = [
      user("please act on the brief at the bottom"),
      assistantText(cascadeQuote),
      assistantText(oracleQuote),
      assistantText(inspectorQuote),
      assistantToolCall("read", "tc1", "I'll start by reading context.md."),
      toolResult("tc1", "read", "# Context\n\nHere is the context."),
      user("BRIEF: implement slice 1 of the plan."),
    ];
    const out = filterParentContextCompact(msgs);

    // 1. Synthetic header announces elision (4 narration blocks:
    //    3 standalone assistant texts + 1 preface text inside toolCall msg).
    assert.equal(out[0].role, "assistant");
    assert.match(
      (out[0] as any).content[0].text,
      /\[conductor narration elided: 4 prose block/,
    );

    // 2. None of the verbatim parent narration appears in any kept
    //    text block (other than the synthetic header itself).
    for (const m of out.slice(1)) {
      const c = (m as any).content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "text") {
            assert.ok(
              !b.text.includes(cascadeQuote),
              "cascade quote leaked into sub-agent context",
            );
            assert.ok(!b.text.includes(oracleQuote), "oracle quote leaked");
            assert.ok(
              !b.text.includes(inspectorQuote),
              "inspector quote leaked",
            );
          }
        }
      }
    }

    // 3. The user's actual brief is still present as the last user msg.
    const lastUser = [...out].reverse().find((m) => m.role === "user");
    assert.ok(lastUser, "last user message preserved");
    const lastUserText =
      typeof (lastUser as any).content === "string"
        ? (lastUser as any).content
        : JSON.stringify((lastUser as any).content);
    assert.match(lastUserText, /BRIEF: implement slice 1/);

    // 4. The 'read' toolCall + its result are preserved (file knowledge
    //    survives — that's the whole point of compact over none).
    const sawReadToolCall = out.some(
      (m: any) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === "toolCall" && b.name === "read"),
    );
    const sawReadResult = out.some(
      (m: any) => m.role === "toolResult" && m.toolName === "read",
    );
    assert.ok(sawReadToolCall, "read toolCall preserved");
    assert.ok(sawReadResult, "read toolResult preserved");
  },
);
