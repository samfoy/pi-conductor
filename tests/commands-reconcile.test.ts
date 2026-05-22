/**
 * Tests for the /conductor reconcile slash subcommand (v0.9.x slice 4).
 *
 * Drives `runReconcileCmd` directly with a mock `ExtensionCommandContext`
 * that captures notify calls. `process.env.HOME` is redirected so
 * `runsRoot()` lands inside an mkdtempSync fixture. Mirrors the pattern
 * in `tests/commands-gc.test.ts`.
 *
 * Spec: docs/v0.9.x-post-startup-reconcile-design.md §6.
 *
 * Two surfaces under test:
 *   1. `runReconcileCmd` — slash command happy path with and without
 *      --dry-run, ensuring on-disk record is mutated only when not
 *      dry-run.
 *   2. `buildReconcileReport` — pure renderer used by both the doctor
 *      surface and the slash command, tested separately in doctor.test
 *      via the lastReconcile field.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReconcileCmd } from "../src/commands.ts";
import { runsRoot, RunRegistry } from "../src/runs.ts";
import { emptyUsage, type RunRecord } from "../src/types.ts";

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
  runsDir: string;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-reconcile-cmd-test-"));
  const homeDir = join(root, "home");
  const runsDir = join(homeDir, ".pi", "agent", "conductor", "runs");
  mkdirSync(runsDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, realHome, runsDir };
}

function teardown(fx: Fx): Promise<void> {
  if (fx.realHome !== undefined) process.env.HOME = fx.realHome;
  else delete process.env.HOME;
  return rm(fx.root, { recursive: true, force: true });
}

/**
 * Build a `running`-status record with a deliberately-dead pid so the
 * default liveness probe (kill(pid, 0)) classifies it as orphaned.
 * Pid 2147483647 is the kernel max — no process owns it.
 */
function makeOrphanRecord(fx: Fx, id: string): void {
  const runDir = join(fx.runsDir, id);
  mkdirSync(runDir, { recursive: true });
  const record: RunRecord = {
    id,
    persona: "builder",
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now() - 60_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runDir, "record.json"),
    transcriptPath: join(runDir, "transcript.jsonl"),
    finalPath: join(runDir, "final.md"),
    pid: 2_147_483_647,
  };
  writeFileSync(record.recordPath, JSON.stringify(record));
}

function ctxOpts(_fx: Fx) {
  return {
    getCwd: () => "/tmp",
    getRegistry: () => new RunRegistry(),
  };
}

test("runReconcileCmd: default (no flags) reclassifies orphans and prints summary", async () => {
  const fx = setup();
  try {
    assert.equal(runsRoot(), fx.runsDir);
    makeOrphanRecord(fx, "builder-orph1");

    const ctx = mockCtx();
    await runReconcileCmd(ctxOpts(fx), ctx as unknown as Parameters<typeof runReconcileCmd>[1], "");

    // One notify, info level, with the reconcile section header.
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0]!.level, "info");
    const out = ctx.calls[0]!.message;
    assert.match(out, /Post-startup reconcile/i);
    assert.match(out, /scanned\s*[:=]?\s*1/);
    assert.match(out, /reclassified\s*[:=]?\s*1/);

    // On-disk record was mutated to status=killed with orphan errorMessage.
    const updated = JSON.parse(
      readFileSync(join(fx.runsDir, "builder-orph1", "record.json"), "utf-8"),
    ) as RunRecord;
    assert.equal(updated.status, "killed");
    assert.match(updated.errorMessage ?? "", /^orphaned:/);
  } finally {
    await teardown(fx);
  }
});

test("runReconcileCmd: --dry-run reports same shape but does NOT mutate disk", async () => {
  const fx = setup();
  try {
    makeOrphanRecord(fx, "builder-orph2");

    const ctx = mockCtx();
    await runReconcileCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runReconcileCmd>[1],
      "--dry-run",
    );

    assert.equal(ctx.calls.length, 1);
    const out = ctx.calls[0]!.message;
    assert.match(out, /dry/i); // banner names dry-run mode
    assert.match(out, /reclassified\s*[:=]?\s*1/);

    // On-disk record was NOT mutated.
    const after = JSON.parse(
      readFileSync(join(fx.runsDir, "builder-orph2", "record.json"), "utf-8"),
    ) as RunRecord;
    assert.equal(after.status, "running");
    assert.equal(after.errorMessage, undefined);
  } finally {
    await teardown(fx);
  }
});

test("runReconcileCmd: --help prints usage and does not run reconcile", async () => {
  const fx = setup();
  try {
    makeOrphanRecord(fx, "builder-orph3");

    const ctx = mockCtx();
    await runReconcileCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runReconcileCmd>[1],
      "--help",
    );
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /reconcile/i);
    assert.match(ctx.calls[0]!.message, /--dry-run/);

    // Help must not mutate disk.
    const after = JSON.parse(
      readFileSync(join(fx.runsDir, "builder-orph3", "record.json"), "utf-8"),
    ) as RunRecord;
    assert.equal(after.status, "running");
  } finally {
    await teardown(fx);
  }
});

test("runReconcileCmd: unknown flag emits warning, does not run reconcile", async () => {
  const fx = setup();
  try {
    makeOrphanRecord(fx, "builder-orph4");

    const ctx = mockCtx();
    await runReconcileCmd(
      ctxOpts(fx),
      ctx as unknown as Parameters<typeof runReconcileCmd>[1],
      "--bogus",
    );
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0]!.level, "warning");
    assert.match(ctx.calls[0]!.message, /unknown flag/);

    const after = JSON.parse(
      readFileSync(join(fx.runsDir, "builder-orph4", "record.json"), "utf-8"),
    ) as RunRecord;
    assert.equal(after.status, "running");
  } finally {
    await teardown(fx);
  }
});
