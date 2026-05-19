/**
 * pi-conductor — Pinning primitives tests.
 *
 * Spec: docs/v0.9-gc-design.md §D4 (sidecar `.pinned` file). The policy
 * engine (slice 1) already consumes `entry.pinned` from walkInventory;
 * this slice lands the write/read primitives the UI uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pinRun, unpinRun, isPinned } from "../src/gc/pinning.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-conductor-pinning-"));
}

function makeRunDir(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("pinRun: creates an empty .pinned sidecar inside runDir", async () => {
  const root = makeRoot();
  try {
    const dir = makeRunDir(root, "inspector-aaaa");
    await pinRun(root, "inspector-aaaa");
    const sidecar = join(dir, ".pinned");
    assert.equal(existsSync(sidecar), true);
    assert.equal(statSync(sidecar).size, 0, ".pinned should be an empty marker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinRun: idempotent — second call leaves a single .pinned file (no throw)", async () => {
  const root = makeRoot();
  try {
    makeRunDir(root, "inspector-bbbb");
    await pinRun(root, "inspector-bbbb");
    await pinRun(root, "inspector-bbbb");
    assert.equal(existsSync(join(root, "inspector-bbbb", ".pinned")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinRun: throws a clear error when runDir is missing", async () => {
  const root = makeRoot();
  try {
    await assert.rejects(
      () => pinRun(root, "inspector-cccc"),
      (err: Error) => /no such run/.test(err.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinRun: throws when target path is a file, not a directory", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "not-a-dir"), "");
    await assert.rejects(
      () => pinRun(root, "not-a-dir"),
      (err: Error) => /not a directory/.test(err.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpinRun: removes the .pinned sidecar", async () => {
  const root = makeRoot();
  try {
    makeRunDir(root, "inspector-dddd");
    await pinRun(root, "inspector-dddd");
    assert.equal(existsSync(join(root, "inspector-dddd", ".pinned")), true);
    await unpinRun(root, "inspector-dddd");
    assert.equal(existsSync(join(root, "inspector-dddd", ".pinned")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpinRun: idempotent — absent sidecar is a no-op (no throw)", async () => {
  const root = makeRoot();
  try {
    makeRunDir(root, "inspector-eeee");
    await unpinRun(root, "inspector-eeee");
    await unpinRun(root, "inspector-eeee");
    // No assertion needed — the test passes by not throwing.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpinRun: idempotent — missing runDir is a no-op (no throw)", async () => {
  const root = makeRoot();
  try {
    await unpinRun(root, "inspector-ffff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isPinned: true when sidecar exists, false otherwise", async () => {
  const root = makeRoot();
  try {
    makeRunDir(root, "inspector-gggg");
    assert.equal(isPinned(root, "inspector-gggg"), false, "no sidecar yet");
    await pinRun(root, "inspector-gggg");
    assert.equal(isPinned(root, "inspector-gggg"), true, "after pinRun");
    await unpinRun(root, "inspector-gggg");
    assert.equal(isPinned(root, "inspector-gggg"), false, "after unpinRun");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isPinned: false when runDir is missing entirely", () => {
  const root = makeRoot();
  try {
    assert.equal(isPinned(root, "no-such-id"), false);
  } finally {
    // synchronous teardown is fine here
  }
});
