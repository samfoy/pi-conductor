/**
 * v0.12 slice 4 — ensemble_send tool + RPC steer/follow_up paths.
 *
 * Pins the LLM tool surface end-to-end:
 *   - streaming_behavior arg routes to rpc-steer / rpc-follow-up /
 *     spawn-resume / rejected via resolveSendStrategy.
 *   - `Run.rpcStdinQueue.enqueue({id, type, message})` is called with
 *     the right command type for each behavior.
 *   - The 30s ack timeout fires correctly under a faked clock; the
 *     pendingAcks entry self-removes on timeout.
 *   - EPIPE during enqueue surfaces as "sub-agent finished before
 *     steer was delivered" without flipping run state.
 *   - On `response` arrival, routeRpcResponse resolves the ack and
 *     the tool returns the delivered envelope.
 *
 * Critic-gate teeth (per slice 4 plan): mechanical wiring; no W2/W3
 * mutation witnesses required at this layer (those live in slice 5).
 *
 * Test discipline: real subprocess spawning is OFF — the queue is
 * stubbed to capture calls and simulate ack/EPIPE. The 30s timer test
 * uses `node:test` `mock.timers` so the suite stays under the <5s
 * budget per AGENTS.md.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { applyEvent } from "../src/event-handler.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function tmpSessionFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-send-steer-"));
  const path = join(dir, "abc.jsonl");
  writeFileSync(path, "{}\n");
  return { dir, path };
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now() - 10_000,
    lastEventAt: Date.now() - 10_000,
    finishedAt: undefined,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    streamingMode: "rpc",
    steerable: true,
    ...overrides,
  };
}

interface RegisteredTool {
  name: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
}

function captureTools() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: { registerTool: (tool: RegisteredTool) => tools.push(tool) },
  };
}

/**
 * Fake RpcStdinQueue. Records every enqueue and lets the test pick
 * the resolution shape (success / EPIPE).
 */
class FakeRpcStdinQueue {
  public readonly calls: Array<Record<string, unknown>> = [];
  /** When set, every enqueue rejects with this error (EPIPE simulation). */
  public rejectWith?: Error;
  enqueue(cmd: Record<string, unknown>): Promise<void> {
    this.calls.push(cmd);
    if (this.rejectWith) return Promise.reject(this.rejectWith);
    return Promise.resolve();
  }
  destroy(_reason: string): void {
    // no-op
  }
}

/**
 * Wait for the fake queue's first enqueue. The ensemble_send tool's
 * execute path does async file I/O (resolvePersonas) before reaching
 * sendToRun, so we must yield to the event loop until the call lands.
 */
