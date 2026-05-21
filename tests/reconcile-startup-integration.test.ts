/**
 * v0.9.x post-startup reconcile — slice 2 fs-scanner + integration witnesses.
 *
 * Tests for `reconcileOrphansAtStartup` from `src/reconcile-startup.ts`.
 * Walks ephemeral `mkdtempSync` runs/ fixtures, drives the scanner with
 * a stubbed `RunRegistry` and a stubbed `isAlive` oracle, asserts the
 * `PostStartupReconcileResult` shape and on-disk record mutations.
 *
 * WDD witnesses pinned in `docs/v0.9.x-post-startup-reconcile-design.md`
 * §7 slice 2 table:
 *   W1 — readopted orphans land in registry
 *   W2 — reclassified records persist to disk
 *   W3 — reclassified records carry orphan errorMessage
 *   W4 — reconcile is idempotent over a populated registry
 *   W5 — orphans without sessionPath land in unresumable list
 *   W6 — malformed record.json doesn't break reconcile
 *
 * Real-subprocess discipline: NO real children spawn from these tests.
 * `isAlive` is always stubbed to a deterministic boolean. The classifier
 * + liveness-probe witnesses live in `reconcile-startup-classifier.test.ts`
 * (slice 1).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileOrphansAtStartup,
  type PostStartupReconcileDeps,
  type PostStartupReconcileResult,
  type RegistryLike,
} from "../src/reconcile-startup.ts";
import type { Run, RunRecord, RunStatus } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// ── Test helpers ──────────────────────────────────────────────────────

/**
 * Minimal in-memory registry that satisfies the `RegistryLike` shape
 * the scanner consumes. Production uses `RunRegistry`; tests use this
 * so we don't drag the full class into fixtures.
 */
function makeStubRegistry(): RegistryLike & { runs: Map<string, Run> } {
  const runs = new Map<string, Run>();
  return {
    runs,
    has: (id: string) => runs.has(id),
    register: (run: Run) => {
      runs.set(run.id, run);
    },
    get: (id: string) => runs.get(id),
  };
}

interface FixtureRecordOpts {
  id: string;
  status: RunStatus | "queued";
  pid?: number;
  /** When provided, also creates `runs/<id>/session/seeded.jsonl` and points sessionPath at it. */
  withSessionFile?: boolean;
  /** When set, points sessionPath at a path that does NOT exist. */
  brokenSessionPath?: string;
  /** When true, writes `record.json` as malformed JSON (`{`). */
  corrupt?: boolean;
  extra?: Partial<RunRecord>;
}

interface Fixture {
  runsRoot: string;
  ids: string[];
  cleanup: () => void;
}

function makeFixture(records: FixtureRecordOpts[]): Fixture {
  const runsRoot = mkdtempSync(join(tmpdir(), "reconcile-startup-slice2-"));
  const ids: string[] = [];

  for (const opts of records) {
    const dir = join(runsRoot, opts.id);
    mkdirSync(dir, { recursive: true });
    ids.push(opts.id);

    if (opts.corrupt) {
      writeFileSync(join(dir, "record.json"), "{ this is not json");
      continue;
    }

    let sessionPath: string | undefined;
    if (opts.withSessionFile) {
      const sessionDir = join(dir, "session");
      mkdirSync(sessionDir, { recursive: true });
      sessionPath = join(sessionDir, "seeded.jsonl");
      writeFileSync(sessionPath, '{"type":"session"}\n');
    } else if (opts.brokenSessionPath) {
      sessionPath = opts.brokenSessionPath;
    }

    const record: RunRecord = {
      id: opts.id,
      persona: "builder",
      task: "fixture",
      mode: "background",
      status: opts.status as RunStatus,
      startTime: 1_000,
      pid: opts.pid,
      usage: emptyUsage(),
      cwd: "/tmp",
      recordPath: join(dir, "record.json"),
      transcriptPath: join(dir, "transcript.jsonl"),
      finalPath: join(dir, "final.md"),
      sessionPath,
      ...opts.extra,
    };

    writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 2));
  }

  return {
    runsRoot,
    ids,
    cleanup: () => rmSync(runsRoot, { recursive: true, force: true }),
  };
}

function readRecord(runsRoot: string, id: string): RunRecord {
  return JSON.parse(readFileSync(join(runsRoot, id, "record.json"), "utf-8"));
}

function makeDeps(
  fx: Fixture,
  registry: RegistryLike,
  isAlive: (pid: number) => boolean = () => false,
  now = 2_000,
): PostStartupReconcileDeps {
  return {
    runsRoot: fx.runsRoot,
    registry,
    isAlive,
    now,
  };
}

