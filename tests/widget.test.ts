/**
 * Tests for src/widget.ts — v0.10 Slice 4 stall indicator.
 *
 * The widget render path goes through `ctx.ui.setWidget(...)` which
 * is awkward to fake; the load-bearing logic — when the `· STALLED Ns`
 * segment is appended and which theme slot it uses — lives in the
 * exported pure helper `formatStallSegment`. We test that directly.
 *
 * Mutation-witness target (W1, slice 4): dropping the
 * `· STALLED ${seconds}s` branch in formatStallSegment makes the
 * "stalled run renders STALLED Ns" test go red.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatStallSegment } from "../src/widget.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";
import type { WatchdogConfig } from "../src/watchdog.ts";

const T0 = 1_700_000_000_000;

const CFG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-aaaa",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running" as RunStatus,
    startTime: T0,
    lastEventAt: T0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    ...overrides,
  };
}

// Theme stub: returns "<slot>:<text>" so we can grep the slot used.
const stubTheme = {
  fg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`,
};

test("formatStallSegment: returns '' when nowMs/wdCfg omitted (back-compat)", () => {
  const r = runFx({ lastEventAt: T0 - 200_000 });
  assert.equal(formatStallSegment(r, stubTheme), "");
  assert.equal(formatStallSegment(r, stubTheme, T0), "");
});

test("formatStallSegment: fresh run (silent < soft) returns ''", () => {
  // 60s of silence after a 60s-old run; soft is 120s → fresh.
  const r = runFx({ startTime: T0 - 60_000, lastEventAt: T0 - 60_000 });
  assert.equal(formatStallSegment(r, stubTheme, T0, CFG), "");
});

test("formatStallSegment: paused run never emits STALLED (LOAD-BEARING)", () => {
  const r = runFx({
    status: "running",
    pausedAt: T0 - 100_000,
    startTime: T0 - 1_000_000,
    lastEventAt: T0 - 900_000, // would be hard if not paused
  });
  assert.equal(formatStallSegment(r, stubTheme, T0, CFG), "");
});

test("formatStallSegment: terminal run never emits STALLED", () => {
  const r = runFx({
    status: "completed",
    startTime: T0 - 1_000_000,
    lastEventAt: T0 - 900_000,
  });
  assert.equal(formatStallSegment(r, stubTheme, T0, CFG), "");
});

test("formatStallSegment: soft threshold crossed → ' · STALLED Ns' in warning slot (W1 witness)", () => {
  // Run started 200s ago, last event 184s ago: silent=184s, between soft (120) and hard (600).
  const r = runFx({
    startTime: T0 - 200_000,
    lastEventAt: T0 - 184_000,
  });
  const out = formatStallSegment(r, stubTheme, T0, CFG);
  assert.equal(out, "<warning> · STALLED 184s</warning>");
});

test("formatStallSegment: hard threshold crossed → ' · STALLED Ns!' in error slot", () => {
  // Run started 700s ago, last event 650s ago: silent=650s ≥ hard (600).
  const r = runFx({
    startTime: T0 - 700_000,
    lastEventAt: T0 - 650_000,
  });
  const out = formatStallSegment(r, stubTheme, T0, CFG);
  assert.equal(out, "<error> · STALLED 650s!</error>");
});

test("formatStallSegment: per-run softStallSeconds override changes the fire boundary", () => {
  // softStallSeconds=300 ⇒ hard scales to 1500 (5×). At silent=200s,
  // override means fresh; default would mean soft.
  const r = runFx({
    startTime: T0 - 220_000,
    lastEventAt: T0 - 200_000,
    softStallSeconds: 300,
  });
  assert.equal(formatStallSegment(r, stubTheme, T0, CFG), "");
});

test("formatStallSegment: still in grace window → '' (60s old run, default 30s grace, 35s silent at boundary)", () => {
  // Within grace. With grace=30s, run age 25s < 30s, no classification.
  const r = runFx({
    startTime: T0 - 25_000,
    lastEventAt: T0 - 25_000,
  });
  assert.equal(formatStallSegment(r, stubTheme, T0, CFG), "");
});

// ── v0.11 slice 5: · hook in-flight glyph ───────────────────────────────

import { formatRow } from "../src/widget.ts";

test("widget: shows · hook glyph when run.hookExecuting === true", () => {
  const r = runFx({ status: "running", hookExecuting: true });
  const out = formatRow(r, stubTheme);
  // The activity segment uses the "warning" theme slot and " · hook" text.
  assert.match(out, /warning.*·.*hook|· hook/);
});

test("widget: · hook glyph absent when run.hookExecuting !== true", () => {
  const r = runFx({ status: "running", hookExecuting: false });
  const out = formatRow(r, stubTheme);
  assert.doesNotMatch(out, /· hook/);
  // And a run with hookExecuting undefined (never set)
  const r2 = runFx({ status: "running" });
  const out2 = formatRow(r2, stubTheme);
  assert.doesNotMatch(out2, /· hook/);
});
