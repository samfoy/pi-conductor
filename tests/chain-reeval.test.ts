/**
 * v0.18-S3 — plans-as-hypotheses re-evaluation: evaluateChainOutcome.
 *
 * Pure deterministic verdict. Coverage:
 *   1. clean final + no failure → proceed
 *   2. non-retryable failure class (logic/syntax/permission) → stop
 *   3. retryable/undefined failure class does NOT stop on class alone
 *   4. explicit stop signals in final → stop (case-insensitive)
 *   5. incidental prose containing a near-signal → proceed (no false halt)
 *   6. deterministic layer never emits adapt/insert
 */

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateChainOutcome, type ChainStep } from "../src/chain.ts";

const STEP: ChainStep = { then: "critic", reevaluate: true };

test("clean final, no failure → proceed", () => {
  const v = evaluateChainOutcome({ parentFinal: "All done, tests pass.", step: STEP });
  assert.equal(v.kind, "proceed");
});

test("non-retryable failure class → stop", () => {
  for (const fc of ["logic", "syntax", "permission"] as const) {
    const v = evaluateChainOutcome({ parentFinal: "x", parentFailureClass: fc, step: STEP });
    assert.equal(v.kind, "stop", `${fc} should stop`);
    if (v.kind === "stop") assert.match(v.reason, new RegExp(fc));
  }
});

test("retryable/undefined failure class does not stop on class alone", () => {
  for (const fc of ["environment", "stall", "timeout", "test", "unknown"] as const) {
    const v = evaluateChainOutcome({ parentFinal: "ok", parentFailureClass: fc, step: STEP });
    assert.equal(v.kind, "proceed", `${fc} should proceed`);
  }
  assert.equal(evaluateChainOutcome({ parentFinal: "ok", step: STEP }).kind, "proceed");
});

test("explicit stop signals halt the chain (case-insensitive)", () => {
  const signals = [
    "CHAIN: STOP now",
    "I cannot proceed with this",
    "Do Not Proceed — the schema is undefined",
    "BLOCKED: waiting on upstream",
    "recommend we halt the chain here",
    "please escalate to human",
  ];
  for (const final of signals) {
    const v = evaluateChainOutcome({ parentFinal: final, step: STEP });
    assert.equal(v.kind, "stop", `"${final}" should stop`);
  }
});

test("incidental prose near a signal does not false-halt", () => {
  // "proceed" appears but not as a stop signal; "block" without colon.
  const v = evaluateChainOutcome({
    parentFinal: "The plan will proceed smoothly; I refactored the block allocator.",
    step: STEP,
  });
  assert.equal(v.kind, "proceed");
});

test("'unblocked:' / 'roadblocked:' do not false-halt (word-boundary fix)", () => {
  for (const final of [
    "unblocked: the race condition, tests green",
    "I unblocked: the deadlock and shipped",
    "roadblocked: earlier but now resolved",
  ]) {
    const v = evaluateChainOutcome({ parentFinal: final, step: STEP });
    assert.equal(v.kind, "proceed", `"${final}" must proceed`);
  }
  // but a real 'blocked:' at a word boundary still halts
  assert.equal(
    evaluateChainOutcome({ parentFinal: "Status blocked: waiting on API", step: STEP }).kind,
    "stop",
  );
});

test("deterministic layer never emits adapt or insert", () => {
  const finals = ["done", "blocked: x", "proceed", ""];
  for (const f of finals) {
    const v = evaluateChainOutcome({ parentFinal: f, step: STEP });
    assert.notEqual(v.kind, "adapt");
    assert.notEqual(v.kind, "insert");
  }
});
