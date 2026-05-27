/**
 * v0.12 slice 3 — event-handler RPC dispatch tests.
 *
 * Pins three new applyEvent branches added by slice 3:
 *   1. `response` line → `routeRpcResponse(run, evt)` stub call;
 *      returns `{kind: "updated"}`. NO `lastEventAt` bump (slice 5
 *      owns the asymmetric bump policy per design §4.7 + oracle
 *      fix #2).
 *   2. `extension_ui_request` line → `handleExtensionUiRequest(run, evt)`
 *      synchronously enqueues `{type: "extension_ui_response", id,
 *      cancelled: true}` via `run.rpcStdinQueue?.enqueue()`. Always-
 *      cancel-and-warn policy (Risk 2 lock; design §4.2). Returns
 *      `{kind: "updated"}`. NO `lastEventAt` bump.
 *   3. Print-mode runs (existing `message_end` / `tool_result_end`
 *      paths) are byte-identical to pre-slice-3 behaviour — no
 *      regression.
 *
 * `routeRpcResponse` is a slice-3 STUB: signature pinned for slice 4,
 * body is a no-op. Slice 4 fills it with the correlation-Map lookup
 * (`Run.pendingAcks`).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyEvent,
  handleExtensionUiRequest,
  routeRpcResponse,
} from "../src/event-handler.ts";
import { emptyUsage, type Run } from "../src/types.ts";

// ── Test fixture ──────────────────────────────────────────────────────

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "tester-abcd",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

/**
 * Minimal queue spy. Records every `enqueue(cmd)` call; lets us assert
 * the auto-cancel envelope reaches the queue synchronously within the
 * same event-loop tick (no setImmediate / queueMicrotask defer).
 */
class FakeRpcStdinQueue {
  public readonly calls: object[] = [];
  enqueue(cmd: object): Promise<void> {
    this.calls.push(cmd);
    return Promise.resolve();
  }
  destroy(_reason: string): void {
    // no-op
  }
}

// ── 1. response line ──────────────────────────────────────────────────

test("applyEvent: response line routes to routeRpcResponse stub and returns {kind: \"updated\"}", () => {
  const run = makeRun();
  const lastEventAtBefore = run.lastEventAt;
  const evt = {
    type: "response",
    id: "init-tester-abcd",
    command: "prompt",
    success: true,
  };
  const r = applyEvent(run, evt);
  assert.deepEqual(r, { kind: "updated" });
  // Slice 5 owns the `lastEventAt` bump on `response`. Slice 3 must
  // NOT bump — verify the field is unchanged. (The W2 mutation
  // witness in slice 5 will pin both directions; this assert is the
  // pre-condition.)
  assert.equal(
    run.lastEventAt,
    lastEventAtBefore,
    "slice 3 must NOT bump lastEventAt on response (slice 5 owns)",
  );
});

test("routeRpcResponse: stub is a no-op and returns {kind: \"updated\"}", () => {
  // Direct invocation pin — slice 4 will replace the body with the
  // correlation-Map lookup. The signature is locked here so slice 4
  // doesn't have to renegotiate the export shape.
  const run = makeRun();
  const before = JSON.stringify(run);
  const r = routeRpcResponse(run, {
    type: "response",
    id: "x",
    command: "prompt",
    success: true,
  } as any);
  assert.deepEqual(r, { kind: "updated" });
  assert.equal(JSON.stringify(run), before, "stub must not mutate run state");
});

// ── 2. extension_ui_request line ──────────────────────────────────────

test("applyEvent: extension_ui_request triggers auto-cancel; envelope {type: \"extension_ui_response\", id, cancelled: true} reaches the queue within the same tick", () => {
  const queue = new FakeRpcStdinQueue();
  const run = makeRun({ rpcStdinQueue: queue as any });
  const evt = {
    type: "extension_ui_request",
    id: "uir-1",
    method: "confirm",
    title: "Proceed?",
    message: "Are you sure?",
  };
  const r = applyEvent(run, evt);
  assert.deepEqual(r, { kind: "updated" });
  // Synchronous-same-tick assertion. enqueue must have been called
  // BEFORE applyEvent returned. We do not allow setImmediate /
  // queueMicrotask defer — if the dispatch goes through a microtask
  // the call would land AFTER applyEvent returned and this assert
  // would fail.
  assert.equal(queue.calls.length, 1, "auto-cancel envelope must reach queue synchronously");
  assert.deepEqual(queue.calls[0], {
    type: "extension_ui_response",
    id: "uir-1",
    cancelled: true,
  });
});

