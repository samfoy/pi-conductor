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
