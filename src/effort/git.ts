import { spawnSync } from "node:child_process";
import { effortGit } from "./open.ts";
import { gitEnv } from "../worktree.ts";
import { parseMergeTree } from "./core.ts";

export function effortEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_") || k.startsWith("HERDR_")).map(k => [k, undefined])), ...extra };
}
export function mergeTree(root: string, tip: string, branch: string) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "-z", tip, branch], { cwd: root, env: gitEnv(), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  return { ...parseMergeTree(result.stdout ?? "", result.status, result.error?.message ?? result.stderr), output: result.stdout ?? "" };
}
/** Only ordinary cached entries (H) can attest working bytes; h/S/s can hide changes from status. */
export function assertCandidateIndexFlags(path: string): void {
  const unsafe = effortGit(path, "ls-files", "-v", "-z").split("\0").filter(entry => entry && !entry.startsWith("H "));
  if (unsafe.length) throw new Error(`candidate has unsafe index flags: ${JSON.stringify(unsafe)}; refusing integration`);
}
export function assertCandidate(path: string, oid: string): void {
  if (effortGit(path, "rev-parse", "HEAD") !== oid) throw new Error("candidate HEAD changed after verification setup");
  assertCandidateIndexFlags(path);
  if (effortGit(path, "status", "--porcelain", "--untracked-files=all")) throw new Error("candidate has unexpected dirty changes; refusing integration");
  if (effortGit(path, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error("candidate must stay detached");
}
export class StaleTipError extends Error {}
export function checkedCas(root: string, ref: string, candidate: string, expected: string, fence: () => void): void {
  if (effortGit(root, "worktree", "list", "--porcelain").split("\n").includes(`branch ${ref}`)) throw new Error("integration ref is checked out; queue paused");
  fence();
  try { effortGit(root, "update-ref", ref, candidate, expected); }
  catch (error) {
    if (effortGit(root, "rev-parse", "--verify", ref) !== expected) throw new StaleTipError("integration tip changed; recompute");
    throw error;
  }
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }

/** A status/trailer search alone cannot certify the WAL's exact integration. */
export function integratedCandidate(record: import("./store.ts").EffortRecord, run: Pick<import("../types.ts").Run, "id" | "integration">): string | undefined {
  const e = run.integration;
  if (!e?.candidateOid || !e.expectedTip || !e.candidateTree ||
      (e.verifiedOid !== e.candidateOid && e.state !== "verified" && e.state !== "accepted") ||
      e.verifyIdentity.command !== record.policy.verify || e.verifyIdentity.timeoutSeconds !== record.policy.verifyTimeoutSeconds || e.verifyIdentity.retries !== record.policy.verifyRetries ||
      (e.verifyIdentity.command && (!e.verify?.passed || e.verify.command !== e.verifyIdentity.command))) return;
  const root = record.gitRoot;
  const body = effortGit(root, "show", "-s", "--format=%B", e.candidateOid).split("\n");
  if ([`Conductor-Effort: ${record.name}`, `Conductor-Run: ${run.id}`].some(trailer => body.filter(line => line === trailer).length !== 1)) return;
  if (effortGit(root, "show", "-s", "--format=%P", e.candidateOid) !== e.expectedTip || effortGit(root, "rev-parse", `${e.candidateOid}^{tree}`) !== e.candidateTree) return;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", e.candidateOid, record.intRef], { cwd: root, env: gitEnv(), timeout: 30000 });
  if (result.status === 0) return e.candidateOid;
  if (result.status !== 1) throw new Error("candidate reachability unknown; preserve integration");
}
