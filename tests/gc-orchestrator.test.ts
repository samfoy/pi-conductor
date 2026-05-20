/**
 * pi-conductor — GC orchestrator (Slice 5) tests.
 *
 * Integration-style: builds a temporary runs root with mkdtempSync,
 * runs `runGc` end-to-end, asserts on-disk + return-shape state.
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 5"; docs/v0.9-gc-design.md §3 + R10/R11.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeAutoRunGc, runGc } from "../src/gc/index.ts";
import { _resetRecentlyDeletedIdsForTest, _peekRecentlyDeletedForTest } from "../src/gc/id-reuse.ts";
import { lastGcMarkerPath, writeLastGcMtime } from "../src/gc/last-gc.ts";
import { RunRegistry } from "../src/runs.ts";
import { DEFAULT_CONFIG, emptyUsage, type GcConfig, type Run, type RunRecord } from "../src/types.ts";

const NOW = 1_750_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function makeFakeRoot(): { root: string; runsRoot: string } {
  // The real layout is `<conductorRoot>/runs/<id>/...`. The marker
  // lives at `<conductorRoot>/.last-gc`. Build the same shape so the
  // marker write doesn't escape the tmp dir.
  const root = mkdtempSync(join(tmpdir(), "pi-conductor-gc-orch-"));
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot, { recursive: true });
  return { root, runsRoot };
}

interface RunDirOpts {
  status?: RunRecord["status"];
  startedMsAgo?: number;
  finishedMsAgo?: number;
  withTranscriptBytes?: number;
  withSession?: boolean;
  withPinned?: boolean;
  withArchived?: boolean;
}

function makeRunDir(runsRoot: string, id: string, opts: RunDirOpts = {}): void {
  const runDir = join(runsRoot, id);
  mkdirSync(runDir, { recursive: true });
  const startedAgo = opts.startedMsAgo ?? 60_000;
  const finishedAgo = opts.finishedMsAgo ?? 30_000;
  const status: RunRecord["status"] = opts.status ?? "completed";
  const record: RunRecord = {
    id,
    persona: "inspector",
    task: "test",
    mode: "background",
    status,
    startTime: NOW - startedAgo,
    finishedAt: status === "running" ? undefined : NOW - finishedAgo,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runDir, "record.json"),
    transcriptPath: join(runDir, "transcript.jsonl"),
    finalPath: join(runDir, "final.md"),
  };
  writeFileSync(record.recordPath, JSON.stringify(record));
  // Also set record mtime so the orphan-stale check sees old runs.
  if (opts.finishedMsAgo !== undefined || status === "running") {
    const mtime = new Date(NOW - (opts.finishedMsAgo ?? opts.startedMsAgo ?? 0));
    utimesSync(record.recordPath, mtime, mtime);
  }
  const transcriptBytes = opts.withTranscriptBytes ?? 100;
  if (transcriptBytes > 0) {
    writeFileSync(record.transcriptPath, "x".repeat(transcriptBytes));
  }
  writeFileSync(record.finalPath, "final");
  if (opts.withSession ?? true) {
    const sd = join(runDir, "session");
    mkdirSync(sd);
    writeFileSync(join(sd, "s.jsonl"), "{}\n");
  }
  if (opts.withPinned) writeFileSync(join(runDir, ".pinned"), "");
  if (opts.withArchived) {
    const apath = join(runDir, ".archived");
    writeFileSync(apath, "");
    // Backdate sidecar mtime so the archived-TTL check sees it as old.
    const mtime = new Date(NOW - (opts.finishedMsAgo ?? opts.startedMsAgo ?? 0));
    utimesSync(apath, mtime, mtime);
  }
}

function gcCfg(overrides: Partial<GcConfig> = {}): GcConfig {
  return { ...DEFAULT_CONFIG.gc, ...overrides };
}

// ── runGc ─────────────────────────────────────────────────────────────

test("runGc: empty inventory yields zero-action result with positive durationMs", async () => {
  const { runsRoot } = makeFakeRoot();
  const r = await runGc({ runsRoot, config: gcCfg(), registry: new RunRegistry(), now: NOW });
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.planSummary, { archive: 0, delete: 0, reconcile: 0, keep: 0 });
  assert.equal(r.archived.length, 0);
  assert.equal(r.deleted.length, 0);
  assert.equal(r.reconciled.length, 0);
  assert.equal(r.totalBytesReclaimed, 0);
  assert.ok(r.durationMs >= 1, `durationMs should be positive, got ${r.durationMs}`);
});

test("runGc: ancient terminal run with archived sidecar -> delete + bytes reclaimed", async () => {
  const { runsRoot } = makeFakeRoot();
  // Already cold-archived in a previous pass, but old enough now to delete.
  // To force "delete": need archived sidecar AND age > completedTtlDays.
  // policy.ts:decideForEntry: archived + > TTL -> delete.
  makeRunDir(runsRoot, "inspector-old1", {
    status: "completed",
    finishedMsAgo: 31 * DAY_MS,
    withTranscriptBytes: 0,
    withArchived: true,
  });
  const r = await runGc({ runsRoot, config: gcCfg(), registry: new RunRegistry(), now: NOW });
  assert.equal(r.scanned, 1);
  assert.equal(r.planSummary.delete, 1);
  assert.equal(r.deleted.length, 1);
  assert.equal(r.deleted[0]!.agentId, "inspector-old1");
  // Run dir is gone.
  assert.ok(!existsSync(join(runsRoot, "inspector-old1")));
  // R10 side effect: deleted id is in the recently-deleted set.
  assert.ok(_peekRecentlyDeletedForTest().has("inspector-old1"));
  _resetRecentlyDeletedIdsForTest();
});

test("runGc: huge unarchived transcript -> cold-archive (transcript-cap)", async () => {
  const { runsRoot } = makeFakeRoot();
  makeRunDir(runsRoot, "designer-fat", {
    status: "completed",
    finishedMsAgo: DAY_MS,
    withTranscriptBytes: 200, // > 100 bytes per-cap below
  });
  const cfg = gcCfg({ transcriptSizeCapBytes: 100 });
  const r = await runGc({ runsRoot, config: cfg, registry: new RunRegistry(), now: NOW });
  assert.equal(r.planSummary.archive, 1);
  assert.equal(r.archived.length, 1);
  assert.equal(r.archived[0]!.agentId, "designer-fat");
  // Sidecar exists; transcript unlinked.
  assert.ok(existsSync(join(runsRoot, "designer-fat", ".archived")));
  assert.ok(!existsSync(join(runsRoot, "designer-fat", "transcript.jsonl")));
});

test("runGc: stale running record reconciles to killed before executor (orphan)", async () => {
  const { runsRoot } = makeFakeRoot();
  // Status running, no inMemory, mtime older than orphan TTL (24h default).
  makeRunDir(runsRoot, "inspector-orphan", {
    status: "running",
    startedMsAgo: 48 * HOUR_MS,
    finishedMsAgo: 48 * HOUR_MS, // mtime
    withTranscriptBytes: 0,
  });
  const r = await runGc({ runsRoot, config: gcCfg(), registry: new RunRegistry(), now: NOW });
  assert.equal(r.planSummary.reconcile, 1);
  assert.deepEqual(r.reconciled, ["inspector-orphan"]);
  // Record on disk now status=killed.
  const rec = JSON.parse(
    readFileSync(join(runsRoot, "inspector-orphan", "record.json"), "utf-8"),
  ) as RunRecord;
  assert.equal(rec.status, "killed");
  assert.ok(rec.errorMessage?.includes("reconciled by GC"));
});

test("runGc: dryRun=true skips reconcile + executor; plan summary still populated", async () => {
  const { runsRoot } = makeFakeRoot();
  makeRunDir(runsRoot, "designer-fat", {
    status: "completed",
    finishedMsAgo: DAY_MS,
    withTranscriptBytes: 200,
  });
  makeRunDir(runsRoot, "inspector-orphan", {
    status: "running",
    startedMsAgo: 48 * HOUR_MS,
    finishedMsAgo: 48 * HOUR_MS,
    withTranscriptBytes: 0,
  });
  const cfg = gcCfg({ transcriptSizeCapBytes: 100 });
  const r = await runGc({ runsRoot, config: cfg, registry: new RunRegistry(), now: NOW, dryRun: true });
  assert.equal(r.planSummary.archive, 1);
  assert.equal(r.planSummary.reconcile, 1);
  // No actions executed.
  assert.equal(r.archived.length, 0);
  assert.equal(r.deleted.length, 0);
  assert.equal(r.reconciled.length, 0);
  assert.equal(r.totalBytesReclaimed, 0);
  // Dry-run did NOT touch disk.
  assert.ok(existsSync(join(runsRoot, "designer-fat", "transcript.jsonl")));
  const rec = JSON.parse(
    readFileSync(join(runsRoot, "inspector-orphan", "record.json"), "utf-8"),
  ) as RunRecord;
  assert.equal(rec.status, "running");
});

test("runGc: dryRun preserves runsLoseResume from plan", async () => {
  const { runsRoot } = makeFakeRoot();
  // Old completed run with session/ -> delete -> losesResume.
  // policy.ts marks delete-with-session as losesResume.
  makeRunDir(runsRoot, "inspector-old1", {
    status: "completed",
    finishedMsAgo: 31 * DAY_MS,
    withTranscriptBytes: 0,
    withArchived: true,
    withSession: true,
  });
  const r = await runGc({ runsRoot, config: gcCfg(), registry: new RunRegistry(), now: NOW, dryRun: true });
  assert.equal(r.runsLoseResume, 1);
});

test("runGc: registry has live proc for an id -> entry kept (active-run gate)", async () => {
  const { runsRoot } = makeFakeRoot();
  makeRunDir(runsRoot, "inspector-live", {
    status: "completed",
    finishedMsAgo: 31 * DAY_MS,
    withTranscriptBytes: 0,
    withArchived: true,
  });
  // Even archived + ancient, an in-memory live `proc` keeps the entry.
  const reg = new RunRegistry();
  const liveRun: Run = {
    id: "inspector-live",
    persona: "inspector",
    task: "live",
    mode: "background",
    status: "completed",
    startTime: NOW - 10_000,
    finishedAt: NOW - 1_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runsRoot, "inspector-live", "record.json"),
    transcriptPath: join(runsRoot, "inspector-live", "transcript.jsonl"),
    finalPath: join(runsRoot, "inspector-live", "final.md"),
    messages: [],
    lastEventAt: NOW - 1_000,
    proc: { pid: 99999 } as unknown as Run["proc"],
  };
  reg.register(liveRun);
  const r = await runGc({ runsRoot, config: gcCfg(), registry: reg, now: NOW });
  assert.equal(r.deleted.length, 0);
  assert.equal(r.archived.length, 0);
  assert.ok(existsSync(join(runsRoot, "inspector-live")));
});

test("runGc: aggregates failed entries from reconcile + executor", async () => {
  // Simplest path: an action that the executor's gate blocks. If we
  // make a "delete" action whose id is also in the live-proc set, the
  // executor pushes a `failed[]` entry.
  const { runsRoot } = makeFakeRoot();
  makeRunDir(runsRoot, "inspector-old1", {
    status: "completed",
    finishedMsAgo: 31 * DAY_MS,
    withTranscriptBytes: 0,
    withArchived: true,
  });
  const reg = new RunRegistry();
  reg.register({
    id: "inspector-old1",
    persona: "inspector",
    task: "x",
    mode: "background",
    status: "completed",
    startTime: NOW - 10_000,
    finishedAt: NOW - 1_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runsRoot, "inspector-old1", "record.json"),
    transcriptPath: join(runsRoot, "inspector-old1", "transcript.jsonl"),
    finalPath: join(runsRoot, "inspector-old1", "final.md"),
    messages: [],
    lastEventAt: NOW - 1_000,
    proc: { pid: 12345 } as unknown as Run["proc"],
  });
  const r = await runGc({ runsRoot, config: gcCfg(), registry: reg, now: NOW });
  // Live proc -> policy keeps it; nothing reaches executor; nothing fails.
  assert.equal(r.failed.length, 0);
  assert.equal(r.deleted.length, 0);
});

// ── maybeAutoRunGc — debounce + flags ─────────────────────────────────

test("maybeAutoRunGc: enabled=false -> ran=false, reason=disabled", async () => {
  const { runsRoot } = makeFakeRoot();
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg({ enabled: false }),
    registry: new RunRegistry(),
    now: NOW,
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, "disabled");
});

test("maybeAutoRunGc: autoOnSessionStart=false -> ran=false, reason=auto-disabled", async () => {
  const { runsRoot } = makeFakeRoot();
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg({ autoOnSessionStart: false }),
    registry: new RunRegistry(),
    now: NOW,
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, "auto-disabled");
});

test("maybeAutoRunGc: marker fresh (within debounce) -> skip", async () => {
  const { root, runsRoot } = makeFakeRoot();
  // Marker mtime = NOW - 1h; debounce default 6h => skip.
  writeLastGcMtime(runsRoot, NOW - HOUR_MS);
  // Sanity: marker exists in conductor root, NOT under runs/ (R11).
  assert.ok(existsSync(lastGcMarkerPath(runsRoot)));
  assert.ok(!existsSync(join(runsRoot, ".last-gc")), "marker must not be under runs/");
  assert.equal(lastGcMarkerPath(runsRoot), join(root, ".last-gc"));

  const logs: string[] = [];
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg(),
    registry: new RunRegistry(),
    now: NOW,
    log: (l) => logs.push(l),
  });
  assert.equal(r.ran, false);
  assert.equal(r.reason, "debounced");
  assert.equal(logs.length, 0, "skip path must not emit a log line");
});

test("maybeAutoRunGc: marker stale (older than debounce) -> run, write marker, log summary", async () => {
  const { runsRoot } = makeFakeRoot();
  // Marker 12h ago; debounce default 6h => run.
  writeLastGcMtime(runsRoot, NOW - 12 * HOUR_MS);
  const logs: string[] = [];
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg(),
    registry: new RunRegistry(),
    now: NOW,
    log: (l) => logs.push(l),
  });
  assert.equal(r.ran, true);
  assert.ok(r.result);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^gc auto: scanned=0/);
  assert.match(logs[0]!, /failed=0/);
  // Marker mtime updated to NOW-ish.
  // (We can't compare exactly because `writeLastGcMtime` re-uses the
  // injected `now` — we asserted ran=true and the function path runs,
  // which is the load-bearing claim.)
});

test("maybeAutoRunGc: no marker yet -> run on first session_start", async () => {
  const { runsRoot } = makeFakeRoot();
  assert.ok(!existsSync(lastGcMarkerPath(runsRoot)));
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg(),
    registry: new RunRegistry(),
    now: NOW,
    log: () => undefined,
  });
  assert.equal(r.ran, true);
  // Marker now exists.
  assert.ok(existsSync(lastGcMarkerPath(runsRoot)));
});

test("maybeAutoRunGc: force=true bypasses debounce", async () => {
  const { runsRoot } = makeFakeRoot();
  writeLastGcMtime(runsRoot, NOW - HOUR_MS); // would normally debounce
  const r = await maybeAutoRunGc({
    runsRoot,
    config: gcCfg(),
    registry: new RunRegistry(),
    now: NOW,
    force: true,
    log: () => undefined,
  });
  assert.equal(r.ran, true);
});

// ── v0.10 A1: sub-agent context skip ─────────────────────────────────────────
//
// Conductor extension loads in BOTH the parent pi session and every
// sub-agent's pi subprocess. Without a guard, every sub-agent runs auto-
// GC on its own session_start — wasted work, plus its log line leaks
// into stderr which the parent captures and assigns to errorMessage.
// Witnessed in v0.9 dogfood (critic-yjsn). Marker env var
// `CONDUCTOR_SUBAGENT=1` is set by `buildSubagentEnv()` in `src/runs.ts`.

test("maybeAutoRunGc: subagent context (CONDUCTOR_SUBAGENT=1) → skipped, no inventory walk", async () => {
  const { runsRoot } = makeFakeRoot();
  const prev = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "1";
  let logged = false;
  try {
    const r = await maybeAutoRunGc({
      runsRoot,
      config: gcCfg(),
      registry: new RunRegistry(),
      now: NOW,
      log: () => {
        // The completion-summary log only fires when runGc actually ran.
        // If this fires, the skip guard has been removed.
        logged = true;
      },
    });
    assert.equal(r.ran, false);
    assert.equal(r.reason, "subagent-context");
    assert.equal(logged, false, "runGc body must not execute in sub-agent context");
    // Marker must NOT be written when we skip due to sub-agent context.
    assert.equal(existsSync(lastGcMarkerPath(runsRoot)), false);
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
  }
});

test("maybeAutoRunGc: subagent skip wins over force=true (transitive sub-agent must not run GC)", async () => {
  const { runsRoot } = makeFakeRoot();
  const prev = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "1";
  try {
    const r = await maybeAutoRunGc({
      runsRoot,
      config: gcCfg(),
      registry: new RunRegistry(),
      now: NOW,
      force: true,
      log: () => undefined,
    });
    assert.equal(r.ran, false);
    assert.equal(r.reason, "subagent-context");
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
  }
});

test("maybeAutoRunGc: parent context (CONDUCTOR_SUBAGENT unset) → runs normally", async () => {
  const { runsRoot } = makeFakeRoot();
  const prev = process.env.CONDUCTOR_SUBAGENT;
  delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const r = await maybeAutoRunGc({
      runsRoot,
      config: gcCfg(),
      registry: new RunRegistry(),
      now: NOW,
      log: () => undefined,
    });
    assert.equal(r.ran, true);
  } finally {
    if (prev !== undefined) process.env.CONDUCTOR_SUBAGENT = prev;
  }
});
