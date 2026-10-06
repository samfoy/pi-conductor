// M6a fixtures: a private repo, canonical writer records, and a driver merger seam.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openEffort } from "../../src/effort/open.ts";
import type { EffortPolicy } from "../../src/effort/policy.ts";
import type { MergerLaunch, MergerRequest } from "../../src/effort/merger.ts";
import { RunRegistry, runDir, writeRecord } from "../../src/runs.ts";
import { emptyUsage, type MergerWal, type Run, type RunStatus } from "../../src/types.ts";
import { git } from "./effort-integration.ts";
import { tmpDir } from "./tmp.ts";

export const unmerged = (cwd: string) => [...new Set(git(cwd, "ls-files", "-u").split("\n").filter(Boolean).map(l => l.split("\t")[1]!))].sort();
export const trailerCount = (cwd: string, oid: string, trailer: string) => git(cwd, "show", "-s", "--format=%B", oid).split("\n").filter(l => l === trailer).length;

/** Ordinary hooked commits only: a temporary detached checkout lands a commit, then a CAS moves the ref. */
export function land(root: string, ref: string, files: Record<string, string>, message = "test: landed outside the writer"): string {
  const tip = git(root, "rev-parse", ref), wt = join(root, ".worktrees", `land-${randomUUID().slice(0, 8)}`);
  git(root, "worktree", "add", "--detach", wt, tip);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(wt, path), text);
  git(wt, "add", "--", ...Object.keys(files)); git(wt, "commit", "-m", message);
  const oid = git(wt, "rev-parse", "HEAD");
  git(root, "update-ref", ref, oid, tip); git(root, "worktree", "remove", wt);
  return oid;
}

export function mergerFixture(t: TestContext, opts: { verify?: string; policy?: Partial<EffortPolicy>; session?: string } = {}) {
  const root = tmpDir("m6a-repo-"); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  writeFileSync(join(root, "base"), "original\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", "base", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), index = readFileSync(join(root, ".git", "index"));
  const session = opts.session ?? "owner";
  const record = openEffort(root, "probe", session, { verify: opts.verify ?? "true", ...opts.policy });
  const registry = new RunRegistry();
  const heads = new Map<string, string>();
  const writer = (id: string, files: Record<string, string>): Run => {
    const worktree = join(root, ".worktrees", id), branch = `conductor-wt/${id}`;
    git(root, "worktree", "add", "-b", branch, worktree, base);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree, path), text);
    git(worktree, "add", "--", ...Object.keys(files)); git(worktree, "commit", "-m", `test: ${id}`);
    const head = git(worktree, "rev-parse", "HEAD"); heads.set(branch, head);
    const dir = runDir(id); mkdirSync(dir, { recursive: true });
    const run: Run = { id, persona: "builder", task: `Implement ${id}`, mode: "background", status: "integrating", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: { ...emptyUsage(), cost: 0.01 }, cwd: root,
      parentSessionId: record.owner.sessionId, parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
      effort: { name: record.name, gitRoot: root, role: "writer", spawnBase: base, cwd: worktree, owner: record.owner, gate: null },
      integration: { state: "queued", branchHead: head, enqueuedAt: Date.now(), attempts: 0, resultText: `${id} report: implemented and committed.`,
        verifyIdentity: { command: record.policy.verify, timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: record.policy.verifyRetries } },
      worktreePath: worktree, worktreeBranch: branch, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
    registry.register(run);
    return run;
  };
  const start = (run: Run) => registry.integrations.enqueue(run, () => registry.notify(run)).then(outcome => {
    run.status = outcome.terminal; run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit; registry.notify(run); return outcome;
  });
  t.after(() => {
    assert.equal(git(root, "rev-parse", "HEAD"), base, "main checkout HEAD unchanged");
    assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "main checkout index bytes unchanged");
    assert.equal(readFileSync(join(root, "base"), "utf8"), "original\n");
    assert.equal(git(root, "status", "--porcelain"), "");
    for (const [branch, head] of heads) assert.equal(git(root, "rev-parse", branch), head, `${branch} retained`);
  });
  const hook = (body: string) => writeFileSync(join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { root, record, registry, base, writer, start, hook, tip: () => git(root, "rev-parse", record.intRef) };
}

/** The driver's launcher seam with a merger the test drives; records what was durable at launch. */
export function fakeMergers(registry: RunRegistry, opts: { delay?: Promise<void>; refuse?: string } = {}) {
  const calls: MergerRequest[] = [], claims: (MergerWal | undefined)[] = [], launched: Run[] = [], liveAtLaunch: number[] = [];
  let waiting: (() => boolean)[] = [];
  const launch: MergerLaunch = async request => {
    claims.push(JSON.parse(readFileSync(request.writer.recordPath, "utf8")).integration?.merger);
    liveAtLaunch.push(launched.filter(m => m.status === "running" || m.status === "blocked" || m.status === "queued").length);
    calls.push(request);
    if (opts.delay) await opts.delay;
    if (opts.refuse) throw new Error(opts.refuse);
    const dir = runDir(request.wal.runId); mkdirSync(dir, { recursive: true });
    const m: Run = { id: request.wal.runId, persona: "merger", task: request.task, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(),
      cwd: request.wal.candidatePath, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      mergerFor: request.mergerFor, parentPid: process.pid, parentSessionId: request.mergerFor.owner.sessionId, depth: 1, delegateAllow: [] };
    registry.register(m); await writeRecord(m);
    launched.push(m); waiting = waiting.filter(check => !check());
    return m;
  };
  registry.integrations.configureMerger(launch);
  return {
    calls, claims, launched, liveAtLaunch, launch,
    /** Resolves with the i-th launched merger, whenever it launches. */
    nth: (i: number) => new Promise<Run>(resolve => { const check = () => { if (!launched[i]) return false; resolve(launched[i]!); return true; }; if (!check()) waiting.push(check); }),
  };
}

/** Settle a fake merger the way a pipeline does: final text and usage, then the terminal notify. */
export async function settle(registry: RunRegistry, m: Run, text: string, cost = 0.02, status: RunStatus = "completed"): Promise<void> {
  m.messages = [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as never];
  m.usage = { ...m.usage, cost: m.usage.cost + cost, turns: m.usage.turns + 1 };
  m.status = status; m.finishedAt = Date.now();
  await writeRecord(m); writeFileSync(m.finalPath, text);
  registry.notify(m);
}
