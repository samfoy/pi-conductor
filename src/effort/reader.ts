// M7 effort readers: a detached view of the integration tip, proven untouched before it counts as a review.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { childExitUnconfirmed, isTerminal, type EffortRole, type FinalizerVerdict, type Persona, type Run, type RunEffort } from "../types.ts";
import { effortGit } from "./open.ts";
import { assertCandidateIndexFlags } from "./git.ts";
import { assertRunEffortOwner, readEffort, writeEffort, type EffortRecord } from "./store.ts";

/** `read_only` alone decides; no persona name or flag turns a read-only persona into a writer. */
export const effortRole = (persona: Pick<Persona, "readOnly">): EffortRole => persona.readOnly === true ? "reader" : "writer";

/** The frozen assignment snapshot that a queued placeholder, admission and the actual spawn share. */
export function effortAssignment(effort: EffortRecord, opts: { persona: Pick<Persona, "readOnly">; touches?: readonly string[]; retryOf?: readonly string[] }): RunEffort {
  const role = effortRole(opts.persona);
  return { owner: effort.owner, name: effort.name, gitRoot: effort.gitRoot, role,
    ...(role === "writer" ? { touches: opts.touches ? [...opts.touches] : undefined, ...(opts.retryOf?.length ? { retryOf: [...opts.retryOf] } : {}) } : {}) };
}

/** A reader's cards, callbacks and evidence belong to the effort's current owner; other runs are unaffected. */
export function readerFence(run: Run): void { if (run.effort?.role === "reader") assertRunEffortOwner(run); }
export function readerOwned(run: Run): boolean { try { readerFence(run); return true; } catch { return false; } }

const viewPath = (gitRoot: string, runId: string) => join(gitRoot, ".worktrees", "conductor-view", runId);

/** A detached checkout of exactly `tip` in the effort's own repository: never a branch or the shared cwd. */
export function createReaderView(gitRoot: string, runId: string, tip: string): string {
  const path = viewPath(gitRoot, runId);
  effortGit(gitRoot, "worktree", "add", "--detach", path, tip);
  return path;
}

/** The reader's own leftovers: kept for inspection, but still the same snapshot for an owner answer. */
export const DIRTY_VIEW = "changes, untracked or ignored files";

/** Undefined only for this run's own registered view, detached at `spawnBase`, with nothing in it. */
export function readerViewProblem(run: Run): string | undefined {
  const e = run.effort, path = run.worktreePath;
  if (e?.role !== "reader" || !e.spawnBase || !path) return "view unknown";
  try {
    if (path !== viewPath(e.gitRoot, run.id) || !existsSync(path) || realpathSync(path) !== path) return "not this run's own view path";
    const entry = effortGit(e.gitRoot, "worktree", "list", "--porcelain").split("\n\n").map(block => block.split("\n")).find(lines => lines[0] === `worktree ${path}`);
    if (!entry?.includes("detached") || !entry.includes(`HEAD ${e.spawnBase}`)) return `not detached at ${e.spawnBase}`;
    if (effortGit(path, "rev-parse", "HEAD") !== e.spawnBase) return "view HEAD moved";
    try { assertCandidateIndexFlags(path); } catch { return "unsafe index flags can hide changes"; }
    if (effortGit(path, "status", "--porcelain", "--ignored", "--untracked-files=all")) return DIRTY_VIEW;
    return undefined;
  } catch (error) { return `state unknown: ${(error as Error).message}`; }
}

export interface ReaderOutcome {
  /** A natural exit with code 0 whose validation hook passed or is known absent. */
  succeeded: boolean;
  /** This lead's own invocation, not a readopted or recovered one. */
  live: boolean;
  finalText: string;
}
export interface ReaderReleaseDeps {
  /** The live invocation, registry entry and durable record still name exactly this assignment and view. */
  isCurrent(): boolean;
  /** This pipeline still owns the invocation: false once it was replaced (resume, reload, readopt). */
  live(): boolean;
  /** Prove and close this run's own empty herdr pane; true when there is none (subprocess). */
  releasePane(): Promise<boolean>;
}
/**
 * `retired`: the invocation was replaced and mutates nothing more. `preserved`: still this invocation, but its
 * registry entry or durable record no longer matches; nothing more may be written or published for it.
 */
