/**
 * v0.12 RPC stdin queue — single-writer JSON-line queue for one
 * sub-agent's stdin.
 *
 * Mitigates Risk #1 from `docs/v0.12-steering-design.md` §4.2 +
 * `docs/v0.12-steering-inspector-map.md` §6 (stdin race / partial-
 * event tearing). All RPC commands flow through this queue.
 * **Absolutely no other code may call `proc.stdin.write(...)`
 * directly.**
 *
 * Sequencing guarantee: commands are framed and delivered in
 * submit order; back-pressure is awaited; partial writes are joined;
 * framing is LF-only (matches pi's `serializeJsonLine` per
 * `[pi-dist] modes/rpc/jsonl.d.ts`).
 *
 * The returned promise resolves when the line is fully written to
 * the pipe (kernel acknowledges the write via the `write()`
 * callback). It does **NOT** resolve when the pi server has acted
 * on the command — that's the response line on stdout (slice 3+).
 *
 * Slice 2 lands the queue in isolation; slice 3 wires it into
 * `runPiSubprocess` after the rpc-mode subprocess plumbing is in.
 */

import type { Writable } from "node:stream";

/**
 * Recursively scan a value for any string field containing a raw
 * CR. Returns `"\r"` on first hit, or null. Bounded by `MAX_DEPTH`
 * to defeat cycle bombs; cycles otherwise are caught by
 * `JSON.stringify` later.
 *
 * Why CR-only (was LF + CR pre-v0.12-slice-6): `JSON.stringify`
 * always escapes a string-value `\n` to the JSON two-char escape
 * `\\n`, so the wire byte-stream never carries a raw LF inside a
 * payload string — pi's `attachJsonlLineReader` framing is safe.
 * Slice 2 was over-defensive: it rejected raw `\n` in input strings
 * AND broke slice 3's initial-prompt-injection path, because
 * `buildSubAgentPrompt` always produces multi-line text. The slice 6
 * live integration tests caught it (no `response` line ever arrived
 * because every steerable spawn's initial prompt was silently
 * rejected by the queue's pre-check).
 *
 * CR (`\r`) is still rejected because pi's reader strips a trailing
 * `\r` before parsing; a CR inside a payload string is unusual and
 * not produced by any production caller, so we keep that defense as
 * a tripwire for accidental CRLF tooling. Drop if a real use case
 * appears.
 */
