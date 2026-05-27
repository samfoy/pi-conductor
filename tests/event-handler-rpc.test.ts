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
  bumpOnRpcLine,
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

test("applyEvent: response line on RPC run routes to routeRpcResponse and BUMPS lastEventAt (slice 5 contract; supersedes slice 3 no-bump)", () => {
  // Slice 5 flips the slice-3 contract: `response` on a steerable run
  // is concrete progress evidence (sub-agent acked our command), so
  // it bumps `lastEventAt`. The W2(a) witness below pins the formula
  // directly via `bumpOnRpcLine`; this test pins the wired effect on
  // applyEvent for an RPC run.
  const NOW = 2_500_000_000_000;
  const run = makeRun({
    streamingMode: "rpc",
    lastEventAt: 1_000_000_000_000,
  });
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const r = applyEvent(run, {
      type: "response",
      id: "init-tester-abcd",
      command: "prompt",
      success: true,
    });
    assert.deepEqual(r, { kind: "updated" });
    assert.equal(
      run.lastEventAt,
      NOW,
      "slice 5 contract: response on streamingMode=rpc bumps lastEventAt",
    );
  } finally {
    Date.now = realNow;
  }
});

test("routeRpcResponse: no-op when run has no pendingAcks Map (defensive)", () => {
  // Slice 4 replaced the slice-3 stub body with the correlation-Map
  // lookup. Without a pendingAcks Map (run never had a steer
  // enqueued), the function early-returns UPDATED without mutating
  // run state. The ensemble-send slice-4 tests cover the
  // populated-Map path (resolve + clearTimeout + delete).
  const run = makeRun();
  const before = JSON.stringify(run);
  const r = routeRpcResponse(run, {
    type: "response",
    id: "x",
    command: "prompt",
    success: true,
  } as any);
  assert.deepEqual(r, { kind: "updated" });
  assert.equal(JSON.stringify(run), before, "no pendingAcks → no mutation");
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

test("applyEvent: extension_ui_request on RPC run does NOT bump lastEventAt (oracle fix #2 asymmetry)", () => {
  // Oracle fix #2 asymmetry: `response` bumps; `extension_ui_request`
  // does NOT bump even on a steerable run. Sub-agent is BLOCKED on
  // host's reply — not progress. The W2(b) witness below pins the
  // formula directly; this test pins the wired effect on applyEvent
  // for an RPC run.
  const queue = new FakeRpcStdinQueue();
  const run = makeRun({
    streamingMode: "rpc",
    rpcStdinQueue: queue as any,
  });
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

// ── W2 mutation witness: bumpOnRpcLine asymmetry ────────────────
//
// Per `docs/wdd.md` parallel-formula rule, the mutation witnesses
// import the production helper directly and assert against its
// truth-table (NOT a re-derivation). Mutating the helper formula
// in either direction reds the matching test.

test(
  'W2(a) bumpOnRpcLine returns true for evtType="response" — mutating to no-op fails this stall-recovery pin',
  () => {
    // The recovery scenario: a steerable sub-agent has been silent
    // (no message_end / tool_result_end), about to soft-stall. A
    // `response` ack arrives. Bumping lastEventAt is the only way
    // the watchdog learns the sub-agent acked our prompt. If the
    // helper is mutated to `return false` for "response", this
    // assertion reds and the witness has teeth.
    const run = makeRun({ streamingMode: "rpc" });
    assert.equal(
      bumpOnRpcLine(run, Date.now(), "response"),
      true,
      "response on streamingMode=rpc MUST signal a bump",
    );
  },
);

test(
  'W2(b) bumpOnRpcLine returns false for evtType="extension_ui_request" — mutating to bump fails this host-blocked-stall-detection pin',
  () => {
    // The detection scenario: a steerable sub-agent's extension code
    // emits ctx.ui.confirm — sub-agent is now BLOCKED on our reply.
    // Bumping lastEventAt would mask this stall class ("sub-agent
    // waiting on unanswered UI request"). The conductor auto-cancels
    // synchronously today, but the no-bump policy is load-bearing for
    // v0.13+ when extension_ui_request may be proxied to the user. If
    // the helper is mutated to return true for "extension_ui_request",
    // this assertion reds and the witness has teeth.
    const run = makeRun({ streamingMode: "rpc" });
    assert.equal(
      bumpOnRpcLine(run, Date.now(), "extension_ui_request"),
      false,
      "extension_ui_request on streamingMode=rpc MUST NOT signal a bump",
    );
  },
);

test(
  "W2(c) bumpOnRpcLine returns false for any non-RPC line type (defensive default)",
  () => {
    // Future RPC line types default to no-bump until explicitly
    // added to the truth-table. Defensive default mirrors v0.10
    // watchdog Q5-deferred pattern (build-on-demand).
    const run = makeRun({ streamingMode: "rpc" });
    for (const t of ["unknown_line", "agent_event", "", "message_end"]) {
      assert.equal(
        bumpOnRpcLine(run, Date.now(), t),
        false,
        `evtType=${JSON.stringify(t)} must default to no-bump`,
      );
    }
  },
);

test(
  "applyEvent: print-mode runs see no bumpOnRpcLine effect (streamingMode !== 'rpc' short-circuits the RPC bump policy)",
  () => {
    // Print-mode contract: applying a stray `response` line on a
    // print-mode run (streamingMode undefined) must NOT bump
    // lastEventAt via the RPC bump policy. This is the call-site
    // short-circuit that the plan calls out: the RPC bump branch
    // gates on `run.streamingMode === "rpc"` BEFORE entering
    // bumpOnRpcLine.
    //
    // (The dispatch into routeRpcResponse / handleExtensionUiRequest
    // still runs for backwards compatibility with the existing
    // wire-permissive contract, but the bump branch does not.)
    const NOW = 2_500_000_000_000;
    const run = makeRun({ lastEventAt: 1_000_000_000_000 });
    assert.equal(run.streamingMode, undefined);
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      applyEvent(run, {
        type: "response",
        id: "x",
        command: "prompt",
        success: true,
      });
      assert.equal(
        run.lastEventAt,
        1_000_000_000_000,
        "print-mode response line must NOT bump lastEventAt (call-site short-circuit)",
      );
    } finally {
      Date.now = realNow;
    }
  },
);

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
