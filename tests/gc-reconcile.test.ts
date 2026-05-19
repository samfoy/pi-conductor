/**
 * pi-conductor — GC orphan reconciler tests.
 *
 * Spec: docs/v0.9-gc-design.md D5 / A1; docs/v0.9-gc-plan.md "Slice 2".
 *
 * Effectful (touches a tmpdir runs root via mkdtempSync) but no clock —
 * `now` is injected. Verifies the on-disk side effect of orphan
 * reconciliation actions emitted by the policy engine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { reconcileOrphans } from "../src/gc/reconcile.ts";
import type { ReclaimAction } from "../src/gc/policy.ts";
import type { RunRecord } from "../src/types.ts";

const NOW = 1_750_000_000_000;

interface Layout {
  runsRoot: string;
  cleanup: () => void;
}

function makeLayout(): Layout {
  const runsRoot = mkdtempSync(join(tmpdir(), "pi-conductor-reconcile-"));
  return {
    runsRoot,
    cleanup: () => rmSync(runsRoot, { recursive: true, force: true }),
  };
}

function writeRecordFile(runsRoot: string, id: string, record: Partial<RunRecord> & { id: string; status: RunRecord["status"] }): string {
  const dir = join(runsRoot, id);
  mkdirSync(dir, { recursive: true });
  const full: RunRecord = {
    id: record.id,
    persona: record.persona ?? "inspector",
    task: record.task ?? "noop",
    mode: record.mode ?? "background",
    status: record.status,
    startTime: record.startTime ?? NOW - 86_400_000,
    finishedAt: record.finishedAt,
    pausedAt: record.pausedAt,
    exitCode: record.exitCode,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    usage: record.usage ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    cwd: record.cwd ?? "/tmp",
    recordPath: record.recordPath ?? join(dir, "record.json"),
    transcriptPath: record.transcriptPath ?? join(dir, "transcript.jsonl"),
    finalPath: record.finalPath ?? join(dir, "final.md"),
    sessionPath: record.sessionPath,
  };
  const path = join(dir, "record.json");
  writeFileSync(path, JSON.stringify(full, null, 2));
  return path;
}

function readRec(path: string): RunRecord {
  return JSON.parse(readFileSync(path, "utf-8")) as RunRecord;
}

// ────────────────────────────────────────────────────────────────────
// Single orphan
// ────────────────────────────────────────────────────────────────────

test("reconcileOrphans: single orphan action flips record to killed with marker errorMessage", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const id = "stale-aaaa";
    const path = writeRecordFile(runsRoot, id, { id, status: "running" });
    const actions: ReclaimAction[] = [
      { kind: "reconcile-orphan", id, reason: "orphaned: process gone" },
    ];

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.reconciled, [id]);

    const rec = readRec(path);
    assert.equal(rec.status, "killed");
    assert.equal(rec.finishedAt, NOW);
    assert.match(rec.errorMessage ?? "", /orphaned: process gone \(reconciled by GC\)/);
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// Multiple orphans
// ────────────────────────────────────────────────────────────────────

test("reconcileOrphans: multiple orphan actions all reconciled in one pass", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const ids = ["stale-bbbb", "stale-cccc", "stale-dddd"];
    const paths = ids.map((id) => writeRecordFile(runsRoot, id, { id, status: "running" }));
    const actions: ReclaimAction[] = ids.map((id) => ({
      kind: "reconcile-orphan",
      id,
      reason: "orphaned: process gone",
    }));

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    assert.deepEqual(result.failed, []);
    assert.deepEqual([...result.reconciled].sort(), [...ids].sort());

    for (const path of paths) {
      const rec = readRec(path);
      assert.equal(rec.status, "killed");
      assert.equal(rec.finishedAt, NOW);
    }
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// Race: record was deleted between plan and execute
// ────────────────────────────────────────────────────────────────────

test("reconcileOrphans: missing record dir is silently skipped (race with another reclaimer)", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const actions: ReclaimAction[] = [
      { kind: "reconcile-orphan", id: "nonexistent-eeee", reason: "orphaned: process gone" },
    ];

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    // The race is OK: not an error. Just skipped from `reconciled`.
    assert.deepEqual(result.reconciled, []);
    assert.deepEqual(result.failed, []);
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// Already-not-running (someone else updated it; idempotent re-run)
// ────────────────────────────────────────────────────────────────────

test("reconcileOrphans: defensive check skips records already not in running state", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const id = "already-killed-ffff";
    const path = writeRecordFile(runsRoot, id, {
      id,
      status: "killed",
      errorMessage: "explicitly killed by user",
      finishedAt: NOW - 60_000,
    });
    const actions: ReclaimAction[] = [
      { kind: "reconcile-orphan", id, reason: "orphaned: process gone" },
    ];

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    // Skipped from `reconciled` because the defensive check saw status !== "running".
    assert.deepEqual(result.reconciled, []);
    assert.deepEqual(result.failed, []);

    // The pre-existing record fields must be preserved (idempotent / no clobber).
    const rec = readRec(path);
    assert.equal(rec.status, "killed");
    assert.equal(rec.errorMessage, "explicitly killed by user");
    assert.equal(rec.finishedAt, NOW - 60_000);
  } finally {
    cleanup();
  }
});

test("reconcileOrphans: ignores non-orphan actions in the input list", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const id = "stale-gggg";
    const path = writeRecordFile(runsRoot, id, { id, status: "running" });
    const actions: ReclaimAction[] = [
      { kind: "keep", id: "kept-xxxx", reason: "active" },
      { kind: "delete", id: "del-yyyy", reason: "ttl", bytesReclaimed: 0, losesResume: false },
      { kind: "cold-archive", id: "arch-zzzz", reason: "cap", bytesReclaimed: 0 },
      { kind: "reconcile-orphan", id, reason: "orphaned" },
    ];

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    assert.deepEqual(result.reconciled, [id]);
    const rec = readRec(path);
    assert.equal(rec.status, "killed");
  } finally {
    cleanup();
  }
});

test("reconcileOrphans: malformed record.json is reported in failed", async () => {
  const { runsRoot, cleanup } = makeLayout();
  try {
    const id = "broken-hhhh";
    const dir = join(runsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "record.json"), "{not valid json");
    const actions: ReclaimAction[] = [
      { kind: "reconcile-orphan", id, reason: "orphaned" },
    ];

    const result = await reconcileOrphans(actions, runsRoot, NOW);

    assert.deepEqual(result.reconciled, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.agentId, id);
    // Record file still exists; we did not delete or clobber it.
    assert.equal(existsSync(join(dir, "record.json")), true);
  } finally {
    cleanup();
  }
});
