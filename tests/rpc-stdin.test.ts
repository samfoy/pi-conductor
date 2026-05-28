/**
 * Tests for `RpcStdinQueue` — the single-writer JSON-line queue
 * that fronts a sub-agent's stdin in v0.12 RPC mode.
 *
 * Design ref: `docs/v0.12-steering-design.md` §4.2 (lines ~410–447).
 * Slice ref: `docs/v0.12-steering-plan.md` §"Slice 2".
 *
 * Five named acceptance cases:
 *   1. enqueue serialises writes in submit order under back-pressure
 *   2. enqueue rejects on EPIPE with cause-tagged error; only the
 *      in-flight write rejects, queued writes after still succeed
 *      when the pipe is alive again
 *   3. destroy(reason) rejects all pending writes with the supplied
 *      reason
 *   4. enqueue rejects payloads containing embedded newlines after
 *      JSON.stringify
 *   5. framing is LF-only (no CR; matches pi serializeJsonLine)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Writable } from "node:stream";

import { RpcStdinQueue } from "../src/rpc-stdin.ts";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Hand-rolled duck-type for the subset of `Writable` the queue uses.
 * We deliberately do NOT extend `node:stream` Writable: Node's
 * internal Writable latches the first per-write error into the
 * stream's state, so a one-shot EPIPE poisons subsequent writes.
 * In real life the conductor only ever wires this queue to a
 * subprocess stdin pipe (which doesn't recover from EPIPE either),
 * but the queue's *contract* is that **the queue itself** doesn't
 * latch — it tries the next entry. A hand-rolled fake is the only
 * way to test that contract without reaching into pi's RPC mode.
 *
 * Modes:
 *   - `ok`             — every chunk accepted; callback fires async.
 *   - `back-pressure`  — every callback queued, drained via
 *     `releaseOne()` so the test controls the pacing.
 *   - `epipe-on-next`  — the next write fires its callback with
 *     EPIPE; subsequent writes succeed (one-shot).
 */
interface FakeWritable {
  chunks: string[];
  mode: "ok" | "back-pressure" | "epipe-on-next";
  pending: Array<() => void>;
  writableEnded: boolean;
  destroyed: boolean;
  write(
    chunk: Buffer | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    maybeCb?: (err?: Error | null) => void,
  ): boolean;
  releaseOne(): boolean;
  releaseAll(): void;
}

function makeFakeWritable(): FakeWritable {
  const fake: FakeWritable = {
    chunks: [],
    mode: "ok",
    pending: [],
    writableEnded: false,
    destroyed: false,
    write(chunk, encodingOrCb, maybeCb): boolean {
      const cb =
        typeof encodingOrCb === "function"
          ? encodingOrCb
          : maybeCb ?? ((_err?: Error | null) => {});
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      fake.chunks.push(text);
      if (fake.mode === "epipe-on-next") {
        fake.mode = "ok";
        const err = new Error("write EPIPE") as Error & { code?: string };
        err.code = "EPIPE";
        // Async dispatch so the queue's promise plumbing sees the
        // rejection in the next microtask, matching real subprocess
        // pipe semantics.
        setImmediate(() => cb(err));
        return false;
      }
      if (fake.mode === "back-pressure") {
        fake.pending.push(() => cb());
        return false;
      }
      setImmediate(() => cb());
      return true;
    },
    releaseOne(): boolean {
      const cb = fake.pending.shift();
      if (!cb) return false;
      cb();
      return true;
    },
    releaseAll(): void {
      while (fake.releaseOne()) {
        /* spin */
      }
    },
  };
  return fake;
}

// The queue's signature accepts `Writable`. The fake implements only
// the subset the queue touches; cast at use sites.
function asWritable(f: FakeWritable): Writable {
  return f as unknown as Writable;
}

// Allow promises to settle without dragging in a fake-timer harness.
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// ── Tests ─────────────────────────────────────────────────────────────

