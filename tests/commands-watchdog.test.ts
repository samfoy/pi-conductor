/**
 * Tests for /conductor watchdog status — v0.10 Slice 4.
 *
 * Drives `buildWatchdogStatusReport` directly. The slash dispatcher
 * `runWatchdog` just calls into this builder, so testing the pure
 * report covers the on-screen shape without setting up
 * ExtensionCommandContext or loading config.
 *
 * Empty-state, single fresh run, soft-stalled run, hard-stalled run,
 * paused run excluded, terminal run excluded, kill_on_stall flag
 * surfaced per-run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildWatchdogStatusReport } from "../src/commands.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";
import type { WatchdogConfig } from "../src/watchdog.ts";

const T0 = 1_700_000_000_000;

const CFG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

function runFx(overrides: Partial<Run>): Run {
  return {
    id: "builder-aaaa",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running" as RunStatus,
    startTime: T0 - 60_000,
    lastEventAt: T0 - 5_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    ...overrides,
  };
}

function buildArgs(reg: RunRegistry, opts: Partial<{
  defaultKillOnStall: boolean;
  enabled: boolean;
}> = {}) {
  return {
    registry: reg,
    watchdogConfig: CFG,
    defaultKillOnStall: opts.defaultKillOnStall ?? false,
    enabled: opts.enabled ?? true,
    now: T0,
  };
}

test("buildWatchdogStatusReport: empty registry → '0 active runs' + '(no active runs)'", () => {
  const reg = new RunRegistry();
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.match(out, /## Watchdog/);
  assert.match(out, /0 active runs/);
  assert.match(out, /\(no active runs\)/);
});

test("buildWatchdogStatusReport: one fresh active run renders silent/state/threshold/action", () => {
  const reg = new RunRegistry();
  reg.register(runFx({ id: "builder-aaaa", lastEventAt: T0 - 5_000 }));
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.match(out, /1 active run\b/);
  assert.match(out, /builder-aaaa/);
  assert.match(out, /5s/); // silent column
  assert.match(out, /fresh/); // state
  assert.match(out, /120s\/600s/); // threshold
  assert.match(out, /\u2014/); // action: em-dash for fresh
});

test("buildWatchdogStatusReport: stalled (soft) run shows state=soft + warn action when kill_on_stall=false", () => {
  const reg = new RunRegistry();
  reg.register(
    runFx({
      id: "builder-bbbb",
      startTime: T0 - 200_000,
      lastEventAt: T0 - 184_000,
      killOnStall: false,
    }),
  );
  const out = buildWatchdogStatusReport(buildArgs(reg, { defaultKillOnStall: false }));
  assert.match(out, /builder-bbbb/);
  assert.match(out, /184s/); // silent column matches design example
  assert.match(out, /\bsoft\b/);
  assert.match(out, /warn \(kill_on_stall=false\)/);
});

test("buildWatchdogStatusReport: hard-stalled with kill_on_stall=true shows kill action", () => {
  const reg = new RunRegistry();
  reg.register(
    runFx({
      id: "inspector-cccc",
      persona: "inspector",
      startTime: T0 - 700_000,
      lastEventAt: T0 - 650_000,
      killOnStall: true,
    }),
  );
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.match(out, /inspector-cccc/);
  assert.match(out, /\bhard\b/);
  assert.match(out, /kill \(kill_on_stall=true\)/);
});

test("buildWatchdogStatusReport: paused run is NOT listed (paused freezes lastEventAt)", () => {
  const reg = new RunRegistry();
  reg.register(
    runFx({
      id: "builder-dddd",
      status: "paused",
      pausedAt: T0 - 100_000,
    }),
  );
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.doesNotMatch(out, /builder-dddd/);
  assert.match(out, /0 active runs/);
});

test("buildWatchdogStatusReport: terminal runs are NOT listed", () => {
  const reg = new RunRegistry();
  reg.register(runFx({ id: "x-1", status: "completed" }));
  reg.register(runFx({ id: "x-2", status: "failed" }));
  reg.register(runFx({ id: "x-3", status: "killed" }));
  reg.register(runFx({ id: "x-4", status: "timeout" }));
  reg.register(runFx({ id: "x-5", status: "queued" }));
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.doesNotMatch(out, /x-[1-5]/);
  assert.match(out, /0 active runs/);
});

test("/conductor watchdog status: filter excludes hook_failed runs", () => {
  // v0.11 slice 1a: hook_failed is a new terminal status; the
  // active-run filter at src/commands.ts:833–839 uses literal-equality
  // exclusions (it does not call isTerminal). Without an explicit case
  // it would mis-categorize hook_failed runs as active. Slice 1a adds
  // the exclusion line; this test pins it.
  const reg = new RunRegistry();
  reg.register(runFx({ id: "hf-1", status: "hook_failed" as RunStatus }));
  const out = buildWatchdogStatusReport(buildArgs(reg));
  assert.doesNotMatch(out, /hf-1/);
  assert.match(out, /0 active runs/);
});

test("buildWatchdogStatusReport: header row contains the documented columns", () => {
  const reg = new RunRegistry();
  reg.register(runFx({}));
  const out = buildWatchdogStatusReport(buildArgs(reg));
  // Per design §5 example: id, persona, silent, state, threshold, action.
  // Status column from the example is omitted intentionally — pure-`running`
  // is the only state we render here (queued/paused/terminal are excluded).
  assert.match(out, /\bid\b.*\bpersona\b.*\bsilent\b.*\bstate\b.*\bthreshold\b.*\baction\b/);
});

test("buildWatchdogStatusReport: shows '(watchdog DISABLED)' note when enabled=false", () => {
  const reg = new RunRegistry();
  const out = buildWatchdogStatusReport(buildArgs(reg, { enabled: false }));
  assert.match(out, /\(watchdog DISABLED\)/);
});
