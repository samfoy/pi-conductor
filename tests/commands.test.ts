/**
 * Tests for src/commands.ts helpers exported for verification.
 *
 * Pinned via the F1 fast-follow on Slice 0 — `statusGlyph` is the
 * /conductor status row's glyph helper; it must read from the shared
 * STATUS_GLYPH map (single source of truth) and preserve the historical
 * "·" fallback for unknown status strings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { formatRunRowForTest, statusGlyph } from "../src/commands.ts";
import { STATUS_GLYPH } from "../src/status-glyph.ts";
import type { Run } from "../src/types.ts";

test("statusGlyph: each RunStatus key returns STATUS_GLYPH[status]", () => {
  for (const status of Object.keys(STATUS_GLYPH) as Array<keyof typeof STATUS_GLYPH>) {
    assert.equal(statusGlyph(status), STATUS_GLYPH[status]);
  }
});

test("statusGlyph: unknown status string falls back to '·'", () => {
  assert.equal(statusGlyph("nope"), "·");
  assert.equal(statusGlyph(""), "·");
  assert.equal(statusGlyph("RUNNING"), "·"); // case-sensitive
});

test("statusGlyph: matches the historical inline switch (regression)", () => {
  // These are the seven values the pre-dedup switch returned, byte-exact.
  // If anyone changes a glyph in status-glyph.ts they must update this list
  // deliberately.
  assert.equal(statusGlyph("queued"), "◌");
  assert.equal(statusGlyph("running"), "●");
  assert.equal(statusGlyph("paused"), "⏸");
  assert.equal(statusGlyph("completed"), "✓");
  assert.equal(statusGlyph("failed"), "✗");
  assert.equal(statusGlyph("killed"), "■");
  assert.equal(statusGlyph("timeout"), "⏱");
  assert.equal(statusGlyph("anything-else"), "·");
});

// ── formatRunRow liveness probe (item 4) ────────────────────────────────────
//
// Pins the liveness-probe suffix added in commit X (item 4 closure).
// Witness: `builder-ew9e` (docs/backlog.md item 4) — the orchestrator
// had no first-class signal for "pi alive but slow" vs "pi crashed"
// from the slash-status output. Suffix `· pid-gone` appears only when
// the run is `running`, has a `pid`, and the probe says dead.

function makeRun(over: Partial<Run>): Run {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "",
    mode: "foreground",
    status: "running",
    startTime: Date.now() - 60_000,
    cwd: "/tmp",
    runDir: "/tmp/runs/oracle-7f3a",
    recordPath: "/tmp/runs/oracle-7f3a/record.json",
    transcriptPath: "/tmp/runs/oracle-7f3a/transcript.jsonl",
    finalPath: "/tmp/runs/oracle-7f3a/final.md",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeoutMinutes: 60,
    timeoutMs: 60 * 60_000,
    lastEventAt: Date.now(),
    ...over,
  } as unknown as Run;
}

test("formatRunRow: alive running run shows no pid-gone suffix", () => {
  const r = makeRun({ status: "running", pid: 9999 });
  const out = formatRunRowForTest(r, () => true);
  assert.ok(!out.includes("pid-gone"), `expected no pid-gone suffix; got: ${out}`);
});

test("formatRunRow: dead running run appends ' · pid-gone' suffix", () => {
  const r = makeRun({ status: "running", pid: 9999 });
  const out = formatRunRowForTest(r, () => false);
  assert.ok(
    out.endsWith(" · pid-gone"),
    `expected suffix ' · pid-gone'; got: ${out}`,
  );
});

test("formatRunRow: non-running status does NOT call the liveness probe", () => {
  let probeCalls = 0;
  const probe = (_pid: number) => {
    probeCalls++;
    return false;
  };
  for (const status of ["queued", "paused", "completed", "failed", "killed", "timeout"] as const) {
    const r = makeRun({ status, pid: 9999 });
    const out = formatRunRowForTest(r, probe);
    assert.ok(!out.includes("pid-gone"), `${status} should not show pid-gone; got: ${out}`);
  }
  assert.equal(probeCalls, 0, "probe must not be called for non-running statuses");
});

test("formatRunRow: undefined pid does NOT call the liveness probe", () => {
  let probeCalls = 0;
  const probe = (_pid: number) => {
    probeCalls++;
    return false;
  };
  const r = makeRun({ status: "running", pid: undefined });
  const out = formatRunRowForTest(r, probe);
  assert.ok(!out.includes("pid-gone"), `expected no pid-gone suffix; got: ${out}`);
  assert.equal(probeCalls, 0, "probe must not be called when pid is undefined");
});

test("formatRunRow: pid-gone suffix wording is character-pinned (W3 string witness)", () => {
  // If anyone tweaks the suffix text, this test reds and the W3 pin in
  // tests/commands.test.ts must be updated deliberately.
  const r = makeRun({ status: "running", pid: 9999 });
  const out = formatRunRowForTest(r, () => false);
  assert.match(out, / · pid-gone$/);
});
