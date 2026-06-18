/**
 * v0.15 chains — finalize trigger tests.
 *
 * Verifies that `onChain` is called exactly once when a run completes
 * successfully, and NOT called when the run fails/is killed or when
 * `onChain` is not provided.
 *
 * Uses `applyChainIfPresent` exported from runs.ts — the same seam
 * pattern used by `applyHookToTerminal` (v0.11) and
 * `applyMergeToTerminal` (v0.14).
 *
 * WDD invariants:
 *   W1 — onChain called when terminal is "completed"
 *   W2 — onChain NOT called when terminal is "failed"
 *   W3 — onChain NOT called when terminal is "killed"
 *   W4 — onChain NOT called when terminal is "hook_failed"
 *   W5 — onChain NOT called when opts.onChain is undefined
 *   W6 — onChain is passed the run object
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyChainIfPresent } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<Run> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "conductor-chain-test-"));
  return {
    id: "builder-test",
    persona: "builder",
    task: "test task",
    status: "completed",
    startedAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    ...overrides,
  } as Run;
}

// ── W1: onChain called when completed ──────────────────────────────────

test("applyChainIfPresent: calls onChain when terminal is completed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir });
    let called = false;
    let calledWith: Run | undefined;

    applyChainIfPresent(run, "completed", (r) => {
      called = true;
      calledWith = r;
    });

    assert.ok(called, "onChain should have been called");
    assert.strictEqual(calledWith, run, "onChain should receive the run object");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W2: onChain NOT called when failed ─────────────────────────────────

test("applyChainIfPresent: does NOT call onChain when terminal is failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir, status: "failed" });
    let called = false;
    applyChainIfPresent(run, "failed", () => { called = true; });
    assert.strictEqual(called, false, "onChain should NOT be called for failed runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W3: onChain NOT called when killed ─────────────────────────────────

test("applyChainIfPresent: does NOT call onChain when terminal is killed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir, status: "killed" });
    let called = false;
    applyChainIfPresent(run, "killed", () => { called = true; });
    assert.strictEqual(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W4: onChain NOT called when hook_failed ────────────────────────────

test("applyChainIfPresent: does NOT call onChain when terminal is hook_failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir, status: "hook_failed" });
    let called = false;
    applyChainIfPresent(run, "hook_failed", () => { called = true; });
    assert.strictEqual(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W5: no-op when onChain is undefined ───────────────────────────────

test("applyChainIfPresent: no-op when callback is undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir, status: "completed" });
    // should not throw
    assert.doesNotThrow(() => applyChainIfPresent(run, "completed", undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W6: exception in onChain is swallowed (never crashes finalize) ─────

test("applyChainIfPresent: swallows exceptions thrown by onChain", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const run = makeRun({ cwd: dir, status: "completed" });
    assert.doesNotThrow(() =>
      applyChainIfPresent(run, "completed", () => {
        throw new Error("chain spawn failed");
      })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
