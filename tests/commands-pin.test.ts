/**
 * Tests for /conductor pin and /conductor unpin slash subcommands.
 *
 * Drives `runPin` / `runUnpin` directly with a mock `ExtensionCommandContext`
 * that captures notify calls. `process.env.HOME` is redirected so
 * `runsRoot()` lands inside an mkdtempSync fixture, mirroring the pattern
 * in `tests/doctor.test.ts`.
 *
 * Spec: docs/v0.9-gc-design.md §D4; docs/v0.9-gc-plan.md "Slice 4".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPin, runUnpin } from "../src/commands.ts";
import { runsRoot } from "../src/runs.ts";

interface NotifyCall {
  message: string;
  level: string;
}

interface MockCtx {
  ui: {
    notify: (msg: string, level?: string) => void;
  };
  calls: NotifyCall[];
}

function mockCtx(): MockCtx {
  const calls: NotifyCall[] = [];
  return {
    ui: {
      notify: (message: string, level?: string) => {
        calls.push({ message, level: level ?? "info" });
      },
    },
    calls,
  };
}

interface Fx {
  root: string;
  homeDir: string;
  realHome: string | undefined;
  runsDir: string;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-pin-test-"));
  const homeDir = join(root, "home");
  // runsRoot() is `<HOME>/.pi/agent/conductor/runs`.
  const runsDir = join(homeDir, ".pi", "agent", "conductor", "runs");
  mkdirSync(runsDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, realHome, runsDir };
}

function teardown(fx: Fx): Promise<void> {
  if (fx.realHome !== undefined) process.env.HOME = fx.realHome;
  else delete process.env.HOME;
  return rm(fx.root, { recursive: true, force: true });
}

function makeRunDir(fx: Fx, id: string): string {
  const dir = join(fx.runsDir, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("runPin: creates the .pinned sidecar and notifies success", async () => {
  const fx = setup();
  try {
    // Sanity — runsRoot() resolves to our fixture's runs dir.
    assert.equal(runsRoot(), fx.runsDir);
    makeRunDir(fx, "inspector-aaaa");
    const ctx = mockCtx();

    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "inspector-aaaa");

    assert.equal(existsSync(join(fx.runsDir, "inspector-aaaa", ".pinned")), true);
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /Pinned inspector-aaaa\./);
    assert.equal(ctx.calls[0]!.level, "info");
  } finally {
    await teardown(fx);
  }
});

test("runPin: missing agent_id surfaces a usage warning", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "");
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /usage: \/conductor pin/);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runPin: rejects invalid agent_id format (path traversal defense)", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "../escape");
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /invalid agent_id format/);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runPin: surfaces 'No such run' for unknown id", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "inspector-zzzz");
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /No such run: inspector-zzzz/);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runPin: idempotent — second pin says 'Already pinned'", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "inspector-bbbb");
    const ctx = mockCtx();
    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "inspector-bbbb");
    await runPin(ctx as unknown as Parameters<typeof runPin>[0], "inspector-bbbb");
    assert.equal(ctx.calls.length, 2);
    assert.match(ctx.calls[1]!.message, /Already pinned: inspector-bbbb\./);
    assert.equal(ctx.calls[1]!.level, "info");
  } finally {
    await teardown(fx);
  }
});

test("runUnpin: removes the .pinned sidecar and notifies success", async () => {
  const fx = setup();
  try {
    const dir = makeRunDir(fx, "inspector-cccc");
    writeFileSync(join(dir, ".pinned"), "");
    const ctx = mockCtx();

    await runUnpin(ctx as unknown as Parameters<typeof runUnpin>[0], "inspector-cccc");

    assert.equal(existsSync(join(dir, ".pinned")), false);
    assert.equal(ctx.calls.length, 1);
    assert.match(ctx.calls[0]!.message, /Unpinned inspector-cccc\./);
    assert.equal(ctx.calls[0]!.level, "info");
  } finally {
    await teardown(fx);
  }
});

test("runUnpin: missing argument surfaces usage", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runUnpin(ctx as unknown as Parameters<typeof runUnpin>[0], "");
    assert.match(ctx.calls[0]!.message, /usage: \/conductor unpin/);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runUnpin: 'Not pinned' for an existing-but-unpinned run", async () => {
  const fx = setup();
  try {
    makeRunDir(fx, "inspector-dddd");
    const ctx = mockCtx();
    await runUnpin(ctx as unknown as Parameters<typeof runUnpin>[0], "inspector-dddd");
    assert.match(ctx.calls[0]!.message, /Not pinned: inspector-dddd\./);
    assert.equal(ctx.calls[0]!.level, "info");
  } finally {
    await teardown(fx);
  }
});

test("runUnpin: 'No such run' for unknown id", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runUnpin(ctx as unknown as Parameters<typeof runUnpin>[0], "inspector-yyyy");
    assert.match(ctx.calls[0]!.message, /No such run: inspector-yyyy/);
    assert.equal(ctx.calls[0]!.level, "warning");
  } finally {
    await teardown(fx);
  }
});

test("runUnpin: rejects path-traversal id", async () => {
  const fx = setup();
  try {
    const ctx = mockCtx();
    await runUnpin(ctx as unknown as Parameters<typeof runUnpin>[0], "../foo");
    assert.match(ctx.calls[0]!.message, /invalid agent_id format/);
  } finally {
    await teardown(fx);
  }
});
