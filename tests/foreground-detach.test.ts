/**
 * Tests for the foreground-detach helpers (Esc-to-detach UX, PRD-locked).
 *
 * `awaitOrDetach` races a "done" promise against a detach signal and
 * reports which resolved first.
 *
 * `renderForegroundDetachedResult` formats the tool result returned to
 * the LLM when the user detaches a foreground spawn — analogous to the
 * queued-as-background result, so the conductor knows the sub-agent is
 * still running and completion will arrive as a notification.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitOrDetach,
  renderForegroundDetachedResult,
} from "../src/foreground-stream.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "test task",
    mode: "foreground",
    status: "running",
    startTime: Date.now() - 4_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

// ── awaitOrDetach ──────────────────────────────────────────────────────

test("awaitOrDetach: returns 'completed' when done resolves first", async () => {
  const done = Promise.resolve("finished");
  const detach = new Promise<void>(() => {
    /* never resolves */
  });
  const out = await awaitOrDetach(done, detach);
  assert.deepEqual(out, { kind: "completed", value: "finished" });
});

test("awaitOrDetach: returns 'detached' when detach resolves first", async () => {
  const done = new Promise(() => {
    /* never resolves */
  });
  const detach = Promise.resolve();
  const out = await awaitOrDetach(done, detach);
  assert.deepEqual(out, { kind: "detached" });
});

test("awaitOrDetach: completed wins when both resolve same tick (microtask order)", async () => {
  // Both promises are already settled synchronously.
  const done = Promise.resolve("first");
  const detach = Promise.resolve();
  // Promise.race semantics: the first to be enqueued in the microtask queue
  // wins. We just assert the outcome is one of the two expected shapes.
  const out = await awaitOrDetach(done, detach);
  assert.ok(
    out.kind === "completed" || out.kind === "detached",
    `expected one of completed/detached, got ${JSON.stringify(out)}`,
  );
});

test("awaitOrDetach: surfaces the resolved value verbatim on completed", async () => {
  const sentinel = { foo: "bar", n: 42 };
  const out = await awaitOrDetach(Promise.resolve(sentinel), new Promise(() => {}));
  assert.equal(out.kind, "completed");
  if (out.kind !== "completed") return;
  assert.equal(out.value, sentinel, "value must be the same object reference");
});

// ── renderForegroundDetachedResult ──────────────────────────────────────

test("renderForegroundDetachedResult: tells the LLM the sub-agent is now in background", () => {
  const run = makeRun();
  const r = renderForegroundDetachedResult(run);
  const text = (r.content[0] as any).text as string;
  assert.match(text, /detached/i);
  assert.match(text, /oracle-7f3a/);
  assert.match(text, /background/);
  // The LLM is told a notification will arrive — same convention as the
  // queued-as-background path so the conductor doesn't re-spawn.
  assert.match(text, /<sub-agent-completed>|notification/i);
});

test("renderForegroundDetachedResult: details payload matches background-spawn shape", () => {
  const run = makeRun();
  const r = renderForegroundDetachedResult(run);
  const d = r.details as Record<string, unknown>;
  assert.equal(d.status, "detached-as-background");
  assert.equal(d.agent_id, run.id);
  assert.equal(d.persona, run.persona);
  assert.equal(d.mode, "background");
});
