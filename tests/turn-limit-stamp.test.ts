/**
 * Tests for v0.17-S3 — stamp `maxTurns`/`graceTurns`/`gracePeriodActive`
 * onto `Run` at `spawnRun` time.
 *
 * WDD witnesses:
 *   W1: when SpawnOptions.maxTurns = 10, run.maxTurns === 10 after spawn
 *   W2: when no maxTurns in any layer, run.maxTurns === undefined
 *   W3: run.graceTurns defaults to 5 when not configured
 *   W4: run.gracePeriodActive is false at spawn time
 *   W5: RunRecord serialisation round-trip preserves maxTurns + graceTurns
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { spawnRun } from "../src/runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { toRunRecord } from "../src/types.ts";

const createRegistry = () => new RunRegistry();

// ── Minimal persona fixture ───────────────────────────────────────────

function makePersona(overrides: { maxTurns?: number; graceTurns?: number } = {}) {
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
    maxTurns: overrides.maxTurns,
    graceTurns: overrides.graceTurns,
  };
}

// ── Shared spawn helper ───────────────────────────────────────────────

function makeSpawnOpts(overrides: {
  maxTurns?: number;
  graceTurns?: number;
  persona?: ReturnType<typeof makePersona>;
} = {}) {
  const tmpDir = join(tmpdir(), `s3-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const registry = createRegistry();
  return {
    tmpDir,
    opts: {
      registry,
      persona: overrides.persona ?? makePersona(),
      task: "test task",
      mode: "background" as const,
      cwd: tmpDir,
      timeoutMs: 60_000,
      maxTurns: overrides.maxTurns,
      graceTurns: overrides.graceTurns,
    },
  };
}

// ── W1: SpawnOptions.maxTurns stamps onto run ─────────────────────────

test("S3-W1: run.maxTurns === 10 when SpawnOptions.maxTurns = 10", () => {
  const { opts, tmpDir } = makeSpawnOpts({ maxTurns: 10 });
  try {
    const { run } = spawnRun(opts);
    // Kill subprocess immediately to avoid hanging the test
    run.proc?.kill("SIGKILL");
    assert.equal(run.maxTurns, 10);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── W2: no limit → run.maxTurns === undefined ─────────────────────────

test("S3-W2: run.maxTurns === undefined when no layer defines maxTurns", () => {
  const { opts, tmpDir } = makeSpawnOpts();
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.maxTurns, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── W3: graceTurns defaults to 5 ─────────────────────────────────────

test("S3-W3: run.graceTurns === 5 when no layer defines graceTurns", () => {
  const { opts, tmpDir } = makeSpawnOpts();
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.graceTurns, 5);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("S3-W3b: run.graceTurns === 2 when SpawnOptions.graceTurns = 2", () => {
  const { opts, tmpDir } = makeSpawnOpts({ graceTurns: 2 });
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.graceTurns, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── W4: gracePeriodActive === false at spawn time ─────────────────────

test("S3-W4: run.gracePeriodActive === false at spawn time", () => {
  const { opts, tmpDir } = makeSpawnOpts({ maxTurns: 10 });
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.gracePeriodActive, false);
    assert.equal(run.gracePeriodStartTurn, undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── W5: persona frontmatter layer feeds the cascade ───────────────────

test("S3-W5: persona.maxTurns feeds cascade when no per-call override", () => {
  const persona = makePersona({ maxTurns: 25, graceTurns: 3 });
  const { opts, tmpDir } = makeSpawnOpts({ persona });
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.maxTurns, 25);
    assert.equal(run.graceTurns, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("S3-W5b: per-call SpawnOptions.maxTurns wins over persona.maxTurns", () => {
  const persona = makePersona({ maxTurns: 25, graceTurns: 3 });
  const { opts, tmpDir } = makeSpawnOpts({ maxTurns: 10, persona });
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    assert.equal(run.maxTurns, 10);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── W6: RunRecord serialisation round-trip ────────────────────────────

test("S3-W6: toRunRecord preserves maxTurns and graceTurns", () => {
  const { opts, tmpDir } = makeSpawnOpts({ maxTurns: 7, graceTurns: 2 });
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    const record = toRunRecord(run);
    assert.equal(record.maxTurns, 7);
    assert.equal(record.graceTurns, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("S3-W6b: toRunRecord preserves maxTurns=undefined (no limit)", () => {
  const { opts, tmpDir } = makeSpawnOpts();
  try {
    const { run } = spawnRun(opts);
    run.proc?.kill("SIGKILL");
    const record = toRunRecord(run);
    assert.equal(record.maxTurns, undefined);
    assert.equal(record.graceTurns, 5);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
