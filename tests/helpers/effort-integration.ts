import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openEffort } from "../../src/effort/open.ts";
import { RunRegistry } from "../../src/runs.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import { tmpDir } from "./tmp.ts";
import { gitTestEnv } from "./git-env.ts";
import type { EffortPolicy } from "../../src/effort/policy.ts";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe", timeout: 5000 }).trim();
export function fixture(t: TestContext, verify: string, policy: Partial<EffortPolicy> = {}, change = true) {
  const root = tmpDir("m2-fixture-"); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  writeFileSync(join(root, "base"), "original\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", "base", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"); const index = readFileSync(join(root, ".git", "index"));
  const record = openEffort(root, "probe", "owner", { verify, ...policy });
  const worktree = join(root, ".worktrees", "writer");
  git(root, "worktree", "add", "-b", "writer", worktree, base);
  if (change) { writeFileSync(join(worktree, "change"), "work"); git(worktree, "add", "change"); git(worktree, "commit", "-m", "change"); }
  const head = git(worktree, "rev-parse", "HEAD"); const dir = tmpDir("m2-record-");
  const run: Run = { id: "builder-probe", persona: "builder", task: "Implement a change", mode: "background", status: "integrating", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), cwd: root,
    parentSessionId: record.owner.sessionId, parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
    effort: { name: record.name, gitRoot: root, role: "writer", spawnBase: base, cwd: worktree },
    integration: { state: "queued", branchHead: head, enqueuedAt: Date.now(), attempts: 0, verifyIdentity: { command: verify, timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: record.policy.verifyRetries } },
    worktreePath: worktree, worktreeBranch: "writer", recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const registry = new RunRegistry(); registry.register(run);
  const start = () => registry.integrations.enqueue(run, () => registry.notify(run)).then(outcome => { run.status = outcome.terminal; run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit; registry.notify(run); return outcome; });
  const unchanged = () => { assert.equal(run.landedCommit, undefined, "run must not be accepted"); assert.equal(git(root, "rev-parse", record.intRef), base, "unverified candidate must not advance intRef"); };
  t.after(() => {
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
    assert.equal(readFileSync(join(root, "base"), "utf8"), "original\n");
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-parse", "writer"), head, "writer branch must be retained");
  });
  const hook = (body: string) => writeFileSync(join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { root, record, run, registry, base, head, start, unchanged, hook };
}
export async function until(registry: RunRegistry, run: Run, condition: (run: Run) => boolean, timeoutMs = 5000): Promise<void> {
  if (condition(run)) return;
  await new Promise<void>((resolve, reject) => {
    const off = registry.onChange(r => { if (r === run && condition(r)) { clearTimeout(timer); off(); resolve(); } });
    const timer = setTimeout(() => { off(); reject(new Error(`integration state not reached: ${run.status}: ${run.errorMessage}: ${JSON.stringify(run.hookResult)}: ${JSON.stringify(run.integration)}`)); }, timeoutMs);
  });
}
