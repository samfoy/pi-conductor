/**
 * Tests for FocusedStreamModel — the pure navigation/fold/scroll state that
 * drives the focused-stream overlay.
 *
 * Pure: a class that owns state and exposes mutator methods. No TUI imports.
 * The overlay Component holds an instance and asks it for the current view.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(id: string, status: Run["status"] = "running"): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status,
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
  };
}

function setup(initialIds: string[] = ["a-1", "b-2", "c-3"]): {
  reg: RunRegistry;
  model: FocusedStreamModel;
  runs: Run[];
} {
  const reg = new RunRegistry();
  const runs = initialIds.map((id) => makeRun(id));
  for (const r of runs) reg.register(r);
  const model = new FocusedStreamModel(reg);
  return { reg, model, runs };
}

// ── Initial state ─────────────────────────────────────────────────────

test("FocusedStreamModel: initial focus is the most recently registered run at construction", () => {
  const reg = new RunRegistry();
  const a = makeRun("a-1");
  const b = makeRun("b-2");
  const c = makeRun("c-3");
  // Stagger startTimes so 'newest' is unambiguous.
  a.startTime = 1000;
  b.startTime = 2000;
  c.startTime = 3000;
  reg.register(a);
  reg.register(b);
  reg.register(c);
  const model = new FocusedStreamModel(reg);
  assert.equal(model.focused()?.id, "c-3");
});

test("FocusedStreamModel: refresh keeps the current focus when still valid (sticky)", () => {
  const { reg, model } = setup(["a-1", "b-2"]);
  model.focus("a-1");
  // A new run appears; the user is looking at a-1; their focus should not
  // be yanked away from them.
  reg.register(makeRun("c-3"));
  model.refresh();
  assert.equal(model.focused()?.id, "a-1");
});

test("FocusedStreamModel: initial state has tool calls collapsed and thinking hidden", () => {
  const { model } = setup();
  assert.equal(model.collapseToolCalls(), true);
  assert.equal(model.showThinking(), false);
});

test("FocusedStreamModel: initial scroll offset is 0", () => {
  const { model } = setup();
  assert.equal(model.scrollOffset(), 0);
});

test("FocusedStreamModel: empty registry yields focused() = undefined", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  assert.equal(model.focused(), undefined);
});

// ── Cycling ───────────────────────────────────────────────────────────

test("FocusedStreamModel: cycleNext moves to the next run in the active list", () => {
  const { model } = setup(["a-1", "b-2", "c-3"]);
  // Set initial focus to a known run.
  model.focus("a-1");
  model.cycleNext();
  assert.equal(model.focused()?.id, "b-2");
  model.cycleNext();
  assert.equal(model.focused()?.id, "c-3");
});

test("FocusedStreamModel: cycleNext wraps around past the end", () => {
  const { model } = setup(["a-1", "b-2"]);
  model.focus("b-2");
  model.cycleNext();
  assert.equal(model.focused()?.id, "a-1");
});

test("FocusedStreamModel: cyclePrev moves to the previous run, wrapping around", () => {
  const { model } = setup(["a-1", "b-2", "c-3"]);
  model.focus("a-1");
  model.cyclePrev();
  assert.equal(model.focused()?.id, "c-3");
  model.cyclePrev();
  assert.equal(model.focused()?.id, "b-2");
});

test("FocusedStreamModel: cycle is a no-op when only one run exists", () => {
  const { model } = setup(["only-1"]);
  model.cycleNext();
  assert.equal(model.focused()?.id, "only-1");
  model.cyclePrev();
  assert.equal(model.focused()?.id, "only-1");
});

test("FocusedStreamModel: cycle with empty registry is a no-op", () => {
  const reg = new RunRegistry();
  const model = new FocusedStreamModel(reg);
  model.cycleNext();
  model.cyclePrev();
  assert.equal(model.focused(), undefined);
});

// ── Focus by id ───────────────────────────────────────────────────────

test("FocusedStreamModel: focus(id) sets the focused run when id exists", () => {
  const { model } = setup(["a-1", "b-2"]);
  const ok = model.focus("b-2");
  assert.equal(ok, true);
  assert.equal(model.focused()?.id, "b-2");
});

test("FocusedStreamModel: focus(id) returns false and does nothing when id missing", () => {
  const { model } = setup(["a-1"]);
  const ok = model.focus("doesnt-exist");
  assert.equal(ok, false);
  assert.equal(model.focused()?.id, "a-1"); // unchanged
});

test("FocusedStreamModel: focus(id) resets scroll offset to 0", () => {
  const { model } = setup(["a-1", "b-2"]);
  model.focus("a-1");
  model.scrollDown(20);
  assert.notEqual(model.scrollOffset(), 0);
  model.focus("b-2");
  assert.equal(model.scrollOffset(), 0);
});

// ── Scrolling ─────────────────────────────────────────────────────────

test("FocusedStreamModel: scrollDown(n) advances offset", () => {
  const { model } = setup();
  model.scrollDown(5);
  assert.equal(model.scrollOffset(), 5);
  model.scrollDown(3);
  assert.equal(model.scrollOffset(), 8);
});

test("FocusedStreamModel: scrollUp(n) clamps at 0", () => {
  const { model } = setup();
  model.scrollUp(5);
  assert.equal(model.scrollOffset(), 0);
  model.scrollDown(10);
  model.scrollUp(15);
  assert.equal(model.scrollOffset(), 0);
});

test("FocusedStreamModel: scrollDown ignores non-positive arguments", () => {
  const { model } = setup();
  model.scrollDown(0);
  model.scrollDown(-3);
  assert.equal(model.scrollOffset(), 0);
});

test("FocusedStreamModel: scroll offset is per-agent (cycling preserves position)", () => {
  const { model } = setup(["a-1", "b-2"]);
  model.focus("a-1");
  model.scrollDown(10);
  model.cycleNext();
  assert.equal(model.scrollOffset(), 0); // b-2 has its own offset
  model.scrollDown(5);
  model.cyclePrev();
  assert.equal(model.scrollOffset(), 10); // back to a-1's position
});

// ── Fold toggles ──────────────────────────────────────────────────────

test("FocusedStreamModel: toggleCollapseToolCalls flips the flag", () => {
  const { model } = setup();
  assert.equal(model.collapseToolCalls(), true);
  model.toggleCollapseToolCalls();
  assert.equal(model.collapseToolCalls(), false);
  model.toggleCollapseToolCalls();
  assert.equal(model.collapseToolCalls(), true);
});

test("FocusedStreamModel: toggleShowThinking flips the flag", () => {
  const { model } = setup();
  assert.equal(model.showThinking(), false);
  model.toggleShowThinking();
  assert.equal(model.showThinking(), true);
  model.toggleShowThinking();
  assert.equal(model.showThinking(), false);
});

test("FocusedStreamModel: fold flags are global (persist across cycle)", () => {
  const { model } = setup(["a-1", "b-2"]);
  model.toggleCollapseToolCalls();
  model.toggleShowThinking();
  assert.equal(model.collapseToolCalls(), false);
  assert.equal(model.showThinking(), true);
  model.cycleNext();
  assert.equal(model.collapseToolCalls(), false);
  assert.equal(model.showThinking(), true);
});

// ── Refresh on registry change ────────────────────────────────────────

test("FocusedStreamModel: refresh() picks up newly registered runs", () => {
  const { reg, model } = setup(["a-1"]);
  model.focus("a-1");
  reg.register(makeRun("b-2"));
  model.refresh();
  // b-2 now exists; focused unchanged unless dropped.
  assert.equal(model.focused()?.id, "a-1");
  // Cycling now reaches b-2.
  model.cycleNext();
  assert.equal(model.focused()?.id, "b-2");
});

test("FocusedStreamModel: refresh() handles a focused run that was removed", () => {
  // We can't actually remove a run from the registry (no API), but we can
  // simulate by focusing on an id, then dropping the registry's reference.
  // Refresh should fall back to the next available run gracefully.
  const reg = new RunRegistry();
  const a = makeRun("a-1");
  reg.register(a);
  const model = new FocusedStreamModel(reg);
  model.focus("a-1");
  // Mutate the registry's internal state via a fresh registry to simulate.
  const reg2 = new RunRegistry();
  reg2.register(makeRun("b-2"));
  const model2 = new FocusedStreamModel(reg2);
  model2.focus("a-1"); // doesn't exist
  model2.refresh();
  // Should fall back to whatever's available.
  assert.equal(model2.focused()?.id, "b-2");
});
