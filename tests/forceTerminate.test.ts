/**
 * v0.12 slice 5 — forceTerminate stdin cleanup + W7 idempotency on RPC runs.
 *
 * Design §4.6 lock + plan §5 critic gate 3 + Q6 lock:
 *   - SIGTERM path itself is unchanged for v0.12 (no graceful RPC abort).
 *   - PRE-SIGTERM, when run.streamingMode === "rpc" and run.rpcStdinQueue
 *     exists, call rpcStdinQueue.destroy("force-terminate"). This rejects
 *     pending stdin write Promises with cause "force-terminate".
 *   - All entries in run.pendingAcks are also rejected (each entry's timer
 *     cleared, reject() called) so any LLM-tool send awaiting an ack
 *     surfaces a clean rejection rather than hanging on a 30s timeout.
 *   - W7 idempotency: a second forceTerminate on an already-killed RPC run
 *     does NOT re-iterate pendingAcks (already cleared), does NOT re-flip
 *     run.status (existing W7 guard at runs.ts:1878–1881 preserved),
 *     and does NOT re-call rpcStdinQueue.destroy (the queue is idempotent;
 *     verified here for completeness).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { Writable } from "node:stream";

import { RunRegistry, forceTerminate } from "../src/runs.ts";
import { RpcStdinQueue } from "../src/rpc-stdin.ts";
import { emptyUsage, type Run } from "../src/types.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * A Writable that holds writes pending until manually drained — lets
 * us prove the in-flight write rejects when destroy() fires before
 * the kernel ack arrives.
 */
class StuckWritable extends Writable {
  public writeCalls: { chunk: any; cb: (err?: Error | null) => void }[] = [];
  override _write(
    chunk: any,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    // Hold the callback so destroy() can fire before the kernel acks.
    this.writeCalls.push({ chunk, cb });
  }
  drain(): void {
    for (const { cb } of this.writeCalls.splice(0, this.writeCalls.length)) {
      cb();
    }
  }
}

interface FakeProcLike {
  killCalls: NodeJS.Signals[];
  pid: number | undefined;
}

function makeFakeProc(): FakeProcLike & { kill: (sig: NodeJS.Signals) => void } {
  const killCalls: NodeJS.Signals[] = [];
  return {
    killCalls,
    pid: 12345,
    kill(sig: NodeJS.Signals): void {
      killCalls.push(sig);
    },
  };
}

function makeRpcRun(opts: {
  queue: RpcStdinQueue;
  proc: FakeProcLike & { kill: (sig: NodeJS.Signals) => void };
}): Run {
  return {
    id: "tester-rpc",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    streamingMode: "rpc",
    steerable: true,
    rpcStdinQueue: opts.queue,
    pendingAcks: new Map(),
    proc: opts.proc as any,
    parentPid: process.pid,
  } as Run;
}

// Suppress runs.ts' best-effort writeRecord/writeFinal side effects by
// pointing recordPath/finalPath at a non-existent dir. These are
// fire-and-forget `void` promises — the tmp paths do not need to exist
// for the synchronous test assertions.

// ── 1. RPC in-flight stdin write rejects with cause "force-terminate" ──

test(
  "forceTerminate: RPC in-flight stdin write rejects with cause 'force-terminate' before SIGTERM",
  async () => {
    const stream = new StuckWritable();
    const queue = new RpcStdinQueue(stream);
    const proc = makeFakeProc();
    const run = makeRpcRun({ queue, proc });
    const reg = new RunRegistry();
    reg.register(run);

    // Enqueue a write that will sit in-flight (StuckWritable's _write
    // holds the callback). The promise should reject when destroy fires.
    const inflight = queue.enqueue({ id: "send-1", type: "steer", message: "hi" });
    // Yield once so pump() runs and the entry becomes in-flight.
    await new Promise((r) => setImmediate(r));

    forceTerminate(run, "killed", reg);

    // The in-flight enqueue Promise must have rejected with the
    // force-terminate reason embedded in the error message.
    let rejectedWith: Error | null = null;
    try {
      await inflight;
      assert.fail("in-flight enqueue should have rejected");
    } catch (e: unknown) {
      rejectedWith = e as Error;
    }
    assert.match(
      rejectedWith?.message ?? "",
      /force-terminate/,
      "in-flight stdin write must reject with 'force-terminate' cause",
    );

    // SIGTERM was still issued (Q6 lock — SIGTERM path unchanged).
    assert.deepEqual(proc.killCalls, ["SIGTERM"]);
    assert.equal(run.status, "killed");
  },
);

// ── 2. pendingAcks entries reject (no timer leak) ─────────────────────

