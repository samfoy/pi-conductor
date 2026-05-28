/**
 * Tests for /conductor send — v0.12 slice 6.
 *
 * The slash command surface mirrors the LLM tool's `streaming_behavior`
 * knob from `ensemble_send`. Default = "auto"; flags `--steer`,
 * `--follow-up`, `--resume` map to the three explicit behaviors.
 * Per design §4.8, this is a thin wrapper over the same `sendToRun`
 * pipeline — the parser is the only logic worth pinning here.
 *
 * Tests target the pure parser `parseSendCommand` so they don't need
 * an ExtensionCommandContext or a registered run; integration of
 * parser → sendToRun is covered by the live RPC test (slice 6 second
 * acceptance — `tests/integration-rpc-spawn.test.ts`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseSendCommand } from "../src/commands.ts";

test("parseSendCommand: bare <id> <msg> → streaming_behavior=auto", () => {
  const out = parseSendCommand("builder-abcd hello world");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.agentId, "builder-abcd");
  assert.equal(out.message, "hello world");
  assert.equal(out.behavior, "auto");
});

test("parseSendCommand: --steer flag → streaming_behavior=steer", () => {
  const out = parseSendCommand("builder-abcd --steer interrupt now");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.agentId, "builder-abcd");
  assert.equal(out.message, "interrupt now");
  assert.equal(out.behavior, "steer");
});

test("parseSendCommand: --follow-up flag → streaming_behavior=follow_up", () => {
  const out = parseSendCommand("builder-abcd --follow-up queue this");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.agentId, "builder-abcd");
  assert.equal(out.message, "queue this");
  assert.equal(out.behavior, "follow_up");
});

test("parseSendCommand: --resume flag → streaming_behavior=resume", () => {
  const out = parseSendCommand("builder-abcd --resume restart from terminal");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.agentId, "builder-abcd");
  assert.equal(out.message, "restart from terminal");
  assert.equal(out.behavior, "resume");
});

test("parseSendCommand: empty arg → helpful error mentioning agent-id", () => {
  const out = parseSendCommand("");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  // Slice 6 critic carry-forward 8a: pin against the specific
  // missing-agent-id production string rather than the SEND_USAGE
  // interpolation, which also fires from the missing-message branch
  // and other error paths. The literal "missing agent-id." prefix is
  // unique to the empty-arg / whitespace-only-arg branch in
  // src/commands.ts:425.
  assert.match(out.message, /^missing agent-id\./);
  assert.match(out.message, /usage/i);
});

test("parseSendCommand: whitespace-only arg → helpful error mentioning agent-id", () => {
  const out = parseSendCommand("   ");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  // Same scoping as the empty-arg test above (carry-forward 8a).
  assert.match(out.message, /^missing agent-id\./);
});

// ── Edge cases beyond the slice-6 minimum acceptance — keep the
// parser unambiguous so the slash command never silently forwards
// something the user didn't mean.

test("parseSendCommand: <id> with no message → error mentions message", () => {
  const out = parseSendCommand("builder-abcd");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  assert.match(out.message, /message/);
});

test("parseSendCommand: <id> --steer with no message → error mentions message", () => {
  const out = parseSendCommand("builder-abcd --steer");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  assert.match(out.message, /message/);
});

test("parseSendCommand: dual flags --steer --follow-up → error rejecting dual flags", () => {
  const out = parseSendCommand("builder-abcd --steer --follow-up msg");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  assert.match(out.message, /one/i);
});

test("parseSendCommand: unknown --double-dash token → treated as part of message (auto)", () => {
  // Only --steer / --follow-up / --resume are recognised flags. A
  // user message that happens to begin with another --foo token is
  // forwarded verbatim under streaming_behavior=auto. This avoids
  // surprising rejections when users prefix messages with markdown
  // bullets or shell flags.
  const out = parseSendCommand("builder-abcd --notes update the spec");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.message, "--notes update the spec");
  assert.equal(out.behavior, "auto");
});

test("parseSendCommand: agent-id with multiple internal whitespace tokens collapses to single agent-id", () => {
  // Defensive path. The dispatcher splits on /\s+/ so internal runs
  // of whitespace shouldn't reach the parser, but if they do, the
  // first non-empty token is the agent-id.
  const out = parseSendCommand("  builder-abcd   hello   world  ");
  assert.equal(out.kind, "ok");
  if (out.kind !== "ok") return;
  assert.equal(out.agentId, "builder-abcd");
  assert.equal(out.message, "hello   world");
  assert.equal(out.behavior, "auto");
});

test("parseSendCommand: --steer with only whitespace message → error", () => {
  const out = parseSendCommand("builder-abcd --steer    ");
  assert.equal(out.kind, "error");
  if (out.kind !== "error") return;
  assert.match(out.message, /message/);
});