function findRawCr(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof value === "string") return value.includes("\r");
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) if (findRawCr(item, depth + 1)) return true;
    return false;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (findRawCr((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/** A single FIFO entry — one enqueued command. */
interface QueueEntry {
  /** Pre-stringified JSON line (without the trailing newline). */
  json: string;
  resolve: () => void;
  reject: (err: Error) => void;
  /** Set once resolve/reject has fired so destroy() doesn't double-settle. */
  settled: boolean;
}

export class RpcStdinQueue {
  private readonly stream: Writable;
  private readonly queue: QueueEntry[] = [];
  /** The entry currently awaiting its write callback, if any. */
  private inFlightEntry: QueueEntry | null = null;
  /** True after destroy(); subsequent enqueues reject immediately. */
  private destroyed = false;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  /**
   * Enqueue a command for sequenced JSON-line write. Resolves when
   * the kernel acknowledges the write; rejects on EPIPE / ECANCELED
   * (with `cause` set to the underlying `Error`) or if the queue has
   * been destroyed.
   *
   * Embedded LF / CR characters in the stringified payload are
   * rejected synchronously (LF-only framing invariant).
   */
  enqueue(cmd: object): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error("RpcStdinQueue is destroyed; cannot enqueue"));
        return;
      }

      // CR-only framing tripwire. `JSON.stringify` escapes a
      // string-value `\n` to `\\n` (the JSON two-char escape) so the
      // wire byte-stream never carries a raw LF inside a payload —
      // pi's `attachJsonlLineReader` framing is safe regardless. We
      // keep CR rejection as a defense against accidental CRLF
      // tooling (pi's reader strips trailing `\r` before parsing,
      // but mid-payload CR is still suspicious).
      //
      // Slice 2 originally rejected raw `\n` too; that broke slice 3's
      // initial-prompt injection because `buildSubAgentPrompt` always
      // produces multi-line text. The slice 6 live integration tests
      // caught it (no `response` line ever arrived because every
      // steerable spawn's initial prompt was rejected here). Removed
      // 2026-05-28 as part of slice 6 closure.
      if (findRawCr(cmd)) {
        reject(
          new Error(
            "embedded carriage return in command payload string field; LF-only framing forbids raw CR",
          ),
        );
        return;
      }

      let json: string;
      try {
        json = JSON.stringify(cmd);
      } catch (e) {
        reject(new Error(`failed to JSON.stringify command: ${(e as Error).message}`));
        return;
      }

      const entry: QueueEntry = {
        json,
        resolve: () => {
          if (entry.settled) return;
          entry.settled = true;
          resolve();
        },
        reject: (err: Error) => {
          if (entry.settled) return;
          entry.settled = true;
          reject(err);
        },
        settled: false,
      };
      this.queue.push(entry);
      this.pump();
    });
  }

  /**
   * Synchronously reject every pending entry (in-flight + queued)
   * with an Error whose message embeds the supplied reason. Idempotent:
   * a second destroy() call is a no-op.
   */
  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const err = new Error(`RpcStdinQueue destroyed: ${reason}`);
    // In-flight entry first — its write callback may still fire later
    // (the kernel/stream finishes the write or errors), but its
    // resolve/reject are guarded by `entry.settled` so nothing
    // double-fires.
    if (this.inFlightEntry) {
      const e = this.inFlightEntry;
      this.inFlightEntry = null;
      e.reject(err);
    }
    const drained = this.queue.splice(0, this.queue.length);
    for (const entry of drained) {
      entry.reject(err);
    }
  }

  // ── Internals ───────────────────────────────────────────────────

  /**
   * Pump the next queued entry into the stream, one at a time.
   * Callback-based so we observe back-pressure correctly: the
   * Writable's _write callback fires only after the chunk is
   * accepted into the internal buffer (or rejected).
   */
  private pump(): void {
    if (this.inFlightEntry !== null || this.destroyed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.inFlightEntry = entry;

    const line = entry.json + "\n";

    // Defensive null-guard. If the stream is undefined (consumer
    // bug) or already destroyed, fail this entry and the queue
    // explicitly.
    if (!this.stream || this.stream.writableEnded || this.stream.destroyed) {
      this.inFlightEntry = null;
      const err = new Error("RpcStdinQueue: underlying stream is not writable") as Error & {
        cause?: unknown;
      };
      entry.reject(err);
      // Continue draining — let the next entry observe the same
      // failure mode (or recover, if e.g. a test reattaches).
      this.pump();
      return;
    }

    const onWriteSettled = (err: Error | null | undefined): void => {
      // destroy() may have already cleared our slot and rejected
      // the entry. The entry's settled-guard short-circuits, but
      // we still need to advance the pump.
      if (this.inFlightEntry === entry) {
        this.inFlightEntry = null;
      }
      if (err) {
        const wrapped = new Error(
          `RpcStdinQueue write failed: ${err.message}`,
        ) as Error & { cause?: unknown };
        wrapped.cause = err;
        entry.reject(wrapped);
      } else {
        entry.resolve();
      }
      // Drain the next entry whether the previous one succeeded or
      // failed — a single EPIPE shouldn't poison subsequent writes
      // (per design §4.2 + plan slice 2 acceptance "queued writes
      // after still succeed when pipe is alive again").
      if (!this.destroyed) this.pump();
    };

    try {
      this.stream.write(line, "utf8", onWriteSettled);
    } catch (e) {
      // Some Writable implementations throw synchronously when
      // their underlying resource is gone (EPIPE on a closed pipe,
      // for instance). Funnel that into the same settled path.
      onWriteSettled(e as Error);
    }
  }
}