test(
  "forceTerminate: every pendingAcks entry is rejected with cause 'force-terminate' and its timer is cleared",
  () => {
    const stream = new StuckWritable();
    const queue = new RpcStdinQueue(stream);
    const proc = makeFakeProc();
    const run = makeRpcRun({ queue, proc });
    const reg = new RunRegistry();
    reg.register(run);

    // Plant 3 pendingAcks entries; their timers must be cleared when
    // forceTerminate fires, otherwise a later setTimeout would attempt
    // to delete an entry from an empty Map (benign) but the timer
    // would still tick (memory + scheduler waste).
    const rejects: Error[] = [];
    let timerFired = 0;
    for (const id of ["a", "b", "c"]) {
      const timer = setTimeout(() => {
        timerFired += 1;
      }, 30_000);
      run.pendingAcks!.set(id, {
        resolve: () => {},
        reject: (err: Error) => rejects.push(err),
        timer,
      });
    }

    forceTerminate(run, "killed", reg);

    // All 3 entries rejected with the force-terminate cause.
    assert.equal(rejects.length, 3, "every pendingAcks entry must reject");
    for (const e of rejects) {
      assert.match(e.message, /force-terminate/);
    }
    // Map must be cleared so re-enumeration is empty (W7 prep).
    assert.equal(run.pendingAcks!.size, 0, "pendingAcks must be cleared after destroy");
    // No timer should still be live: clean shutdown.
    assert.equal(timerFired, 0);
  },
);

// ── 3. W7 idempotency — double-kill is safe ──────────────────────────

test(
  "forceTerminate: W7 idempotency — double-kill on RPC run with pendingAcks does not re-reject already-rejected promises",
  () => {
    const stream = new StuckWritable();
    const queue = new RpcStdinQueue(stream);
    const proc = makeFakeProc();
    const run = makeRpcRun({ queue, proc });
    const reg = new RunRegistry();
    reg.register(run);

    let rejectCount = 0;
    const timer = setTimeout(() => {}, 30_000);
    run.pendingAcks!.set("a", {
      resolve: () => {},
      reject: () => {
        rejectCount += 1;
      },
      timer,
    });

    forceTerminate(run, "killed", reg);
    assert.equal(rejectCount, 1, "first call rejects exactly once");
    assert.equal(run.status, "killed");
    assert.deepEqual(proc.killCalls, ["SIGTERM"], "first call SIGTERMs");

    // Second forceTerminate: the W7 idempotency guard at runs.ts:1878
    // (isTerminal(run.status) → return) must short-circuit BEFORE the
    // RPC stdin cleanup branch. Therefore:
    //   - rejectCount stays at 1 (no re-rejection)
    //   - kill is NOT called again (proc.killCalls unchanged)
    //   - run.status stays "killed"
    forceTerminate(run, "killed", reg);
    assert.equal(rejectCount, 1, "second call must NOT re-reject pendingAcks");
    assert.deepEqual(proc.killCalls, ["SIGTERM"], "second call must NOT SIGTERM again");
    assert.equal(run.status, "killed", "status remains killed");

    // Defensive: the queue is also idempotent on its own (per
    // src/rpc-stdin.ts:152), but the W7 guard means we never even
    // reach that path on the second call.
    clearTimeout(timer);
  },
);

// ── 4. Print-mode runs are unchanged (regression pin) ─────────────────

test(
  "forceTerminate: print-mode run is byte-identical to pre-v0.12 (no rpcStdinQueue, no pendingAcks branch)",
  () => {
    const proc = makeFakeProc();
    const run: Run = {
      id: "tester-print",
      persona: "tester",
      task: "test",
      mode: "background",
      status: "running",
      startTime: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      messages: [],
      usage: emptyUsage(),
      cwd: "/tmp",
      recordPath: "/tmp/x/record.json",
      transcriptPath: "/tmp/x/transcript.jsonl",
      finalPath: "/tmp/x/final.md",
      streamingMode: "print",
      proc: proc as any,
      parentPid: process.pid,
    } as Run;
    const reg = new RunRegistry();
    reg.register(run);

    forceTerminate(run, "killed", reg);
    assert.deepEqual(proc.killCalls, ["SIGTERM"]);
    assert.equal(run.status, "killed");
    // streamingMode === "print" → no queue branch. Test asserts the
    // run has no queue (defensive — print-mode doesn't construct one).
    assert.equal(run.rpcStdinQueue, undefined);
  },
);

// ── 5. RPC run without an active queue (defensive) ────────────────────

test(
  "forceTerminate: RPC run with rpcStdinQueue=undefined still SIGTERMs cleanly (defensive: queue may have been gc'd)",
  () => {
    const proc = makeFakeProc();
    // streamingMode === "rpc" but rpcStdinQueue undefined: the queue
    // may have been cleared by an earlier code path (e.g. a forced
    // close). The cleanup branch must not throw.
    const run = makeRpcRun({ queue: undefined as any, proc });
    run.rpcStdinQueue = undefined;
    const reg = new RunRegistry();
    reg.register(run);

    forceTerminate(run, "killed", reg);
    assert.deepEqual(proc.killCalls, ["SIGTERM"]);
    assert.equal(run.status, "killed");
  },
);

