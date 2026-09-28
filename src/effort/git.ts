import { spawnSync } from "node:child_process";
import { effortGit } from "./open.ts";
import { gitEnv } from "../worktree.ts";
import { parseMergeTree } from "./core.ts";

export function effortEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_") || k.startsWith("HERDR_")).map(k => [k, undefined])), ...extra };
}
export function mergeTree(root: string, tip: string, branch: string) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", tip, branch], { cwd: root, env: gitEnv(), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  return parseMergeTree(result.stdout ?? "", result.status, result.error?.message ?? result.stderr);
}
export function assertCandidate(path: string, oid: string): void {
  if (effortGit(path, "rev-parse", "HEAD") !== oid) throw new Error("candidate HEAD changed after verification setup");
  if (effortGit(path, "status", "--porcelain", "--untracked-files=all")) throw new Error("candidate has unexpected dirty changes; refusing integration");
  if (effortGit(path, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error("candidate must stay detached");
}
export function checkedCas(root: string, ref: string, candidate: string, expected: string, fence: () => void): void {
  if (effortGit(root, "worktree", "list", "--porcelain").split("\n").includes(`branch ${ref}`)) throw new Error("integration ref is checked out; queue paused");
  fence();
  effortGit(root, "update-ref", ref, candidate, expected);
}
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
