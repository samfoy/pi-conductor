/**
 * pi-conductor — v0.18 Slice 1: failure classification (pure).
 *
 * Ports Metaphor's failure taxonomy. Given a terminal failure signal,
 * classify it into a `FailureClass` so downstream logic (classified
 * retry in S2, autonomous re-plan in S3/S5, doctor/history surfaces) can
 * decide whether re-running is worthwhile or a human must intervene.
 *
 * Pure: no I/O, no clock. Mirrors `src/watchdog.ts`'s detector shape.
 * Classification is deterministic-first — terminal status and
 * termination reason pin the obvious cases before the fuzzy stderr
 * probes run, so a known cause (timeout/stall/turns) can never be
 * overridden by an incidental substring match in the log tail.
 */

import type { RunStatus } from "./types.ts";
import type { TerminationReason } from "./runs.ts";

// ── Public API ────────────────────────────────────────────────────────

export type FailureClass =
  | "syntax" // build/compile/parse error in the sub-agent's output
  | "logic" // test assertions failed (code ran, produced wrong result)
  | "test" // test harness/runner failed to execute (infra of tests)
  | "environment" // missing dep, brazil/npm setup, path, tool not found
  | "permission" // denied host op / tool permission / auth (mwinit) failure
  | "timeout" // wall-clock timeout terminal
  | "stall" // watchdog hard-stall kill
  | "turns" // turn-limit abort (v0.17 "aborted")
  | "unknown"; // classifier could not decide

export interface FailureSignal {
  /** The terminal status the run settled into. */
  readonly terminal: RunStatus;
  /** Process exit code, when the run exited naturally. */
  readonly exitCode?: number;
  /** Last slice of the sub-agent's stderr (bounded upstream). */
  readonly stderrTail?: string;
  /** Human-readable error message set on the run, if any. */
  readonly errorMessage?: string;
  /** Reason a forceTerminate fired (killed/timeout/stalled/aborted). */
  readonly terminationReason?: TerminationReason;
}

/**
 * A single fuzzy probe. `test(haystack)` matches the combined
 * lower-cased stderrTail + errorMessage. Ordered highest-priority
 * first; the first match wins. Exported for unit testing.
 */
export interface Probe {
  readonly cls: FailureClass;
  readonly test: (haystack: string) => boolean;
}

const has = (...needles: string[]) => (h: string) =>
  needles.some((n) => h.includes(n));

/**
 * Fuzzy probes for the ambiguous `failed` / `hook_failed` terminals.
 * Priority order matters: permission (needs a human) is checked before
 * environment (transient), which is checked before syntax/test/logic
 * (deterministic code problems). First match wins.
 */
export const PROBES: readonly Probe[] = [
  {
    cls: "permission",
    test: has(
      "permission denied",
      "eacces",
      "not authorized",
      "mwinit",
      "midway",
      "credentials expired",
      "403 forbidden",
      "access denied",
      "operation not permitted",
    ),
  },
  {
    cls: "environment",
    test: has(
      "command not found",
      "no such file or directory",
      "enoent",
      "cannot find module",
      "module not found",
      "econnrefused",
      "etimedout",
      "network is unreachable",
      "network error",
      "brazil-build",
      "could not resolve",
      "unable to locate",
      "version not found",
    ),
  },
  {
    cls: "syntax",
    test: has(
      "syntaxerror",
      "parse error",
      "unexpected token",
      "compile error",
      "compilation failed",
      "ts(",
      "cannot find name",
      "type error",
    ),
  },
  {
    cls: "test",
    test: has(
      "test suite failed to run",
      "no tests found",
      "jest encountered",
      "cannot run tests",
      "test runner",
    ),
  },
  {
    cls: "logic",
    test: has(
      "assertionerror",
      "assertion failed",
      "expect(",
      "tests failed",
      "test failed",
      "failing tests",
    ),
  },
];

/**
 * Classify a terminal failure. Deterministic-first:
 *
 *   1. `terminationReason` (a forceTerminate cause) pins timeout/stall/turns.
 *   2. `terminal` status pins timeout ("timeout") and turns ("aborted")
 *      and merge_conflict (→ logic; the merge exposed conflicting edits).
 *   3. Otherwise (`failed` / `hook_failed` / bare `killed`) run the fuzzy
 *      PROBES over stderrTail+errorMessage; first match wins.
 *   4. No signal → "unknown".
 *
 * `completed` returns "unknown" (callers should not classify successes;
 * guarding here keeps the function total).
 */
export function classifyFailure(sig: FailureSignal): FailureClass {
  // 1. Termination reason is the most authoritative signal.
  switch (sig.terminationReason) {
    case "timeout":
      return "timeout";
    case "stalled":
      return "stall";
    case "aborted":
      return "turns";
    // "killed" is ambiguous (user Ctrl+C, shutdown, or crash) — fall through.
    case "killed":
    case undefined:
      break;
  }

  // 2. Terminal status pins the remaining deterministic cases.
  switch (sig.terminal) {
    case "timeout":
      return "timeout";
    case "aborted":
      return "turns";
    case "merge_conflict":
      return "logic";
    case "completed":
      return "unknown";
    default:
      break; // failed / hook_failed / killed → probe.
  }

  // 3. Fuzzy probes over the combined log surface.
  const haystack = `${sig.stderrTail ?? ""}\n${sig.errorMessage ?? ""}`.toLowerCase();
  if (haystack.trim()) {
    for (const probe of PROBES) {
      if (probe.test(haystack)) return probe.cls;
    }
  }

  // 4. Nothing matched.
  return "unknown";
}

// ── Retry decision ──────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retry. */
  readonly maxAttempts: number;
  /** Failure classes worth re-running. Deterministic-cause classes
   *  (syntax/logic) and human-gated classes (permission) are excluded
   *  by default — re-running reproduces the same result or needs a human. */
  readonly retryableClasses: readonly FailureClass[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  retryableClasses: ["environment", "stall", "timeout", "test"],
};

/**
 * Decide whether a run that failed with `cls` on its `attempt`-th try
 * (0-indexed: 0 = original spawn) should be retried under `policy`.
 *
 * Pure and total. Returns false once attempts are exhausted or the class
 * is not in the retryable set.
 */
export function shouldRetry(
  cls: FailureClass,
  attempt: number,
  policy: RetryPolicy,
): boolean {
  if (policy.maxAttempts <= 1) return false;
  if (attempt >= policy.maxAttempts - 1) return false;
  return policy.retryableClasses.includes(cls);
}
