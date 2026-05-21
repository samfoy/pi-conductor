import test from "node:test";
import assert from "node:assert/strict";

import { STATUS_GLYPH } from "../src/status-glyph.ts";

// These glyphs are load-bearing: widget.ts wraps them in theme.fg() at runtime,
// transcript.ts and foreground-stream.ts emit them as plain chars. Any change
// here ripples to every rendered run header. Pin the exact code points.

test("STATUS_GLYPH: queued is ◌", () => {
  assert.equal(STATUS_GLYPH.queued, "◌");
});

test("STATUS_GLYPH: running is ●", () => {
  assert.equal(STATUS_GLYPH.running, "●");
});

test("STATUS_GLYPH: paused is ⏸", () => {
  assert.equal(STATUS_GLYPH.paused, "⏸");
});

test("STATUS_GLYPH: completed is ✓", () => {
  assert.equal(STATUS_GLYPH.completed, "✓");
});

test("STATUS_GLYPH: failed is ✗", () => {
  assert.equal(STATUS_GLYPH.failed, "✗");
});

test("STATUS_GLYPH: killed is ■", () => {
  assert.equal(STATUS_GLYPH.killed, "■");
});

test("STATUS_GLYPH: timeout is ⏱", () => {
  assert.equal(STATUS_GLYPH.timeout, "⏱");
});

test("STATUS_GLYPH: hook_failed entry is ⊗", () => {
  // v0.11 slice 1a: hook_failed is a new terminal status. Glyph chosen
  // distinct from `failed`/`killed`/`timeout` so a hook gate failure is
  // visually distinguishable in the panel and history.
  assert.equal(STATUS_GLYPH.hook_failed, "⊗");
});

test("STATUS_GLYPH: covers every RunStatus key (no holes)", () => {
  // Surfaces drift if RunStatus gains a member without STATUS_GLYPH being updated.
  const keys = Object.keys(STATUS_GLYPH).sort();
  assert.deepEqual(keys, [
    "completed",
    "failed",
    "hook_failed",
    "killed",
    "paused",
    "queued",
    "running",
    "timeout",
  ]);
});
