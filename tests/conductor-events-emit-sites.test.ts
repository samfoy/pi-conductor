/**
 * WDD tests for v0.16-S2: created + started emit sites.
 *
 * S2 — created + started emit sites
 * ─────────────────────────────────
 *   W1: spy confirms emitCreated called exactly once per direct spawnRun call.
 *       Killing mutation: remove the emitCreated call from the non-preAllocatedId
 *       branch of spawnRun → W1 test fails (call count = 0).
 *
 *   W2: spy confirms emitStarted fires at queued→running (preAllocatedId path),
 *       NOT at placeholder creation time (enqueueOrSpawn with full queue).
 *       Killing mutation: move emitStarted to top of spawnRun (unconditionally)
 *       instead of only in the preAllocatedId branch → W2-a still passes but
 *       W2-b fails (emitStarted count at placeholder-creation time = 1, not 0).
 *       OR: remove emitStarted from the preAllocatedId branch → W2-b fails
 *       (emitStarted never fires).
 *
 * S3 witnesses (emitCompleted, emitFailed, emitSteered) live here too but
 * are committed separately in v0.16-S3.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConductorEventEmitter,
  CHANNEL,
} from "../src/conductor-events.ts";
import {
  RunRegistry,
  spawnRun,
  emitFinalizeEvent,
} from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";

// ── Shared helpers ──────────────────────────────────────────────────────────

function makePersona(name = "oracle"): Persona {
  return {
    name,
    description: "test persona description",
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "you are " + name,
    source: "builtin",
    sourcePath: "/tmp/" + name + ".md",
    readOnly: false,
  };
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  const dir = join(tmpdir(), "conductor-events-emit-" + id);
  mkdirSync(dir, { recursive: true });
  return {
    id,
    persona: "builder",
    task: "test task",
    mode: "background",
    status: "running",
    startTime: Date.now() - 1000,
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    ...overrides,
  };
}

/** Fake event bus that records all emitted events. */
function makeFakeBus() {
  const events: { channel: string; data: unknown }[] = [];
  const bus = {
    emit(channel: string, data: unknown) {
      events.push({ channel, data });
    },
    on(_ch: string, _h: (d: unknown) => void): () => void {
      return () => {};
    },
  };
  return { bus, events };
}

function withFakeHome<T>(fn: (home: string) => T): T {
  const root = join(
    tmpdir(),
    "conductor-emit-home-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return fn(root);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ── S2 W1: emitCreated fires once per direct spawnRun ──────────────────────
//
// Killing mutation: remove the `opts.events?.emitCreated(...)` call from
// the `!opts.preAllocatedId` branch in spawnRun.
// → This test fails: createdEvents.length === 0 instead of 1.

test("S2-W1: emitCreated fires exactly once on direct spawnRun (no preAllocatedId)", (t, done) => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    const { bus, events } = makeFakeBus();
    const emitter = new ConductorEventEmitter(bus);

    const { run } = spawnRun({
      registry: reg,
      persona: makePersona(),
      task: "do the thing",
      mode: "background",
      cwd: home,
      timeoutMs: 5_000,
      events: emitter,
    });

    // emitCreated fires synchronously inside spawnRun before runPiSubprocess.
    // Check immediately; the subprocess will fail later (no real pi binary) but
    // that's irrelevant — we only care about the synchronous emit.
    const created = events.filter((e) => e.channel === CHANNEL.created);
    assert.strictEqual(created.length, 1, "emitCreated must fire exactly once");
    assert.strictEqual((created[0]!.data as any).id, run.id);
    assert.strictEqual((created[0]!.data as any).persona, run.persona);
    done();
  });
});

// ── S2 W2-a: emitStarted fires at preAllocatedId (drain) path ─────────────
//
// Killing mutation: remove the `opts.events?.emitStarted(...)` call from
// spawnRun entirely.
// → This test fails: startedEvents.length === 0 instead of 1.

test("S2-W2a: emitStarted fires once on drain path (preAllocatedId set)", (t, done) => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    const { bus, events } = makeFakeBus();
    const emitter = new ConductorEventEmitter(bus);

    // Simulate the drain path: spawnRun called with a preAllocatedId.
    spawnRun({
      registry: reg,
      persona: makePersona(),
      task: "do the thing",
      mode: "background",
      cwd: home,
      timeoutMs: 5_000,
      preAllocatedId: "oracle-drain-001",
      events: emitter,
    });

    // emitStarted fires synchronously for the drain (queued→running) path.
    const started = events.filter((e) => e.channel === CHANNEL.started);
    assert.strictEqual(started.length, 1, "emitStarted must fire exactly once on drain path");
    assert.strictEqual((started[0]!.data as any).id, "oracle-drain-001");

    // emitCreated must NOT fire on the drain path (it fired at queue time).
    const created = events.filter((e) => e.channel === CHANNEL.created);
    assert.strictEqual(created.length, 0, "emitCreated must NOT fire on drain path");
    done();
  });
});

// ── S2 W2-b: emitStarted NOT called at placeholder creation ───────────────
//
// Killing mutation: add an unconditional `opts.events?.emitStarted(...)` call
// inside `enqueueOrSpawn` when creating the placeholder.
// → This test fails: startedAtQueueTime.length === 1 instead of 0.