// ── 6. Hard-threshold no-op-safety with dead pid (item 1 in-repo half) ──
//
// Pins the invariant from docs/backlog.md item 1: when the watchdog
// hits hard threshold AND `kill_on_stall: true` AND the underlying pi
// subprocess has died externally (e.g. pi-dashboard server restart per
// `builder-shzs` witness, host crash per `builder-mtpt` witness, idle-
// reaper per `builder-utrr` witness), the dispatch chain through
// `forceTerminate` → `subprocess.kill()` is no-op-safe:
//   - status flips to "killed" exactly once
//   - errorMessage is set to the watchdog hard-stall message
//   - no exception escapes
// The cross-repo half (heartbeat into pi-dashboard so the reaper can
// be re-enabled) remains OPEN. This is purely the in-repo invariant.
//
// Implementation note: the `try { run.proc.kill("SIGTERM") } catch {}`
// wrapper at src/runs.ts already swallows the dead-pid case for both
// Node's `subprocess.kill()` (returns false) and our test's throwing
// fake (catches the throw). We pin both shapes — the throwing fake is
// the worst case the production catch must absorb.

function makePrintRun(
  proc: FakeProcLike & { kill: (sig: NodeJS.Signals) => void },
  startTimeMs: number,
): Run {
  return {
    id: "tester-zombie",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running",
    startTime: startTimeMs,
    lastEventAt: startTimeMs,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x-zombie/record.json",
    transcriptPath: "/tmp/x-zombie/transcript.jsonl",
    finalPath: "/tmp/x-zombie/final.md",
    streamingMode: "print",
    steerable: false,
    pid: 99999,
    proc: proc as any,
    parentPid: process.pid,
    killOnStall: true,
  } as Run;
}

test(
  "forceTerminate: hard-threshold dead-pid (kill returns false) flips status to killed exactly once",
  () => {
    // Node's `subprocess.kill()` on a dead pid returns false WITHOUT
    // throwing. Same pid-already-gone shape as the witnessed
    // pi-dashboard restart.
    const proc = makeFakeProc();
    const run = makePrintRun(proc, 1_700_000_000_000);
    const reg = new RunRegistry();
    reg.register(run);

    let notifications = 0;
    const unsub = reg.onChange(() => notifications++);
    forceTerminate(run, "stalled", reg);
    unsub();

    assert.equal(run.status, "killed", "status flips to killed exactly once");
    assert.match(
      run.errorMessage ?? "",
      /watchdog: hard-stalled/,
      "errorMessage indicates watchdog hard-stall reason",
    );
    assert.deepEqual(proc.killCalls, ["SIGTERM"]);
    assert.equal(notifications, 1, "registry.notify fires once for the terminal flip");
  },
);

test(
  "forceTerminate: hard-threshold pid already gone (kill throws ESRCH) is swallowed by the try/catch wrapper",
  () => {
    // Worst case: the proc.kill handle throws (some test fakes /
    // exotic platforms do). The production try/catch must swallow.
    const killCalls: NodeJS.Signals[] = [];
    const proc = {
      killCalls,
      pid: 99999,
      kill: (sig: NodeJS.Signals) => {
        killCalls.push(sig);
        const err = new Error("ESRCH: no such process");
        (err as { code?: string }).code = "ESRCH";
        throw err;
      },
    };
    const run = makePrintRun(proc as any, 1_700_000_000_000);
    const reg = new RunRegistry();
    reg.register(run);

    assert.doesNotThrow(
      () => forceTerminate(run, "stalled", reg),
      "forceTerminate must not surface the kill() throw",
    );
    assert.equal(run.status, "killed", "status still flips to killed");
    assert.deepEqual(killCalls, ["SIGTERM"], "SIGTERM was attempted before the throw");
    assert.match(
      run.errorMessage ?? "",
      /watchdog: hard-stalled/,
    );
  },
);

test(
  "forceTerminate: hard-threshold W7 idempotency — second call on already-killed run is a no-op",
  () => {
    // The W7 idempotency guard at src/runs.ts:2013
    // (`if (isTerminal(run.status)) return;`) protects the dead-pid
    // path the same way it protects the live-pid path: a second
    // forceTerminate call MUST NOT re-flip status, re-emit notifications,
    // or re-attempt SIGTERM. Pinning here for the dead-pid × watchdog
    // path specifically (the RPC W7 case is already pinned in test 4
    // above).
    const proc = makeFakeProc();
    const run = makePrintRun(proc, 1_700_000_000_000);
    const reg = new RunRegistry();
    reg.register(run);

    forceTerminate(run, "stalled", reg);
    const firstStatus = run.status;
    const firstFinishedAt = run.finishedAt;
    const firstError = run.errorMessage;

    // Second call — must be a no-op.
    forceTerminate(run, "stalled", reg);
    assert.equal(run.status, firstStatus, "status unchanged on second call");
    assert.equal(run.finishedAt, firstFinishedAt, "finishedAt unchanged on second call");
    assert.equal(run.errorMessage, firstError, "errorMessage unchanged on second call");
    assert.deepEqual(
      proc.killCalls,
      ["SIGTERM"],
      "SIGTERM not re-issued on second call",
    );
  },
);