test("RpcStdinQueue: enqueue serialises writes in submit order under back-pressure", async () => {
  const w = makeFakeWritable();
  w.mode = "back-pressure";
  const q = new RpcStdinQueue(asWritable(w));

  // Three concurrent enqueues: A, B, C.
  const pA = q.enqueue({ id: "A", type: "prompt", message: "first" });
  const pB = q.enqueue({ id: "B", type: "prompt", message: "second" });
  const pC = q.enqueue({ id: "C", type: "prompt", message: "third" });

  // Settle scheduling.
  await tick();

  // Only one write should be in flight at a time. The queue's
  // single-writer invariant means B and C are NOT yet in `chunks`.
  assert.equal(w.chunks.length, 1, "exactly one write should be in flight");
  assert.match(w.chunks[0], /"id":"A"/);

  // Drain A.
  w.releaseOne();
  await pA; // resolves now
  await tick();
  assert.equal(w.chunks.length, 2);
  assert.match(w.chunks[1], /"id":"B"/);

  // Drain B.
  w.releaseOne();
  await pB;
  await tick();
  assert.equal(w.chunks.length, 3);
  assert.match(w.chunks[2], /"id":"C"/);

  // Drain C.
  w.releaseOne();
  await pC;

  // No interleaving: each chunk is exactly one full JSON line.
  for (const c of w.chunks) {
    assert.equal(c.endsWith("\n"), true);
    // Only one trailing newline; no double-LF or partial frame.
    assert.equal(c.split("\n").length, 2);
  }

  q.destroy("end of test");
});

test("RpcStdinQueue: enqueue rejects on EPIPE with cause-tagged error; queued writes after still succeed when pipe is alive again", async () => {
  const w = makeFakeWritable();
  const q = new RpcStdinQueue(asWritable(w));

  // First write hits EPIPE.
  w.mode = "epipe-on-next";
  const pFail = q.enqueue({ id: "F", type: "prompt", message: "bad" });

  // Second write should still attempt — pipe is "alive again" (mode
  // reverted to "ok" after the one-shot EPIPE).
  const pOk = q.enqueue({ id: "G", type: "prompt", message: "good" });

  let failError: Error | undefined;
  try {
    await pFail;
    assert.fail("expected EPIPE rejection");
  } catch (e) {
    failError = e as Error;
  }
  assert.ok(failError);
  assert.match(failError.message, /EPIPE/i);
  // Cause-tagged: the underlying error is preserved as `.cause`.
  const cause = (failError as Error & { cause?: unknown }).cause;
  assert.ok(cause, "rejection error must carry a `.cause`");
  assert.equal((cause as Error & { code?: string }).code, "EPIPE");

  // The good write survives — queue did not poison subsequent
  // writes after a single EPIPE rejection.
  await pOk;
  // Both writes were attempted (the failed and the survivor).
  assert.equal(w.chunks.length, 2);
  assert.match(w.chunks[1], /"id":"G"/);

  q.destroy("end of test");
});

test("RpcStdinQueue: destroy(reason) rejects all pending writes with the supplied reason", async () => {
  const w = makeFakeWritable();
  w.mode = "back-pressure";
  const q = new RpcStdinQueue(asWritable(w));

  const pA = q.enqueue({ id: "A", type: "prompt", message: "first" });
  const pB = q.enqueue({ id: "B", type: "prompt", message: "second" });
  const pC = q.enqueue({ id: "C", type: "prompt", message: "third" });

  await tick();
  // A is in flight (its callback is parked in w.pending); B and C
  // are queued inside RpcStdinQueue.
  assert.equal(w.pending.length, 1);

  q.destroy("force-terminate");

  for (const [name, p] of [
    ["A", pA],
    ["B", pB],
    ["C", pC],
  ] as const) {
    let err: Error | undefined;
    try {
      await p;
      assert.fail(`expected ${name} to reject`);
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err);
    assert.match(err!.message, /force-terminate/, `${name} rejection should mention reason`);
  }
});

