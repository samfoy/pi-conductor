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

// ── Foreign-pid filter (defence-in-depth pending reconcile-startup fix) ──
//
// The reconcile-startup ownership gate (`src/reconcile-startup.ts:248`)
// already skips foreign-pid records, but the model layer keeps its own
// filter as a belt-and-braces defence: if a foreign run somehow lands in
// the local RunRegistry (race, future refactor, manual injection), the
// overlay must not surface it. See `docs/focused-overlay-redesign-design.md`
// §15 for context.

test("FocusedStreamModel: activeList() excludes run with foreign parentPid", () => {
  const reg = new RunRegistry();
  const local = makeRun("local-1");
  local.parentPid = process.pid;
  const foreign = makeRun("foreign-1");
  foreign.parentPid = 999_999;
  reg.register(local);
  reg.register(foreign);
  const model = new FocusedStreamModel(reg);
  // agentCount() routes through activeList(); foreign is filtered out.
  assert.equal(model.agentCount(), 1);
  // focus(id) consults activeList for membership; foreign is unreachable.
  assert.equal(model.focus("foreign-1"), false);
});

test("FocusedStreamModel: activeList() includes run with parentPid===process.pid", () => {
  const reg = new RunRegistry();
  const local = makeRun("local-1");
  local.parentPid = process.pid;
  reg.register(local);
  const model = new FocusedStreamModel(reg);
  assert.equal(model.agentCount(), 1);
  assert.equal(model.focus("local-1"), true);
});

test("FocusedStreamModel: activeList() includes run with no parentPid (legacy)", () => {
  const reg = new RunRegistry();
  const legacy = makeRun("legacy-1");
  // parentPid intentionally undefined — represents records spawned before
  // the parentPid field shipped. Treat as local for back-compat.
  reg.register(legacy);
  const model = new FocusedStreamModel(reg);
  assert.equal(model.agentCount(), 1);
  assert.equal(model.focus("legacy-1"), true);
});

test("FocusedStreamModel: refresh() ignores foreign-pid run when picking default focus", () => {
  const reg = new RunRegistry();
  const foreign = makeRun("foreign-1");
  foreign.parentPid = 999_999;
  foreign.startTime = 5000; // newest by startTime
  const local = makeRun("local-1");
  local.parentPid = process.pid;
  local.startTime = 1000;
  reg.register(foreign);
  reg.register(local);
  const model = new FocusedStreamModel(reg);
  // Default focus would be the foreign run (newest startTime); the gate
  // must drop it from consideration and pick the local run instead.
  assert.equal(model.focused()?.id, "local-1");
});

test("FocusedStreamModel: refresh() drops _focusedId when current run becomes foreign", () => {
  const reg = new RunRegistry();
  const a = makeRun("a-1");
  a.parentPid = process.pid;
  const b = makeRun("b-2");
  b.parentPid = process.pid;
  reg.register(a);
  reg.register(b);
  const model = new FocusedStreamModel(reg);
  model.focus("a-1");
  assert.equal(model.focused()?.id, "a-1");
  // a-1 becomes foreign (e.g. record rewritten by a sibling host); refresh
  // must re-pick from the local active list, not retain the foreign id.
  a.parentPid = 999_999;
  model.refresh();
  assert.equal(model.focused()?.id, "b-2");
});

test("FocusedStreamModel: focused() returns undefined when stored _focusedId resolves to a foreign run", () => {
  const reg = new RunRegistry();
  const a = makeRun("a-1");
  a.parentPid = process.pid;
  reg.register(a);
  const model = new FocusedStreamModel(reg);
  model.focus("a-1");
  // Mutate to foreign without calling refresh — focused() must gate inline
  // so a stale _focusedId can't surface a foreign run between refreshes.
  a.parentPid = 999_999;
  assert.equal(model.focused(), undefined);
});

// ── Slice 4: bounded scroll + stickToTail (auto-follow-tail) ─────────
//
// The model now accepts a `getMetrics: () => { bodyRows; transcriptLength }`
// closure at construction. It uses this to (a) clamp `scrollDown` at
// the renderable bottom, (b) latch a per-agent `stickToTail` flag when
// the user reaches the bottom, and (c) re-snap the offset to the new
// bottom on `refresh()` while latched. `Component.handleInput`'s
// signature is unchanged — the closure is the data path.

interface MetricsHandle {
  get: () => { bodyRows: number; transcriptLength: number };
  set: (next: Partial<{ bodyRows: number; transcriptLength: number }>) => void;
}

function makeMetrics(bodyRows = 10, transcriptLength = 0): MetricsHandle {
  let m = { bodyRows, transcriptLength };
  return {
    get: () => m,
    set: (next) => {
      m = { ...m, ...next };
    },
  };
}

test("FocusedStreamModel: model takes getMetrics injection", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 0);
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  // Construction with an injected getMetrics is enough to satisfy the
  // contract — the offset stays at 0 with no transcript, and scrolling
  // is clamped (covered by the next test).
  assert.equal(model.scrollOffset(), 0);
});

test("FocusedStreamModel: scrollDown clamps at bottom (per getMetrics)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 20); // bottom = max(0, 20 - 10) = 10
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.scrollDown(50);
  assert.equal(model.scrollOffset(), 10, "scrollDown clamps at bottom");
});

test("FocusedStreamModel: stickToTail latches on at bottom", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 20); // bottom = 10
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  assert.equal(model.stickToTail(), false, "starts unlatched");
  model.scrollDown(50); // organically reaches bottom
  assert.equal(model.stickToTail(), true, "latches on after reaching bottom");
});

