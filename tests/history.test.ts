/**
 * Tests for buildHistoryReport — the pure renderer behind /conductor
 * history. Takes injected I/O (record + final readers, mtime stat) so
 * the renderer can be tested without touching the filesystem.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryReport, type HistoryDeps } from "../src/history.ts";
import { emptyUsage } from "../src/types.ts";
import type { RunRecord } from "../src/types.ts";

function rec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "test task",
    mode: "background",
    status: "completed",
    startTime: 1_700_000_000_000,
    finishedAt: 1_700_000_014_000, // 14s later
    usage: { ...emptyUsage(), turns: 3, input: 1200, output: 800, cost: 0.012 },
    cwd: "/tmp",
    recordPath: "/runs/oracle-7f3a/record.json",
    transcriptPath: "/runs/oracle-7f3a/transcript.jsonl",
    finalPath: "/runs/oracle-7f3a/final.md",
    ...overrides,
  };
}

function makeDeps(records: Array<{ id: string; record: RunRecord; finalText?: string; mtime?: number }>): HistoryDeps {
  return {
    listRunIds: () => records.map((r) => r.id),
    readRecord: (id: string) => {
      const r = records.find((x) => x.id === id);
      return r ? r.record : undefined;
    },
    readFinalText: (id: string) => {
      const r = records.find((x) => x.id === id);
      return r?.finalText;
    },
    statMtime: (id: string) => {
      const r = records.find((x) => x.id === id);
      // Default mtime to finishedAt for ordering when not supplied.
      return r?.mtime ?? r?.record.finishedAt ?? r?.record.startTime ?? 0;
    },
  };
}

// ── Empty / edge cases ────────────────────────────────────────────────

test("buildHistoryReport: empty runs root → friendly empty message", () => {
  const out = buildHistoryReport(makeDeps([]), { limit: 20 });
  assert.match(out, /no run history/i);
});

test("buildHistoryReport: skips entries whose record.json is missing or unreadable", () => {
  const deps: HistoryDeps = {
    listRunIds: () => ["broken-1", "good-2"],
    readRecord: (id: string) => (id === "good-2" ? rec({ id: "good-2", persona: "oracle" }) : undefined),
    readFinalText: () => undefined,
    statMtime: () => 0,
  };
  const out = buildHistoryReport(deps, { limit: 20 });
  assert.match(out, /good-2/);
  assert.doesNotMatch(out, /broken-1/);
});

// ── Rendering ──────────────────────────────────────────────────────────

test("buildHistoryReport: lists each run with persona, status, elapsed, usage", () => {
  const deps = makeDeps([
    { id: "oracle-7f3a", record: rec({ id: "oracle-7f3a", persona: "oracle", status: "completed" }) },
    { id: "builder-aa11", record: rec({ id: "builder-aa11", persona: "builder", status: "failed", errorMessage: "boom" }) },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  // Both runs present.
  assert.match(out, /oracle-7f3a/);
  assert.match(out, /builder-aa11/);
  // Status glyphs surface terminal states distinctly.
  assert.match(out, /✓.*oracle/s);
  assert.match(out, /✗.*builder/s);
  // Persona shown.
  assert.match(out, /oracle/);
  assert.match(out, /builder/);
  // Usage interpolated.
  assert.match(out, /3t/);
  // Elapsed shown.
  assert.match(out, /14s/);
});

test("buildHistoryReport: respects the limit and shows count", () => {
  const records = Array.from({ length: 10 }, (_, i) => ({
    id: `oracle-${String(i).padStart(4, "0")}`,
    record: rec({ id: `oracle-${String(i).padStart(4, "0")}`, finishedAt: 1_700_000_000_000 + i * 1000 }),
  }));
  const out = buildHistoryReport(makeDeps(records), { limit: 3 });
  // Only the first 3 (most recent) appear.
  assert.match(out, /oracle-0009/);
  assert.match(out, /oracle-0008/);
  assert.match(out, /oracle-0007/);
  assert.doesNotMatch(out, /oracle-0006/);
  // Count callout: shows "3 of 10" or similar.
  assert.match(out, /3.*of.*10|showing 3|10 total/i);
});

test("buildHistoryReport: orders by mtime DESC (most recent first)", () => {
  const deps = makeDeps([
    { id: "old", record: rec({ id: "old", persona: "oracle" }), mtime: 1_700_000_000_000 },
    { id: "new", record: rec({ id: "new", persona: "oracle" }), mtime: 1_700_000_999_999 },
    { id: "mid", record: rec({ id: "mid", persona: "oracle" }), mtime: 1_700_000_500_000 },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  const newIdx = out.indexOf("new");
  const midIdx = out.indexOf("mid");
  const oldIdx = out.indexOf("old");
  assert.ok(newIdx < midIdx, "new should appear before mid");
  assert.ok(midIdx < oldIdx, "mid should appear before old");
});

test("buildHistoryReport: includes a final-text excerpt when available", () => {
  const deps = makeDeps([
    {
      id: "oracle-7f3a",
      record: rec({ id: "oracle-7f3a", status: "completed" }),
      finalText: "JWT auth design looks solid; recommend rotating keys quarterly.",
    },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  assert.match(out, /JWT auth design looks solid/);
});

test("buildHistoryReport: surfaces in-flight runs with the running glyph + omits final-text excerpt", () => {
  const deps = makeDeps([
    {
      id: "oracle-7f3a",
      record: rec({
        id: "oracle-7f3a",
        status: "running",
        finishedAt: undefined,
        startTime: Date.now() - 5_000,
      }),
      finalText: "this should not be rendered while the run is still alive",
    },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  // Running glyph from the status table.
  assert.match(out, /●/);
  assert.match(out, /running/);
  // The final-text "shouldn't appear yet" — the run hasn't completed.
  assert.doesNotMatch(out, /this should not be rendered/);
});

test("buildHistoryReport: tail-truncates the final-text excerpt with ellipsis", () => {
  const deps = makeDeps([
    {
      id: "oracle-7f3a",
      record: rec({ id: "oracle-7f3a", status: "completed" }),
      finalText: "x".repeat(500),
    },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  // Each rendered line stays bounded.
  for (const line of out.split("\n")) {
    assert.ok(line.length < 300, `line too long: ${line.length}`);
  }
  assert.match(out, /…|\.\.\./);
});
test("buildHistoryReport: failure runs surface the error message", () => {
  const deps = makeDeps([
    {
      id: "builder-aa11",
      record: rec({ id: "builder-aa11", status: "failed", errorMessage: "context overflow" }),
    },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  assert.match(out, /context overflow/);
});

test("buildHistoryReport: omits final-text excerpt for non-completed status", () => {
  const deps = makeDeps([
    {
      id: "oracle-7f3a",
      record: rec({ id: "oracle-7f3a", status: "killed" }),
      finalText: "should not be rendered as the success line",
    },
  ]);
  const out = buildHistoryReport(deps, { limit: 20 });
  assert.doesNotMatch(out, /should not be rendered/);
});

test("buildHistoryReport: each RunStatus surfaces the shared STATUS_GLYPH char", async () => {
  const { STATUS_GLYPH } = await import("../src/status-glyph.ts");
  const statuses = [
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "killed",
    "timeout",
  ] as const;
  for (const status of statuses) {
    const id = `probe-${status}`;
    const deps = makeDeps([
      {
        id,
        record: rec({ id, persona: "probe", status, finishedAt: 1_700_000_001_000 }),
      },
    ]);
    const out = buildHistoryReport(deps, { limit: 5 });
    const glyph = STATUS_GLYPH[status];
    assert.ok(
      out.includes(glyph),
      `expected glyph ${glyph} for status ${status} in:\n${out}`,
    );
  }
});
