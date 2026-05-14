/**
 * Tests for the spawn queue + run registry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry, runDir } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";

function makePersona(name: string, body = "you are the " + name): Persona {
  return {
    name,
    description: "test persona",
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: body,
    source: "builtin",
    sourcePath: "/tmp/" + name + ".md",
  };
}

function makeRun(id: string, status: Run["status"] = "running"): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status,
    startTime: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/" + id + "/record.json",
    transcriptPath: "/tmp/" + id + "/transcript.jsonl",
    finalPath: "/tmp/" + id + "/final.md",
  };
}

test("RunRegistry: countActive ignores queued and terminal runs", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1", "running"));
  reg.register(makeRun("a-2", "queued"));
  reg.register(makeRun("a-3", "completed"));
  reg.register(makeRun("a-4", "paused"));
  reg.register(makeRun("a-5", "failed"));

  // running + paused = 2 active (queued + terminal don't count)
  assert.equal(reg.countActive(), 2);
  assert.equal(reg.countQueued(), 1);
});

test("RunRegistry: onChange notifies subscribers", () => {
  const reg = new RunRegistry();
  let calls = 0;
  const unsub = reg.onChange(() => calls++);
  reg.register(makeRun("a-1"));
  reg.register(makeRun("a-2"));
  assert.equal(calls, 2);
  unsub();
  reg.register(makeRun("a-3"));
  assert.equal(calls, 2, "unsubscribe should stop notifications");
});

test("SpawnQueue: foreground spawn auto-downgrades to background when full", async () => {
  // Use a fake HOME so runDir paths land in a tmp dir.
  const fakeHome = mkdirSyncTmp();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const reg = new RunRegistry();
    // Pre-populate the registry with maxConcurrent active runs so the queue is full.
    reg.register(makeRun("filler-1", "running"));
    reg.register(makeRun("filler-2", "running"));

    const queue = new SpawnQueue(reg, 2);

    // Foreground spawn should be queued + downgraded.
    const result = queue.enqueueOrSpawn({
      persona: makePersona("oracle"),
      task: "review the plan",
      mode: "foreground",
      cwd: fakeHome,
      timeoutMs: 60_000,
    });

    assert.equal(result.kind, "queued");
    if (result.kind !== "queued") return;
    assert.equal(result.downgraded, true);
    assert.equal(result.queuePosition, 1);
    assert.equal(result.placeholderRun.status, "queued");
    assert.equal(result.pending.requestedMode, "foreground");
    assert.equal(result.pending.effectiveMode, "background");
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("SpawnQueue: removeQueued cancels a pending entry", () => {
  const fakeHome = mkdirSyncTmp();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const reg = new RunRegistry();
    reg.register(makeRun("filler-1", "running"));
    const queue = new SpawnQueue(reg, 1);

    const r = queue.enqueueOrSpawn({
      persona: makePersona("redteam"),
      task: "review",
      mode: "background",
      cwd: fakeHome,
      timeoutMs: 60_000,
    });
    assert.equal(r.kind, "queued");
    if (r.kind !== "queued") return;

    assert.equal(queue.size(), 1);
    const cancelled = queue.removeQueued(r.placeholderRun.id);
    assert.equal(cancelled, true);
    assert.equal(queue.size(), 0);

    // Placeholder run should now be in killed state.
    const after = reg.get(r.placeholderRun.id);
    assert.ok(after);
    assert.equal(after.status, "killed");
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("SpawnQueue: drain promotes a queued spawn when a slot opens (mocked)", async () => {
  // We don't actually spawn pi here — too slow and depends on environment.
  // We test that when an active run reaches a terminal state, the queue
  // attempts to drain. Real spawn integration is exercised elsewhere.
  const fakeHome = mkdirSyncTmp();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    const reg = new RunRegistry();
    const filler = makeRun("filler-1", "running");
    reg.register(filler);

    const queue = new SpawnQueue(reg, 1);
    let drainCallCount = 0;
    const realDrain = queue.drain.bind(queue);
    queue.drain = () => {
      drainCallCount++;
      return realDrain();
    };

    queue.enqueueOrSpawn({
      persona: makePersona("oracle"),
      task: "review",
      mode: "background",
      cwd: fakeHome,
      timeoutMs: 60_000,
    });

    // Trigger a registry change by completing the filler; queue should drain attempt.
    filler.status = "completed";
    filler.finishedAt = Date.now();
    reg.notify(filler);

    assert.ok(drainCallCount >= 1, "drain should fire when a registered run changes status");
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function mkdirSyncTmp(): string {
  const root = join(tmpdir(), "conductor-queue-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(root, { recursive: true });
  return root;
}

// Suppress unused-import warning in the runDir helper (used only in real spawn flows).
void runDir;
