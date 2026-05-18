/**
 * Tests for ensemble_kill tool (v0.8.2 (A) slice).
 *
 * Mirrors the structure of tests/ensemble-pause-resume.test.ts. Like those
 * tests, we don't fork real processes — synthetic Run records have
 * `proc` undefined, and forceTerminate's `if (run.proc)` block is skipped.
 * forceTerminate still flips run.status to "killed" and writes records
 * (best-effort), which is what the tool surface needs.
 *
 * Coverage:
 *   - registration
 *   - unknown agent_id → error
 *   - kill from running / paused → status flips to "killed"
 *   - kill from queued → removed from queue + status "killed"
 *   - kill from terminal states (completed/failed/killed/timeout) → idempotent
 *     no-op success (different from pause/resume which error on terminal)
 *   - return shape mirrors ensemble_pause's success envelope
 *   - tool description carries the documented "silent kill" convention
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now() - 5_000,
    lastEventAt: Date.now() - 5_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...overrides,
  };
}

interface RegisteredTool {
  name: string;
  description?: string;
  execute: (id: string, params: any) => Promise<any>;
}

function setup(extraRuns: Run[] = []) {
  const reg = new RunRegistry();
  for (const r of extraRuns) reg.register(r);
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const tools: RegisteredTool[] = [];
  registerTools(
    {
      registerTool: (t: RegisteredTool) => tools.push(t),
    } as any,
    {
      getCwd: () => "/tmp",
      getRegistry: () => reg,
      getQueue: () => queue,
      getModel: () => model,
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({
        detachSignal: new Promise<void>(() => {}),
        unregister: () => {},
      }),
      pushCompletionNotification: () => {},
    },
  );
  return {
    reg,
    queue,
    killTool: tools.find((t) => t.name === "ensemble_kill"),
  };
}

test("ensemble_kill tool is registered", () => {
  const { killTool } = setup();
  assert.ok(killTool, "ensemble_kill should be registered");
});

test("ensemble_kill description documents the silent-kill convention", () => {
  const { killTool } = setup();
  assert.ok(killTool);
  // Pin the pi-wide convention: tool-initiated kills don't trigger a
  // follow-up turn. Matches subagent_kill's documented behavior.
  assert.match(
    killTool.description ?? "",
    /never triggers a follow-up turn|silent|tool-initiated kill/i,
  );
});

test("ensemble_kill errors when agent_id is unknown", async () => {
  const { killTool } = setup();
  assert.ok(killTool);
  const result = await killTool.execute("call-1", { agent_id: "ghost" });
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /not found|unknown|ghost/i);
});

test("ensemble_kill on a running sub-agent flips status to killed", async () => {
  const run = makeRun("oracle-runn", { status: "running" });
  const { killTool } = setup([run]);
  assert.ok(killTool);
  const result = await killTool.execute("call-1", { agent_id: run.id });
  assert.equal(run.status, "killed");
  assert.equal(result.details.status, "killed");
  assert.equal(result.details.agent_id, run.id);
});

test("ensemble_kill on a paused sub-agent flips status to killed", async () => {
  const run = makeRun("oracle-paus", { status: "paused" });
  const { killTool } = setup([run]);
  assert.ok(killTool);
  const result = await killTool.execute("call-1", { agent_id: run.id });
  assert.equal(run.status, "killed");
  assert.equal(result.details.status, "killed");
});

test("ensemble_kill on a queued sub-agent flips status and removes from pending", async () => {
  const run = makeRun("oracle-queu", { status: "queued" });
  const { killTool, queue } = setup([run]);
  assert.ok(killTool);
  // Seed a pending entry that mirrors what enqueueOrSpawn would have
  // created. SpawnQueue.removeQueued matches by id and splices.
  (queue as any).pending.push({
    id: run.id,
    persona: run.persona,
    task: run.task,
    requestedMode: "background",
    effectiveMode: "background",
    cwd: run.cwd,
    timeoutMs: 60_000,
    enqueuedAt: Date.now(),
  });
  assert.equal(queue.size(), 1, "precondition: pending list contains one");
  const result = await killTool.execute("call-1", { agent_id: run.id });
  assert.equal(run.status, "killed");
  assert.equal(queue.size(), 0, "queued run must be removed from pending");
  assert.equal(result.details.status, "killed");
});

const TERMINAL: RunStatus[] = ["completed", "failed", "killed", "timeout"];
for (const status of TERMINAL) {
  test(`ensemble_kill is idempotent on terminal status=${status}`, async () => {
    const run = makeRun(`oracle-${status.slice(0, 4)}`, { status });
    const { killTool } = setup([run]);
    assert.ok(killTool);
    const result = await killTool.execute("call-1", { agent_id: run.id });
    // Success envelope, status preserved (not flipped from completed/failed/timeout to killed).
    assert.equal(run.status, status, "terminal status must not be overwritten");
    assert.equal(result.details.status, status);
    assert.equal(result.details.agent_id, run.id);
    // Should NOT be an error envelope.
    assert.equal(result.details.error, undefined, "idempotent kill must not surface an error");
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.doesNotMatch(text, /^error\b/i);
  });
}
