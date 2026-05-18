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
import { statusGlyph } from "../src/commands.ts";
import { STATUS_GLYPH } from "../src/status-glyph.ts";

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