// ── W1 ────────────────────────────────────────────────────────────────

test(
  "W1 readopted orphans land in registry as running with proc undefined",
  async () => {
    const fx = makeFixture([
      { id: "builder-alive", status: "running", pid: 99999, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => true);
      const result = await reconcileOrphansAtStartup(deps);
      assert.deepEqual(result.readopted, ["builder-alive"]);
      const run = reg.get("builder-alive");
      assert.ok(run, "registry should have the readopted run");
      assert.equal(run!.status, "running");
      assert.equal(run!.proc, undefined, "re-adopted runs have no proc handle");
      assert.equal(run!.pid, 99999, "pid carries from disk");
    } finally {
      fx.cleanup();
    }
  },
);

// ── W2 ────────────────────────────────────────────────────────────────

test(
  "W2 reclassified records persist status=killed to disk",
  async () => {
    const fx = makeFixture([
      { id: "builder-dead", status: "running", pid: 12345, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => false);
      const result = await reconcileOrphansAtStartup(deps);
      assert.deepEqual(result.reclassified, ["builder-dead"]);
      const onDisk = readRecord(fx.runsRoot, "builder-dead");
      assert.equal(onDisk.status, "killed");
      assert.equal(typeof onDisk.finishedAt, "number");
    } finally {
      fx.cleanup();
    }
  },
);

// ── W3 ────────────────────────────────────────────────────────────────

test(
  "W3 reclassified records carry orphaned: errorMessage prefix",
  async () => {
    const fx = makeFixture([
      { id: "critic-dead", status: "running", pid: 12345, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => false);
      await reconcileOrphansAtStartup(deps);
      const onDisk = readRecord(fx.runsRoot, "critic-dead");
      assert.ok(
        onDisk.errorMessage?.startsWith("orphaned:"),
        `errorMessage should start with "orphaned:", got: ${onDisk.errorMessage}`,
      );
      assert.match(
        onDisk.errorMessage!,
        /process gone/,
        "process-gone variant should mention 'process gone'",
      );
    } finally {
      fx.cleanup();
    }
  },
);

// ── W4 ────────────────────────────────────────────────────────────────

test(
  "W4 reconcile is idempotent over a populated registry",
  async () => {
    const fx = makeFixture([
      { id: "builder-loop", status: "running", pid: 99999, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      // Pre-register an entry that mimics what the prior reconcile pass
      // (or live spawn) would have placed in the registry.
      const stubRun: Run = {
        id: "builder-loop",
        persona: "builder",
        task: "stub",
        mode: "background",
        status: "running",
        startTime: 1_000,
        lastEventAt: 1_000,
        messages: [],
        usage: emptyUsage(),
        cwd: "/tmp",
        recordPath: join(fx.runsRoot, "builder-loop", "record.json"),
        transcriptPath: join(fx.runsRoot, "builder-loop", "transcript.jsonl"),
        finalPath: join(fx.runsRoot, "builder-loop", "final.md"),
      };
      reg.register(stubRun);
      const deps = makeDeps(fx, reg, () => true);
      const r1 = await reconcileOrphansAtStartup(deps);
      const r2 = await reconcileOrphansAtStartup(deps);
      // Re-register over a stub-already-present id is a no-op:
      // neither result should claim the orphan as readopted.
      assert.equal(r1.readopted.includes("builder-loop"), false, "first pass: id already in registry → skip");
      assert.equal(r2.readopted.includes("builder-loop"), false, "second pass: still skip");
      assert.equal(r1.errors.length, 0, "no errors on first pass");
      assert.equal(r2.errors.length, 0, "no errors on second pass");
      // Original stub still in place.
      assert.equal(reg.get("builder-loop")!.task, "stub", "registry entry not overwritten");
    } finally {
      fx.cleanup();
    }
  },
);

// ── W5 ────────────────────────────────────────────────────────────────

test(
  "W5 orphans without sessionPath land in unresumable list",
  async () => {
    const fx = makeFixture([
      // Dead orphan whose sessionPath points to a missing file.
      {
        id: "oracle-orphan",
        status: "running",
        pid: 12345,
        brokenSessionPath: "/tmp/this-file-definitely-does-not-exist-1234",
      },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => false);
      const result = await reconcileOrphansAtStartup(deps);
      assert.ok(
        result.unresumable.includes("oracle-orphan"),
        `unresumable should include oracle-orphan, got ${JSON.stringify(result.unresumable)}`,
      );
      // Still got reclassified on disk:
      assert.equal(readRecord(fx.runsRoot, "oracle-orphan").status, "killed");
    } finally {
      fx.cleanup();
    }
  },
);

// ── W6 ────────────────────────────────────────────────────────────────

test(
  "W6 malformed record.json doesn't break reconcile",
  async () => {
    const fx = makeFixture([
      { id: "corrupt-1", status: "running", corrupt: true },
      { id: "valid-2", status: "running", pid: 99999, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => true);
      const result = await reconcileOrphansAtStartup(deps);
      assert.equal(result.errors.length, 1, "corrupt record surfaces in errors[]");
      assert.equal(result.errors[0].id, "corrupt-1");
      assert.match(
        result.errors[0].message,
        /^JSON parse error:/,
        "error message should be the formatted 'JSON parse error:' prefix from the per-record JSON.parse try/catch — if this fails, the inner try/catch was dropped and the outer catch-all is rendering raw V8 syntax errors instead",
      );
      // Valid record processed despite corrupt sibling:
      assert.deepEqual(result.readopted, ["valid-2"]);
      assert.ok(reg.get("valid-2"));
    } finally {
      fx.cleanup();
    }
  },
);

// ── Coverage helpers — exhaustive transitions ─────────────────────────

test(
  "reconcile: queued orphan flips to failed with orphaned: prefix",
  async () => {
    const fx = makeFixture([
      { id: "queued-orphan", status: "queued", pid: undefined },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => false);
      const result = await reconcileOrphansAtStartup(deps);
      assert.ok(result.reclassified.includes("queued-orphan"));
      const onDisk = readRecord(fx.runsRoot, "queued-orphan");
      assert.equal(onDisk.status, "failed");
      assert.match(onDisk.errorMessage!, /^orphaned:.*queue/);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "reconcile: pre-pid-schema record flips to killed with orphaned: prefix",
  async () => {
    const fx = makeFixture([
      { id: "old-record", status: "running", pid: undefined, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => true);
      const result = await reconcileOrphansAtStartup(deps);
      assert.ok(result.preSchema.includes("old-record"));
      const onDisk = readRecord(fx.runsRoot, "old-record");
      assert.equal(onDisk.status, "killed");
      assert.match(onDisk.errorMessage!, /^orphaned:.*pre-pid-schema/);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "reconcile: terminal records are skipped (no registry mutation, no disk write)",
  async () => {
    const fx = makeFixture([
      { id: "completed-old", status: "completed", pid: 1, withSessionFile: true },
      { id: "killed-old", status: "killed", pid: 2, withSessionFile: true },
      { id: "failed-old", status: "failed", pid: 3, withSessionFile: true },
    ]);
    try {
      const reg = makeStubRegistry();
      const before = readRecord(fx.runsRoot, "completed-old");
      const deps = makeDeps(fx, reg, () => false);
      const result = await reconcileOrphansAtStartup(deps);
      assert.equal(result.readopted.length, 0);
      assert.equal(result.reclassified.length, 0);
      assert.equal(result.errors.length, 0);
      assert.equal(reg.runs.size, 0, "registry unchanged for terminal records");
      // Disk unchanged:
      const after = readRecord(fx.runsRoot, "completed-old");
      assert.equal(after.status, before.status);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "reconcile: ENOENT on runsRoot → empty result, no throw",
  async () => {
    const reg = makeStubRegistry();
    const deps: PostStartupReconcileDeps = {
      runsRoot: "/tmp/this-directory-definitely-does-not-exist-9876543210",
      registry: reg,
      isAlive: () => false,
      now: 2_000,
    };
    const result = await reconcileOrphansAtStartup(deps);
    assert.equal(result.scanned, 0);
    assert.equal(result.readopted.length, 0);
    assert.equal(result.reclassified.length, 0);
    assert.equal(result.errors.length, 0);
  },
);

test(
  "reconcile: scan count covers every record dir seen",
  async () => {
    const fx = makeFixture([
      { id: "a", status: "running", pid: 99999, withSessionFile: true },
      { id: "b", status: "completed", pid: 1, withSessionFile: true },
      { id: "c", status: "queued" },
    ]);
    try {
      const reg = makeStubRegistry();
      const deps = makeDeps(fx, reg, () => true);
      const result = await reconcileOrphansAtStartup(deps);
      assert.equal(result.scanned, 3, "every record.json contributes to scanned");
    } finally {
      fx.cleanup();
    }
  },
);
