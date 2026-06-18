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
  return chains[personaName];
}

/**
 * Expand the task template for a chained run.
 *
 * Template variables:
 *   {persona} — parent run's persona name
 *   {runId}   — parent run's ID
 *   {task}    — parent run's original task
 *   {final}   — contents of `finalPath` on disk (or placeholder)
 *
 * Falls back to the default review template when `taskTemplate` is undefined.
 */
export function buildChainTask(
  taskTemplate: string | undefined,
  context: {
    persona: string;
    runId: string;
    task: string;
    finalPath: string;
  },
): string {
  const template = taskTemplate ?? DEFAULT_TEMPLATE;

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
    .replace(/\{final\}/g, finalContent);
}
