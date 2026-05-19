/**
 * Tests for src/compaction-hook.ts.
 *
 * v0.8.1 Item 5 — context-inflation compaction. The hook collapses
 * older `<sub-agent-completed>` envelopes to a `<result-summary>`
 * form, leaving the most-recent N expanded.
 *
 * Tests are organized into three layers:
 *   1. summarizeResultText — pure truncation primitive.
 *   2. compactEnvelopeBlock — single-envelope rewrite.
 *   3. compactOlderEnvelopes — multi-message walk + selection.
 *   4. installCompactionHook — context-handler registration.
 *
 * Mirrors tests/sanitizer-hook.test.ts in shape.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEEP_RECENT_ENVELOPES,
  RESULT_SUMMARY_MAX_CHARS,
  compactEnvelopeBlock,
  compactOlderEnvelopes,
  installCompactionHook,
  summarizeResultText,
} from "../src/compaction-hook.ts";

// ── helpers ────────────────────────────────────────────────────────

function envelope(opts: {
  id?: string;
  persona?: string;
  status?: string;
  duration?: string;
  cost?: string;
  result?: string;
}): string {
  const {
    id = "builder-w9bt",
    persona = "builder",
    status = "completed",
    duration = "6.6m",
    cost = "3.7460",
    result,
  } = opts;
  const lines: string[] = [];
  lines.push("<sub-agent-completed>");
  lines.push(`  <agent-id>${id}</agent-id>`);
  lines.push(`  <persona>${persona}</persona>`);
  lines.push(`  <status>${status}</status>`);
  lines.push(`  <duration>${duration}</duration>`);
  lines.push(
    `  <usage><turns>40</turns><input>45</input><output>22414</output><cost>${cost}</cost></usage>`,
  );
  if (result !== undefined) {
    lines.push("  <result>");
    lines.push(result);
    lines.push("  </result>");
  }
  lines.push(`  <transcript>/home/samfp/.pi/agent/conductor/runs/${id}/transcript.jsonl</transcript>`);
  lines.push("</sub-agent-completed>");
  return lines.join("\n");
}

function userMsgString(content: string): any {
  return { role: "user", content };
}

function userMsgBlocks(text: string): any {
  return { role: "user", content: [{ type: "text", text }] };
}

// ── summarizeResultText ────────────────────────────────────────────

test("summarizeResultText: short text is returned unchanged after whitespace collapse", () => {
  assert.equal(summarizeResultText("hello world"), "hello world");
});

test("summarizeResultText: collapses internal whitespace runs to single spaces", () => {
  assert.equal(summarizeResultText("hello\n\nworld   foo\tbar"), "hello world foo bar");
});

test("summarizeResultText: trims leading/trailing whitespace", () => {
  assert.equal(summarizeResultText("  \n  hello  \n "), "hello");
});

test("summarizeResultText: long text is truncated to RESULT_SUMMARY_MAX_CHARS with ellipsis", () => {
  const input = "a".repeat(500);
  const out = summarizeResultText(input);
  assert.equal(out.length, RESULT_SUMMARY_MAX_CHARS + 1); // 200 + ellipsis char
  assert.ok(out.endsWith("…"));
  assert.equal(out.slice(0, -1), "a".repeat(RESULT_SUMMARY_MAX_CHARS));
});

test("summarizeResultText: respects custom max parameter", () => {
  const out = summarizeResultText("abcdefghij", 5);
  assert.equal(out, "abcde…");
});

test("summarizeResultText: empty input returns empty string", () => {
  assert.equal(summarizeResultText(""), "");
});

test("summarizeResultText: at exactly max length, no ellipsis", () => {
  const exact = "x".repeat(RESULT_SUMMARY_MAX_CHARS);
  assert.equal(summarizeResultText(exact), exact);
});

// ── compactEnvelopeBlock ───────────────────────────────────────────

test("compactEnvelopeBlock: replaces <result> with <result-summary>", () => {
  const env = envelope({ result: "Slice complete: foo bar baz" });
  const out = compactEnvelopeBlock(env);
  assert.match(out, /<result-summary>Slice complete: foo bar baz<\/result-summary>/);
  assert.doesNotMatch(out, /<result>/);
  assert.doesNotMatch(out, /<\/result>/);
});

test("compactEnvelopeBlock: preserves agent-id, persona, status, duration, usage, transcript", () => {
  const env = envelope({
    id: "designer-ab12",
    persona: "designer",
    result: "anything",
  });
  const out = compactEnvelopeBlock(env);
  assert.match(out, /<agent-id>designer-ab12<\/agent-id>/);
  assert.match(out, /<persona>designer<\/persona>/);
  assert.match(out, /<status>completed<\/status>/);
  assert.match(out, /<duration>6\.6m<\/duration>/);
  assert.match(out, /<usage>/);
  assert.match(out, /<transcript>/);
});

test("compactEnvelopeBlock: truncates long result to <=200 chars + ellipsis", () => {
  const long = "x".repeat(800);
  const env = envelope({ result: long });
  const out = compactEnvelopeBlock(env);
  const m = out.match(/<result-summary>([\s\S]*?)<\/result-summary>/);
  assert.ok(m, "compacted envelope must contain <result-summary>");
  const summary = m![1]!;
  assert.equal(summary.length, RESULT_SUMMARY_MAX_CHARS + 1);
  assert.ok(summary.endsWith("…"));
});

test("compactEnvelopeBlock: idempotent on already-compacted envelope", () => {
  const env = envelope({ result: "first compaction" });
  const once = compactEnvelopeBlock(env);
  const twice = compactEnvelopeBlock(once);
  assert.equal(twice, once);
});

test("compactEnvelopeBlock: envelope without <result> is returned unchanged", () => {
  const env = envelope({}); // no result
  const out = compactEnvelopeBlock(env);
  assert.equal(out, env);
});

// ── compactOlderEnvelopes ──────────────────────────────────────────

test("compactOlderEnvelopes: empty messages array passes through", () => {
  const out = compactOlderEnvelopes([]);
  assert.deepEqual(out, []);
});

test("compactOlderEnvelopes: messages with no envelopes returned identity-equal", () => {
  const msgs = [userMsgString("just user prose"), userMsgString("more prose")];
  const out = compactOlderEnvelopes(msgs);
  assert.equal(out, msgs);
});

test("compactOlderEnvelopes: 1 envelope (default keepRecent=2) untouched", () => {
  const env = envelope({ id: "one", result: "the only envelope" });
  const msgs = [userMsgString(env)];
  const out = compactOlderEnvelopes(msgs);
  assert.match(out[0]!.content as string, /<result>/);
  assert.doesNotMatch(out[0]!.content as string, /<result-summary>/);
});

test("compactOlderEnvelopes: 2 envelopes (default keepRecent=2) untouched", () => {
  const env1 = envelope({ id: "one", result: "first" });
  const env2 = envelope({ id: "two", result: "second" });
  const msgs = [userMsgString(env1), userMsgString(env2)];
  const out = compactOlderEnvelopes(msgs);
  assert.match(out[0]!.content as string, /<result>/);
  assert.match(out[1]!.content as string, /<result>/);
});

test("compactOlderEnvelopes: 3 envelopes — oldest compacted, two newest expanded", () => {
  const env1 = envelope({ id: "first", result: "FIRST" });
  const env2 = envelope({ id: "second", result: "SECOND" });
  const env3 = envelope({ id: "third", result: "THIRD" });
  const msgs = [userMsgString(env1), userMsgString(env2), userMsgString(env3)];
  const out = compactOlderEnvelopes(msgs);
  assert.match(out[0]!.content as string, /<result-summary>FIRST<\/result-summary>/);
  assert.doesNotMatch(out[0]!.content as string, /<result>/);
  assert.match(out[1]!.content as string, /<result>\nSECOND/);
  assert.match(out[2]!.content as string, /<result>\nTHIRD/);
});

test("compactOlderEnvelopes: 12 envelopes — 10 compacted, 2 expanded (witnessed scenario)", () => {
  const msgs = Array.from({ length: 12 }, (_, i) =>
    userMsgString(envelope({ id: `agent-${i}`, result: `body-${i}` })),
  );
  const out = compactOlderEnvelopes(msgs);
  for (let i = 0; i < 10; i++) {
    assert.match(
      out[i]!.content as string,
      /<result-summary>/,
      `envelope #${i} should be compacted`,
    );
    assert.doesNotMatch(out[i]!.content as string, /<result>/);
  }
  for (let i = 10; i < 12; i++) {
    assert.match(out[i]!.content as string, /<result>/, `envelope #${i} should be expanded`);
  }
});

test("compactOlderEnvelopes: respects custom keepRecent=0 — every envelope compacted", () => {
  const env1 = envelope({ id: "a", result: "A" });
  const env2 = envelope({ id: "b", result: "B" });
  const out = compactOlderEnvelopes([userMsgString(env1), userMsgString(env2)], 0);
  assert.match(out[0]!.content as string, /<result-summary>A<\/result-summary>/);
  assert.match(out[1]!.content as string, /<result-summary>B<\/result-summary>/);
});

test("compactOlderEnvelopes: respects custom keepRecent=1 — only the latest expanded", () => {
  const env1 = envelope({ id: "a", result: "A" });
  const env2 = envelope({ id: "b", result: "B" });
  const env3 = envelope({ id: "c", result: "C" });
  const out = compactOlderEnvelopes(
    [userMsgString(env1), userMsgString(env2), userMsgString(env3)],
    1,
  );
  assert.match(out[0]!.content as string, /<result-summary>A<\/result-summary>/);
  assert.match(out[1]!.content as string, /<result-summary>B<\/result-summary>/);
  assert.match(out[2]!.content as string, /<result>\nC/);
});

test("compactOlderEnvelopes: handles array-of-blocks message content (assistant shape)", () => {
  const env1 = envelope({ id: "a", result: "A" });
  const env2 = envelope({ id: "b", result: "B" });
  const env3 = envelope({ id: "c", result: "C" });
  // Pretend the envelopes were embedded in an assistant text block.
  const msgs = [userMsgBlocks(env1), userMsgBlocks(env2), userMsgBlocks(env3)];
  const out = compactOlderEnvelopes(msgs);
  const text = (m: any) => (m.content as any[])[0]!.text as string;
  assert.match(text(out[0]), /<result-summary>A<\/result-summary>/);
  assert.match(text(out[1]!), /<result>/);
  assert.match(text(out[2]!), /<result>/);
});

test("compactOlderEnvelopes: idempotent — compacting twice yields the same result", () => {
  const msgs = Array.from({ length: 5 }, (_, i) =>
    userMsgString(envelope({ id: `agent-${i}`, result: `body-${i}` })),
  );
  const once = compactOlderEnvelopes(msgs);
  const twice = compactOlderEnvelopes(once);
  for (let i = 0; i < msgs.length; i++) {
    assert.equal(twice[i]!.content, once[i]!.content);
  }
});

test("compactOlderEnvelopes: does not mutate input messages", () => {
  const env1 = envelope({ id: "a", result: "A" });
  const env2 = envelope({ id: "b", result: "B" });
  const env3 = envelope({ id: "c", result: "C" });
  const msgs = [userMsgString(env1), userMsgString(env2), userMsgString(env3)];
  const before = msgs.map((m) => m.content);
  compactOlderEnvelopes(msgs);
  for (let i = 0; i < msgs.length; i++) {
    assert.equal(msgs[i]!.content, before[i]);
  }
});

test("compactOlderEnvelopes: multiple envelopes in the SAME message text are counted independently", () => {
  // Edge case: a single message body carrying two envelopes (unlikely
  // in production but possible if a future code path concatenates).
  const env1 = envelope({ id: "a", result: "A" });
  const env2 = envelope({ id: "b", result: "B" });
  const env3 = envelope({ id: "c", result: "C" });
  const single = userMsgString(`${env1}\n\n${env2}\n\n${env3}`);
  const out = compactOlderEnvelopes([single]);
  const text = out[0]!.content as string;
  // Three envelopes total; two newest (env2, env3) expanded; oldest
  // (env1) compacted.
  const summaryHits = text.match(/<result-summary>/g) ?? [];
  const fullHits = text.match(/<result>/g) ?? [];
  assert.equal(summaryHits.length, 1);
  assert.equal(fullHits.length, 2);
});

test("compactOlderEnvelopes: KEEP_RECENT_ENVELOPES default constant is 2", () => {
  assert.equal(KEEP_RECENT_ENVELOPES, 2);
});

// ── installCompactionHook ──────────────────────────────────────────

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeFakePi(): {
  pi: { on: (event: "context", handler: Handler) => void };
  contextHandlers: Handler[];
} {
  const contextHandlers: Handler[] = [];
  const pi = {
    on(event: "context", handler: Handler) {
      assert.equal(event, "context");
      contextHandlers.push(handler);
    },
  };
  return { pi, contextHandlers };
}

test("installCompactionHook: registers exactly one context handler", () => {
  const { pi, contextHandlers } = makeFakePi();
  installCompactionHook(pi);
  assert.equal(contextHandlers.length, 1);
});

test("installCompactionHook: handler returns { messages } shape on every invocation", async () => {
  const { pi, contextHandlers } = makeFakePi();
  installCompactionHook(pi);
  const handler = contextHandlers[0]!;
  const out = await handler({ messages: [] });
  assert.ok(out && typeof out === "object");
  assert.ok(Array.isArray(out.messages));
});

test("installCompactionHook: handler compacts older envelopes via default keepRecent", async () => {
  const { pi, contextHandlers } = makeFakePi();
  installCompactionHook(pi);
  const handler = contextHandlers[0]!;
  const msgs = Array.from({ length: 4 }, (_, i) =>
    userMsgString(envelope({ id: `agent-${i}`, result: `body-${i}` })),
  );
  const out = await handler({ messages: msgs });
  // 2 oldest compacted, 2 newest expanded.
  assert.match(out.messages[0].content, /<result-summary>/);
  assert.match(out.messages[1].content, /<result-summary>/);
  assert.match(out.messages[2].content, /<result>/);
  assert.match(out.messages[3].content, /<result>/);
});

test("installCompactionHook: respects keepRecent override", async () => {
  const { pi, contextHandlers } = makeFakePi();
  installCompactionHook(pi, { keepRecent: 0 });
  const handler = contextHandlers[0]!;
  const msgs = [userMsgString(envelope({ id: "only", result: "ONLY" }))];
  const out = await handler({ messages: msgs });
  assert.match(out.messages[0].content, /<result-summary>ONLY<\/result-summary>/);
});

test("installCompactionHook: returns a handle with a noop reset()", () => {
  const { pi } = makeFakePi();
  const handle = installCompactionHook(pi);
  assert.equal(typeof handle.reset, "function");
  handle.reset(); // must not throw
});
