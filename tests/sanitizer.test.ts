/**
 * Tests for sanitizeToolNames — defense-in-depth sanitizer for
 * malformed `toolCall.name` values that violate the strictest provider
 * charset (Bedrock's `[a-zA-Z0-9_-]+`).
 *
 * Spec: design.md (designer-w2a5, oracle-eur8 PASS-WITH-NOTES).
 *
 * RED-step Fixture A is the byte-exact `samfp/Rosie` wedge confirmed
 * via lines 106–107 of the wedged JSONL — `'ensemble_kill" >\n</invoke>'`
 * (24 bytes).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { filterParentContext } from "../src/context-filter.ts";
import {
  TOOL_NAME_REGEX,
  sanitizeToolNames,
  slugifyForBedrock,
  type SanitizeReport,
} from "../src/sanitizer.ts";

// ── Builders ──────────────────────────────────────────────────────────

function assistantWithToolCall(
  toolCallId: string,
  name: string,
  opts?: { thinking?: string; preface?: string },
): AgentMessage {
  const content: any[] = [];
  if (opts?.thinking)
    content.push({ type: "thinking", thinking: opts.thinking, thinkingSignature: "" });
  if (opts?.preface) content.push({ type: "text", text: opts.preface });
  content.push({ type: "toolCall", id: toolCallId, name, arguments: {} });
  return {
    role: "assistant",
    content,
    api: "bedrock-converse-stream" as any,
    provider: "amazon-claude-code" as any,
    model: "us.anthropic.claude-opus-4-7",
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

function assistantMultiToolCall(
  blocks: Array<{ id: string; name: string }>,
): AgentMessage {
  const content = blocks.map((b) => ({
    type: "toolCall",
    id: b.id,
    name: b.name,
    arguments: {},
  }));
  return {
    role: "assistant",
    content: content as any,
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

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
}

// ── Fixture A: byte-exact samfp/Rosie wedge (RED-step) ────────────────

const BAD = 'ensemble_kill" >\n</invoke>';
const GOOD = "ensemble_kill_invoke_INVALID";

test("sanitizeToolNames: Fixture A — rewrites byte-exact samfp/Rosie wedge toolCall.name", () => {
  const fixture: AgentMessage[] = [
    assistantWithToolCall("tooluse_PPo6RdUryeEr1TS4iXjQRW", BAD, {
      thinking: "I'm going to remove the analyst…",
    }),
    toolResult(
      "tooluse_PPo6RdUryeEr1TS4iXjQRW",
      BAD,
      `Tool ${BAD} not found`,
    ),
  ];
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames(fixture, {
    onSanitize: (r) => reports.push(r),
  });

  // (1) returned a NEW array, not the input reference (pure function).
  assert.notStrictEqual(out, fixture, "expected a new array reference");

  // (2) toolCall.name rewritten to the slugified placeholder.
  const assistantMsg = out[0] as any;
  const toolCallBlock = assistantMsg.content.find((b: any) => b.type === "toolCall");
  assert.ok(toolCallBlock, "toolCall block present");
  assert.equal(
    toolCallBlock.name,
    GOOD,
    `expected toolCall.name = ${GOOD}, got ${JSON.stringify(toolCallBlock.name)}`,
  );

  // (3) toolResult.toolName mirror.
  const trMsg = out[1] as any;
  assert.equal(trMsg.toolName, GOOD, "toolResult.toolName mirror");

  // (4) toolResult content text rewritten — bad substring gone, replaced by placeholder.
  assert.equal(
    trMsg.content[0].text,
    `Tool ${GOOD} not found`,
    "toolResult content text rewritten",
  );

  // (5) opaque ids preserved.
  assert.equal(toolCallBlock.id, "tooluse_PPo6RdUryeEr1TS4iXjQRW");
  assert.equal(trMsg.toolCallId, "tooluse_PPo6RdUryeEr1TS4iXjQRW");

  // (6) thinking block preserved (sanitizer does not touch thinking; that's filterParentContext's domain).
  const thinkingBlock = assistantMsg.content.find((b: any) => b.type === "thinking");
  assert.ok(thinkingBlock, "thinking block preserved");
  assert.equal(thinkingBlock.thinking, "I'm going to remove the analyst…");

  // (7) onSanitize fires once with the right report.
  assert.equal(reports.length, 1, "onSanitize called once");
  assert.deepEqual(reports[0], {
    toolCallId: "tooluse_PPo6RdUryeEr1TS4iXjQRW",
    originalName: BAD,
    sanitizedName: GOOD,
  });

  // (8) input not mutated — the bad name is still on the input fixture.
  const inAssistant = fixture[0] as any;
  const inToolCall = inAssistant.content.find((b: any) => b.type === "toolCall");
  assert.equal(inToolCall.name, BAD, "input toolCall.name not mutated");
  const inTr = fixture[1] as any;
  assert.equal(inTr.toolName, BAD, "input toolResult.toolName not mutated");
  assert.equal(
    inTr.content[0].text,
    `Tool ${BAD} not found`,
    "input toolResult content text not mutated",
  );

  // (9) regex sanity: GOOD passes the regex, BAD does not.
  assert.equal(TOOL_NAME_REGEX.test(GOOD), true);
  assert.equal(TOOL_NAME_REGEX.test(BAD), false);
});

// ── Fixture B: already-clean messages — idempotence pin ──────────────

test("sanitizeToolNames: Fixture B — already-clean messages pass through; onSanitize not called", () => {
  const fixture: AgentMessage[] = [
    assistantWithToolCall("tc1", "read"),
    toolResult("tc1", "read", "file contents"),
    assistantWithToolCall("tc2", "ensemble_spawn"),
  ];
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames(fixture, {
    onSanitize: (r) => reports.push(r),
  });
  assert.equal(reports.length, 0, "no reports on clean input");
  // Names unchanged.
  const tc1 = (out[0] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc1.name, "read");
  assert.equal((out[1] as any).toolName, "read");
  const tc2 = (out[2] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc2.name, "ensemble_spawn");
});

// ── Fixture C: multiple corruptions in one assistant message ─────────

test("sanitizeToolNames: Fixture C — multiple bad toolCalls in one turn rewritten independently; clean ones untouched", () => {
  const msg = assistantMultiToolCall([
    { id: "tc1", name: "bad name with spaces" },
    { id: "tc2", name: "ensemble:weird" },
    { id: "tc3", name: "fine_tool" },
  ]);
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames([msg], {
    onSanitize: (r) => reports.push(r),
  });
  const blocks = (out[0] as any).content;
  assert.equal(blocks.length, 3, "all three blocks retained, none dropped");
  assert.equal(blocks[0].name, "bad_name_with_spaces_INVALID");
  assert.equal(blocks[1].name, "ensemble_weird_INVALID");
  assert.equal(blocks[2].name, "fine_tool", "clean name unchanged");
  assert.equal(reports.length, 2, "onSanitize called once per bad tool");
  // Order preserved.
  assert.deepEqual(
    reports.map((r) => r.toolCallId),
    ["tc1", "tc2"],
  );
});

// ── Fixture D: orphan toolCall (no matching toolResult) ──────────────

test("sanitizeToolNames: Fixture D — orphan toolCall (no matching toolResult) sanitized; no throw", () => {
  const fixture = [assistantWithToolCall("tc1", BAD)];
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames(fixture, {
    onSanitize: (r) => reports.push(r),
  });
  const tc = (out[0] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc.name, GOOD);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].toolCallId, "tc1");
  assert.equal(reports[0].originalName, BAD);
  assert.equal(reports[0].sanitizedName, GOOD);
});

// ── Fixture E: orphan toolResult (no matching toolCall) ──────────────

test("sanitizeToolNames: Fixture E — orphan toolResult with bad toolName sanitized in isolation", () => {
  const fixture = [toolResult("tc1", BAD, "x")];
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames(fixture, {
    onSanitize: (r) => reports.push(r),
  });
  assert.equal((out[0] as any).toolName, GOOD);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].toolCallId, "tc1");
  assert.equal(reports[0].originalName, BAD);
});

// ── Fixture F: slug edge cases (table-driven) ────────────────────────

test("sanitizeToolNames: Fixture F — slugifyForBedrock table", () => {
  const cases: Array<[string, string]> = [
    [BAD, GOOD],
    ["", "INVALID_TOOL_NAME"],
    ["!@#$%^&*()", "INVALID_TOOL_NAME"],
    ["__a__", "a_INVALID"],
    ["a".repeat(100), `${"a".repeat(64)}_INVALID`],
    ["ensemble.kill", "ensemble_kill_INVALID"],
    ["ensemble  kill", "ensemble_kill_INVALID"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      slugifyForBedrock(input),
      expected,
      `slugifyForBedrock(${JSON.stringify(input)})`,
    );
  }
  // Already-valid name does not need slugification at the call-site (the
  // sanitizer never invokes the placeholder builder for valid names),
  // but slugifyForBedrock itself is total — passes valid input through
  // with the _INVALID suffix appended. Document the behavior.
  assert.equal(slugifyForBedrock("ensemble_kill"), "ensemble_kill_INVALID");
});

// ── Fixture G: idempotence ───────────────────────────────────────────

test("sanitizeToolNames: Fixture G — second pass over sanitized output is a no-op (zero reports)", () => {
  const fixture: AgentMessage[] = [
    assistantWithToolCall("tc1", BAD),
    toolResult("tc1", BAD, `Tool ${BAD} not found`),
  ];
  const onceReports: SanitizeReport[] = [];
  const once = sanitizeToolNames(fixture, {
    onSanitize: (r) => onceReports.push(r),
  });
  const twiceReports: SanitizeReport[] = [];
  const twice = sanitizeToolNames(once, {
    onSanitize: (r) => twiceReports.push(r),
  });
  assert.equal(onceReports.length, 1, "first pass reports once");
  assert.equal(twiceReports.length, 0, "second pass reports zero");
  assert.deepEqual(twice, once, "second pass output deep-equals first pass");
});

// ── Fixture H: orthogonality with v0.8.1 Item 1's filterParentContext ─

test("sanitizeToolNames: Fixture H — identity over filterParentContext fixtures (v0.8.1 orthogonality pin)", () => {
  // Representative slice from tests/context-filter.test.ts: assistant
  // turn whose content includes an excluded `ensemble_spawn` toolCall.
  // sanitizeToolNames must be a no-op over this — `ensemble_spawn` is a
  // valid name. Pins the orthogonality claim with a runnable test.
  const orchestrationTurn = assistantWithToolCall("tc1", "ensemble_spawn", {
    preface: "I'll spawn an inspector",
  });
  const followup = toolResult("tc1", "ensemble_spawn", "agent_id=oracle-7f3a");
  const inputs: AgentMessage[] = [orchestrationTurn, followup];

  // Sanitizer is identity over these fixtures.
  const reports: SanitizeReport[] = [];
  const sanitizedFirst = sanitizeToolNames(inputs, {
    onSanitize: (r) => reports.push(r),
  });
  assert.equal(reports.length, 0, "sanitizer must not fire on legitimate ensemble_spawn");
  assert.deepEqual(sanitizedFirst, inputs, "sanitizer output deep-equals input");

  // And running the filter first then the sanitizer (or sanitizer-then-
  // filter) yields identical results — the two are commutative on
  // legitimate inputs because the sanitizer is identity here.
  const filteredThenSanitized = sanitizeToolNames(filterParentContext(inputs));
  const sanitizedThenFiltered = filterParentContext(sanitizeToolNames(inputs));
  assert.deepEqual(filteredThenSanitized, sanitizedThenFiltered);
});

// ── Gated text rewrite (criterion 12) ────────────────────────────────

test("sanitizeToolNames: gated text rewrite — toolResult text without bad substring is untouched", () => {
  // Builder-trap: mirror toolName, but only rewrite text when it embeds
  // the original bad name. Catches a builder who unconditionally
  // rewrites all toolResult text content.
  const fixture: AgentMessage[] = [
    assistantWithToolCall("tc1", BAD),
    toolResult("tc1", BAD, "unrelated content with no bad substring"),
  ];
  const out = sanitizeToolNames(fixture);
  const tr = out[1] as any;
  assert.equal(tr.toolName, GOOD, "toolName mirror happens");
  assert.equal(
    tr.content[0].text,
    "unrelated content with no bad substring",
    "text without bad substring is identity",
  );
});

// ── Multiple toolResults sharing one toolCallId ───────────────────────

test("sanitizeToolNames: multiple toolResults sharing one bad toolCallId all rewritten", () => {
  const fixture: AgentMessage[] = [
    assistantWithToolCall("tc1", BAD),
    toolResult("tc1", BAD, `Tool ${BAD} not found`),
    toolResult("tc1", BAD, `partial: ${BAD}`),
  ];
  const reports: SanitizeReport[] = [];
  const out = sanitizeToolNames(fixture, {
    onSanitize: (r) => reports.push(r),
  });
  // Both toolResults sanitized; report is still ONCE per toolCallId
  // (dedup pinned).
  assert.equal((out[1] as any).toolName, GOOD);
  assert.equal((out[2] as any).toolName, GOOD);
  assert.equal((out[1] as any).content[0].text, `Tool ${GOOD} not found`);
  assert.equal((out[2] as any).content[0].text, `partial: ${GOOD}`);
  assert.equal(reports.length, 1, "one report per unique toolCallId");
});

// ── Pluggable isValid (charset escape hatch) ──────────────────────────

test("sanitizeToolNames: SanitizeOptions.isValid override is honored", () => {
  // Provider with a stricter rule that disallows underscores. The
  // legitimate name `read` passes; `ensemble_spawn` is rejected and
  // sanitized.
  const fixture: AgentMessage[] = [assistantWithToolCall("tc1", "ensemble_spawn")];
  const out = sanitizeToolNames(fixture, {
    isValid: (n) => /^[a-zA-Z]+$/.test(n),
  });
  const tc = (out[0] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc.name, "ensemble_spawn_INVALID");
});

// ── Pluggable buildPlaceholder ───────────────────────────────────────

test("sanitizeToolNames: SanitizeOptions.buildPlaceholder override is honored", () => {
  const fixture: AgentMessage[] = [assistantWithToolCall("tc1", BAD)];
  const out = sanitizeToolNames(fixture, {
    buildPlaceholder: () => "CUSTOM_PLACEHOLDER",
  });
  const tc = (out[0] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc.name, "CUSTOM_PLACEHOLDER");
});