test("S2-W2b: emitStarted NOT called at placeholder creation (queue full)", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    const { bus, events } = makeFakeBus();
    const emitter = new ConductorEventEmitter(bus);

    // Fill the registry so the queue is full (no slots available).
    const filler1 = makeRun("filler-1");
    const filler2 = makeRun("filler-2");
    reg.register(filler1);
    reg.register(filler2);

    const queue = new SpawnQueue(reg, 2);

    // Enqueue a spawn — creates a placeholder with status="queued".
    const result = queue.enqueueOrSpawn({
      persona: makePersona(),
      task: "queued task",
      mode: "background",
      cwd: home,
      timeoutMs: 5_000,
      events: emitter,
    });

    assert.strictEqual(result.kind, "queued", "should be queued since slots are full");

    // At placeholder-creation time, emitCreated should fire but emitStarted should NOT.
    const created = events.filter((e) => e.channel === CHANNEL.created);
    const started = events.filter((e) => e.channel === CHANNEL.started);

    assert.strictEqual(created.length, 1, "emitCreated must fire at queue time");
    assert.strictEqual(started.length, 0, "emitStarted must NOT fire at placeholder creation");
  });
});

// ── S3 W1: emitCompleted payload has durationMs > 0 ──────────────────────
//
// Killing mutation: hardcode `durationMs: 0` in emitFinalizeEvent
// → this test fails: durationMs === 0, not >= 1000.

test("S3-W1: emitCompleted payload has durationMs >= 1000 when run lasted ~1s", () => {
  const { bus, events } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);

  const now = Date.now();
  const run = makeRun("s3-w1", {
    status: "completed",
    startTime: now - 1000,
    finishedAt: now,
  });

  emitFinalizeEvent(run, emitter);

  const completed = events.filter((e) => e.channel === CHANNEL.completed);
  assert.strictEqual(completed.length, 1, "emitCompleted must fire exactly once");
  const payload = completed[0]!.data as { durationMs: number };
  assert.ok(
    payload.durationMs >= 1000,
    `durationMs should be >= 1000 but got ${payload.durationMs}`,
  );
});

// ── S3 W2: emitFailed payload .status equals actual run.status ───────────
//
// Killing mutation: hardcode `status: "failed"` in the emitFailed call inside
// emitFinalizeEvent → W2 fails for "killed", "hook_failed", etc.

test("S3-W2: emitFailed payload.status reflects actual run.status (not hardcoded)", () => {
  const failureStatuses = ["killed", "hook_failed", "merge_conflict", "timeout"] as const;

  for (const status of failureStatuses) {
    const { bus, events } = makeFakeBus();
    const emitter = new ConductorEventEmitter(bus);

    const now = Date.now();
    const run = makeRun(`s3-w2-${status}`, {
      status,
      startTime: now - 500,
      finishedAt: now,
    });

    emitFinalizeEvent(run, emitter);

    const failed = events.filter((e) => e.channel === CHANNEL.failed);
    assert.strictEqual(failed.length, 1, `emitFailed must fire once for status=${status}`);
    const payload = failed[0]!.data as { status: string };
    assert.strictEqual(
      payload.status,
      status,
      `payload.status should be "${status}" but got "${payload.status}"`,
    );
  }
});

// ── S3 W3: emitFailed fires (and emitCompleted does NOT) for all failure terminals
//
// Killing mutation: remove `emitFailed` call from emitFinalizeEvent
// → W3 fails: failed.length === 0 instead of 1.

test("S3-W3: emitFailed fires for all failure terminals; emitCompleted does not", () => {
  const failureStatuses = ["killed", "hook_failed", "merge_conflict", "timeout"] as const;

  for (const status of failureStatuses) {
    const { bus, events } = makeFakeBus();
    const emitter = new ConductorEventEmitter(bus);

    const now = Date.now();
    const run = makeRun(`s3-w3-${status}`, {
      status,
      startTime: now - 200,
      finishedAt: now,
    });

    emitFinalizeEvent(run, emitter);

    const failed = events.filter((e) => e.channel === CHANNEL.failed);
    const completed = events.filter((e) => e.channel === CHANNEL.completed);

    assert.strictEqual(
      failed.length,
      1,
      `emitFailed must fire for status="${status}"`,
    );
    assert.strictEqual(
      completed.length,
      0,
      `emitCompleted must NOT fire for status="${status}"`,
    );
  }
});

// ── S3 W4: emitSteered NOT called on spawn-resume path ───────────────────
//
// Structural witness: verify the emitSteered call site is inside the RPC
// block (before the spawn-resume path), not at the function's return level.
//
// Killing mutation: move `opts.events?.emitSteered(...)` to after the
// spawn-resume block → W4 fails (steeredIdx > spawnResumeIdx).

test("S3-W4: emitSteered call is inside the RPC block, not on the spawn-resume path", async () => {
  const { readFileSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const src = readFileSync(
    pathJoin(new URL("../src/runs.ts", import.meta.url).pathname),
    "utf8",
  );

  const lines = src.split("\n");

  // Find the line that calls emitSteered
  const steeredIdx = lines.findIndex((l) => l.includes("emitSteered("));
  assert.ok(steeredIdx >= 0, "emitSteered call must exist in src/runs.ts");

  // The spawn-resume block starts with a comment "spawn-resume:" — find it.
  const spawnResumeIdx = lines.findIndex((l) => l.includes("spawn-resume:"));
  assert.ok(spawnResumeIdx >= 0, "spawn-resume: comment anchor must exist in src/runs.ts");

  assert.ok(
    steeredIdx < spawnResumeIdx,
    `emitSteered (line ${steeredIdx + 1}) must appear before spawn-resume block (line ${spawnResumeIdx + 1})`,
  );
});

