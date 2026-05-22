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
    lastEventAt: Date.now(),
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

// ── Slice 1: getViewportHeight wiring ────────────────────────────────
//
// FocusedStreamOverlay already declares an optional
// `getViewportHeight: () => number` slot in its options (used by
// renderEmpty centring and renderScrollHint). Today the factory does
// NOT pass it through, so production reads `viewportHeight = 0`,
// which silently suppresses the scroll hint and collapses the
// empty-state padding. Slice 1 wires it through the factory.

test("createFocusedOverlayComponent: wires getViewportHeight from injected source", () => {
  const registry = new RunRegistry();
  const model = new FocusedStreamModel(registry);
  let probeCalls = 0;
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: () => {},
    getViewportHeight: () => {
      probeCalls += 1;
      return 42;
    },
  });
  // Render the empty state so renderEmpty consumes the viewport height.
  // We don't assert layout here — the dedicated centring test below does.
  // We only assert the probe is invoked, i.e. the slot is wired.
  void overlay.render(80);
  assert.ok(probeCalls >= 1, `getViewportHeight should be probed by render(); was ${probeCalls}`);
});

test("createFocusedOverlayComponent: viewport rows propagate to renderEmpty centring", () => {
  const registry = new RunRegistry();
  const model = new FocusedStreamModel(registry);
  // No runs registered → empty-state branch.
  const tall = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: () => {},
    getViewportHeight: () => 30,
  });
  const small = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: () => {},
    // Default (no viewport) → topPad collapses to 1
  });
  const tallLines = tall.render(80);
  const smallLines = small.render(80);
  // renderEmpty pads top with Math.max(1, floor((viewport - 5) / 2)).
  // viewport=30 → topPad=12 spacers; viewport=0 → topPad=1 spacer.
  // Counting leading blank lines is the cheapest stable assertion.
  const leadingBlanks = (lines: readonly string[]): number => {
    let i = 0;
    while (i < lines.length && lines[i] === "") i += 1;
    return i;
  };
  const tallTop = leadingBlanks(tallLines);
  const smallTop = leadingBlanks(smallLines);
  assert.ok(
    tallTop > smallTop,
    `taller viewport must yield more top padding (got tall=${tallTop}, small=${smallTop})`,
  );
});

test("createFocusedOverlayComponent: viewport rows propagate to renderScrollHint", () => {
  // renderScrollHint suppresses output entirely when viewportHeight<=0.
  // With the factory wiring fixed, a non-zero viewport must let the
  // hint through when the transcript is long enough to produce hidden
  // lines below the fold. Today this is dead code in production
  // (focused-stream-overlay.ts:372).
  const registry = new RunRegistry();
  // Build a run with enough message history that renderTranscript
  // produces > viewportHeight body lines.
  const longRun = makeRun({
    messages: Array.from({ length: 80 }, (_, i) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `line ${i}` }],
    })) as any,
  });
  registry.register(longRun);
  const model = new FocusedStreamModel(registry);
  model.refresh();
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: () => {},
    getViewportHeight: () => 20,
  });
  const lines = overlay.render(80);
  const joined = lines.join("\n");
  // The hint contains the literal phrase "hidden" when at least one
  // direction is clipped. With offset=0 + 80 messages of body content +
  // viewport=20, the below-clip is non-zero, so the hint must appear.
  assert.ok(
    joined.includes("hidden"),
    `expected scroll hint with 'hidden' in output (today suppressed because factory passes viewportHeight=0); got:\n${joined}`,
  );
});

// ── Slice 4: factory wires getMetrics closure ───────────────────
//
// The model needs `getMetrics: () => { bodyRows; transcriptLength }`
// to clamp scroll + drive stickToTail. The factory builds it from
// (a) the injected `getViewportHeight` (which production wires to
// `tui.terminal.rows`) and (b) the overlay component's own
// `getTranscriptLength()`. The factory MUST register the closure
// with the model after constructing the overlay so the transcript-
// length getter is reachable.

test("createFocusedOverlayComponent: wires getMetrics closure with live tui.terminal.rows", () => {
  const registry = new RunRegistry();
  registry.register(makeRun({ id: "a-1" }));
  let viewportRows = 30;
  const model = new FocusedStreamModel(registry);
  const overlay = createFocusedOverlayComponent({
    model,
    registry,
    forceTerminate: () => {},
    promptAndSendToRun: () => {},
    done: () => {},
    getViewportHeight: () => viewportRows,
  });
  // After construction the overlay’s `getTranscriptLength()` is 0 until
  // the first render(); we render once at width 80 to populate it.
  overlay.render(80);
  // Probe via the model: scrollDown(huge) clamps at the bottom, which
  // is `max(0, transcriptLength - bodyRows)`. Picking a known transcript
  // size requires rendering with content; the simplest behavioural probe
  // is just that scrolling is clamped at SOME finite value derived from
  // the live closure (i.e. NOT unbounded — which is the pre-fix bug).
  model.scrollDown(10_000);
  const offset = model.scrollOffset();
  // Live: changing the viewport rows must change the clamp on the next
  // mutation — i.e. the closure is not captured-by-value at construction.
  viewportRows = 5;
  // Bigger viewport in the original probe (rows=30) means a smaller
  // clamp (bottom = transcriptLength - 30); shrinking to rows=5 must
  // raise the bottom on the next mutation.
  overlay.render(80);
  model.scrollDown(10_000);
  const tighterOffset = model.scrollOffset();
  assert.ok(
    tighterOffset >= offset,
    `expected smaller viewport (5 rows) to allow at-least-as-deep scroll bottom as 30 rows; got first=${offset}, second=${tighterOffset}`,
  );
  // Strong invariant: scrolling must be clamped, not unbounded.
  assert.ok(
    Number.isFinite(tighterOffset) && tighterOffset < 10_000,
    `scrollOffset must be clamped under getMetrics; got ${tighterOffset}`,
  );
});