async function waitForFirstEnqueue(
  fake: FakeRpcStdinQueue,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fake.calls.length === 0) {
    if (Date.now() > deadline) {
      throw new Error(`waitForFirstEnqueue: no enqueue in ${timeoutMs}ms`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

function setup(extraRuns: Run[] = []) {
  const reg = new RunRegistry();
  for (const r of extraRuns) reg.register(r);
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);

  const cap = captureTools();
  registerTools(cap.pi as any, {
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
  });

  const sendTool = cap.tools.find((t) => t.name === "ensemble_send");
  return { reg, sendTool };
}

test("ensemble_send: running steerable + auto enqueues rpc-follow-up command and returns delivered:true on response", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const fake = new FakeRpcStdinQueue();
    const run = makeRun("oracle-stra", {
      sessionPath: path,
      rpcStdinQueue: fake as any,
    });
    const { reg, sendTool } = setup([run]);
    assert.ok(sendTool);

    // streaming_behavior omitted → defaults to "auto" → rpc-follow-up.
    const promise = sendTool.execute("call-1", {
      agent_id: "oracle-stra",
      message: "next steer",
      foreground: false,
    });

    // Allow microtask flush so enqueue() completes and the
    // pendingAcks entry is registered.
    await waitForFirstEnqueue(fake);

    assert.equal(fake.calls.length, 1, "exactly one command enqueued");
    const cmd = fake.calls[0]! as { id: string; type: string; message: string };
    assert.equal(cmd.type, "follow_up", "auto on a running rpc run resolves to follow_up");
    assert.equal(cmd.message, "next steer");
    assert.match(cmd.id, /^send-oracle-stra-/, "ack-correlation id is present");

    // Deliver the matching response.
    applyEvent(run, { type: "response", id: cmd.id, command: "follow_up", success: true });

    const result = await promise;
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /delivered:/);
    assert.match(text, /RPC ack received/);
    assert.equal(result.details?.delivered, true);
    assert.equal(typeof result.details?.delivered_at, "number");

    // pendingAcks entry was deleted on response.
    assert.equal(run.pendingAcks?.size ?? 0, 0, "pendingAcks Map cleared after response");

    // Run status was NOT mutated to a fresh subprocess spawn — RPC
    // sends ride the live subprocess.
    assert.equal(run.status, "running");
    assert.equal(reg.get(run.id), run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble_send: running steerable + steer enqueues rpc-steer command and returns delivered:true on response", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const fake = new FakeRpcStdinQueue();
    const run = makeRun("oracle-strs", {
      sessionPath: path,
      rpcStdinQueue: fake as any,
    });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);

    const promise = sendTool.execute("call-1", {
      agent_id: "oracle-strs",
      message: "interrupt now",
      foreground: false,
      streaming_behavior: "steer",
    });

    await waitForFirstEnqueue(fake);
    assert.equal(fake.calls.length, 1);
    const cmd = fake.calls[0]! as { id: string; type: string };
    assert.equal(cmd.type, "steer", "explicit steer maps to RPC `steer` command");

    applyEvent(run, { type: "response", id: cmd.id, command: "steer", success: true });

    const result = await promise;
    assert.equal(result.details?.delivered, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensemble_send: running steerable + resume rejects with "currently running"', async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const fake = new FakeRpcStdinQueue();
    const run = makeRun("oracle-strr", {
      sessionPath: path,
      rpcStdinQueue: fake as any,
    });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);

    const result = await sendTool.execute("call-1", {
      agent_id: "oracle-strr",
      message: "hi",
      streaming_behavior: "resume",
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /currently running/);
    assert.equal(fake.calls.length, 0, "resume on running run must not enqueue anything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble_send: running steerable + ack timeout (faked 30s clock) rejects with timeout reason", async () => {
  // Real-clock would blow the <5s suite budget. Mock setTimeout +
  // Date so the 30s ack timer fires synchronously when we tick.
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { dir, path } = tmpSessionFile();
  try {
    const fake = new FakeRpcStdinQueue();
    const run = makeRun("oracle-strt", {
      sessionPath: path,
      rpcStdinQueue: fake as any,
    });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);

    const promise = sendTool.execute("call-1", {
      agent_id: "oracle-strt",
      message: "no ack will come",
      foreground: false,
    });

    // Let the async side of sendToRun + enqueue settle. The tool
    // does file I/O (resolvePersonas) before reaching sendToRun;
    // setImmediate flushes are sufficient because mock.timers only
    // mocks setTimeout/Date — setImmediate stays real.
    await waitForFirstEnqueue(fake);
    assert.equal(fake.calls.length, 1);

    // Advance the faked clock past the 30s ack timeout.
    mock.timers.tick(30_001);

    const result = await promise;
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /ack timeout/);
    assert.match(text, /check via ensemble_status/);

    // Timer-fire path must clean up pendingAcks (self-removal).
    assert.equal(run.pendingAcks?.size ?? 0, 0, "pendingAcks cleared after ack timeout");
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensemble_send: running steerable + EPIPE during enqueue rejects with "sub-agent finished before steer was delivered"', async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const fake = new FakeRpcStdinQueue();
    fake.rejectWith = new Error("EPIPE: write after end");
    const run = makeRun("oracle-stre", {
      sessionPath: path,
      rpcStdinQueue: fake as any,
    });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);

    const promise = sendTool.execute("call-1", {
      agent_id: "oracle-stre",
      message: "doomed steer",
      foreground: false,
    });

    const result = await promise;
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(
      text,
      /finished before steer was delivered/,
      "Q3 lock wording: 'sub-agent ... finished before steer was delivered'",
    );

    // EPIPE path must clean up pendingAcks (no orphan timer left running).
    assert.equal(run.pendingAcks?.size ?? 0, 0, "pendingAcks cleared after EPIPE");

    // Run status NOT mutated to a fresh subprocess spawn.
    assert.equal(run.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
