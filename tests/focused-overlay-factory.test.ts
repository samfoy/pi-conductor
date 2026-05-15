/**
 * Tests for createFocusedOverlayComponent — the small factory that
 * builds a FocusedStreamOverlay from session-scoped dependencies
 * (model, registry, kill/send wiring, close callback).
 *
 * Lives in its own module so the wiring can be tested without spinning
 * up the full ExtensionAPI runtime. Extracted from src/index.ts
 * `openFocusedOverlay`'s `.custom(...)` factory body.
 *
 * The most important property pinned here: the factory must NOT
 * register any listener on RunRegistry. The previous implementation
 * (pre-fix) registered a no-op listener that was never disposed,
 * leaking one entry per overlay open. The overlay's own invalidate /
 * request-render plumbing is sufficient — see the comment block in
 * the deleted code for the original (incorrect) reasoning.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFocusedOverlayComponent } from "../src/focused-overlay-factory.ts";
import { RunRegistry } from "../src/runs.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "test task",
    mode: "foreground",
    status: "running",
    startTime: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

test("createFocusedOverlayComponent: does NOT register any listener on the registry", () => {
  const registry = new RunRegistry();
  // Spy on onChange to detect any subscription. We replace the bound
  // method so any caller (the factory or its dependencies) goes through
  // the counter.
  let onChangeCalls = 0;
  const realOnChange = registry.onChange.bind(registry);
  registry.onChange = (fn) => {
    onChangeCalls += 1;
    return realOnChange(fn);
  };
  const model = new FocusedStreamModel(registry);
  let killed: { agentId: string } | null = null;
  let sent: { agentId: string } | null = null;
  let closeArg: unknown = "untouched";

  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: (run) => {
      killed = { agentId: run.id };
    },
    promptAndSendToRun: (agentId) => {
      sent = { agentId };
    },
    done: (value) => {
      closeArg = value;
    },
  });

  assert.ok(overlay, "factory returns an overlay instance");
  assert.equal(
    onChangeCalls,
    0,
    "factory must not register any listener (the live re-render plumbing comes from the overlay's own invalidate hooks, not registry.onChange)",
  );
  assert.equal(killed, null, "no kill should have fired during construction");
  assert.equal(sent, null, "no send should have fired during construction");
  assert.equal(closeArg, "untouched", "no close should have fired during construction");
});

test("createFocusedOverlayComponent: onClose wires `done(undefined)`", () => {
  const registry = new RunRegistry();
  const model = new FocusedStreamModel(registry);
  let closeArg: unknown = "untouched";
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: (value) => {
      closeArg = value;
    },
  });
  // Simulate Esc-to-close via the overlay's input dispatch.
  overlay.handleInput("\x1b");
  assert.equal(closeArg, undefined, "onClose forwards `undefined` to done");
});

test("createFocusedOverlayComponent: onKill calls forceTerminate(run, 'killed', registry) for the focused run", () => {
  const registry = new RunRegistry();
  const run = makeRun();
  registry.register(run);
  const model = new FocusedStreamModel(registry);
  let killArgs: { runId: string; reason: string } | null = null;
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: (r, reason) => {
      killArgs = { runId: r.id, reason };
    },
    promptAndSendToRun: () => {},
    done: () => {},
  });
  // 'k' triggers onKill.
  overlay.handleInput("k");
  assert.deepEqual(killArgs, { runId: run.id, reason: "killed" });
});

test("createFocusedOverlayComponent: onSend invokes promptAndSendToRun with the focused agent id", () => {
  const registry = new RunRegistry();
  const run = makeRun();
  registry.register(run);
  const model = new FocusedStreamModel(registry);
  let sentTo: string | null = null;
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: (id) => {
      sentTo = id;
    },
    done: () => {},
  });
  overlay.handleInput("s");
  assert.equal(sentTo, run.id);
});