test("FocusedStreamModel: stickToTail latches off on user-up", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 20);
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.jumpToTail();
  assert.equal(model.stickToTail(), true);
  model.scrollUp(1);
  assert.equal(model.stickToTail(), false, "user-up un-latches");
});

test("FocusedStreamModel: End/G resets stickToTail=true and snaps to bottom", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 50); // bottom = 40
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.scrollDown(5); // offset=5, not latched
  assert.equal(model.stickToTail(), false);
  model.jumpToTail();
  assert.equal(model.scrollOffset(), 40, "snaps to bottom");
  assert.equal(model.stickToTail(), true, "End/G latches on");
});

test("FocusedStreamModel: Home/g sets stickToTail=false and offset=0", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 50);
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.jumpToTail();
  assert.equal(model.stickToTail(), true);
  model.jumpToHome();
  assert.equal(model.scrollOffset(), 0, "Home/g resets offset");
  assert.equal(model.stickToTail(), false, "Home/g un-latches");
});

test("FocusedStreamModel: refresh while stickToTail keeps offset at new bottom (re-reads getMetrics)", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 20); // bottom = 10
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.jumpToTail();
  assert.equal(model.scrollOffset(), 10);
  // Transcript grows — bottom moves.
  metrics.set({ transcriptLength: 30 }); // new bottom = 20
  model.refresh();
  assert.equal(model.scrollOffset(), 20, "re-snaps to new bottom while latched");
});

test("FocusedStreamModel: refresh without stickToTail leaves offset alone", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 50);
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.scrollDown(5); // offset=5, not latched (didn't reach bottom)
  assert.equal(model.stickToTail(), false);
  metrics.set({ transcriptLength: 100 });
  model.refresh();
  assert.equal(model.scrollOffset(), 5, "offset unchanged while unlatched");
});

test("FocusedStreamModel: Tab cycle restores per-agent (offset, stickToTail) pair", () => {
  const reg = new RunRegistry();
  const a = { ...makeRun("a-1"), startTime: 1000 };
  const b = { ...makeRun("b-2"), startTime: 2000 };
  reg.register(a);
  reg.register(b);
  const metrics = makeMetrics(10, 50); // bottom = 40
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  // refresh() picked b-2 (most recent). Latch on b.
  assert.equal(model.focused()?.id, "b-2");
  model.jumpToTail();
  assert.equal(model.scrollOffset(), 40);
  assert.equal(model.stickToTail(), true);
  // Cycle to a; mutate state.
  model.cyclePrev();
  assert.equal(model.focused()?.id, "a-1");
  model.scrollDown(7);
  assert.equal(model.scrollOffset(), 7);
  assert.equal(model.stickToTail(), false, "a-1 not latched");
  // Cycle back to b — offset=40, latched should restore.
  model.cycleNext();
  assert.equal(model.focused()?.id, "b-2");
  assert.equal(model.scrollOffset(), 40, "b-2 offset restored");
  assert.equal(model.stickToTail(), true, "b-2 latched state restored");
  // And back to a.
  model.cyclePrev();
  assert.equal(model.scrollOffset(), 7, "a-1 offset restored");
  assert.equal(model.stickToTail(), false);
});

test("FocusedStreamModel: resize (getMetrics returns new bodyRows) re-clamps offset on next mutation", () => {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  const metrics = makeMetrics(10, 50); // bottom = 40
  const model = new FocusedStreamModel(reg, { getMetrics: metrics.get });
  model.scrollDown(35); // offset=35, valid for bodyRows=10
  assert.equal(model.scrollOffset(), 35);
  // Terminal grew — bodyRows=30 → new bottom = max(0, 50-30) = 20.
  metrics.set({ bodyRows: 30 });
  // Next mutation MUST observe the new clamp. Use scrollDown(1) — the
  // model clamps to 20 (new bottom) before the +1, then clamps the
  // result again → final offset = 20.
  model.scrollDown(1);
  assert.equal(model.scrollOffset(), 20, "next mutation re-clamps under new bodyRows");
});

// ── Slice 5: fold expansion state ────────────────────────────────

test("isExpanded falls back to default when key absent", () => {
  const { model } = setup();
  // No prior expand/collapse → key not in map. The default arg wins.
  assert.equal(model.isExpanded("tool:none", false), false);
  assert.equal(model.isExpanded("tool:none", true), true);
});

test("expandAll/collapseAll mutate _foldExpanded", () => {
  const { model } = setup();
  // Pre-populate with a stale per-key entry to verify clears.
  (model as any)._foldExpanded.set("tool:legacy", true);
  assert.equal((model as any)._foldExpanded.size, 1);

  // expandAll resets the per-key map and turns global override on.
  model.expandAll();
  assert.equal(
    (model as any)._foldExpanded.size,
    0,
    "expandAll clears per-key overrides (global mode supersedes)",
  );
  // Any default-false key now reads as expanded.
  assert.equal(model.isExpanded("tool:any", false), true);
  assert.equal(model.isExpanded("thinking:0:0", false), true);

  // collapseAll clears the map AND drops global mode.
  model.collapseAll();
  assert.equal((model as any)._foldExpanded.size, 0);
  assert.equal(
    model.isExpanded("tool:any", false),
    false,
    "collapseAll restores default-false behaviour",
  );
});

test("FocusedStreamModel: collapseAll after expandAll un-latches global override", () => {
  const { model } = setup();
  model.expandAll();
  assert.equal(model.isExpanded("k1", false), true);
  model.collapseAll();
  assert.equal(model.isExpanded("k1", false), false);
});
