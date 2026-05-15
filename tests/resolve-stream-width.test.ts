/**
 * Tests for resolveStreamWidth — picks the rendering width for the
 * inline-streamed foreground transcript. Prefers the live terminal
 * columns (when available), clamps to a sane min/max, and falls back to
 * a default for headless contexts (CI, RPC mode, missing TTY).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveStreamWidth,
  STREAM_DEFAULT_WIDTH,
  STREAM_MAX_WIDTH,
  STREAM_MIN_WIDTH,
} from "../src/foreground-stream.ts";

test("resolveStreamWidth: returns the default when no columns are available", () => {
  assert.equal(resolveStreamWidth(undefined), STREAM_DEFAULT_WIDTH);
  assert.equal(resolveStreamWidth(null as any), STREAM_DEFAULT_WIDTH);
  assert.equal(resolveStreamWidth(0), STREAM_DEFAULT_WIDTH);
});

test("resolveStreamWidth: returns the live columns when within range", () => {
  assert.equal(resolveStreamWidth(80), 80);
  assert.equal(resolveStreamWidth(120), 120);
  assert.equal(resolveStreamWidth(200), 200);
});

test("resolveStreamWidth: clamps below the minimum", () => {
  // Tool-call cards are unreadable below the minimum.
  assert.equal(resolveStreamWidth(20), STREAM_MIN_WIDTH);
  assert.equal(resolveStreamWidth(1), STREAM_MIN_WIDTH);
});

test("resolveStreamWidth: clamps above the maximum", () => {
  // Above the cap we don't gain useful information density and risk
  // exceeding pi's tool-result text rendering budget.
  assert.equal(resolveStreamWidth(STREAM_MAX_WIDTH + 100), STREAM_MAX_WIDTH);
  assert.equal(resolveStreamWidth(STREAM_MAX_WIDTH + 1), STREAM_MAX_WIDTH);
});

test("resolveStreamWidth: ignores NaN / negative", () => {
  assert.equal(resolveStreamWidth(NaN), STREAM_DEFAULT_WIDTH);
  assert.equal(resolveStreamWidth(-10), STREAM_DEFAULT_WIDTH);
});
