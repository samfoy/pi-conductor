/**
 * pi-conductor — v0.18 Slice 2: classified-retry planning (pure).
 *
 * Turns the S1 failure taxonomy into an actionable retry: resolve the
 * effective RetryPolicy via the standard 5-layer cascade, and build the
 * diagnostic-augmented task for the re-spawn.
 *
 * Pure: no I/O, no clock. Mirrors `src/turn-limit.ts`'s cascade shape and
 * `src/chain.ts`'s task-template shape.
 *
 * The retry DECISION (`shouldRetry`) and the taxonomy (`classifyFailure`,
 * `FailureClass`, `RetryPolicy`, `DEFAULT_RETRY_POLICY`) live in
 * `src/failure-classify.ts`; this module composes them into a spawn plan.
 */

import type { FailureClass, RetryPolicy } from "./failure-classify.ts";
import { DEFAULT_RETRY_POLICY } from "./failure-classify.ts";

// ── Cascade resolution ──────────────────────────────────────────────────

/**
 * One layer's contribution to the retry cascade. A layer may specify the
 * attempt budget, the retryable set, both, or neither. Absent fields fall
 * through to the next-lower layer.
 */
export interface RetryPolicySpec {
  readonly maxAttempts?: number;
  readonly retryableClasses?: readonly FailureClass[];
}

/**
 * Cascade inputs, highest-priority first. Mirrors `resolveMaxTurns`:
 *   per-call > project config > user config > persona frontmatter > built-in.
 */
export interface RetryCascadeInput {
  readonly perCall?: RetryPolicySpec;
  readonly project?: RetryPolicySpec;
  readonly user?: RetryPolicySpec;
  readonly persona?: RetryPolicySpec;
  /** Built-in default; defaults to DEFAULT_RETRY_POLICY when omitted. */
  readonly builtin?: RetryPolicy;
}

/**
 * Resolve the effective RetryPolicy. Each FIELD cascades independently
 * (a per-call `maxAttempts` does not blow away a project `retryableClasses`),
 * matching the field-level merge philosophy in `config.ts`.
 *
 * `maxAttempts` is clamped to ≥ 1 (0 or negative would mean "never run",
 * which is nonsensical — the first attempt always happens).
 */
export function resolveRetryPolicy(input: RetryCascadeInput): RetryPolicy {
  const builtin = input.builtin ?? DEFAULT_RETRY_POLICY;
  const layers = [input.perCall, input.project, input.user, input.persona];

  let maxAttempts: number | undefined;
  let retryableClasses: readonly FailureClass[] | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    if (maxAttempts === undefined && typeof layer.maxAttempts === "number") {
      maxAttempts = layer.maxAttempts;
    }
    if (retryableClasses === undefined && layer.retryableClasses) {
      retryableClasses = layer.retryableClasses;
    }
  }

  return {
    maxAttempts: Math.max(1, Math.floor(maxAttempts ?? builtin.maxAttempts)),
    retryableClasses: retryableClasses ?? builtin.retryableClasses,
  };
}

// ── Retry task augmentation ─────────────────────────────────────────────

/**
 * Build the task for a retry spawn: the pristine original task plus a
 * diagnostic preamble so the retried sub-agent knows what went wrong last
 * time (Metaphor's "retry with the classification as context").
 *
 * `originalTask` MUST be the pristine first-attempt task — never a
 * previously-augmented one — so a second retry doesn't stack preambles.
 * The retry loop keeps the original in a closure for exactly this reason.
 */
export function buildRetryTask(input: {
  readonly originalTask: string;
  readonly failureClass: FailureClass;
  readonly attempt: number; // 0-indexed attempt that just FAILED
  readonly maxAttempts: number;
  readonly errorMessage?: string;
}): string {
  const nextAttempt = input.attempt + 2; // human 1-indexed: failed attempt+1, next is +2
  const diag = input.errorMessage?.trim()
    ? `\nLast error:\n${input.errorMessage.trim()}\n`
    : "";
  return (
    `## Retry (attempt ${nextAttempt} of ${input.maxAttempts})\n\n` +
    `A previous attempt at this task failed with classification \`${input.failureClass}\`. ` +
    `Do not repeat the same approach if it was the cause; address the failure below first, ` +
    `then complete the task.\n${diag}\n` +
    `---\n\n` +
    input.originalTask
  );
}
