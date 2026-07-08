/**
 * v0.18-S4 — cross-session memory: normalizeTaskShape (pure),
 * scoreOutcomes (pure, recency-decayed + confidence-shrunk), and the
 * best-effort I/O round-trip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  normalizeTaskShape,
  scoreOutcomes,
  appendOutcome,
  loadOutcomes,
  recordRunOutcome,
  scoreForShape,
  type OutcomeRecord,
} from "../src/memory.ts";

const DAY = 24 * 60 * 60 * 1000;

// ── normalizeTaskShape ──────────────────────────────────────────────────

test("normalizeTaskShape is order-independent and stopword-insensitive", () => {
  const a = normalizeTaskShape("Add a retry loop to the spawn handler");
  const b = normalizeTaskShape("spawn handler retry loop add"); // reordered, stopwords gone
  assert.equal(a, b);
});

test("normalizeTaskShape distinguishes disjoint vocabularies", () => {
  assert.notEqual(
    normalizeTaskShape("refactor the worktree merge logic"),
    normalizeTaskShape("write documentation for the CLI flags"),
  );
});

test("normalizeTaskShape is a fixed-width hex hash (no raw text leak)", () => {
  const h = normalizeTaskShape("some secret internal task name");
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.doesNotMatch(h, /secret|internal/);
});

// ── scoreOutcomes ────────────────────────────────────────────────────────

function rec(over: Partial<OutcomeRecord>): OutcomeRecord {
  return {
    persona: "builder",
    taskShape: "shape1",
    status: "completed",
    durationMs: 1000,
    ts: 0,
    ...over,
  };
}

test("scoreOutcomes filters by shape", () => {
  const now = 10 * DAY;
  const scores = scoreOutcomes(
    [rec({ taskShape: "shape1" }), rec({ persona: "critic", taskShape: "other" })],
    "shape1",
    now,
  );
  assert.equal(scores.length, 1);
  assert.equal(scores[0].persona, "builder");
});

test("scoreOutcomes ranks a solid track record above one lucky success", () => {
  const now = 5 * DAY;
  const recs: OutcomeRecord[] = [
    // builder: 4 recent successes
    ...Array.from({ length: 4 }, (_, i) => rec({ persona: "builder", ts: now - i * DAY })),
    // simplifier: 1 recent success
    rec({ persona: "simplifier", ts: now }),
  ];
  const scores = scoreOutcomes(recs, "shape1", now);
  assert.equal(scores[0].persona, "builder"); // Laplace prior shrinks n=1 more
  assert.ok(scores[0].successRate > scores[1].successRate);
});

test("scoreOutcomes counts non-completed as failure", () => {
  const now = DAY;
  const scores = scoreOutcomes(
    [
      rec({ persona: "builder", status: "completed", ts: now }),
      rec({ persona: "builder", status: "failed", failureClass: "logic", ts: now }),
    ],
    "shape1",
    now,
  );
  // 1 success + 1 failure + Laplace pseudo-failure → ~1/3
  assert.ok(scores[0].successRate > 0.2 && scores[0].successRate < 0.5);
  assert.equal(scores[0].n, 2);
});

test("scoreOutcomes decays old outcomes (recent failure outweighs ancient success)", () => {
  const now = 400 * DAY;
  const recs: OutcomeRecord[] = [
    rec({ persona: "builder", status: "completed", ts: 0 }), // ~13 half-lives old → ~0 weight
    rec({ persona: "builder", status: "failed", ts: now }), // full weight
  ];
  const scores = scoreOutcomes(recs, "shape1", now);
  assert.ok(scores[0].successRate < 0.1, `expected low, got ${scores[0].successRate}`);
});

// ── I/O round-trip ───────────────────────────────────────────────────────

test("appendOutcome + loadOutcomes round-trips; scoreForShape end-to-end", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const path = join(dir, "outcomes.jsonl");
  try {
    const shape = normalizeTaskShape("optimize the hot path");
    appendOutcome({ persona: "profiler", taskShape: shape, status: "completed", durationMs: 5, ts: 1 }, path);
    appendOutcome({ persona: "builder", taskShape: shape, status: "failed", failureClass: "test", durationMs: 5, ts: 2 }, path);
    const loaded = loadOutcomes(path);
    assert.equal(loaded.length, 2);
    const scores = scoreOutcomes(loadOutcomes(path), shape, 3);
    assert.equal(scores[0].persona, "profiler"); // 100% vs 0%
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadOutcomes returns [] for missing file and skips malformed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const path = join(dir, "outcomes.jsonl");
  try {
    assert.deepEqual(loadOutcomes(path), []); // missing
    appendOutcome({ persona: "x", taskShape: "s", status: "completed", durationMs: 1, ts: 1 }, path);
    // append a junk line manually
    appendFileSync(path, "{not json\n");
    appendFileSync(path, '{"missing":"fields"}\n');
    assert.equal(loadOutcomes(path).length, 1); // only the valid record
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordRunOutcome maps a run and appends", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const path = join(dir, "outcomes.jsonl");
  try {
    recordRunOutcome(
      { persona: "builder", task: "add retry loop", status: "completed", startTime: 100, finishedAt: 350 },
      1000,
      path,
    );
    const loaded = loadOutcomes(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].persona, "builder");
    assert.equal(loaded[0].durationMs, 250);
    assert.equal(loaded[0].ts, 1000);
    assert.equal(loaded[0].taskShape, normalizeTaskShape("add retry loop"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendOutcome never throws on an unwritable path", () => {
  // Directory that can't be created (path component is a file) — best-effort swallow.
  assert.doesNotThrow(() =>
    appendOutcome(
      { persona: "x", taskShape: "s", status: "completed", durationMs: 1, ts: 1 },
      "/dev/null/nope/outcomes.jsonl",
    ),
  );
});
