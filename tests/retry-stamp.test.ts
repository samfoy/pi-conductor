/**
 * Tests for v0.18-S2 — stamp `retryAttempt`/`retryPolicy` onto `Run` at
 * `spawnRun` time, and witness the loop-termination property end-to-end.
 *
 * Mirrors tests/turn-limit-stamp.test.ts (the v0.17 spawn-stamp analog).
 *
 * WDD witnesses:
 *   W1: no retry config anywhere → run.retryPolicy.maxAttempts === 1 (OFF)
 *   W2: per-call retryMaxAttempts stamps the resolved policy
 *   W3: persona.retryMaxAttempts feeds the cascade when no per-call
 *   W4: per-call wins over persona
 *   W5: run.retryAttempt === opts.retryAttempt ?? 0
 *   W6: retryableClasses default to the built-in set
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnRun, RunRegistry } from "../src/runs.ts";

function makePersona(overrides: { retryMaxAttempts?: number } = {}) {
  return {
    name: "builder",
    description: "test builder persona",
    model: undefined,
    thinking: undefined,
    inheritContext: "none" as const,
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 10,
    systemPrompt: "You are a test persona.",
    source: "builtin" as const,
    sourcePath: "/fake/builder.md",
    readOnly: false,
    onCompleteHook: undefined,
    onCompleteHookTimeoutSeconds: undefined,
    maxTurns: undefined,
    graceTurns: undefined,
    retryMaxAttempts: overrides.retryMaxAttempts,
  };
}

function makeSpawnOpts(overrides: {
  retryMaxAttempts?: number;
  retryAttempt?: number;
  persona?: ReturnType<typeof makePersona>;
} = {}) {
  const tmpDir = join(tmpdir(), `s2-retry-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  return {
    tmpDir,
    opts: {
      registry: new RunRegistry(),
      persona: overrides.persona ?? makePersona(),
      task: "test task",
      mode: "background" as const,
      cwd: tmpDir,
      timeoutMs: 60_000,
      retryMaxAttempts: overrides.retryMaxAttempts,
      retryAttempt: overrides.retryAttempt,
    },
  };
}

function withSpawn(
  opts: ReturnType<typeof makeSpawnOpts>["opts"],
  tmpDir: string,
  assertFn: (run: ReturnType<typeof spawnRun>["run"]) => void,
) {
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assertFn(run);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("S2-W1: no retry config → run.retryPolicy.maxAttempts === 1 (OFF)", () => {
  const { opts, tmpDir } = makeSpawnOpts();
  withSpawn(opts, tmpDir, (run) => {
    assert.equal(run.retryPolicy?.maxAttempts, 1);
  });
});

test("S2-W2: per-call retryMaxAttempts stamps the resolved policy", () => {
  const { opts, tmpDir } = makeSpawnOpts({ retryMaxAttempts: 3 });
  withSpawn(opts, tmpDir, (run) => {
    assert.equal(run.retryPolicy?.maxAttempts, 3);
  });
});

test("S2-W3: persona.retryMaxAttempts feeds cascade when no per-call", () => {
  const persona = makePersona({ retryMaxAttempts: 4 });
  const { opts, tmpDir } = makeSpawnOpts({ persona });
  withSpawn(opts, tmpDir, (run) => {
    assert.equal(run.retryPolicy?.maxAttempts, 4);
  });
});

test("S2-W4: per-call wins over persona", () => {
  const persona = makePersona({ retryMaxAttempts: 4 });
  const { opts, tmpDir } = makeSpawnOpts({ retryMaxAttempts: 2, persona });
  withSpawn(opts, tmpDir, (run) => {
    assert.equal(run.retryPolicy?.maxAttempts, 2);
  });
});

test("S2-W5: run.retryAttempt === opts.retryAttempt ?? 0", () => {
  const a = makeSpawnOpts();
  withSpawn(a.opts, a.tmpDir, (run) => assert.equal(run.retryAttempt, 0));
  const b = makeSpawnOpts({ retryAttempt: 2 });
  withSpawn(b.opts, b.tmpDir, (run) => assert.equal(run.retryAttempt, 2));
});

test("S2-W6: retryableClasses default to the built-in set", () => {
  const { opts, tmpDir } = makeSpawnOpts({ retryMaxAttempts: 3 });
  withSpawn(opts, tmpDir, (run) => {
    assert.deepEqual(
      [...(run.retryPolicy?.retryableClasses ?? [])].sort(),
      ["environment", "stall", "test", "timeout"],
    );
  });
});
