/**
 * v0.15 chains — pure helper functions for persona chain resolution.
 *
 * No I/O except for `buildChainTask`, which reads `finalPath` from disk
 * (best-effort; falls back to a placeholder string on any error).
 */

import { readFileSync, existsSync } from "node:fs";
import type { ChainStep } from "./types.ts";
import type { FailureClass } from "./failure-classify.ts";

export type { ChainStep };

const DEFAULT_TEMPLATE =
  "Review the preceding {persona} run ({runId}).\n\nOriginal task:\n{task}\n\n---\nFinal output:\n{final}";

/**
 * Template used when the builder ran with `mergeStrategy: "none"` and left
 * its work on a branch. The critic needs to diff that branch against base
 * rather than reading merged output.
 */
export const WORKTREE_CHAIN_TEMPLATE =
  "Review the preceding {persona} run ({runId}).\n\n" +
  "The work is on branch `{worktreeBranch}` (not yet merged to `{baseBranch}`).\n" +
  "Run the following to inspect the changes:\n\n" +
  "```bash\n" +
  "git diff {baseBranch}...{worktreeBranch}\n" +
  "```\n\n" +
  "Original task:\n{task}";

const FINAL_PLACEHOLDER = "(no final output)";

/**
 * Look up the chain step configured for `personaName` in the chains map.
 * Returns `undefined` when the persona has no chain or `chains` is falsy.
 */
export function resolveChain(
  personaName: string,
  chains: Record<string, ChainStep> | undefined,
): ChainStep | undefined {
  if (!chains) return undefined;
  const step = chains[personaName];
  // Empty string `then` is the explicit-disable sentinel — mirrors
  // `on_complete_hook`'s empty-string disable convention.
  if (!step || !step.then) return undefined;
  return step;
}

/**
 * Expand the task template for a chained run.
 *
 * Template variables:
 *   {persona}        — parent run's persona name
 *   {runId}          — parent run's ID
 *   {task}           — parent run's original task
 *   {final}          — contents of `finalPath` on disk (or placeholder)
 *   {worktreeBranch} — worktree branch name (if set on run)
 *   {baseBranch}     — base branch name (if set on run)
 *
 * Template selection (when `taskTemplate` is undefined):
 *   - `mergeStrategy === "none"` AND `worktreeBranch` is set → `WORKTREE_CHAIN_TEMPLATE`
 *   - otherwise → `DEFAULT_TEMPLATE`
 */
export function buildChainTask(
  taskTemplate: string | undefined,
  context: {
    persona: string;
    runId: string;
    task: string;
    finalPath: string;
    worktreeBranch?: string;
    baseBranch?: string;
    mergeStrategy?: string;
  },
): string {
  let template: string;
  if (taskTemplate !== undefined) {
    template = taskTemplate;
  } else if (
    context.mergeStrategy === "none" &&
    context.worktreeBranch
  ) {
    template = WORKTREE_CHAIN_TEMPLATE;
  } else {
    template = DEFAULT_TEMPLATE;
  }

  let finalContent = FINAL_PLACEHOLDER;
  if (existsSync(context.finalPath)) {
    try {
      finalContent = readFileSync(context.finalPath, "utf-8");
    } catch {
      // best-effort
    }
  }

  return template
    .replace(/\{persona\}/g, context.persona)
    .replace(/\{runId\}/g, context.runId)
    .replace(/\{task\}/g, context.task)
    .replace(/\{final\}/g, finalContent)
    .replace(/\{worktreeBranch\}/g, context.worktreeBranch ?? "")
    .replace(/\{baseBranch\}/g, context.baseBranch ?? "");
}

// ── v0.18 plans-as-hypotheses re-evaluation ─────────────────────────────

/**
 * Verdict from evaluating a completed chain-parent's outcome before
 * spawning its successor. Ports Metaphor's RePlanner posture: "the first
 * plan is always incomplete."
 *
 *   - `proceed` — spawn the configured `then` as planned.
 *   - `adapt`   — spawn a DIFFERENT successor instead of `then`.
 *   - `insert`  — spawn a remediation step first (S5 wires the deferral
 *                 of `then`; the deterministic S3 layer never emits this).
 *   - `stop`    — halt the chain and escalate to the human.
 */
export type ReplanVerdict =
  | { readonly kind: "proceed" }
  | { readonly kind: "adapt"; readonly persona: string; readonly task: string }
  | { readonly kind: "insert"; readonly persona: string; readonly task: string }
  | { readonly kind: "stop"; readonly reason: string };

/**
 * Explicit halt signals a producer may emit in its final output to abort
 * the chain. Regex-matched (case-insensitive). Kept conservative — only
 * unambiguous, intentional markers, not incidental prose. `blocked:` uses
 * a word boundary so `unblocked:` / `roadblocked:` (natural success prose)
 * do NOT false-halt the chain.
 */
const STOP_SIGNALS: readonly RegExp[] = [
  /chain: stop/i,
  /do not proceed/i,
  /cannot proceed/i,
  /halt the chain/i,
  /\bblocked:/i,
  /escalate to human/i,
];

/**
 * Deterministic re-plan verdict. Pure: no I/O, no clock, no LLM.
 *
 * S3 ships the conservative deterministic layer:
 *   1. A non-retryable failure class on the parent → `stop` (a chain
 *      normally fires only on `completed`, but this keeps the function
 *      total and ready for the autonomous executor which re-evals after
 *      failures too).
 *   2. An explicit stop signal in the parent's final output → `stop`.
 *   3. Otherwise → `proceed`.
 *
 * `adapt` / `insert` are reserved for the LLM-backed verdict wired in the
 * autonomous executor (S5); the deterministic layer never emits them, so
 * S3's behavior is exactly "proceed unless explicitly halted."
 */
export function evaluateChainOutcome(input: {
  parentFinal: string;
  parentFailureClass?: FailureClass;
  step: ChainStep;
}): ReplanVerdict {
  // 1. Deterministic-cause / human-gated failures halt the chain.
  const fc = input.parentFailureClass;
  if (fc === "logic" || fc === "syntax" || fc === "permission") {
    return { kind: "stop", reason: `parent failed with non-retryable class '${fc}'` };
  }

  // 2. Explicit halt signal in the final output.
  for (const sig of STOP_SIGNALS) {
    if (sig.test(input.parentFinal)) {
      return { kind: "stop", reason: `parent output signalled halt (${sig.source})` };
    }
  }

  // 3. Default: the plan holds.
  return { kind: "proceed" };
}
