import { matchesGlob } from "node:path";
import type { Run, RunEffort } from "../types.ts";
import { isSettled } from "../types.ts";
import { WRITE_CAPABLE_PERSONAS } from "../personas.ts";
import type { EffortRecord } from "./store.ts";
import { changedPaths as branchChangedPaths } from "./generated.ts";
import { isGeneratedPath, type EffortPolicy } from "./policy.ts";

export interface AdmissionLimits { maxConcurrent: number; maxConcurrentWriteCapable: number }
export const consumesSlot = (run: Run): boolean => !isSettled(run.status) && run.status !== "queued" && run.status !== "integrating";
/** The global cap's reservation: a live status, or a settled run whose owned process has not closed yet (N3). */
export const holdsSlot = (run: Run): boolean => consumesSlot(run) || run.processOpen === true;
const declared = (touches?: readonly string[]): readonly string[] => touches?.length ? touches : ["**"];
// Whole literal segments only. Unknown glob syntax loses precision, never a collision.
const prefix = (glob: string): string[] => {
  const parts = glob.split("/");
  const magic = parts.findIndex(part => /[*?\[\]{}()!+@\\]/.test(part));
  return magic < 0 ? parts : parts.slice(0, magic);
};
export function footprintsOverlap(a: string, b: string): boolean {
  const left = prefix(a), right = prefix(b);
  return left.slice(0, Math.min(left.length, right.length)).every((part, i) => part === right[i]);
}
/** Exclusion requires containment, not intersection. Complex policies only match concrete paths. */
function covered(glob: string, generated: EffortPolicy["generated"]): boolean {
  if (!generated || glob === "**") return false;
  if (!/[*?\[\]{}()!+@\\]/.test(glob)) return isGeneratedPath(glob, generated);
  return generated.paths.some(g => g === glob || (g.endsWith("/**") && !/[*?\[\]{}()!+@\\]/.test(g.slice(0, -3)) && glob.startsWith(g.slice(0, -2))));
}
function holdsFootprint(run: Run): boolean {
  // M7: a reader writes nothing integrated, so it reserves no paths.
  if (run.effort?.role !== "writer" || run.mergeResult?.success) return false;
  // Cancelled placeholders never owned a workspace. Lost/failed writers retain their reservation.
  return run.status === "queued" || consumesSlot(run) || run.status === "blocked" || run.status === "integrating" || !!run.effort.spawnBase || !!run.worktreeBranch;
}
export function admitEffortWriter(candidate: { id?: string; persona: string; effort?: RunEffort }, members: readonly Run[], limits: AdmissionLimits, record?: EffortRecord, efforts: readonly EffortRecord[] = [], waitingBehind: ReadonlySet<string> = new Set()): string | undefined {
  const others = members.filter(r => r.id !== candidate.id);
  const active = others.filter(consumesSlot);
  if (others.filter(holdsSlot).length >= limits.maxConcurrent) return `waits for maxConcurrent (${limits.maxConcurrent})`;
  if (!candidate.effort) {
    if (WRITE_CAPABLE_PERSONAS.has(candidate.persona) && active.filter(r => !r.effort && WRITE_CAPABLE_PERSONAS.has(r.persona)).length >= limits.maxConcurrentWriteCapable) return `waits for maxConcurrentWriteCapable (${limits.maxConcurrentWriteCapable})`;
    return;
  }
  if (!record || record.gitRoot !== candidate.effort.gitRoot || record.name !== candidate.effort.name) return "effort admission requires a validated isolated writer assignment";
  switch (candidate.effort.role) {
    case "reader": return; // the general cap above only: no maxParallel charge, no footprint
    case "writer": break;
    default: return "effort admission requires a validated isolated writer assignment";
  }
  if (efforts.some(e => e.owner.sessionId !== record.owner.sessionId || e.owner.pid !== record.owner.pid || e.owner.startTime !== record.owner.startTime)) return "waits for same-repository effort ownership resolution (foreign effort)";
  if (efforts.some(e => e.members.some(id => id !== candidate.id && !members.some(r => r.id === id)))) return "waits for unobserved same-repository effort assignments; recovery required";
  if (active.filter(r => r.effort?.role === "writer" && r.effort.gitRoot === record.gitRoot && r.effort.name === record.name).length >= record.policy.maxParallel) return `waits for effort maxParallel (${record.policy.maxParallel})`;
  const touches = [...declared(candidate.effort.touches), ...(candidate.effort.changedPaths ?? []), ...(candidate.effort.footprintUnknown ? ["**"] : [])];
  for (const run of others) {
    if (waitingBehind.has(run.id) && run.status === "queued") continue;
    // A retry replaces its own earlier attempts' preserved reservations, and nobody else's.
    if (candidate.effort.retryOf?.includes(run.id)) continue;
    if (!holdsFootprint(run) || run.effort!.gitRoot !== record.gitRoot) continue;
    // Different efforts can freeze different generated policies. Never infer shared permission.
    const footprint = [...declared(run.effort!.touches), ...(run.integration?.changedPaths ?? run.effort!.changedPaths ?? [])];
    if (run.effort!.footprintUnknown || (isSettled(run.status) && run.status !== "blocked")) footprint.push("**");
    const generated = run.effort!.name === record.name && !touches.includes("**") && !footprint.includes("**") ? record.policy.generated : undefined;
    if (touches.some(a => !covered(a, generated) && footprint.some(b => !covered(b, generated) && footprintsOverlap(a, b)))) return `waits on ${run.id} (touches overlap)`;
  }
}

/** NUL records and no rename folding retain both endpoints, deletes and mode-only changes. */
export function measureEffortFootprint(run: Run, branchHead: string, policy: EffortPolicy): { changedPaths: string[]; touchViolations: string[] } {
  if (!run.effort?.spawnBase) throw new Error("missing effort spawn base; footprint unknown");
  const changedPaths = branchChangedPaths(run.effort.gitRoot, run.effort.spawnBase, branchHead);
  const touchViolations = changedPaths.filter(path => !isGeneratedPath(path, policy.generated) && !declared(run.effort!.touches).some(glob => matchesGlob(path, glob)));
  return { changedPaths, touchViolations };
}
