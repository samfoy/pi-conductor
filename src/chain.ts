/**
 * v0.15 chains — pure helper functions for persona chain resolution.
 *
 * No I/O except for `buildChainTask`, which reads `finalPath` from disk
 * (best-effort; falls back to a placeholder string on any error).
 */

import { readFileSync, existsSync } from "node:fs";
import type { ChainStep } from "./types.ts";

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
