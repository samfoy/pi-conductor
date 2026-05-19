/**
 * pi-conductor — GC last-gc marker helpers tests.
 *
 * Spec: docs/v0.9-gc-design.md §D6; docs/v0.9-gc-plan.md "Slice 5", oracle R11.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { lastGcMarkerPath, readLastGcMtime, writeLastGcMtime } from "../src/gc/last-gc.ts";

function makeFakeRoot(): { root: string; runsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-conductor-last-gc-"));
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot, { recursive: true });
  return { root, runsRoot };
}

test("lastGcMarkerPath: marker is at <conductorRoot>/.last-gc, NOT under runs/ (R11)", () => {
  const runsRoot = "/tmp/x/.pi/agent/conductor/runs";
  const path = lastGcMarkerPath(runsRoot);
  assert.equal(path, "/tmp/x/.pi/agent/conductor/.last-gc");
  assert.equal(dirname(path), "/tmp/x/.pi/agent/conductor");
});

test("readLastGcMtime: returns null when marker missing (first run)", () => {
  const { runsRoot } = makeFakeRoot();
  assert.equal(readLastGcMtime(runsRoot), null);
});

test("writeLastGcMtime: creates the marker if missing", () => {
  const { runsRoot } = makeFakeRoot();
  writeLastGcMtime(runsRoot, 1_750_000_000_000);
  assert.ok(existsSync(lastGcMarkerPath(runsRoot)));
});

test("readLastGcMtime: returns the mtime that writeLastGcMtime wrote (epoch ms, ±2s)", () => {
  const { runsRoot } = makeFakeRoot();
  const target = 1_750_000_000_000;
  writeLastGcMtime(runsRoot, target);
  const got = readLastGcMtime(runsRoot);
  assert.ok(got !== null);
  assert.ok(Math.abs(got! - target) < 2_000, `got ${got} want ~${target}`);
});

test("writeLastGcMtime: subsequent calls update the mtime", () => {
  const { runsRoot } = makeFakeRoot();
  writeLastGcMtime(runsRoot, 1_700_000_000_000);
  writeLastGcMtime(runsRoot, 1_750_000_000_000);
  const got = readLastGcMtime(runsRoot);
  assert.ok(got !== null);
  assert.ok(Math.abs(got! - 1_750_000_000_000) < 2_000);
});
