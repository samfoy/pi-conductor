/**
 * Tests for `isNonSubstantiveFinalMessage` (v0.8.1 Item 4).
 *
 * Pin each of the 3 OR-conditions independently plus a positive case.
 * The helper is pure; no I/O fixtures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  isNonSubstantiveFinalMessage,
  SUBSTANTIVE_MIN_CHARS,
} from "../src/substance-check.ts";

function asst(content: any[]): AgentMessage {
  return { role: "assistant", content } as unknown as AgentMessage;
}

const LONG_TEXT = "x".repeat(SUBSTANTIVE_MIN_CHARS + 50);

test("isNonSubstantiveFinalMessage: substantive text returns warn=false", () => {
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: LONG_TEXT }])]);
  assert.equal(r.warn, false);
  assert.equal(r.reason, undefined);
});

test("isNonSubstantiveFinalMessage: condition 1 — last block is thinking_* triggers no_text", () => {
  const r = isNonSubstantiveFinalMessage([
    asst([
      { type: "text", text: LONG_TEXT },
      { type: "thinking", thinking: "still pondering..." },
    ]),
  ]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "no_text");
  assert.match(r.message ?? "", /last block: thinking/);
});

test("isNonSubstantiveFinalMessage: condition 1 — content with only toolUse + thinking triggers no_text", () => {
  const r = isNonSubstantiveFinalMessage([
    asst([
      { type: "toolUse", id: "1", name: "bash", input: { command: "ls" } },
      { type: "thinking_redacted", data: "..." },
    ]),
  ]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "no_text");
});

test("isNonSubstantiveFinalMessage: condition 1 — empty assistant content triggers no_text", () => {
  const r = isNonSubstantiveFinalMessage([asst([])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "no_text");
});

test("isNonSubstantiveFinalMessage: condition 2 — text under 200 chars triggers too_short", () => {
  const r = isNonSubstantiveFinalMessage([
    asst([{ type: "text", text: "All checks passed." }]),
  ]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "too_short");
  assert.match(r.message ?? "", /18 chars/);
  assert.match(r.message ?? "", /< 200/);
});

test("isNonSubstantiveFinalMessage: condition 2 — exactly 199 chars still triggers", () => {
  const txt = "z".repeat(199);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "too_short");
});

test("isNonSubstantiveFinalMessage: condition 2 — exactly 200 chars passes (not too_short)", () => {
  const txt = "z".repeat(200);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, false);
});

test("isNonSubstantiveFinalMessage: condition 3 — 'Let me check ...' triggers orient_phrase", () => {
  const txt = "Let me check `any` leakage in the new code path before I finalize the recommendation. " + "x".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
  assert.match(r.message ?? "", /orient-yourself/);
});

test("isNonSubstantiveFinalMessage: condition 3 — 'Now I'll inspect ...' triggers", () => {
  const txt = "Now I'll inspect the persona resolver to double-check that legacy paths are correctly handled. " + "y".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: condition 3 — 'Next I'll ...' triggers", () => {
  const txt = "Next I'll trace the close-handler path to confirm finalize fires once. " + "y".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: condition 3 — 'I need to verify ...' triggers", () => {
  const txt = "I need to verify the regex actually anchors to the start of the string before publishing this. " + "z".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: condition 3 — 'Let's start by ...' triggers", () => {
  const txt = "Let's start by reading the runs.ts finalize closure and trace the message stream. " + "z".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: condition 3 — 'First, I ...' triggers", () => {
  const txt = "First, I want to walk through the entire substance-check helper to make sure the heuristic is sound. " + "x".repeat(150);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: orient phrase matches case-insensitively", () => {
  const txt = "LET ME explain what the heuristic does here in detail. " + "x".repeat(200);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "orient_phrase");
});

test("isNonSubstantiveFinalMessage: 'letterhead' (similar prefix) does NOT trigger orient_phrase", () => {
  const txt = "Letterhead conventions in formal correspondence vary by organization. " + "x".repeat(200);
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, false, "word boundary must protect non-orient prefixes");
});

test("isNonSubstantiveFinalMessage: oracle-style structured report passes", () => {
  const txt =
    "## Verdict\n\nAPPROVE WITH AMENDMENTS — the design is internally coherent and consistent " +
    "with PRD locks; coverage is complete; the architectural fork is well-justified. Three " +
    "concrete amendments needed before planner takes it. No rework required.";
  const r = isNonSubstantiveFinalMessage([asst([{ type: "text", text: txt }])]);
  assert.equal(r.warn, false);
});

test("isNonSubstantiveFinalMessage: looks at LAST assistant message, not earlier ones", () => {
  // Earlier turn was substantive; the final turn is a too-short orient phrase.
  const r = isNonSubstantiveFinalMessage([
    asst([{ type: "text", text: LONG_TEXT }]),
    asst([{ type: "text", text: "Let me think." }]),
  ]);
  assert.equal(r.warn, true);
  // 13 chars triggers too_short BEFORE orient_phrase by check order.
  assert.equal(r.reason, "too_short");
});

test("isNonSubstantiveFinalMessage: empty messages array warns no_text", () => {
  const r = isNonSubstantiveFinalMessage([]);
  assert.equal(r.warn, true);
  assert.equal(r.reason, "no_text");
});

test("isNonSubstantiveFinalMessage: skips trailing user/tool-result messages", () => {
  // After the assistant's substantive text, downstream tool_result rows
  // may still trail. The helper must walk back to the last assistant.
  const r = isNonSubstantiveFinalMessage([
    asst([{ type: "text", text: LONG_TEXT }]),
    { role: "tool", content: [{ type: "tool_result", content: "ok" }] } as unknown as AgentMessage,
  ]);
  assert.equal(r.warn, false);
});
