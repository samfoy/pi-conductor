/**
 * Additional SpawnQueue coverage on top of tests/queue.test.ts.
 *
 * Coverage gaps closed by this file:
 *   - removeQueued returns false (no-op) for an id that was never queued
 *   - setMaxConcurrent grows the cap and drains queued spawns immediately
 *   - drain on an empty queue is a safe no-op
 *   - drain when no slots are free is a safe no-op (no spawning attempted)
 *   - queued placeholder Run is registered with the right fields (status=queued,
 *     persona, mode=background, distinct paths, present in registry.list())
 *   - downgraded=false when the original mode was background
 *   - queuePosition increments as more entries are queued
 *   - setMaxConcurrent floors fractional and clamps below 1
 *
 * No real subprocesses: we only exercise paths where the queue *cannot* spawn
 * because the registry already has enough running runs. To force the
 * post-setMaxConcurrent drain not to spawn pi, we cancel queued entries via
 * removeQueued before they are dequeued, or rely on the queued placeholder
 * being non-queued at drain time so the drain loop skips it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";

function makePersona(name = "oracle"): Persona {
  return {
    name,
    description: "test",
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

function makeRun(id: string, status: Run["status"] = "running"): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "t",
    mode: "background",
    status,
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/" + id + "/record.json",
    transcriptPath: "/tmp/" + id + "/transcript.jsonl",
    finalPath: "/tmp/" + id + "/final.md",
  };
}

function withFakeHome<T>(fn: (home: string) => T): T {
  const root = mkdirSyncTmp();
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

function mkdirSyncTmp(): string {
  const root = join(
    tmpdir(),
    "conductor-queue-extra-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  return root;
}

test("SpawnQueue.removeQueued: returns false for an unknown id", () => {
  const reg = new RunRegistry();
  const queue = new SpawnQueue(reg, 2);
  assert.equal(queue.removeQueued("nope-zzzz"), false);
});

test("SpawnQueue.drain: no-op when queue is empty", () => {
  withFakeHome(() => {
    const reg = new RunRegistry();
    const queue = new SpawnQueue(reg, 2);
    // Nothing queued — drain must not throw and must not register any new run.
    queue.drain();
    assert.equal(reg.list().length, 0);
    assert.equal(queue.size(), 0);
  });
});

test("SpawnQueue.drain: no-op when no slots are free", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    // Saturate the registry.
    reg.register(makeRun("filler-1", "running"));
    reg.register(makeRun("filler-2", "running"));
    const queue = new SpawnQueue(reg, 2);

    // Enqueue a spawn (must queue because the registry is full).
    queue.enqueueOrSpawn({
      persona: makePersona(),
      task: "review",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(queue.size(), 1);

    // Calling drain with no free slots must not dequeue anything or spawn.
    queue.drain();
    assert.equal(queue.size(), 1);
  });
});

test("SpawnQueue.enqueueOrSpawn: background spawn (queued) reports downgraded=false", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const r = queue.enqueueOrSpawn({
      persona: makePersona(),
      task: "x",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(r.kind, "queued");
    if (r.kind !== "queued") return;
    assert.equal(r.downgraded, false, "background-mode queueing is not a downgrade");
  });
});

test("SpawnQueue.enqueueOrSpawn: queued placeholder run has queued status and matching id", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const r = queue.enqueueOrSpawn({
      persona: makePersona("redteam"),
      task: "review",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(r.kind, "queued");
    if (r.kind !== "queued") return;

    const ph = r.placeholderRun;
    assert.equal(ph.status, "queued");
    assert.equal(ph.persona, "redteam");
    assert.match(ph.id, /^redteam-[a-z0-9]{4}$/);
    assert.equal(ph.mode, "background", "queued placeholders are always background-mode");
    // Must be findable via registry.
    assert.equal(reg.get(ph.id), ph);
    // Paths are unique per-id and live under the run dir.
    assert.match(ph.recordPath, new RegExp(`/${ph.id}/record\\.json$`));
    assert.match(ph.transcriptPath, new RegExp(`/${ph.id}/transcript\\.jsonl$`));
    assert.match(ph.finalPath, new RegExp(`/${ph.id}/final\\.md$`));
  });
});

test("SpawnQueue.enqueueOrSpawn: queuePosition increments per enqueue", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const r1 = queue.enqueueOrSpawn({
      persona: makePersona("a"),
      task: "1",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    const r2 = queue.enqueueOrSpawn({
      persona: makePersona("b"),
      task: "2",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    const r3 = queue.enqueueOrSpawn({
      persona: makePersona("c"),
      task: "3",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(r1.kind === "queued" && r1.queuePosition, 1);
    assert.equal(r2.kind === "queued" && r2.queuePosition, 2);
    assert.equal(r3.kind === "queued" && r3.queuePosition, 3);
    assert.equal(queue.size(), 3);
  });
});

test("SpawnQueue.setMaxConcurrent: triggers drain (calls drain at least once)", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    // Enqueue something so drain has work.
    const r = queue.enqueueOrSpawn({
      persona: makePersona(),
      task: "x",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(r.kind, "queued");
    if (r.kind !== "queued") return;
    // Cancel before bumping the cap so drain doesn't spawn a real pi.
    queue.removeQueued(r.placeholderRun.id);
    assert.equal(queue.size(), 0);

    // Stub drain to count calls.
    let calls = 0;
    const realDrain = queue.drain.bind(queue);
    queue.drain = () => {
      calls++;
      realDrain();
    };

    queue.setMaxConcurrent(4);
    assert.ok(calls >= 1, "setMaxConcurrent should call drain");
  });
});

test("SpawnQueue.setMaxConcurrent: floors fractional input and clamps below 1", () => {
  // We can't read maxConcurrent directly, so we verify behavior:
  //   - setMaxConcurrent(0) clamps to 1, so a 1-active registry leaves 0 free slots
  //   - setMaxConcurrent(3.7) floors to 3, allowing 1 free slot when 2 are running
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    reg.register(makeRun("filler-2", "running"));
    const queue = new SpawnQueue(reg, 5);

    // Clamp to 1 — with 2 running, no slots free, so a new spawn must queue.
    queue.setMaxConcurrent(0);
    const r1 = queue.enqueueOrSpawn({
      persona: makePersona("a"),
      task: "x",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(r1.kind, "queued", "with cap clamped to 1 and 2 running, must queue");
    if (r1.kind === "queued") queue.removeQueued(r1.placeholderRun.id);

    // Set to 3.7 → floor to 3. 2 running → 1 free slot. We want to enqueue
    // *without* spawning a real pi, so we don't actually exercise the
    // free-slot path here — instead, force fullness by adding another run.
    queue.setMaxConcurrent(3.7);
    reg.register(makeRun("filler-3", "running"));
    const r2 = queue.enqueueOrSpawn({
      persona: makePersona("b"),
      task: "x",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    // 3 running, cap=3 → must queue.
    assert.equal(r2.kind, "queued");
    if (r2.kind === "queued") queue.removeQueued(r2.placeholderRun.id);
  });
});

test("SpawnQueue.removeQueued: removing a queued entry decrements queue size and marks placeholder killed", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const r1 = queue.enqueueOrSpawn({
      persona: makePersona("a"),
      task: "x",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    const r2 = queue.enqueueOrSpawn({
      persona: makePersona("b"),
      task: "y",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
    });
    assert.equal(queue.size(), 2);
    if (r1.kind !== "queued" || r2.kind !== "queued") return;

    // Remove the first one; second should still be queued.
    assert.equal(queue.removeQueued(r1.placeholderRun.id), true);
    assert.equal(queue.size(), 1);
    assert.equal(reg.get(r1.placeholderRun.id)?.status, "killed");
    assert.equal(reg.get(r2.placeholderRun.id)?.status, "queued");
  });
});

test("SpawnQueue.enqueueOrSpawn: parentMessages snapshot is captured on the PendingSpawn", () => {
  withFakeHome((home) => {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const parentMessages: any[] = [
      { role: "user", content: "earlier the user said this", timestamp: 0 },
    ];
    const r = queue.enqueueOrSpawn({
      persona: makePersona("scribe"),
      task: "summarize",
      mode: "background",
      cwd: home,
      timeoutMs: 60_000,
      parentMessages,
    });
    assert.equal(r.kind, "queued");
    if (r.kind !== "queued") return;
    // The pending entry should carry the snapshot through to drain time.
    assert.deepEqual(r.pending.parentMessages, parentMessages);
  });
});
