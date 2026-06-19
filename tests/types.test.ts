/**
 * Tests for the RunStatus / TERMINAL_STATUSES contract.
 *
 * Slice 1a of v0.11 adds `"hook_failed"` as a new terminal status; these
 * tests pin its membership and `isTerminal` semantics. Slice 2 produces
 * the value at runtime; this slice only declares the type contract.
 *
 * Parallel-formula compliance: tests import `TERMINAL_STATUSES` and
 * `isTerminal` directly from `src/types.ts`. They do not re-derive
 * the membership.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_STATUSES,
  isTerminal,
  type RunStatus,
} from "../src/types.ts";

test("RunStatus union: hook_failed is a member of TERMINAL_STATUSES", () => {
  assert.equal(TERMINAL_STATUSES.includes("hook_failed" as RunStatus), true);
});

test("isTerminal: hook_failed is terminal", () => {
  assert.equal(isTerminal("hook_failed" as RunStatus), true);
});

test("isTerminal: existing terminals (completed/failed/killed/timeout) still terminal", () => {
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("killed"), true);
  assert.equal(isTerminal("timeout"), true);
});

test("isTerminal: non-terminals (queued/running/paused) are not terminal", () => {
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal("paused"), false);
});

// ── v0.17-S1 witnesses ──────────────────────────────────────────────────────

test("v0.17-S1 W1: aborted is a member of TERMINAL_STATUSES", () => {
  assert.equal(TERMINAL_STATUSES.includes("aborted" as RunStatus), true);
});

test("v0.17-S1 W2: isTerminal aborted returns true", () => {
  assert.equal(isTerminal("aborted" as RunStatus), true);
});

test("v0.17-S1 W2: isTerminal merge_conflict returns true (pre-existing omission now fixed in tools.ts)", () => {
  // merge_conflict was in TERMINAL_STATUSES but the private isTerminalStatus in
  // tools.ts omitted it. This test pins the public isTerminal for completeness.
  assert.equal(isTerminal("merge_conflict" as RunStatus), true);
});

test("v0.17-S1 W4: TERMINAL_STATUSES has exactly 7 members after adding aborted", () => {
  // completed, failed, killed, timeout, hook_failed, merge_conflict, aborted
  assert.equal(TERMINAL_STATUSES.length, 7);
});
