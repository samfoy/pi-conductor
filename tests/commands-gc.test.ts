/**
 * Tests for the /conductor gc slash subcommand (Slice 6).
 *
 * Drives `runGcCmd` directly with a mock `ExtensionCommandContext` that
 * captures notify calls. `process.env.HOME` is redirected so `runsRoot()`
 * lands inside an mkdtempSync fixture. Mirrors the pattern in
 * `tests/commands-pin.test.ts`.
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 6"; oracle amendment A3 (dry-run
 * output must include `bytes_to_reclaim`, `runs_to_archive`,
 * `runs_to_delete`, `runs_lose_resume`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGcCmd } from "../src/commands.ts";
import { runsRoot, RunRegistry } from "../src/runs.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run, type RunRecord } from "../src/types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface NotifyCall {
  message: string;
  level: string;
}

interface MockCtx {
  ui: {
    notify: (msg: string, level?: string) => void;
  };
  calls: NotifyCall[];
}

function mockCtx(): MockCtx {
  const calls: NotifyCall[] = [];
  return {
    ui: {
      notify: (message: string, level?: string) => {
        calls.push({ message, level: level ?? "info" });
      },
    },
    calls,
  };
}

interface Fx {
  root: string;
  homeDir: string;
  realHome: string | undefined;
  conductorRoot: string; // <home>/.pi/agent/conductor (where .last-gc lands)
  runsDir: string; // <conductorRoot>/runs
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-gc-cmd-test-"));
  const homeDir = join(root, "home");
  const conductorRoot = join(homeDir, ".pi", "agent", "conductor");
  const runsDir = join(conductorRoot, "runs");
  mkdirSync(runsDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, realHome, conductorRoot, runsDir };
}

function teardown(fx: Fx): Promise<void> {
  if (fx.realHome !== undefined) process.env.HOME = fx.realHome;
  else delete process.env.HOME;
  return rm(fx.root, { recursive: true, force: true });
}

interface RunDirOpts {
  persona?: string;
  status?: RunRecord["status"];
  finishedMsAgo?: number;
  withTranscriptBytes?: number;
  withSession?: boolean;
  withArchived?: boolean;
}

function makeRunDir(fx: Fx, id: string, opts: RunDirOpts = {}): void {
  const now = Date.now();
  const runDir = join(fx.runsDir, id);
  mkdirSync(runDir, { recursive: true });
  const persona = opts.persona ?? "inspector";
  const status: RunRecord["status"] = opts.status ?? "completed";
  const finishedAgo = opts.finishedMsAgo ?? 1_000;
  const record: RunRecord = {
    id,
    persona,
    task: "test",
    mode: "background",
    status,
    startTime: now - 2 * finishedAgo,
    finishedAt: status === "running" ? undefined : now - finishedAgo,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runDir, "record.json"),
    transcriptPath: join(runDir, "transcript.jsonl"),
    finalPath: join(runDir, "final.md"),
  };
  writeFileSync(record.recordPath, JSON.stringify(record));
  if (opts.finishedMsAgo !== undefined || status === "running") {
    const mtime = new Date(now - finishedAgo);
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
  if (opts.withArchived) {
    const apath = join(runDir, ".archived");
    writeFileSync(apath, "");
    const mtime = new Date(now - finishedAgo);
    utimesSync(apath, mtime, mtime);
  }
}

function ctxOpts(fx: Fx) {
  return {
    getCwd: () => fx.root,
    getRegistry: () => new RunRegistry(),
  };
}

test("runGcCmd: default (no flags) runs and prints summary", async () => {
  const fx = setup();
  try {
    assert.equal(runsRoot(), fx.runsDir);
    makeRunDir(fx, "inspector-fresh", { finishedMsAgo: 1_000 });
    const ctx = mockCtx();
    await runGcCmd(ctxOpts(fx), ctx as unknown as Parameters<typeof runGcCmd>[1], "");
    assert.ok(ctx.calls.length >= 1, "should notify at least once");
    const text = ctx.calls.map((c) => c.message).join("\n");
    assert.match(text, /GC plan/i, "summary header present");
    // Fresh run should be kept.
    assert.match(text, /keep:\s*1/i, "keep count present");
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --dry-run output includes A3 four totals AND a fresh inventory is untouched", async () => {
  const fx = setup();
  try {
    // One huge unarchived transcript -> cold-archive plan; one ancient
    // archived run -> delete plan with sessionPathPresent.
    makeRunDir(fx, "designer-big", {
      persona: "designer",
      finishedMsAgo: 1_000,
      withTranscriptBytes: 200 * 1024 * 1024, // 200 MB > 100 MB cap
    });
    makeRunDir(fx, "planner-old", {
      persona: "planner",
      finishedMsAgo: 31 * DAY_MS,
      withTranscriptBytes: 0,
      withArchived: true,
      withSession: true, // counts toward runsLoseResume
    });

    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--dry-run",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    // A3: all four totals must appear, by name or close synonym.
    assert.match(text, /bytes_to_reclaim/i);
    assert.match(text, /runs_to_archive/i);
    assert.match(text, /runs_to_delete/i);
    assert.match(text, /runs_lose_resume/i);
    // Dry-run side effect: the big designer run is still untouched on disk.
    assert.equal(existsSync(join(fx.runsDir, "designer-big", "transcript.jsonl")), true);
    assert.equal(existsSync(join(fx.runsDir, "planner-old", "record.json")), true);
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --persona=designer scopes inventory to designer-prefixed runs only", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "designer-keep", { persona: "designer", finishedMsAgo: 1_000 });
    makeRunDir(fx, "planner-keep", { persona: "planner", finishedMsAgo: 1_000 });
    makeRunDir(fx, "inspector-keep", { persona: "inspector", finishedMsAgo: 1_000 });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--dry-run --persona=designer",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    // scanned should be 1 (only designer).
    assert.match(text, /scanned[^0-9]*1\b|n=1\b/i, "scanned count is 1");
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --persona=unknown scopes to zero entries", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "designer-x", { persona: "designer", finishedMsAgo: 1_000 });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--dry-run --persona=zzznope",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    assert.match(text, /scanned[^0-9]*0\b|n=0\b/i, "scanned count is 0");
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --verbose includes per-action lines", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "designer-big", {
      persona: "designer",
      finishedMsAgo: 1_000,
      withTranscriptBytes: 200 * 1024 * 1024,
    });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--dry-run --verbose",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    // Per-action line should mention the agent id.
    assert.match(text, /designer-big/);
    // Verbose marker — section heading "Per-action" or similar.
    assert.match(text, /Per-action/i);
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: non-verbose default omits per-action lines", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "designer-big", {
      persona: "designer",
      finishedMsAgo: 1_000,
      withTranscriptBytes: 200 * 1024 * 1024,
    });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--dry-run",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    assert.doesNotMatch(text, /Per-action/i);
    // Run id should NOT appear without --verbose.
    assert.doesNotMatch(text, /designer-big/);
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --force is accepted (manual gc never debounces; documented no-op)", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "inspector-x", { finishedMsAgo: 1_000 });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--force --dry-run",
    );
    // Should produce a normal plan output, not a flag error.
    const text = ctx.calls.map((c) => c.message).join("\n");
    assert.match(text, /GC plan/i);
    assert.doesNotMatch(text, /unknown flag/i);
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --bogus surfaces a helpful error notify", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--bogus",
    );
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /unknown flag/i);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --persona without value surfaces a helpful error", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--persona=",
    );
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /persona/i);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runGcCmd: --help prints flag listing without running gc", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "designer-big", {
      persona: "designer",
      finishedMsAgo: 1_000,
      withTranscriptBytes: 200 * 1024 * 1024,
    });
    const ctx = mockCtx();
    await runGcCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runGcCmd>[1],
      "--help",
    );
    const text = ctx.calls.map((c) => c.message).join("\n");
    assert.match(text, /--dry-run/);
    assert.match(text, /--persona/);
    assert.match(text, /--verbose/);
    // --help should NOT execute gc — the big transcript stays put.
    assert.equal(
      existsSync(join(fx.runsDir, "designer-big", "transcript.jsonl")),
      true,
    );
    // And dry-run/A3 totals shouldn't be in --help output.
    assert.doesNotMatch(text, /bytes_to_reclaim/i);
  } finally {
    await teardown(fx);
  }
});

// ── runGc API: persona filter ─────────────────────────────────────────

test("runGc: persona filter scopes inventory entries by record.persona", async () => {
  const { runGc } = await import("../src/gc/index.ts");
  const fx = setup();
  try {
    makeRunDir(fx, "designer-1", { persona: "designer", finishedMsAgo: 1_000 });
    makeRunDir(fx, "planner-1", { persona: "planner", finishedMsAgo: 1_000 });
    makeRunDir(fx, "designer-2", { persona: "designer", finishedMsAgo: 1_000 });

    const r = await runGc({
      runsRoot: fx.runsDir,
      config: DEFAULT_CONFIG.gc,
      registry: new RunRegistry(),
      persona: "designer",
      dryRun: true,
    });
    assert.equal(r.scanned, 2, "only the two designer runs are scanned");
  } finally {
    await teardown(fx);
  }
});

test("runGc: persona filter with unknown persona returns empty result", async () => {
  const { runGc } = await import("../src/gc/index.ts");
  const fx = setup();
  try {
    makeRunDir(fx, "designer-1", { persona: "designer", finishedMsAgo: 1_000 });
    const r = await runGc({
      runsRoot: fx.runsDir,
      config: DEFAULT_CONFIG.gc,
      registry: new RunRegistry(),
      persona: "no-such-persona",
      dryRun: true,
    });
    assert.equal(r.scanned, 0);
    assert.deepEqual(r.planSummary, { archive: 0, delete: 0, reconcile: 0, keep: 0 });
  } finally {
    await teardown(fx);
  }
});

// ── Slash dispatch regression (W1 witness for case "gc" arm) ──────────
//
// Drives `registerCommands` end-to-end through a captured handler.
// Pre-existing v0.9 bug: `gc` was in SUBCOMMANDS + GC_HELP_TEXT but
// missing from the dispatch switch, so users typing `/conductor gc`
// fell through to the "unknown subcommand" path. This test pins the
// case arm: `/conductor gc --help` must reach `runGcCmd` (which prints
// GC_HELP_TEXT) and NOT the default unknown-subcommand notify.
//
// Mutation witness: removing the `case "gc":` arm in src/commands.ts
// causes the handler to dispatch to default → notify says
// "unknown subcommand: gc" → the GC_HELP_TEXT match fails. Verified
// via `git stash` per docs/wdd.md.
import { registerCommands } from "../src/commands.ts";
import { SpawnQueue } from "../src/queue.ts";

test("slash /conductor gc --help reaches runGcCmd (W1 witness)", async () => {
  const fx = setup();
  try {
    const calls: NotifyCall[] = [];
    let captured: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const fakePi = {
      registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        if (name === "conductor") captured = spec.handler;
      },
    } as unknown as Parameters<typeof registerCommands>[0];
    const opts = {
      getCwd: () => fx.root,
      getRegistry: () => new RunRegistry(),
      getQueue: () => new SpawnQueue(new RunRegistry(), 4),
      getConductorMode: () => false,
      setConductorMode: () => {},
      openFocusedOverlay: () => {},
    } as unknown as Parameters<typeof registerCommands>[1];
    registerCommands(fakePi, opts);
    assert.ok(captured, "registerCommand(\"conductor\", ...) was called");
    const ctx = {
      ui: { notify: (msg: string, level?: string) => { calls.push({ message: msg, level: level ?? "info" }); } },
    };
    await captured!("gc --help", ctx);
    const text = calls.map((c) => c.message).join("\n");
    // Reaching runGcCmd → GC_HELP_TEXT printed.
    assert.match(text, /\/conductor gc \[flags\]/, "GC_HELP_TEXT header must appear");
    assert.match(text, /--dry-run/, "GC_HELP_TEXT body must appear");
    // Not the unknown-subcommand fallthrough.
    assert.doesNotMatch(text, /unknown subcommand/i, "must NOT fall through to default");
  } finally {
    await teardown(fx);
  }
});