test("applyEvent: extension_ui_request auto-cancel covers every method (select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text)", () => {
  // Always-cancel-and-warn policy — no per-method branching. Pin all
  // RpcExtensionUIRequest methods produce the same `cancelled: true`
  // envelope shape.
  const methods = [
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ];
  for (const method of methods) {
    const queue = new FakeRpcStdinQueue();
    const run = makeRun({ rpcStdinQueue: queue as any });
    applyEvent(run, { type: "extension_ui_request", id: `uir-${method}`, method } as any);
    assert.equal(queue.calls.length, 1, `method=${method}: enqueue not called once`);
    assert.deepEqual(queue.calls[0], {
      type: "extension_ui_response",
      id: `uir-${method}`,
      cancelled: true,
    });
  }
});

test("applyEvent: extension_ui_request does NOT bump lastEventAt (no observable side effect on run.lastEventAt)", () => {
  // Oracle fix #2 asymmetry. Slice 5 will add the W2 witness pinning
  // the asymmetry between `response` (bumps in slice 5) and
  // `extension_ui_request` (never bumps); slice 3 just establishes
  // the no-bump path.
  const queue = new FakeRpcStdinQueue();
  const run = makeRun({ rpcStdinQueue: queue as any });
  const lastEventAtBefore = run.lastEventAt;
  applyEvent(run, {
    type: "extension_ui_request",
    id: "uir-2",
    method: "select",
    title: "pick one",
    options: ["a", "b"],
  });
  assert.equal(
    run.lastEventAt,
    lastEventAtBefore,
    "extension_ui_request must NEVER bump lastEventAt (host-blocking ≠ progress)",
  );
});

test("applyEvent: extension_ui_request without rpcStdinQueue (defensive) does not throw and returns {kind: \"updated\"}", () => {
  // Defensive: a print-mode run that somehow receives an
  // `extension_ui_request` line (it shouldn't, but the wire is
  // permissive) must not crash. We tolerate the no-queue case
  // silently — the warning log still fires; the envelope is
  // dropped because there's nowhere to send it.
  const run = makeRun(); // no rpcStdinQueue
  const r = applyEvent(run, {
    type: "extension_ui_request",
    id: "uir-3",
    method: "confirm",
    title: "x",
    message: "y",
  });
  assert.deepEqual(r, { kind: "updated" });
});

test("handleExtensionUiRequest: direct invocation pin — same envelope shape as applyEvent dispatch", () => {
  const queue = new FakeRpcStdinQueue();
  const run = makeRun({ rpcStdinQueue: queue as any });
  const r = handleExtensionUiRequest(run, {
    type: "extension_ui_request",
    id: "uir-4",
    method: "input",
    title: "t",
  } as any);
  assert.deepEqual(r, { kind: "updated" });
  assert.deepEqual(queue.calls[0], {
    type: "extension_ui_response",
    id: "uir-4",
    cancelled: true,
  });
});

// ── 3. Print-mode regression pin ──────────────────────────────────────

test("applyEvent: print-mode runs (streamingMode !== \"rpc\") see no extra dispatch — message_end / tool_result_end paths unchanged", () => {
  // Regression pin. The slice 3 dispatch additions for `response` /
  // `extension_ui_request` must NOT regress the existing print-mode
  // `message_end` / `tool_result_end` bumps. This pins:
  //   - `message_end` still bumps lastEventAt (existing behaviour).
  //   - `tool_result_end` still bumps lastEventAt.
  //   - `streamingMode` undefined (today's print-mode default) does
  //     not gate either path.
  const NOW = 2_000_000_000_000;
  const run = makeRun({ lastEventAt: 1_000_000_000_000 });
  // streamingMode intentionally undefined — pre-v0.12 production
  // path. The RPC dispatch additions must not interfere.
  assert.equal(run.streamingMode, undefined);

  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const r1 = applyEvent(run, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        model: "anthropic/claude-sonnet-4",
        stopReason: "stop",
      },
    });
    assert.deepEqual(r1, { kind: "updated" });
    assert.equal(run.lastEventAt, NOW, "message_end must still bump lastEventAt");
    assert.equal(run.messages.length, 1);

    const r2 = applyEvent(run, {
      type: "tool_result_end",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
    });
    assert.deepEqual(r2, { kind: "updated" });
    assert.equal(run.lastEventAt, NOW, "tool_result_end must still bump lastEventAt");
    assert.equal(run.messages.length, 2);
  } finally {
    Date.now = realNow;
  }

  // Sanity: feeding an unknown event still returns {kind: "none"}.
  const r3 = applyEvent(run, { type: "no_such_event" });
  assert.deepEqual(r3, { kind: "none" });
});
