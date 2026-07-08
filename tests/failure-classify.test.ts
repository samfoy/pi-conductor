/**
 * Tests for the v0.18 Slice 1 failure classifier — pure
 * `classifyFailure` + `shouldRetry`.
 *
 * Scope: classification + retry decision only. No re-spawn loop (S2),
 * no autonomous executor (S5). Pure functions of an injected signal.
 *
 * Coverage targets (per docs/v0.18-autonomous-mode-design.md §F1):
 *   Deterministic-first:
 *     1. terminationReason timeout/stalled/aborted pin the class
 *     2. terminal timeout/aborted/merge_conflict pin the class
 *     3. deterministic reason beats a misleading stderr substring
 *   Fuzzy probes (failed / hook_failed / bare killed):
 *     4. permission > environment > syntax > test > logic priority
 *     5. no signal → unknown
 *     6. completed → unknown (guard)
 *   Retry:
 *     7. maxAttempts<=1 never retries
 *     8. exhausted attempts stop
 *     9. non-retryable class stops even with budget
 *    10. retryable class within budget retries
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFailure,
  shouldRetry,
  DEFAULT_RETRY_POLICY,
  PROBES,
  type RetryPolicy,
} from "../src/failure-classify.ts";

// ── Deterministic-first ────────────────────────────────────────────────

test("terminationReason timeout → timeout", () => {
  assert.equal(
    classifyFailure({ terminal: "timeout", terminationReason: "timeout" }),
    "timeout",
  );
});

test("terminationReason stalled → stall (even though status is killed)", () => {
  // forceTerminate maps stalled → status "killed"; the reason preserves it.
  assert.equal(
    classifyFailure({
      terminal: "killed",
      terminationReason: "stalled",
      errorMessage: "watchdog: hard-stalled",
    }),
    "stall",
  );
});

test("terminationReason aborted → turns", () => {
  assert.equal(
    classifyFailure({ terminal: "aborted", terminationReason: "aborted" }),
    "turns",
  );
});

test("terminal merge_conflict → logic", () => {
  assert.equal(classifyFailure({ terminal: "merge_conflict" }), "logic");
});

test("deterministic reason beats a misleading stderr substring", () => {
  // stderr screams "permission denied" but the run actually timed out.
  assert.equal(
    classifyFailure({
      terminal: "timeout",
      terminationReason: "timeout",
      stderrTail: "permission denied while cleaning up",
    }),
    "timeout",
  );
});

test("bare killed with no reason falls through to probes", () => {
  assert.equal(
    classifyFailure({
      terminal: "killed",
      terminationReason: "killed",
      stderrTail: "npm ERR! cannot find module 'foo'",
    }),
    "environment",
  );
});

// ── Fuzzy probes + priority ─────────────────────────────────────────────

test("permission outranks environment", () => {
  assert.equal(
    classifyFailure({
      terminal: "failed",
      stderrTail: "EACCES: permission denied, and also command not found",
    }),
    "permission",
  );
});

test("mwinit/midway → permission", () => {
  assert.equal(
    classifyFailure({
      terminal: "failed",
      errorMessage: "Midway credentials expired — run mwinit -o",
    }),
    "permission",
  );
});

test("environment outranks syntax", () => {
  assert.equal(
    classifyFailure({
      terminal: "failed",
      stderrTail: "Cannot find module './x'\nSyntaxError: unexpected token",
    }),
    "environment",
  );
});

test("syntax when only a compile error is present", () => {
  assert.equal(
    classifyFailure({
      terminal: "hook_failed",
      stderrTail: "src/foo.ts(12,3): error TS2304: Cannot find name 'bar'.",
    }),
    "syntax",
  );
});

test("test-harness failure → test", () => {
  assert.equal(
    classifyFailure({
      terminal: "failed",
      stderrTail: "Test suite failed to run",
    }),
    "test",
  );
});

test("assertion failure → logic", () => {
  assert.equal(
    classifyFailure({
      terminal: "failed",
      stderrTail: "AssertionError [ERR_ASSERTION]: 1 !== 2\n3 tests failed",
    }),
    "logic",
  );
});

test("no signal → unknown", () => {
  assert.equal(classifyFailure({ terminal: "failed" }), "unknown");
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "   \n  " }),
    "unknown",
  );
});

test("completed → unknown (guard; callers should not classify success)", () => {
  assert.equal(classifyFailure({ terminal: "completed", exitCode: 0 }), "unknown");
});

test("PROBES priority order is permission→environment→syntax→test→logic", () => {
  assert.deepEqual(
    PROBES.map((p) => p.cls),
    ["permission", "environment", "syntax", "test", "logic"],
  );
});

test("tightened probes: benign 'expected'/'unexpected' no longer forced to logic", () => {
  // Bare "expected"/"unexpected error" are generic crash prose, not a
  // test-logic signal — they must fall through to unknown so S2 doesn't
  // deny a legitimate retry (critic blocker 1).
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "An unexpected error occurred during run" }),
    "unknown",
  );
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "Output was not as expected by reviewer" }),
    "unknown",
  );
});

test("tightened probes: runtime TypeError is not miscalled syntax", () => {
  // A runtime `TypeError:` is not a parse/compile failure. With
  // "typeerror:" removed from the syntax probe it falls through.
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "TypeError: cannot read properties of undefined" }),
    "unknown",
  );
});

test("tightened probes: 'social network' noun does not trip environment", () => {
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "building the social network integration module" }),
    "unknown",
  );
  // but a real network error still classifies
  assert.equal(
    classifyFailure({ terminal: "failed", stderrTail: "connect: network is unreachable" }),
    "environment",
  );
});

// ── Retry decision ──────────────────────────────────────────────────────

test("maxAttempts<=1 never retries", () => {
  const policy: RetryPolicy = { maxAttempts: 1, retryableClasses: ["environment"] };
  assert.equal(shouldRetry("environment", 0, policy), false);
});

test("exhausted attempts stop", () => {
  const policy: RetryPolicy = { maxAttempts: 3, retryableClasses: ["environment"] };
  // attempt is 0-indexed: attempt 2 is the 3rd (last) try.
  assert.equal(shouldRetry("environment", 2, policy), false);
  assert.equal(shouldRetry("environment", 1, policy), true);
});

test("non-retryable class stops even with budget", () => {
  const policy: RetryPolicy = { maxAttempts: 3, retryableClasses: ["environment"] };
  assert.equal(shouldRetry("logic", 0, policy), false);
  assert.equal(shouldRetry("permission", 0, policy), false);
});

test("retryable class within budget retries", () => {
  assert.equal(shouldRetry("environment", 0, { maxAttempts: 2, retryableClasses: ["environment"] }), true);
});

test("DEFAULT_RETRY_POLICY excludes logic/syntax/permission", () => {
  assert.equal(DEFAULT_RETRY_POLICY.retryableClasses.includes("logic"), false);
  assert.equal(DEFAULT_RETRY_POLICY.retryableClasses.includes("syntax"), false);
  assert.equal(DEFAULT_RETRY_POLICY.retryableClasses.includes("permission"), false);
  assert.equal(DEFAULT_RETRY_POLICY.retryableClasses.includes("environment"), true);
});
