/**
 * Tests for the v0.10 watchdog enforcer (Slice 2).
 *
 * The enforcer wraps the pure detector from Slice 1 with:
 *   - registry subscription + interval ticker (injectable clock + setTimer)
 *   - per-run state Map<runId, WatchdogState>
 *   - dispatch of soft/hard/recovered transitions to:
 *     - log.warn / log.info
 *     - run.stalledSince writes
 *     - forceTerminate(run, "stalled") gated by kill_on_stall
 *   - **A2 amendment**: a fresh `now - lastEventAt` re-check IMMEDIATELY
 *     before forceTerminate. If the run recovered between the detector
 *     tick and the kill, abort the kill.
 *   - **R7**: skip start when CONDUCTOR_SUBAGENT === "1".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Watchdog, type WatchdogDeps, type WatchdogLog } from "../src/watchdog.ts";
import { DEFAULT_WATCHDOG_CONFIG, resolveKillOnStall, type WatchdogConfig } from "../src/watchdog.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";
import type { TerminationReason } from "../src/runs.ts";

const T0 = 1_700_000_000_000;

const CFG: WatchdogConfig = {
  softThresholdSeconds: 120,
  hardThresholdSeconds: 600,
  graceSeconds: 30,
};

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-test",
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

interface FakeLog extends WatchdogLog {
  warns: { msg: string; data?: unknown }[];
  infos: { msg: string; data?: unknown }[];
}

function fakeLog(): FakeLog {
  const warns: FakeLog["warns"] = [];
  const infos: FakeLog["infos"] = [];
  return {
    warns,
    infos,
    warn(msg, data) {
      warns.push({ msg, data });
    },
    info(msg, data) {
      infos.push({ msg, data });
    },
  };
}

// Minimal fake registry: list() + onChange().
function fakeRegistry(initial: Run[] = []): {
  list: () => Run[];
  setRuns: (rs: Run[]) => void;
  notify: () => void;
  onChange: WatchdogDeps["registry"]["onChange"];
} {
  let runs = [...initial];
  const listeners = new Set<() => void>();
  return {
    list: () => [...runs],
    setRuns: (rs) => {
      runs = [...rs];
    },
    notify: () => {
      for (const fn of listeners) fn();
    },
    onChange: (fn) => {
      // Adapter: detector subscribes by run, but the Watchdog only needs
      // a wake-up signal. We accept any RunListener-shaped callback.
      const wrapped = () => {
        for (const r of runs) fn(r);
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
}

interface KillCall {
  runId: string;
  reason: TerminationReason;
}

function makeDeps(opts: {
  runs: Run[];
  config?: WatchdogConfig;
  killOnStall?: boolean;
  killOnStallFn?: (run: Run) => boolean;
  log?: FakeLog;
  nowRef?: { value: number };
}): {
  deps: WatchdogDeps;
  kills: KillCall[];
  registry: ReturnType<typeof fakeRegistry>;
  log: FakeLog;
} {
  const log = opts.log ?? fakeLog();
  const kills: KillCall[] = [];
  const registry = fakeRegistry(opts.runs);
  const nowRef = opts.nowRef ?? { value: T0 };
  const deps: WatchdogDeps = {
    registry,
    config: opts.config ?? CFG,
    log,
    now: () => nowRef.value,
    kill: (run, reason) => {
      kills.push({ runId: run.id, reason });
    },
    isKillOnStall: opts.killOnStallFn ?? (() => opts.killOnStall ?? false),
  };
  return { deps, kills, registry, log };
}

// ── Lifecycle ─────────────────────────────────────────────────────────

test("Watchdog.start: returns dispose function; dispose unsubscribes registry", () => {
  const run = runFx();
  const { deps, registry } = makeDeps({ runs: [run] });
  const wd = new Watchdog(deps);
  const dispose = wd.start();
  assert.equal(typeof dispose, "function");
  dispose();
  // After dispose, notifying registry should not throw or cause ticks.
  registry.notify();
});

test("Watchdog: dispose clears interval timer", () => {
  let intervalCallCount = 0;
  let cleared = false;
  const fakeSetInterval = (_fn: () => void, _ms: number) => {
    intervalCallCount++;
    return { id: "fake-interval" } as unknown as NodeJS.Timeout;
  };
  const fakeClearInterval = (_t: NodeJS.Timeout) => {
    cleared = true;
  };
  const run = runFx();
  const { deps } = makeDeps({ runs: [run] });
  const wd = new Watchdog({
    ...deps,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
  });
  const dispose = wd.start();
  assert.equal(intervalCallCount, 1, "start scheduled exactly one interval");
  dispose();
  assert.equal(cleared, true, "dispose cleared the interval");
});

// ── Soft transition ──────────────────────────────────────────────────

test("Watchdog.tick: run crosses soft threshold → log.warn called once + run.stalledSince set", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 130_000 }; // 130s silent (past 120s soft)
  const { deps, log } = makeDeps({ runs: [run], nowRef });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.equal(log.warns.length, 1, "exactly one soft warn");
  assert.match(log.warns[0]!.msg, /soft/i);
  assert.ok(run.stalledSince !== undefined, "run.stalledSince was set");
  assert.equal(run.stalledSince, nowRef.value);
});

test("Watchdog.tick: same run still soft on next tick → no duplicate warn (state dedup)", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 130_000 };
  const { deps, log } = makeDeps({ runs: [run], nowRef });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.equal(log.warns.length, 1);
  // Tick again 10s later, still silent — should not re-warn.
  nowRef.value = T0 + 140_000;
  wd.tick();
  assert.equal(log.warns.length, 1, "no duplicate soft warn");
});

// ── Recovery ─────────────────────────────────────────────────────────

test("Watchdog.tick: stalled run advances lastEventAt → log.info recovered + stalledSince cleared", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 130_000 };
  const { deps, log } = makeDeps({ runs: [run], nowRef });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.ok(run.stalledSince !== undefined);
  assert.equal(log.warns.length, 1);
  // Run recovers — event arrives.
  nowRef.value = T0 + 200_000;
  run.lastEventAt = T0 + 199_000;
  wd.tick();
  assert.equal(run.stalledSince, undefined, "stalledSince cleared on recovery");
  assert.equal(log.infos.length, 1, "exactly one recovery info");
  assert.match(log.infos[0]!.msg, /recovered/i);
});

// ── Hard threshold without kill_on_stall ─────────────────────────────

test("Watchdog.tick: crosses hard + kill_on_stall=false → hard warn, NO kill", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 700_000 }; // 700s silent (past 600s hard)
  const { deps, log, kills } = makeDeps({
    runs: [run],
    nowRef,
    killOnStall: false,
  });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.equal(kills.length, 0, "no kill on hard-stall when kill_on_stall=false");
  assert.equal(log.warns.length, 1);
  assert.match(log.warns[0]!.msg, /hard/i);
  assert.ok(run.stalledSince !== undefined);
});

// ── Hard threshold WITH kill_on_stall ────────────────────────────────

test("Watchdog.tick: crosses hard + kill_on_stall=true → forceTerminate(run, 'stalled')", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 700_000 };
  const { deps, kills } = makeDeps({
    runs: [run],
    nowRef,
    killOnStall: true,
  });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.equal(kills.length, 1, "exactly one kill on hard-stall+kill_on_stall");
  assert.equal(kills[0]!.runId, run.id);
  assert.equal(kills[0]!.reason, "stalled");
});

// ── A2 amendment: pre-kill recheck ───────────────────────────────────

test("Watchdog.tick: A2 — run recovers between detector and kill → kill aborted (LOAD-BEARING)", () => {
  // The detector ran at the tick clock (run was hard-stalled); but
  // before the kill dispatcher commits, lastEventAt advances back inside
  // the soft window. The A2 re-check must abort the kill.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 700_000 };
  const { deps, kills, log } = makeDeps({
    runs: [run],
    nowRef,
    killOnStall: true,
  });

  // Override: the kill function reads run.lastEventAt at call time.
  // Simulate the recovery happening in the same synchronous frame by
  // mutating the run BEFORE dispatch — we do this via an isKillOnStall
  // hook that re-checks. The Watchdog's dispatcher is responsible for
  // this; we test it by mutating `run.lastEventAt` between the moment
  // the detector saw stale state and the moment dispatcher consults it.
  //
  // Strategy: subclass via dep injection — `now()` returns the same
  // value, but the Watchdog must call `Date.now()` -- no, actually it
  // must call `deps.now()` again at kill time and compare to
  // `run.lastEventAt` (which we mutate).
  //
  // We mutate inside kill itself: shouldn't, because that's after the
  // recheck. Instead we hook the `now()` to also advance lastEventAt
  // on its second invocation (the recheck call).
  let nowCalls = 0;
  const hookedNow = () => {
    nowCalls++;
    if (nowCalls === 2) {
      // Second now() is the pre-kill recheck — recovery just happened.
      run.lastEventAt = T0 + 699_000; // 1s ago, well under soft.
    }
    return nowRef.value;
  };
  const wd = new Watchdog({ ...deps, now: hookedNow });
  wd.tick();
  assert.equal(
    kills.length,
    0,
    "kill must be aborted when A2 recheck shows recovery",
  );
  // Recovery should be logged as info, not as a kill.
  assert.ok(
    log.infos.some((l) => /recover|aborted/i.test(l.msg)),
    "A2 abort logged as recovery/abort",
  );
});

test("Watchdog.tick: A2 — recheck still stale → kill proceeds", () => {
  // Sanity: when lastEventAt does NOT advance, A2 recheck confirms and kill fires.
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 700_000 };
  const { deps, kills } = makeDeps({
    runs: [run],
    nowRef,
    killOnStall: true,
  });
  const wd = new Watchdog(deps);
  wd.tick();
  assert.equal(kills.length, 1);
});

// ── R7: sub-agent skip ───────────────────────────────────────────────

test("Watchdog.start: CONDUCTOR_SUBAGENT=1 → no listeners attached, no ticks (R7)", () => {
  const prev = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "1";
  try {
    let intervalCalls = 0;
    const fakeSetInterval = (_fn: () => void, _ms: number) => {
      intervalCalls++;
      return { id: "fake" } as unknown as NodeJS.Timeout;
    };
    const run = runFx({ lastEventAt: T0, startTime: T0 });
    const nowRef = { value: T0 + 700_000 };
    const { deps, kills, log } = makeDeps({ runs: [run], nowRef, killOnStall: true });
    const wd = new Watchdog({ ...deps, setInterval: fakeSetInterval });
    const dispose = wd.start();
    assert.equal(intervalCalls, 0, "no interval scheduled in sub-agent context");
    // Ticks are also no-ops.
    wd.tick();
    assert.equal(kills.length, 0, "no kill triggered in sub-agent context");
    assert.equal(log.warns.length, 0, "no warns in sub-agent context");
    dispose();
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
  }
});

// ── Disabled config ──────────────────────────────────────────────────

test("Watchdog.tick: disabled config → no transitions even past hard threshold", () => {
  const run = runFx({ startTime: T0, lastEventAt: T0 });
  const nowRef = { value: T0 + 700_000 };
  const log = fakeLog();
  const kills: KillCall[] = [];
  const registry = fakeRegistry([run]);
  const wd = new Watchdog({
    registry,
    config: CFG,
    log,
    now: () => nowRef.value,
    kill: (r, reason) => {
      kills.push({ runId: r.id, reason });
    },
    isKillOnStall: () => true,
    isEnabled: () => false,
  });
  wd.tick();
  assert.equal(log.warns.length, 0);
  assert.equal(kills.length, 0);
});

// ── Default tick interval ────────────────────────────────────────────

test("Watchdog: default tick interval is 30000ms", () => {
  let intervalMs = -1;
  const fakeSetInterval = (_fn: () => void, ms: number) => {
    intervalMs = ms;
    return { id: "fake" } as unknown as NodeJS.Timeout;
  };
  const run = runFx();
  const { deps } = makeDeps({ runs: [run] });
  const wd = new Watchdog({ ...deps, setInterval: fakeSetInterval });
  const dispose = wd.start();
  assert.equal(intervalMs, 30_000);
  dispose();
});

test("Watchdog: tickIntervalMs override is honoured", () => {
  let intervalMs = -1;
  const fakeSetInterval = (_fn: () => void, ms: number) => {
    intervalMs = ms;
    return { id: "fake" } as unknown as NodeJS.Timeout;
  };
  const run = runFx();
  const { deps } = makeDeps({ runs: [run] });
  const wd = new Watchdog({
    ...deps,
    setInterval: fakeSetInterval,
    tickIntervalMs: 5_000,
  });
  const dispose = wd.start();
  assert.equal(intervalMs, 5_000);
  dispose();
});

// ── v0.10 Slice 3: per-run policy plumbing through dispatch ────────────

test("Watchdog.tick: per-run killOnStall=true (via isKillOnStall(run)) escalates hard to kill (LOAD-BEARING)", () => {
  // Mirrors the index.ts wiring: isKillOnStall reads run.killOnStall.
  // Two runs share a registry; only the one with killOnStall=true is
  // killed when both cross hard. Mutation: drop the per-run lookup
  // (always return false) → no kills → this test fires both negatives.
  const target = runFx({
    id: "builder-kill",
    persona: "builder",
    killOnStall: true,
    startTime: T0,
    lastEventAt: T0,
  });
  const bystander = runFx({
    id: "inspector-keep",
    persona: "inspector",
    killOnStall: false,
    startTime: T0,
    lastEventAt: T0,
  });
  const nowRef = { value: T0 };
  const { deps, kills } = makeDeps({
    runs: [target, bystander],
    nowRef,
    killOnStallFn: (run) => run.killOnStall === true,
  });
  const wd = new Watchdog(deps);
  // Advance past hard threshold (600s) for both.
  nowRef.value = T0 + 700_000;
  wd.tick();
  assert.equal(kills.length, 1, "only one run is killed");
  assert.equal(kills[0]?.runId, target.id);
  assert.equal(kills[0]?.reason, "stalled");
});

test("Watchdog.tick: per-run softStallSeconds override changes the soft fire boundary", () => {
  // Run with softStallSeconds=300; CFG default soft=120. 200s of
  // silence is below the override soft and should NOT fire. Crossing
  // 300s does fire as soft.
  const run = runFx({
    id: "builder-slow",
    softStallSeconds: 300,
    startTime: T0,
    lastEventAt: T0,
  });
  const nowRef = { value: T0 };
  const log = fakeLog();
  const { deps } = makeDeps({ runs: [run], nowRef, log });
  const wd = new Watchdog(deps);

  // 200s in: still below override soft (300s).
  nowRef.value = T0 + 200_000;
  wd.tick();
  assert.equal(
    log.warns.length,
    0,
    "override raised soft to 300s; 200s of silence is healthy",
  );

  // 300s in: crosses override soft.
  nowRef.value = T0 + 300_000;
  wd.tick();
  assert.equal(log.warns.length, 1, "crossed override soft");
  assert.match(log.warns[0]?.msg ?? "", /soft-stall/);
});

test("resolveKillOnStall: per-run override wins; falls through to cfg default (LOAD-BEARING — W1 witness for src/index.ts:391)", () => {
  // The session_start handler in src/index.ts wires the watchdog's
  // `isKillOnStall` to `resolveKillOnStall(run, cfg.watchdog.defaultKillOnStall)`.
  // Mutation: dropping the per-run lookup in `resolveKillOnStall`
  // (i.e. body becomes `return defaultKillOnStall;`) flips assertions 1
  // and 3 below. The other Slice 3 enforcer tests inject their own
  // killOnStallFn into deps, bypassing the production formula — this
  // test pins the formula directly so a regression cannot slip through.
  const r = (k?: boolean): Run => runFx({ killOnStall: k });
  assert.equal(
    resolveKillOnStall(r(true), false),
    true,
    "override true wins over default false",
  );
  assert.equal(
    resolveKillOnStall(r(undefined), true),
    true,
    "undefined run.killOnStall falls through to cfg default",
  );
  assert.equal(
    resolveKillOnStall(r(false), true),
    false,
    "explicit false wins over default true",
  );
});