export type ReaderSettlement = "settled" | "retired" | "preserved";

/**
 * After the child and its delegated leaves exited and the validation hook ran. Evidence needs a successful live
 * invocation, the current effort owner and a clean view detached at `spawnBase`. Removal additionally needs the
 * run's own pane proven empty and closed, then every check again; anything uncertain keeps the view as it is.
 */
export async function settleReaderView(run: Run, outcome: ReaderOutcome, deps: ReaderReleaseDeps): Promise<ReaderSettlement> {
  const e = run.effort!, path = run.worktreePath;
  const keep = (problem: string) => {
    run.worktreeKept = `reader view kept (${problem}): ${run.worktreePath ?? "unavailable"}, detached at ${e.spawnBase ?? "unknown"}; nothing integrated, reset or discarded`;
  };
  // R3: another writer's record or registry entry is not ours to overwrite; the view and the reason stay in memory only.
  // R4: an owner change (which also refuses this reader's own record writes) is named as such.
  const stale = (when: string): ReaderSettlement => {
    if (!deps.live()) return "retired";
    keep(readerOwned(run) ? `durable record or registry changed ${when} release` : "effort owner changed");
    run.settlementPreserved = run.worktreeKept;
    return "preserved";
  };
  if (!deps.isCurrent()) return stale("before");
  const blocker = () => run.integrationSuspended ? "owner runtime shut down" : !readerOwned(run) ? "effort owner changed"
    : childExitUnconfirmed(run) || run.herdrExitUnconfirmed ? "child exit unconfirmed"
    : isTerminal(run.status) ? `terminated (${run.status}) before its review settled` : readerViewProblem(run);
  let problem = blocker();
  if (!problem && outcome.succeeded && outcome.live) {
    e.reviewed = e.spawnBase;
    if (run.persona === "finalizer") recordFinalizerVerdict(run, outcome.finalText);
  }
  if (!problem && !outcome.live) problem = "recovered settlement; review unproven";
  if (!problem) {
    const released = await deps.releasePane();
    if (!deps.isCurrent()) return stale("during");
    problem = !released ? "pane release unproven" : run.worktreePath !== path ? "view path changed" : blocker();
  }
  if (!problem) {
    try {
      effortGit(e.gitRoot, "worktree", "remove", path!);
      run.worktreePath = undefined; run.worktreeKept = undefined;
      return "settled";
    } catch (error) { problem = `removal refused: ${(error as Error).message}`; }
  }
  keep(problem);
  return "settled";
}

/** One leading `## Verdict: <v>` line, exactly as personas/finalizer.md emits it; any other verdict heading is ambiguous. */
export function parseFinalizerVerdict(text: string): FinalizerVerdict | undefined {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim() !== "");
  const verdict = first < 0 ? undefined : /^## Verdict: (complete|continue|failed)$/.exec(lines[first]!)?.[1];
  if (!verdict || lines.some((line, i) => i !== first && /^[\s>]*#{1,6}\s*verdict\b/i.test(line))) return undefined;
  return verdict as FinalizerVerdict;
}

/** Written under the current effort owner's fence; an unowned effort gets no evidence. */
function recordFinalizerVerdict(run: Run, text: string): void {
  const e = run.effort!, verdict = parseFinalizerVerdict(text);
  if (!verdict || !e.reviewed) return;
  try {
    const record = readEffort(e.gitRoot, e.name);
    if (!record) return;
    assertRunEffortOwner(run);
    writeEffort({ ...record, finalizer: { runId: run.id, tip: e.reviewed, verdict, at: Date.now() }, updatedAt: Date.now() });
    e.verdict = verdict;
  } catch { /* no mark: ownership or persistence unproven */ }
}

/** A verdict holds only for the OID it viewed; status computes staleness against the current tip. */
export function finalizerStatus(record: EffortRecord, tip: string) {
  const f = record.finalizer;
  if (!f) return undefined;
  const stale = f.tip !== tip;
  return { ...f, stale, summary: `Finalizer ${f.runId}: ${f.verdict} at ${stale ? `${f.tip} is STALE: the tip is now ${tip}` : `the current tip ${tip}`}. Landing is not available in M7.` };
}
