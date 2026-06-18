/**
 * v0.15 chains — pure-function tests for resolveChain and buildChainTask.
 *
 * resolveChain: looks up the chains map by persona name; returns undefined
 *   when no chain is configured for that persona.
 *
 * buildChainTask: expands {persona}, {runId}, {task}, {final} template vars.
 *   Falls back to the default template when taskTemplate is undefined.
 *   Reads final.md from disk when finalPath resolves; substitutes a
 *   placeholder when the file is absent.
 *
 * WDD invariants:
 *   W1 — resolveChain returns undefined for missing persona
 *   W2 — resolveChain returns the step for a matching persona
 *   W3 — buildChainTask uses the default template when taskTemplate is undefined
 *   W4 — buildChainTask expands all four vars from a custom template
 *   W5 — buildChainTask substitutes placeholder when finalPath doesn't exist
 *   W6 — buildChainTask reads real final.md content when file exists
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveChain, buildChainTask } from "../src/chain.ts";
import type { ChainStep } from "../src/types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

const BUILDER_STEP: ChainStep = { then: "critic" };
const CUSTOM_STEP: ChainStep = { then: "verifier", taskTemplate: "{persona}|{runId}|{task}|{final}" };

const CHAINS: Record<string, ChainStep> = {
  builder: BUILDER_STEP,
  planner: { then: "designer", timeoutMinutes: 20 },
};

// ── W1: resolveChain returns undefined for missing persona ──────────────

test("resolveChain: returns undefined when chains is undefined", () => {
  assert.strictEqual(resolveChain("builder", undefined), undefined);
});

test("resolveChain: returns undefined when persona not in chains map", () => {
  assert.strictEqual(resolveChain("oracle", CHAINS), undefined);
});

test("resolveChain: returns undefined when then is empty string (disable sentinel)", () => {
  const chains: Record<string, ChainStep> = { builder: { then: "" } };
  assert.strictEqual(resolveChain("builder", chains), undefined);
});

// ── W2: resolveChain returns the step for a matching persona ────────────

test("resolveChain: returns the configured step for a matching persona", () => {
  const step = resolveChain("builder", CHAINS);
  assert.deepStrictEqual(step, BUILDER_STEP);
});

test("resolveChain: returns correct step for second persona", () => {
  const step = resolveChain("planner", CHAINS);
  assert.ok(step, "expected a chain step");
  assert.strictEqual(step.then, "designer");
  assert.strictEqual(step.timeoutMinutes, 20);
});

// ── W3: default template contains all four vars ─────────────────────────

test("buildChainTask: default template expands persona, runId, task vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const ctx = {
      persona: "builder",
      runId: "builder-abc1",
      task: "implement the feature",
      finalPath: join(dir, "nonexistent.md"),
    };
    const result = buildChainTask(undefined, ctx);
    assert.ok(result.includes("builder"), "default template should include persona");
    assert.ok(result.includes("builder-abc1"), "default template should include runId");
    assert.ok(result.includes("implement the feature"), "default template should include task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W4: custom template expands all four vars ───────────────────────────

test("buildChainTask: custom template expands {persona} {runId} {task} {final}", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const finalPath = join(dir, "final.md");
    writeFileSync(finalPath, "the output");
    const ctx = {
      persona: "builder",
      runId: "builder-abc1",
      task: "the task",
      finalPath,
    };
    const result = buildChainTask("{persona}|{runId}|{task}|{final}", ctx);
    assert.strictEqual(result, "builder|builder-abc1|the task|the output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W5: placeholder when finalPath doesn't exist ───────────────────────

test("buildChainTask: uses placeholder when finalPath does not exist", () => {
  const ctx = {
    persona: "builder",
    runId: "builder-x",
    task: "t",
    finalPath: "/tmp/__conductor_nonexistent_final__.md",
  };
  const result = buildChainTask("{final}", ctx);
  assert.ok(!result.includes("{final}"), "template var should be expanded");
  assert.ok(result.length > 0, "should produce non-empty output");
  // Should be the placeholder string (no file content)
  assert.ok(result.trim() === "(no final output)" || result.includes("no final"), 
    `expected placeholder, got: ${result}`);
});

// ── W6: reads real final.md content when file exists ───────────────────

test("buildChainTask: reads final.md content when file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "chain-test-"));
  try {
    const finalPath = join(dir, "final.md");
    writeFileSync(finalPath, "## What I built\nA widget.");
    const ctx = {
      persona: "builder",
      runId: "builder-z",
      task: "build widget",
      finalPath,
    };
    const result = buildChainTask("{final}", ctx);
    assert.strictEqual(result, "## What I built\nA widget.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W7: multiple {var} occurrences all expanded ──────────────────────────

test("buildChainTask: replaces all occurrences of each template variable", () => {
  const ctx = {
    persona: "builder",
    runId: "r1",
    task: "t1",
    finalPath: "/tmp/__conductor_nonexistent__.md",
  };
  const result = buildChainTask("{persona} {persona}", ctx);
  assert.strictEqual(result, "builder builder");
});
