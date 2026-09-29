import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { detectBrazilWorkspaceRoot, gitEnv } from "../worktree.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { resolveEffortPolicy, validateEffortName, type EffortPolicy } from "./policy.ts";
import { assertEffortOwner, claimEffort, readEffort, writeEffort, type EffortOwner, type EffortRecord } from "./store.ts";

export function effortGit(cwd: string, ...args: string[]): string {
  const output = execFileSync("git", args, { cwd, env: Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => !key.startsWith("HERDR_"))), encoding: "utf8", stdio: "pipe", timeout: 30000 });
  return output.endsWith("\0") ? output : output.trim();
}
/** Canonical repository identity is the main worktree, not the caller's linked checkout. */
export function effortRepository(cwd: string): { gitRoot: string; requestedRoot: string } {
  try {
    const requestedRoot = realpathSync(effortGit(cwd, "rev-parse", "--show-toplevel"));
    const first = effortGit(cwd, "worktree", "list", "--porcelain", "-z").split("\0")[0]!;
    if (!first.startsWith("worktree ")) throw new Error("missing main worktree");
    return { gitRoot: realpathSync(first.slice(9)), requestedRoot };
  } catch { throw new Error("efforts require a non-bare git repository"); }
}
export function effortOwner(sessionId: string | undefined): EffortOwner {
  const startTime = readProcessStartTime(process.pid) ?? performance.timeOrigin;
  if (!sessionId) throw new Error("effort requires a session id");
  return { sessionId, pid: process.pid, startTime };
}
export function checkEffortRepository(cwd: string): ReturnType<typeof effortRepository> {
  const repo = effortRepository(cwd);
  if (loadConfig(cwd).worktreeMode === "external") throw new Error("efforts do not support external worktree mode");
  if (detectBrazilWorkspaceRoot(repo.gitRoot) || detectBrazilWorkspaceRoot(repo.requestedRoot)) throw new Error("efforts are not supported in Brazil workspaces");
  return repo;
}
export function effortTip(record: EffortRecord): string {
  if (effortGit(record.gitRoot, "worktree", "list", "--porcelain").split("\n").includes(`branch ${record.intRef}`)) throw new Error("effort integration ref is checked out; refusing spawn");
  return effortGit(record.gitRoot, "rev-parse", "--verify", `${record.intRef}^{commit}`);
}
export function openEffort(cwd: string, name: string, sessionId: string | undefined, overrides: Partial<EffortPolicy> = {}): EffortRecord {
  validateEffortName(name);
  const { gitRoot, requestedRoot } = checkEffortRepository(cwd);
  const policy = resolveEffortPolicy(loadConfig(cwd).efforts, overrides);
  const owner = effortOwner(sessionId);
  let baseRef: string;
  try { baseRef = effortGit(requestedRoot, "symbolic-ref", "HEAD"); }
  catch { throw new Error("effort base must be an attached local branch, not detached HEAD"); }
  if (!baseRef.startsWith("refs/heads/") || baseRef.startsWith("refs/heads/conductor-int/")) throw new Error("invalid effort base branch");
  const baseOid = effortGit(requestedRoot, "rev-parse", "--verify", `${baseRef}^{commit}`);
  if (baseOid !== effortGit(requestedRoot, "rev-parse", "HEAD")) throw new Error("effort base changed while opening");
  if (readEffort(gitRoot, name)) throw new Error(`effort "${name}" already exists`);
  claimEffort(gitRoot, name, owner);
  const now = Date.now();
  const record: EffortRecord = { schema: 1, name, gitRoot, intRef: `refs/heads/conductor-int/${name}`, baseBranch: baseRef.slice(11), baseOid, owner, policy, members: [], queue: [], status: "open", createdAt: now, updatedAt: now };
  // Never roll back a ref: even an equal OID cannot prove another actor did not replace it.
  // Failed creation/persistence retains the claim for explicit review, with no checkout writes.
  effortGit(gitRoot, "update-ref", record.intRef, baseOid, "");
  writeEffort(record);
  return record;
}
export function ownedEffort(cwd: string, name: string, sessionId: string | undefined): EffortRecord {
  validateEffortName(name);
  const { gitRoot } = checkEffortRepository(cwd);
  const existing = readEffort(gitRoot, name);
  if (!existing) return openEffort(cwd, name, sessionId);
  assertEffortOwner(existing, effortOwner(sessionId));
  effortTip(existing);
  return existing;
}
