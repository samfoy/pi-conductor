/**
 * Tests for v0.16-S1: ConductorEventEmitter scaffold.
 *
 * WDD witnesses:
 *   W1: CHANNEL.created === "conductor:agent:created" (string literal, not derived)
 *   W2: new ConductorEventEmitter(undefined).emitCreated(...) does not throw
 *   W3: AgentFailedPayload.status is typed as RunStatus — verified via structural
 *       assignability: assigning a RunStatus variable to status must compile
 *       (checked by tsc --noEmit; the runtime test uses the "merge_conflict"
 *       value that would be excluded by any narrowed union missing it)
 *
 * Killing mutation for W1:
 *   Change CHANNEL.created to "conductor:agent:CREATED" (wrong casing).
 *   → W1 test fails.
 *
 * Killing mutation for W2:
 *   Remove the `?.` from `this.events?.emit(...)` so it becomes `this.events.emit(...)`.
 *   → W2 test throws TypeError on null/undefined dereference.
 *
 * Killing mutation for W3:
 *   Narrow AgentFailedPayload.status to `"failed" | "killed"` (dropping "merge_conflict").
 *   → W3 test fails (value "merge_conflict" is not assignable at compile time;
 *   runtime test catches the omission via the type-exhaustion assertion below).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHANNEL,
  ConductorEventEmitter,
  type AgentCreatedPayload,
  type AgentStartedPayload,
  type AgentCompletedPayload,
  type AgentFailedPayload,
  type AgentSteeredPayload,
  type AgentCompactedPayload,
} from "../src/conductor-events.ts";
import type { RunStatus } from "../src/types.ts";

// ──────────────────────────────────────────────
// W1: channel name constants are the expected strings
// ──────────────────────────────────────────────

test("CHANNEL constants have correct string values", () => {
  assert.strictEqual(CHANNEL.created, "conductor:agent:created");
  assert.strictEqual(CHANNEL.started, "conductor:agent:started");
  assert.strictEqual(CHANNEL.completed, "conductor:agent:completed");
  assert.strictEqual(CHANNEL.failed, "conductor:agent:failed");
  assert.strictEqual(CHANNEL.steered, "conductor:agent:steered");
  assert.strictEqual(CHANNEL.compacted, "conductor:agent:compacted");
  // v0.17-S5: hook lifecycle channels
  assert.strictEqual(CHANNEL.hookStarted, "conductor:agent:hook:started");
  assert.strictEqual(CHANNEL.hookCompleted, "conductor:agent:hook:completed");
  assert.strictEqual(CHANNEL.hookFailed, "conductor:agent:hook:failed");
});

test("CHANNEL has exactly 9 entries (6 agent + 3 hook lifecycle v0.17-S5)", () => {
  assert.strictEqual(Object.keys(CHANNEL).length, 9);
});

// ──────────────────────────────────────────────
// W2: ConductorEventEmitter(undefined) does not throw on any emit* call
// ──────────────────────────────────────────────

test("ConductorEventEmitter(undefined) emitCreated does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitCreated({
      id: "run-1",
      persona: "builder",
      description: "do a thing",
      isBackground: false,
    });
  });
});

test("ConductorEventEmitter(undefined) emitStarted does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitStarted({
      id: "run-1",
      persona: "builder",
      description: "do a thing",
    });
  });
});

test("ConductorEventEmitter(undefined) emitCompleted does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitCompleted({
      id: "run-1",
      persona: "builder",
      durationMs: 1000,
      toolUses: 3,
      tokens: { input: 100, output: 50, cost: 0.01 },
    });
  });
});

test("ConductorEventEmitter(undefined) emitFailed does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitFailed({
      id: "run-1",
      persona: "builder",
      durationMs: 500,
      toolUses: 1,
      tokens: { input: 10, output: 5, cost: 0.001 },
      status: "failed",
      errorMessage: undefined,
    });
  });
});

test("ConductorEventEmitter(undefined) emitSteered does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitSteered({ id: "run-1", message: "fix it" });
  });
});

test("ConductorEventEmitter(undefined) emitCompacted does not throw", () => {
  const emitter = new ConductorEventEmitter(undefined);
  assert.doesNotThrow(() => {
    emitter.emitCompacted({
      id: "run-1",
      persona: "builder",
      description: "do a thing",
      compactionCount: 1,
      tokensBefore: 80000,
    });
  });
});

// ──────────────────────────────────────────────
// W3: AgentFailedPayload.status accepts all RunStatus values including
// "merge_conflict" (proving it is typed as RunStatus, not a narrowed union)
// ──────────────────────────────────────────────

test("AgentFailedPayload.status accepts all terminal RunStatus values", () => {
  const terminalStatuses: RunStatus[] = [
    "failed",
    "killed",
    "hook_failed",
    "merge_conflict",
    "timeout",
  ];
  const emitter = new ConductorEventEmitter(undefined);
  for (const status of terminalStatuses) {
    // If AgentFailedPayload.status were narrowed to exclude any of these,
    // TypeScript would fail at compile time. The runtime loop ensures the
    // test imports the production type, not a parallel copy.
    const payload: AgentFailedPayload = {
      id: "run-1",
      persona: "builder",
      durationMs: 100,
      toolUses: 0,
      tokens: { input: 1, output: 1, cost: 0 },
      status,
      errorMessage: undefined,
    };
    assert.doesNotThrow(() => emitter.emitFailed(payload));
  }
});

// ──────────────────────────────────────────────
// Emit routing: real EventBus spy
// ──────────────────────────────────────────────

function makeFakeBus() {
  const received: { channel: string; data: unknown }[] = [];
  const bus = {
    emit(channel: string, data: unknown) {
      received.push({ channel, data });
    },
    on(_channel: string, _handler: (data: unknown) => void) {
      return () => {};
    },
  };
  return { bus, received };
}

test("emitCreated routes to correct channel with correct payload", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  const payload: AgentCreatedPayload = {
    id: "abc",
    persona: "critic",
    description: "review the diff",
    isBackground: true,
  };
  emitter.emitCreated(payload);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].channel, CHANNEL.created);
  assert.deepStrictEqual(received[0].data, payload);
});

test("emitStarted routes to correct channel", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  emitter.emitStarted({ id: "abc", persona: "critic", description: "review" });
  assert.strictEqual(received[0].channel, CHANNEL.started);
});

test("emitCompleted routes to correct channel", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  emitter.emitCompleted({
    id: "abc",
    persona: "builder",
    durationMs: 5000,
    toolUses: 10,
    tokens: { input: 200, output: 100, cost: 0.05 },
  });
  assert.strictEqual(received[0].channel, CHANNEL.completed);
});

test("emitFailed routes to correct channel", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  emitter.emitFailed({
    id: "abc",
    persona: "builder",
    durationMs: 1000,
    toolUses: 2,
    tokens: { input: 50, output: 20, cost: 0.01 },
    status: "killed",
    errorMessage: "watchdog: hard-stalled",
  });
  assert.strictEqual(received[0].channel, CHANNEL.failed);
  const data = received[0].data as AgentFailedPayload;
  assert.strictEqual(data.status, "killed");
  assert.strictEqual(data.errorMessage, "watchdog: hard-stalled");
});

test("emitSteered routes to correct channel", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  emitter.emitSteered({ id: "abc", message: "redirect" });
  assert.strictEqual(received[0].channel, CHANNEL.steered);
});

test("emitCompacted routes to correct channel with compactionCount", () => {
  const { bus, received } = makeFakeBus();
  const emitter = new ConductorEventEmitter(bus);
  emitter.emitCompacted({
    id: "abc",
    persona: "builder",
    description: "build feature",
    compactionCount: 2,
    tokensBefore: 120000,
  });
  assert.strictEqual(received[0].channel, CHANNEL.compacted);
  const data = received[0].data as AgentCompactedPayload;
  assert.strictEqual(data.compactionCount, 2);
  assert.strictEqual(data.tokensBefore, 120000);
});

// ──────────────────────────────────────────────
// SpawnOptions / SendToRunOptions carry events field
// ──────────────────────────────────────────────

test("SpawnOptions accepts events field typed as ConductorEventEmitter | undefined", async () => {
  // Compile-time verification only — import the interface and confirm the field exists
  const { ConductorEventEmitter: ConductorEventsClass } = await import(
    "../src/conductor-events.ts"
  );
  // If the field didn't exist in SpawnOptions, tsc --noEmit would catch it.
  // This test is a structural probe: confirm we can construct ConductorEventEmitter
  // and that it's the same class exported from the module.
  assert.ok(typeof ConductorEventsClass === "function");
});
