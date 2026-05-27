/**
 * Tests for `resolveSendStrategy` — the v0.12 pure decision matrix that
 * routes an `ensemble_send` call to one of:
 *   - rpc-steer    (RPC steer command on live subprocess)
 *   - rpc-follow-up (RPC follow_up command on live subprocess)
 *   - spawn-resume  (pi --session <path> on a fresh subprocess)
 *   - rejected     (state/behavior incompatible — caller-visible reason)
 *
 * Slice 1 lands the resolver only. No production path produces
 * `streamingMode === "rpc"` yet; tests construct fixtures manually.
 * Slice 4 wires the cascade upstream; slice 2 lands the RPC subprocess
 * plumbing. validateSendable becomes a thin shim around
 * `resolveSendStrategy(run, "auto")` plus a post-strategy I/O check
 * for session-file existence.
 *
 * Decision matrix pinned in `docs/v0.12-steering-design.md` §4.3
 * (lines ~571–640). Reject reasons are character-pinned (W3 string
 * witness) so user-visible text drift is detectable.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveSendStrategy, stampSpawnStreamingMode } from "../src/runs.ts";
import {
  emptyUsage,
  type ResolvedSendStrategy,
  type Run,
  type StreamingBehavior,
} from "../src/types.ts";

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "tester-aaaa",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    finalPath: "/tmp/f.md",
    ...overrides,
  };
}

function expectKind(
  r: ResolvedSendStrategy,
  kind: ResolvedSendStrategy["strategy"]["kind"],
): void {
  assert.equal(
    r.strategy.kind,
    kind,
    `expected strategy.kind=${kind}, got ${r.strategy.kind}` +
      (r.strategy.kind === "rejected" ? ` (reason: ${r.strategy.reason})` : ""),
  );
}

function expectRejection(r: ResolvedSendStrategy): { reason: string } {
  if (r.strategy.kind !== "rejected") {
    assert.fail(`expected rejection, got ${r.strategy.kind}`);
  }
  return { reason: r.strategy.reason };
}

// ── running × rpc ─────────────────────────────────────────────────────

test("resolveSendStrategy: running rpc + auto → rpc-follow-up", () => {
  const run = runFx({ status: "running", streamingMode: "rpc", steerable: true });
  expectKind(resolveSendStrategy(run, "auto"), "rpc-follow-up");
});

test("resolveSendStrategy: running rpc + steer → rpc-steer", () => {
  const run = runFx({ status: "running", streamingMode: "rpc", steerable: true });
  expectKind(resolveSendStrategy(run, "steer"), "rpc-steer");
});

test("resolveSendStrategy: running rpc + follow_up → rpc-follow-up", () => {
  const run = runFx({ status: "running", streamingMode: "rpc", steerable: true });
  expectKind(resolveSendStrategy(run, "follow_up"), "rpc-follow-up");
});

test('resolveSendStrategy: running rpc + resume → rejected with "currently running"', () => {
  const run = runFx({ status: "running", streamingMode: "rpc", steerable: true });
  const { reason } = expectRejection(resolveSendStrategy(run, "resume"));
  assert.match(reason, /currently running/);
  assert.match(reason, /resume is for terminal runs/);
});

// ── running × print (or undefined) ────────────────────────────────────

test('resolveSendStrategy: running print + (any) → rejected with "is not steerable; mark steerable: true at spawn"', () => {
  // streamingMode undefined defaults to "print" semantically — production
  // pre-v0.12 paths never set the field, and the resolver must treat
  // those as not-steerable. Both undefined and "print" are tested.
  for (const mode of [undefined, "print" as const]) {
    for (const behavior of ["auto", "steer", "follow_up", "resume"] as StreamingBehavior[]) {
      const run = runFx({ status: "running", streamingMode: mode });
      const { reason } = expectRejection(resolveSendStrategy(run, behavior));
      assert.match(reason, /is not steerable; mark steerable: true at spawn/);
    }
  }
});

// ── paused ────────────────────────────────────────────────────────────

test('resolveSendStrategy: paused (any) → rejected with "is paused; resume it first"', () => {
  for (const mode of [undefined, "print" as const, "rpc" as const]) {
    for (const behavior of ["auto", "steer", "follow_up", "resume"] as StreamingBehavior[]) {
      const run = runFx({ status: "paused", streamingMode: mode });
      const { reason } = expectRejection(resolveSendStrategy(run, behavior));
      assert.match(reason, /is paused; resume it first/);
    }
  }
});

// ── queued ────────────────────────────────────────────────────────────

test('resolveSendStrategy: queued (any) → rejected with "is queued and has not started yet"', () => {
  for (const behavior of ["auto", "steer", "follow_up", "resume"] as StreamingBehavior[]) {
    const run = runFx({ status: "queued", sessionPath: undefined });
    const { reason } = expectRejection(resolveSendStrategy(run, behavior));
    assert.match(reason, /is queued and has not started yet/);
  }
});

// ── terminal ──────────────────────────────────────────────────────────

test("resolveSendStrategy: terminal + auto → spawn-resume", () => {
  for (const status of ["completed", "failed", "killed", "timeout"] as const) {
    const run = runFx({ status, sessionPath: "/tmp/abc.jsonl" });
    expectKind(resolveSendStrategy(run, "auto"), "spawn-resume");
  }
});

test("resolveSendStrategy: terminal + resume → spawn-resume", () => {
  for (const status of ["completed", "failed", "killed", "timeout"] as const) {
    const run = runFx({ status, sessionPath: "/tmp/abc.jsonl" });
    expectKind(resolveSendStrategy(run, "resume"), "spawn-resume");
  }
});

test('resolveSendStrategy: terminal + steer → rejected with "has already finished"', () => {
  const run = runFx({ status: "completed", sessionPath: "/tmp/abc.jsonl" });
  const { reason } = expectRejection(resolveSendStrategy(run, "steer"));
  assert.match(reason, /has already finished/);
  assert.match(reason, /cannot steer a terminal run/);
});

test('resolveSendStrategy: terminal + follow_up → rejected with "has already finished"', () => {
  const run = runFx({ status: "completed", sessionPath: "/tmp/abc.jsonl" });
  const { reason } = expectRejection(resolveSendStrategy(run, "follow_up"));
  assert.match(reason, /has already finished/);
  assert.match(reason, /cannot follow_up a terminal run/);
});

test('resolveSendStrategy: terminal + sessionPath missing → rejected with "no resumable session"', () => {
  // sessionPath unset on a terminal run is the v0.5 "ensemble_send
  // bypass" failure mode. The resolver checks string presence (no I/O);
  // the disk-existence check stays in `validateSendable`'s shim layer.
  const run = runFx({ status: "completed", sessionPath: undefined });
  for (const behavior of ["auto", "resume"] as StreamingBehavior[]) {
    const { reason } = expectRejection(resolveSendStrategy(run, behavior));
    assert.match(reason, /has no resumable session on disk/);
    assert.match(reason, /sessionPath unset/);
  }
});

// ── W3 string-pin witness ─────────────────────────────────────────────

test("resolveSendStrategy: rejection reasons are character-pinned (W3 string witness — mutating one character fails)", () => {
  // W3 — character-precise pins on each rejection variant. Mutating one
  // character of any reason string here fails the corresponding pin.
  // This is what catches user-visible text drift across slices and
  // protects the LLM-facing `errorResult` envelopes from silent edits.

  // 1. running + rpc + resume
  {
    const run = runFx({ status: "running", streamingMode: "rpc", steerable: true });
    const r = resolveSendStrategy(run, "resume");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa is currently running; resume is for terminal runs only. Use streaming_behavior=steer or follow_up to send to the live subprocess.",
      );
    }
  }

  // 2. running + print + auto (non-steerable)
  {
    const run = runFx({ status: "running", streamingMode: "print" });
    const r = resolveSendStrategy(run, "auto");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa is not steerable; mark steerable: true at spawn to send messages while the subprocess is alive. (Currently running; wait for it to finish before sending again.)",
      );
    }
  }

  // 3. paused
  {
    const run = runFx({ status: "paused" });
    const r = resolveSendStrategy(run, "auto");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa is paused; resume it first via /conductor resume tester-aaaa.",
      );
    }
  }

  // 4. queued
  {
    const run = runFx({ status: "queued" });
    const r = resolveSendStrategy(run, "auto");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa is queued and has not started yet; wait for it to start before sending.",
      );
    }
  }

  // 5. terminal + steer
  {
    const run = runFx({ status: "completed", sessionPath: "/tmp/abc.jsonl" });
    const r = resolveSendStrategy(run, "steer");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa has already finished; cannot steer a terminal run. Send without streaming_behavior to spawn a fresh subprocess.",
      );
    }
  }

  // 6. terminal + follow_up
  {
    const run = runFx({ status: "completed", sessionPath: "/tmp/abc.jsonl" });
    const r = resolveSendStrategy(run, "follow_up");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa has already finished; cannot follow_up a terminal run. Send without streaming_behavior to spawn a fresh subprocess.",
      );
    }
  }

  // 7. terminal + sessionPath missing
  {
    const run = runFx({ status: "completed", sessionPath: undefined });
    const r = resolveSendStrategy(run, "auto");
    assert.equal(r.strategy.kind, "rejected");
    if (r.strategy.kind === "rejected") {
      assert.equal(
        r.strategy.reason,
        "sub-agent tester-aaaa has no resumable session on disk (sessionPath unset).",
      );
    }
  }
});

// ── Slice 3 smoke: spawn-time streaming-mode stamp ────────────────────
//
// `stampSpawnStreamingMode(run, steerable)` is the pure helper
// `runPiSubprocess` calls immediately after `spawn()` returns to set
// `run.steerable` and `run.streamingMode`. We test it directly so the
// smoke does NOT have to fork a real `pi --mode rpc` subprocess (slice
// 6 owns the live integration test). Pinning the helper output here
// guarantees `resolveSendStrategy` sees the same shape the production
// spawn pipeline will produce once slice 4 wires the per-call
// `steerable` cascade.

test("slice 3 smoke: stampSpawnStreamingMode(true) + resolveSendStrategy(\"auto\") → rpc-follow-up using actual run.streamingMode set by spawnRun", () => {
  const run = runFx({ status: "running" });
  // streamingMode + steerable both unset coming out of runFx
  // (mirrors a fresh run before runPiSubprocess attaches).
  assert.equal(run.streamingMode, undefined);
  assert.equal(run.steerable, undefined);

  // Same call runPiSubprocess will make in slice 3's stdio-pipe branch.
  stampSpawnStreamingMode(run, true);

  assert.equal(run.streamingMode, "rpc", "steerable=true → streamingMode=rpc");
  assert.equal(run.steerable, true, "steerable=true → run.steerable=true");

  // Resolver routes a steerable, RPC-mode running run + auto to
  // rpc-follow-up. Pin the full integration: helper-output → resolver.
  expectKind(resolveSendStrategy(run, "auto"), "rpc-follow-up");
});

test("slice 3 smoke: stampSpawnStreamingMode(false) preserves print-mode contract", () => {
  // Regression pin: the print-mode default produces streamingMode="print"
  // and steerable=false. resolveSendStrategy then rejects with the
  // not-steerable reason.
  const run = runFx({ status: "running" });
  stampSpawnStreamingMode(run, false);
  assert.equal(run.streamingMode, "print");
  assert.equal(run.steerable, false);
  const r = resolveSendStrategy(run, "auto");
  assert.equal(r.strategy.kind, "rejected");
  if (r.strategy.kind === "rejected") {
    assert.match(r.strategy.reason, /is not steerable; mark steerable: true at spawn/);
  }
});
