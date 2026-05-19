/**
 * Tests for formatCompletionNotification.
 *
 * Coverage gaps closed by this file (vs the existing 4 test files):
 *   - Status-specific glyph + verb header lines (completed/failed/killed/timeout)
 *   - errorMessage rendered in <error> tag, omitted when absent
 *   - <result> tag included only when there is a final assistant text
 *   - XML-special characters escaped (&, <, >) in both <error> and <result>
 *   - <usage> aggregates use the formatted/numeric values from the run
 *   - Header omits the usage suffix when there is no usage
 *   - Transcript path always emitted
 *
 * No I/O, no time dependence — all runs use a fixed startTime/finishedAt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatCompletionNotification, formatCompletionNotificationCompact } from "../src/notifications.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

const T0 = 1_700_000_000_000; // fixed epoch ms

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-abcd",
    persona: "oracle",
    task: "review",
    mode: "background",
    status: "completed",
    startTime: T0,
    lastEventAt: T0,
    finishedAt: T0 + 12_000, // 12s elapsed
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/oracle-abcd/record.json",
    transcriptPath: "/tmp/oracle-abcd/transcript.jsonl",
    finalPath: "/tmp/oracle-abcd/final.md",
    ...overrides,
  };
}

function assistantTextMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

test("formatCompletionNotification: completed status uses ✓ glyph and 'completed' verb", () => {
  const out = formatCompletionNotification(makeRun({ status: "completed" }));
  const header = out.split("\n")[0]!;
  assert.match(header, /^## ✓ `oracle` completed \(/);
  assert.match(out, /<status>completed<\/status>/);
});

test("formatCompletionNotification: failed status uses ✗ glyph and 'failed' verb", () => {
  const out = formatCompletionNotification(makeRun({ status: "failed" }));
  const header = out.split("\n")[0]!;
  assert.match(header, /^## ✗ `oracle` failed \(/);
  assert.match(out, /<status>failed<\/status>/);
});

test("formatCompletionNotification: killed status uses ■ glyph and 'killed' verb", () => {
  const out = formatCompletionNotification(makeRun({ status: "killed" }));
  const header = out.split("\n")[0]!;
  assert.match(header, /^## ■ `oracle` killed \(/);
  assert.match(out, /<status>killed<\/status>/);
});

test("formatCompletionNotification: timeout status uses ⏱ glyph and 'timed out' verb", () => {
  const out = formatCompletionNotification(makeRun({ status: "timeout" }));
  const header = out.split("\n")[0]!;
  assert.match(header, /^## ⏱ `oracle` timed out \(/);
  assert.match(out, /<status>timeout<\/status>/);
});

test("formatCompletionNotification: includes elapsed and run id in header", () => {
  const out = formatCompletionNotification(makeRun({ finishedAt: T0 + 12_000 }));
  const header = out.split("\n")[0]!;
  assert.match(header, /\(12s\)/);
  assert.match(header, /id `oracle-abcd`/);
});

test("formatCompletionNotification: omits usage suffix when usage is zero", () => {
  const out = formatCompletionNotification(makeRun({ usage: emptyUsage() }));
  const header = out.split("\n")[0]!;
  // "(12s)" closes immediately — no comma-separated usage segment
  assert.match(header, /\(12s\) — id /);
  assert.doesNotMatch(header, /\(12s, /);
});

test("formatCompletionNotification: includes usage suffix when usage has activity", () => {
  const out = formatCompletionNotification(
    makeRun({
      usage: { input: 1500, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.012, turns: 3 },
    }),
  );
  const header = out.split("\n")[0]!;
  // turns + arrow tokens + cost
  assert.match(header, /\(12s, 3t ↑1\.5k ↓800 \$0\.012\)/);
});

test("formatCompletionNotification: <usage> tag carries raw numeric fields with cost to 4dp", () => {
  const out = formatCompletionNotification(
    makeRun({
      usage: { input: 1500, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.0125, turns: 3 },
    }),
  );
  assert.match(
    out,
    /<usage><turns>3<\/turns><input>1500<\/input><output>800<\/output><cost>0\.0125<\/cost><\/usage>/,
  );
});

test("formatCompletionNotification: omits <error> tag when no errorMessage", () => {
  const out = formatCompletionNotification(makeRun({ status: "completed" }));
  assert.doesNotMatch(out, /<error>/);
});

test("formatCompletionNotification: includes <error> tag when errorMessage set", () => {
  const out = formatCompletionNotification(
    makeRun({ status: "failed", errorMessage: "process exited 1" }),
  );
  assert.match(out, /<error>process exited 1<\/error>/);
});

test("formatCompletionNotification: omits <result> when no final assistant text", () => {
  const out = formatCompletionNotification(makeRun({ messages: [] }));
  assert.doesNotMatch(out, /<result>/);
});

test("formatCompletionNotification: includes <result> with final assistant text", () => {
  const out = formatCompletionNotification(
    makeRun({ messages: [assistantTextMessage("the answer is 42")] }),
  );
  assert.match(out, /<result>\s*the answer is 42\s*<\/result>/);
});

test("formatCompletionNotification: escapes &, <, > in errorMessage", () => {
  const out = formatCompletionNotification(
    makeRun({
      status: "failed",
      errorMessage: "<panic> at A&B > C",
    }),
  );
  assert.match(out, /<error>&lt;panic&gt; at A&amp;B &gt; C<\/error>/);
  // The raw special chars must NOT leak into the <error> body
  assert.doesNotMatch(out, /<error><panic>/);
});

test("formatCompletionNotification: escapes &, <, > in final assistant text", () => {
  const out = formatCompletionNotification(
    makeRun({ messages: [assistantTextMessage("if x < y && y > z then go")] }),
  );
  assert.match(out, /if x &lt; y &amp;&amp; y &gt; z then go/);
});

test("formatCompletionNotification: always emits <transcript> path", () => {
  const out = formatCompletionNotification(
    makeRun({ transcriptPath: "/some/where/transcript.jsonl" }),
  );
  assert.match(out, /<transcript>\/some\/where\/transcript\.jsonl<\/transcript>/);
});

test("formatCompletionNotification: emits agent-id and persona tags from the run", () => {
  const out = formatCompletionNotification(
    makeRun({ id: "redteam-xyz1", persona: "redteam" }),
  );
  assert.match(out, /<agent-id>redteam-xyz1<\/agent-id>/);
  assert.match(out, /<persona>redteam<\/persona>/);
});

test("formatCompletionNotification: each terminal status produces a header that names the persona", () => {
  const statuses: RunStatus[] = ["completed", "failed", "killed", "timeout"];
  for (const s of statuses) {
    const out = formatCompletionNotification(makeRun({ status: s, persona: "builder" }));
    assert.match(out.split("\n")[0]!, /`builder`/, `header for ${s} mentions persona`);
  }
});

// ── v0.8.1 Item 4: non-substantive-final-message warning ──────────────

test("formatCompletionNotification: emits <warning> when run.nonSubstantiveFinal is set", () => {
  const out = formatCompletionNotification(
    makeRun({
      nonSubstantiveFinal: {
        reason: "too_short",
        message: "Final assistant text is 18 chars (< 200); likely an orient-yourself preamble rather than the substantive report.",
      },
    }),
  );
  assert.match(out, /<warning reason="too_short">/);
  assert.match(out, /18 chars/);
  assert.match(out, /<\/warning>/);
});

test("formatCompletionNotification: omits <warning> when nonSubstantiveFinal is unset", () => {
  const out = formatCompletionNotification(makeRun());
  assert.doesNotMatch(out, /<warning/);
});

test("formatCompletionNotification: escapes XML special chars in warning message", () => {
  const out = formatCompletionNotification(
    makeRun({
      nonSubstantiveFinal: {
        reason: "orient_phrase",
        message: 'Final text starts with "Let me check <any> & finalize…"',
      },
    }),
  );
  assert.match(out, /&lt;any&gt;/);
  assert.match(out, /&amp;/);
});

// ── v0.8.1 Item 5: compact form ──────────────────────────────────

test("formatCompletionNotificationCompact: replaces <result> with <result-summary>", () => {
  const out = formatCompletionNotificationCompact(
    makeRun({ messages: [assistantTextMessage("Slice complete: foo bar baz")] }),
  );
  assert.match(out, /<result-summary>Slice complete: foo bar baz<\/result-summary>/);
  assert.doesNotMatch(out, /<result>/);
  assert.doesNotMatch(out, /<\/result>/);
});

test("formatCompletionNotificationCompact: preserves header line and all metadata tags", () => {
  const out = formatCompletionNotificationCompact(
    makeRun({
      id: "designer-1234",
      persona: "designer",
      status: "completed",
      messages: [assistantTextMessage("anything")],
    }),
  );
  assert.match(out.split("\n")[0]!, /^## ✓ `designer` completed/);
  assert.match(out, /<agent-id>designer-1234<\/agent-id>/);
  assert.match(out, /<persona>designer<\/persona>/);
  assert.match(out, /<status>completed<\/status>/);
  assert.match(out, /<duration>/);
  assert.match(out, /<usage>/);
  assert.match(out, /<transcript>/);
});

test("formatCompletionNotificationCompact: truncates long result body", () => {
  const long = "x".repeat(800);
  const out = formatCompletionNotificationCompact(
    makeRun({ messages: [assistantTextMessage(long)] }),
  );
  const m = out.match(/<result-summary>([\s\S]*?)<\/result-summary>/);
  assert.ok(m);
  assert.ok(m![1]!.endsWith("…"));
});

test("formatCompletionNotificationCompact: pass-through when no <result> body present", () => {
  // No final assistant text → full form omits <result>; compact form
  // also has nothing to rewrite. Idempotent / no-op.
  const out = formatCompletionNotificationCompact(makeRun({ messages: [] }));
  assert.doesNotMatch(out, /<result>/);
  assert.doesNotMatch(out, /<result-summary>/);
});