test(
  "RpcStdinQueue: multi-line strings in payload values are escaped by JSON.stringify and accepted (slice 6 fix)",
  async () => {
    // Slice 2 originally rejected raw `\n` in any string field. That
    // broke slice 3's initial-prompt injection because
    // `buildSubAgentPrompt` always produces multi-line text. The
    // slice 6 live integration tests caught the bug. Removed
    // 2026-05-28 as part of slice 6 closure. CR rejection survives
    // as a defense against accidental CRLF tooling.
    const w = makeFakeWritable();
    const q = new RpcStdinQueue(asWritable(w));

    // Multi-line message must enqueue cleanly.
    await q.enqueue({
      id: "A",
      type: "prompt",
      message: "hello\nworld\nReply with HELLO_MULTI and stop.",
    });
    assert.equal(w.chunks.length, 1, "multi-line message must reach the stream");

    // The wire bytes must be safe: no raw `\n` inside the JSON
    // object portion (only the framing trailing LF). JSON.stringify
    // escapes string `\n` to `\\n` (two chars: backslash + n).
    const wire = w.chunks[0];
    assert.equal(wire.endsWith("\n"), true, "framing trailing LF");
    const objPortion = wire.slice(0, -1);
    // Round-trip parse: pi's reader does the same.
    const parsed = JSON.parse(objPortion);
    assert.equal(parsed.id, "A");
    assert.equal(parsed.type, "prompt");
    assert.equal(
      parsed.message,
      "hello\nworld\nReply with HELLO_MULTI and stop.",
      "message must round-trip through JSON.stringify with newlines preserved as JSON escapes",
    );
    // The object portion itself contains no raw LF (every newline
    // inside the message is JSON-escaped to backslash-n).
    assert.equal(objPortion.includes("\n"), false, "object portion is single-line wire-safe");

    // CR rejection still fires as a tripwire.
    let errCR: Error | undefined;
    try {
      await q.enqueue({ id: "B", type: "prompt", message: "hello\rworld" });
      assert.fail("expected rejection on embedded CR");
    } catch (e) {
      errCR = e as Error;
    }
    assert.ok(errCR);
    assert.match(errCR!.message, /carriage return|raw CR|CR/i);
    assert.equal(w.chunks.length, 1, "rejected CR payload must not reach the stream");

    // Nested CR in array values still trips the recursive scan.
    let errNested: Error | undefined;
    try {
      await q.enqueue({
        id: "C",
        type: "prompt",
        message: "ok",
        images: [{ content: "data\rbreak" } as unknown as never],
      });
      assert.fail("expected rejection on nested embedded CR");
    } catch (e) {
      errNested = e as Error;
    }
    assert.ok(errNested);
    assert.match(errNested!.message, /CR|carriage/i);
    assert.equal(w.chunks.length, 1, "nested CR rejected");

    // After all the rejections, a clean payload still goes through:
    // the queue is not poisoned by prior validation failures.
    await q.enqueue({ id: "D", type: "prompt", message: "clean" });
    assert.equal(w.chunks.length, 2);
    assert.match(w.chunks[1], /"id":"D"/);

    q.destroy("end of test");
  },
);

test("RpcStdinQueue: framing is LF-only (no CR; matches pi serializeJsonLine)", async () => {
  const w = makeFakeWritable();
  const q = new RpcStdinQueue(asWritable(w));

  await q.enqueue({ id: "X", type: "prompt", message: "hello" });
  await q.enqueue({ id: "Y", type: "abort" });

  for (const chunk of w.chunks) {
    // Exactly one LF, at the end.
    assert.equal(chunk.endsWith("\n"), true);
    assert.equal(chunk.split("\n").length, 2);
    // No CR anywhere.
    assert.equal(chunk.includes("\r"), false, `framing must be LF-only; got ${JSON.stringify(chunk)}`);
    // No double-LF.
    assert.equal(chunk.includes("\n\n"), false);
  }

  // Round-trip parse: stripping the trailing \n yields valid JSON
  // matching the original command shape.
  const parsed1 = JSON.parse(w.chunks[0].slice(0, -1));
  assert.equal(parsed1.id, "X");
  assert.equal(parsed1.type, "prompt");
  assert.equal(parsed1.message, "hello");

  const parsed2 = JSON.parse(w.chunks[1].slice(0, -1));
  assert.equal(parsed2.id, "Y");
  assert.equal(parsed2.type, "abort");

  q.destroy("end of test");
});
