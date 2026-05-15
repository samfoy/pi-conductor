/**
 * Tests for resolveStreamWidth — picks the rendering width for the
 * inline-streamed foreground transcript. Prefers the live terminal
 * columns (when available), clamps to a sane min/max, and falls back to
 * a default for headless contexts (CI, RPC mode, missing TTY).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveStreamWidth } from "../src/foreground-stream.ts";

test("resolveStreamWidth: returns the default when no columns are available", () => {
  assert.equal(resolveStreamWidth(undefined), 100);
  assert.equal(resolveStreamWidth(null as any), 100);
  assert.equal(resolveStreamWidth(0), 100);
});

test("resolveStreamWidth: returns the live columns when within range", () => {
  assert.equal(resolveStreamWidth(80), 80);
  assert.equal(resolveStreamWidth(120), 120);
  assert.equal(resolveStreamWidth(200), 200);
});

test("resolveStreamWidth: clamps below the minimum", () => {
  // Tool-call cards are unreadable below 40 cols.
  assert.equal(resolveStreamWidth(20), 40);
  assert.equal(resolveStreamWidth(1), 40);
});

test("resolveStreamWidth: clamps above the maximum", () => {
  // Above 240 we don't gain useful information density and risk
  // exceeding pi's tool-result text rendering budget.
  assert.equal(resolveStreamWidth(500), 240);
  assert.equal(resolveStreamWidth(241), 240);
});

test("resolveStreamWidth: ignores NaN / negative", () => {
  assert.equal(resolveStreamWidth(NaN), 100);
  assert.equal(resolveStreamWidth(-10), 100);
});
