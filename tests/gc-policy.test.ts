/**
 * pi-conductor — GC policy tests.
 *
 * Spec: docs/v0.9-gc-design.md §2 (D1\u2013D8); docs/v0.9-gc-plan.md "Slice 1".
 *
 * Pure-function tests: no fs, no clock — `now` is injected. Mutation-
 * tested gates documented per case.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { planReclaim } from "../src/gc/policy.ts";
import type { InventoryEntry } from "../src/gc/inventory.ts";
import { DEFAULT_CONFIG, emptyUsage, type GcConfig, type Run } from "../src/types.ts";

const NOW = 1_750_000_000_000; // 2025-06-15 ish
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function defaultGcConfig(overrides: Partial<GcConfig> = {}): GcConfig {
  return { ...DEFAULT_CONFIG.gc, ...overrides };
}

function makeEntry(overrides: Partial<InventoryEntry> & { id: string }): InventoryEntry {
  const { id, ...rest } = overrides;
  return {
    id,
    runDir: `/tmp/${id}`,
    persona: "inspector",
    status: "completed",
    startTime: NOW - 5 * DAY_MS,
    finishedAt: NOW - 5 * DAY_MS + 60_000,
    transcriptMtime: NOW - 5 * DAY_MS + 60_000,
    transcriptSizeBytes: 1024,
    recordSizeBytes: 512,
    finalSizeBytes: 256,
    totalSizeBytes: 1024 + 512 + 256,
    pinned: false,
    archived: false,
    archivedAt: null,
    sessionPathPresent: false,
    inMemory: undefined,
    malformed: false,
    ...rest,
  };
}

function makeLiveRun(id: string, status: Run["status"] = "running", proc?: object): Run {
  return {
    id,
    persona: "inspector",
    task: "noop",
    mode: "background",
    status,
    startTime: NOW - 60_000,
    lastEventAt: NOW - 60_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...(proc ? { proc: proc as Run["proc"] } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────
// Empty / disabled
// ────────────────────────────────────────────────────────────────────

test("planReclaim: empty inventory yields empty plan with all-zero totals", () => {
  const plan = planReclaim([], defaultGcConfig(), NOW);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.totalBytesBefore, 0);
  assert.equal(plan.totalBytesReclaimed, 0);
  assert.equal(plan.runsLoseResume, 0);
  assert.equal(plan.pinnedBytes, 0);
});

test("planReclaim: enabled=false keeps every entry, never reclaims", () => {
  const inv = [
    makeEntry({ id: "ancient-aaaa", status: "completed", finishedAt: NOW - 1000 * DAY_MS, archived: true }),
    makeEntry({ id: "fat-bbbb", status: "completed", transcriptSizeBytes: 5_000_000_000 }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ enabled: false }), NOW);
  assert.equal(plan.actions.length, 2);
  assert.ok(plan.actions.every((a) => a.kind === "keep"));
  assert.equal(plan.totalBytesReclaimed, 0);
});

// ────────────────────────────────────────────────────────────────────
// Active-run gate (LOAD-BEARING — mutation-tested)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: in-memory run with live proc → keep (active-run gate, LOAD-BEARING)", () => {
  // This is the gate the slice 1 mutation test removes.
  const live = makeLiveRun("active-cccc", "running", { fakeProc: true });
  const inv = [
    makeEntry({
      id: "active-cccc",
      status: "running",
      transcriptSizeBytes: 5_000_000_000, // huge — would normally evict on size-budget
      inMemory: live,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig(), NOW);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, "keep");
  assert.match((plan.actions[0] as { reason: string }).reason, /active in registry/);
});

test("planReclaim: in-memory run with non-terminal status (no proc) → keep", () => {
  // Even if proc is undefined, a non-terminal status means the registry still owns it.
  const live = makeLiveRun("paused-dddd", "paused");
  const inv = [makeEntry({ id: "paused-dddd", status: "paused", inMemory: live })];
  const plan = planReclaim(inv, defaultGcConfig(), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  // F-S1.3: pin the exact reason so removing rule 1 (active-in-registry
  // gate) flips the action to a non-keep kind — without this assertion,
  // a mutated rule 1 would still keep paused entries via rule 3 / 9 and
  // the test would silently pass.
  assert.match(
    (plan.actions[0] as { reason: string }).reason,
    /active in registry/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Orphan reconciliation (D5)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: status=running, no inMemory, fresh (< orphan TTL) → keep", () => {
  const inv = [
    makeEntry({
      id: "fresh-eeee",
      status: "running",
      transcriptMtime: NOW - 1 * HOUR_MS,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ orphanReconcileAfterHours: 24 }), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  assert.match((plan.actions[0] as { reason: string }).reason, /running but fresh/);
});

test("planReclaim: status=running, no inMemory, stale (> orphan TTL) → reconcile-orphan", () => {
  const inv = [
    makeEntry({
      id: "stale-ffff",
      status: "running",
      transcriptMtime: NOW - 48 * HOUR_MS,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ orphanReconcileAfterHours: 24 }), NOW);
  assert.equal(plan.actions[0]!.kind, "reconcile-orphan");
});

test("planReclaim: orphan check uses transcriptMtime when present, else startTime", () => {
  const inv = [
    makeEntry({
      id: "no-mtime-gggg",
      status: "running",
      transcriptMtime: null,
      startTime: NOW - 48 * HOUR_MS,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ orphanReconcileAfterHours: 24 }), NOW);
  assert.equal(plan.actions[0]!.kind, "reconcile-orphan");
});

// ────────────────────────────────────────────────────────────────────
// Pinning (D4)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: pinned terminal run > TTL > size budget → keep (pinned trumps)", () => {
  const inv = [
    makeEntry({
      id: "pinned-hhhh",
      status: "completed",
      finishedAt: NOW - 365 * DAY_MS, // way past TTL
      transcriptSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB — over budget
      totalSizeBytes: 10 * 1024 * 1024 * 1024,
      pinned: true,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ totalSizeBudgetBytes: 1024 }), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  assert.match((plan.actions[0] as { reason: string }).reason, /pinned/);
  assert.equal(plan.pinnedBytes, 10 * 1024 * 1024 * 1024);
});

// ────────────────────────────────────────────────────────────────────
// Already-archived runs (rules 6/7)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: archived run within TTL → keep", () => {
  const inv = [
    makeEntry({
      id: "young-archive-iiii",
      status: "completed",
      archived: true,
      archivedAt: NOW - 10 * DAY_MS,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ completedTtlDays: 30 }), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  assert.match((plan.actions[0] as { reason: string }).reason, /archived; within TTL/);
});

test("planReclaim: archived run beyond TTL → delete (uses completedTtlDays)", () => {
  const inv = [
    makeEntry({
      id: "old-archive-jjjj",
      status: "completed",
      archived: true,
      archivedAt: NOW - 90 * DAY_MS,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ completedTtlDays: 30 }), NOW);
  const a = plan.actions[0]!;
  assert.equal(a.kind, "delete");
  if (a.kind === "delete") {
    assert.ok(a.bytesReclaimed > 0);
  }
});

// F-S1.1 (slice 0 critic followup): TTL boundary mutation gap.
// `policy.ts` uses `ageMs > ttlDays * DAY_MS` (strict greater-than).
// At age == ttlDays*DAY_MS exactly the entry stays kept; mutating the
// comparator to `>=` would flip this to delete. Pin the boundary so
// MUT-B is caught.
test("planReclaim: archived run with age === completedTtlDays * DAY_MS exactly → keep (boundary, F-S1.1)", () => {
  const ttlDays = 30;
  const inv = [
    makeEntry({
      id: "boundary-archive-kkkk",
      status: "completed",
      archived: true,
      archivedAt: NOW - ttlDays * DAY_MS, // exact boundary
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ completedTtlDays: ttlDays }), NOW);
  assert.equal(
    plan.actions[0]!.kind,
    "keep",
    "strict `>` boundary: at age == ttl, the entry is kept; only age > ttl deletes",
  );
  assert.match((plan.actions[0] as { reason: string }).reason, /archived; within TTL/);
});

// F-S1.2 (slice 0 critic followup): the dead `pinned (archived)` branch
// in policy.ts has been removed because rule 5 (pinned + terminal)
// already wins for any pinned archived entry (archived implies terminal).
// Pin the invariant so a future change can't accidentally revive the
// dead branch by reordering the rules.
test("planReclaim: pinned + archived run is kept by rule 5, not the archived branch (F-S1.2)", () => {
  const inv = [
    makeEntry({
      id: "pinned-archive-llll",
      status: "completed",
      archived: true,
      archivedAt: NOW - 365 * DAY_MS, // way past TTL; archived branch would delete
      pinned: true,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ completedTtlDays: 30 }), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  // Rule 5's reason is the literal string "pinned" — the dead branch
  // would have produced "pinned (archived)". Pinning the exact reason
  // string locks the rule order.
  assert.equal((plan.actions[0] as { reason: string }).reason, "pinned");
});

test("planReclaim: failed-status archived run uses failedTtlDays", () => {
  const config = defaultGcConfig({ completedTtlDays: 30, failedTtlDays: 60 });
  // 45d old archived: completed → delete; failed → keep.
  const archivedAt = NOW - 45 * DAY_MS;
  const completed = makeEntry({
    id: "completed-kkkk",
    status: "completed",
    archived: true,
    archivedAt,
  });
  const failed = makeEntry({
    id: "failed-llll",
    status: "failed",
    archived: true,
    archivedAt,
  });
  const plan = planReclaim([completed, failed], config, NOW);
  const byId = Object.fromEntries(plan.actions.map((a) => [a.id, a]));
  assert.equal(byId["completed-kkkk"]!.kind, "delete");
  assert.equal(byId["failed-llll"]!.kind, "keep");
});

// ────────────────────────────────────────────────────────────────────
// Per-transcript size cap (rule 8)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: terminal run with transcript > per-cap → cold-archive", () => {
  const inv = [
    makeEntry({
      id: "fat-mmmm",
      status: "completed",
      transcriptSizeBytes: 200 * 1024 * 1024, // 200 MB
      totalSizeBytes: 200 * 1024 * 1024,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ transcriptSizeCapBytes: 100 * 1024 * 1024 }), NOW);
  const a = plan.actions[0]!;
  assert.equal(a.kind, "cold-archive");
  if (a.kind === "cold-archive") assert.ok(a.bytesReclaimed >= 200 * 1024 * 1024);
});

test("planReclaim: terminal run with transcript at-or-under cap → keep", () => {
  const inv = [
    makeEntry({
      id: "lean-nnnn",
      status: "completed",
      transcriptSizeBytes: 50 * 1024 * 1024,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ transcriptSizeCapBytes: 100 * 1024 * 1024 }), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
});

// ────────────────────────────────────────────────────────────────────
// Total size budget post-pass (rule 7)
// ────────────────────────────────────────────────────────────────────

test("planReclaim: total > budget → cold-archive largest first until under", () => {
  const inv = [
    makeEntry({ id: "small-1", status: "completed", transcriptSizeBytes: 100, totalSizeBytes: 200 }),
    makeEntry({ id: "huge-2", status: "completed", transcriptSizeBytes: 10_000, totalSizeBytes: 10_100 }),
    makeEntry({ id: "med-3", status: "completed", transcriptSizeBytes: 5_000, totalSizeBytes: 5_100 }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ totalSizeBudgetBytes: 6_000, transcriptSizeCapBytes: Number.MAX_SAFE_INTEGER }), NOW);
  const byId = Object.fromEntries(plan.actions.map((a) => [a.id, a]));
  assert.equal(byId["huge-2"]!.kind, "cold-archive");
  assert.match((byId["huge-2"] as { reason: string }).reason, /size-budget/);
  // Total now: 200 + 10100-10000 + 5100 = 5400 (< 6000), so others kept.
  assert.equal(byId["small-1"]!.kind, "keep");
  assert.equal(byId["med-3"]!.kind, "keep");
});

test("planReclaim: budget post-pass skips already-archived and pinned entries", () => {
  // Total 30 GB; budget 1 KB. Pinned 10 GB and already-archived 10 GB
  // are NOT eligible for the post-pass; only the unpinned-unarchived 10 GB
  // gets cold-archived.
  const inv = [
    makeEntry({
      id: "pinned-vault",
      status: "completed",
      transcriptSizeBytes: 10 * 1024 * 1024 * 1024,
      totalSizeBytes: 10 * 1024 * 1024 * 1024,
      pinned: true,
    }),
    makeEntry({
      id: "already-cold",
      status: "completed",
      transcriptSizeBytes: 10 * 1024 * 1024 * 1024,
      totalSizeBytes: 10 * 1024 * 1024 * 1024,
      archived: true,
      archivedAt: NOW - 1 * DAY_MS,
    }),
    makeEntry({
      id: "fat-fresh",
      status: "completed",
      transcriptSizeBytes: 10 * 1024 * 1024 * 1024,
      totalSizeBytes: 10 * 1024 * 1024 * 1024,
    }),
  ];
  const plan = planReclaim(
    inv,
    defaultGcConfig({ totalSizeBudgetBytes: 1024, transcriptSizeCapBytes: Number.MAX_SAFE_INTEGER }),
    NOW,
  );
  const byId = Object.fromEntries(plan.actions.map((a) => [a.id, a]));
  assert.equal(byId["pinned-vault"]!.kind, "keep");
  assert.equal(byId["already-cold"]!.kind, "keep");
  assert.equal(byId["fat-fresh"]!.kind, "cold-archive");
});

// ────────────────────────────────────────────────────────────────────
// runsLoseResume tracking
// ────────────────────────────────────────────────────────────────────

test("planReclaim: runsLoseResume counts only delete actions with sessionPathPresent", () => {
  const inv = [
    // Delete with session → +1 to runsLoseResume.
    makeEntry({
      id: "send-able-oooo",
      status: "completed",
      archived: true,
      archivedAt: NOW - 365 * DAY_MS,
      sessionPathPresent: true,
    }),
    // Delete without session → does not count.
    makeEntry({
      id: "no-session-pppp",
      status: "completed",
      archived: true,
      archivedAt: NOW - 365 * DAY_MS,
      sessionPathPresent: false,
    }),
    // Cold-archive with session → never counts (resume preserved).
    makeEntry({
      id: "cold-with-sess-qqqq",
      status: "completed",
      transcriptSizeBytes: 200 * 1024 * 1024,
      sessionPathPresent: true,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig({ transcriptSizeCapBytes: 100 * 1024 * 1024 }), NOW);
  assert.equal(plan.runsLoseResume, 1);
});

// ────────────────────────────────────────────────────────────────────
// Malformed records
// ────────────────────────────────────────────────────────────────────

test("planReclaim: malformed entry kept (surface only, do not reclaim)", () => {
  const inv = [
    makeEntry({
      id: "broken-rrrr",
      malformed: true,
      persona: "<unknown>",
      status: "failed",
      transcriptSizeBytes: 1024 * 1024 * 1024,
    }),
  ];
  const plan = planReclaim(inv, defaultGcConfig(), NOW);
  assert.equal(plan.actions[0]!.kind, "keep");
  assert.match((plan.actions[0] as { reason: string }).reason, /malformed/);
});

// ────────────────────────────────────────────────────────────────────
// Per-persona TTL override
// ────────────────────────────────────────────────────────────────────

test("planReclaim: perPersonaTtlDays shortens completed TTL for the named persona", () => {
  const inv = [
    makeEntry({
      id: "designer-ssss",
      persona: "designer",
      status: "completed",
      archived: true,
      archivedAt: NOW - 20 * DAY_MS,
    }),
  ];
  // Default completedTtlDays = 30, but designer override = 14 → archive at 20d → delete.
  const plan = planReclaim(
    inv,
    defaultGcConfig({ completedTtlDays: 30, perPersonaTtlDays: { designer: 14 } }),
    NOW,
  );
  assert.equal(plan.actions[0]!.kind, "delete");
});

// ────────────────────────────────────────────────────────────────────
// Plan-level invariants
// ────────────────────────────────────────────────────────────────────

test("planReclaim: totalBytesBefore is sum of all entry totalSizeBytes", () => {
  const inv = [
    makeEntry({ id: "a", totalSizeBytes: 100 }),
    makeEntry({ id: "b", totalSizeBytes: 250 }),
    makeEntry({ id: "c", totalSizeBytes: 999 }),
  ];
  const plan = planReclaim(inv, defaultGcConfig(), NOW);
  assert.equal(plan.totalBytesBefore, 1349);
});

test("planReclaim: action order matches inventory order (1:1 mapping)", () => {
  const inv = [
    makeEntry({ id: "first" }),
    makeEntry({ id: "second" }),
    makeEntry({ id: "third" }),
  ];
  const plan = planReclaim(inv, defaultGcConfig(), NOW);
  assert.deepEqual(plan.actions.map((a) => a.id), ["first", "second", "third"]);
});

// ────────────────────────────────────────────────────────────────────
// Acceptance pin: policy.ts is pure — no fs, no runs.ts, no clock imports.
// Slice 1 acceptance criterion guards architectural drift; if a future
// edit pulls runs.ts into the policy module, the inventory layer's role
// as the sole registry/IO consumer breaks.
// ────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("policy.ts: zero imports from node:fs, node:fs/promises, or runs.ts (pure)", () => {
  const policyPath = fileURLToPath(new URL("../src/gc/policy.ts", import.meta.url));
  const source = readFileSync(policyPath, "utf-8");
  assert.doesNotMatch(source, /from\s+["']node:fs["']/, "policy.ts must not import node:fs");
  assert.doesNotMatch(
    source,
    /from\s+["']node:fs\/promises["']/,
    "policy.ts must not import node:fs/promises",
  );
  assert.doesNotMatch(
    source,
    /from\s+["'](?:\.\.\/)?runs(\.ts)?["']/,
    "policy.ts must not import from runs.ts (inventory is the only registry consumer)",
  );
});
