/**
 * Startup reconcile: who runs it, and what a re-adopted run keeps.
 *
 *   (a) A conductor child (CONDUCTOR_SUBAGENT=1) shares the lead's runs
 *       root but owns none of its runs, so its session_start must not
 *       reconcile them.
 *   (b) A re-adopted run is never auto-merged: its on_complete_hook gate
 *       can't be rebuilt faithfully (the per-call hook isn't persisted,
 *       and the resume that completes it runs in run.cwd, not the
 *       worktree being merged). It lands in merge_conflict instead.
 *   (c) buildOrphanRun restores every field record.json persists.
 *   (d) A re-adopted run's worktree survives a resume that ends in any
 *       terminal status: the resume runs in run.cwd, so the worktree
 *       still holds the dead process's only copy of its work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { applyMergeToTerminal, RunRegistry, sendToRun } from "../src/runs.ts";
import { emptyUsage, toRunRecord, type Run, type RunRecord } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { loadConductor, stubCtx } from "./helpers/stub-pi.ts";

function stubRegistry() {
  const runs = new Map<string, Run>();
  return { runs, has: (k: string) => runs.has(k), get: (k: string) => runs.get(k), register: (r: Run) => void runs.set(r.id, r) };
}

/** A Run whose persisted record has every RunRecord field set. */
function fullRun(dir: string, over: Partial<Run> = {}): Run {
  return {
    id: "builder-full",
    persona: "builder",
    task: "carry everything",
    model: "amazon-bedrock/m",
    thinking: "high",
    mode: "background",
    status: "running",
    startTime: 1_000,
    pid: 424_242,
    parentPid: 1,
    parentSessionId: "lead-session",
    parentStartTime: 77,
    finishedAt: 1_500,
    pausedAt: 1_200,
    exitCode: 0,
    stopReason: "stop",
    errorMessage: "earlier error",
    failureClass: "logic",
    retryAttempt: 2,
    usage: { ...emptyUsage(), input: 10, output: 20, turns: 3 },
    cwd: dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    sessionPath: join(dir, "session.jsonl"),
    contextRetired: false,
    pendingAsk: { askId: "ask-test", question: "Continue?", evidence: "" },
    systemPrompt: "You are builder.",
    tools: ["read", "bash"],
    excludeTools: ["edit"],
    steerable: false,
    streamingMode: "print",
    hookResult: {
      passed: true,
      command: "npm test",
      exitCode: 0,
      durationMs: 5,
      logPath: join(dir, "hook.log"),
      tailText: "ok",
      tailBytes: 2,
      tailLines: 1,
    },
    worktreePath: join(dir, "wt"),
    worktreeBranch: "conductor-wt/builder-full",
    worktreeBaseBranch: "mainline",
    mergeStrategy: "squash",
    mergeResult: { success: false, conflicts: ["a.ts"] },
    lastEventAt: 1_400,
    thisInvocationStartedAt: 1_300,
    thisInvocationUsageBaseline: { turns: 1, input: 2, output: 3, cost: 0 },
    resumeCount: 4,
    compactionCount: 5,
    maxTurns: 50,
    graceTurns: 3,
    messages: [],
    ...over,
  };
}

// Fields reconcile deliberately rewrites when it reclassifies a record.
const REWRITTEN_ON_RECLASSIFY = new Set(["status", "finishedAt", "errorMessage", "pendingAsk"]);

// ── (c) buildOrphanRun carries every persisted field ────────────────

for (const [label, status, alive, expected] of [
  ["readopt", "running", true, "running"],
  ["killed", "running", false, "killed"],
  ["failed-queued", "queued", false, "failed"],
] as const) {
  test(`reconcile (${label}): the registered run restores every field record.json persists`, async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "conductor-readopt-fields-"));
    try {
      const dir = join(runsRoot, "builder-full");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.jsonl"), "{}\n");
      const record = toRunRecord(fullRun(dir, { status, contextRetired: true }));
      const unset = Object.entries(record).filter(([, v]) => v === undefined).map(([k]) => k);
      assert.deepEqual(unset, [], "fixture sets every persisted field");
      writeFileSync(record.recordPath, JSON.stringify(record));

      const registry = stubRegistry();
      await reconcileOrphansAtStartup({
        runsRoot,
        registry,
        isAlive: () => alive,
        isParentAlive: () => false,
        now: 9_000,
      });

      const run = registry.get("builder-full");
      assert.equal(run?.status, expected);
      const restored = toRunRecord(run!);
      for (const key of Object.keys(record) as Array<keyof RunRecord>) {
        if (expected !== "running" && REWRITTEN_ON_RECLASSIFY.has(key)) continue;
        if (key === "status") continue;
        assert.deepEqual(restored[key], record[key], `${key} survives re-adoption`);
      }
      assert.equal(run!.reconciledAtStartup, true, "marked as re-adopted");
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
}

// ── (b) a re-adopted run is not auto-merged ─────────────────────────

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, env: gitTestEnv(), stdio: "pipe" }).toString();
}

test("reconcile then completion: a re-adopted worktree run lands in merge_conflict, unmerged, worktree kept", { timeout: 15_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-readopt-merge-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init -b mainline");
    git(repo, "config user.email t@t");
    git(repo, "config user.name T");
    writeFileSync(join(repo, "README.md"), "init\n");
    git(repo, "add README.md");
    git(repo, "commit -m init");
    const branch = "conductor-wt/builder-full";
    const wt = join(repo, ".worktrees", "conductor-wt", "builder-full");
    git(repo, `worktree add -b ${branch} ${JSON.stringify(wt)}`);
    writeFileSync(join(wt, "work.ts"), "partial work of a dead process\n");
    git(wt, "add work.ts");
    git(wt, "commit -m wip");

    const runsRoot = join(root, "runs");
    const dir = join(runsRoot, "builder-full");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), "{}\n");
    const record = toRunRecord(
      fullRun(dir, { worktreePath: wt, worktreeBranch: branch, mergeResult: undefined, errorMessage: undefined }),
    );
    writeFileSync(record.recordPath, JSON.stringify(record));

    const registry = stubRegistry();
    await reconcileOrphansAtStartup({ runsRoot, registry, isAlive: () => false, isParentAlive: () => false, now: 9_000 });
    const run = registry.get("builder-full")!;
    assert.equal(run.worktreePath, wt, "worktree fields survive re-adoption");

    // An ensemble_send resume is the only way this run reaches `completed`.
    const terminal = await applyMergeToTerminal(run, repo, "completed");

    assert.equal(terminal, "merge_conflict");
    assert.equal(git(repo, "log --oneline mainline").trim().split("\n").length, 1, "mainline gets no merge commit");
    assert.equal(run.worktreePath, wt, "worktree path kept for manual review");
    assert.equal(run.worktreeBranch, branch);
    assert.match(run.errorMessage ?? "", /re-adopted/);
    assert.match(run.errorMessage ?? "", /on_complete_hook/);
    assert.ok(run.errorMessage?.includes(`/conductor worktree merge builder-full`), run.errorMessage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) a failed resume never destroys a re-adopted worktree ────────

test("reconcile then a failed resume: the dead builder's worktree and branch survive", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-readopt-resume-")));
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init -b mainline");
    git(repo, "config user.email t@t");
    git(repo, "config user.name T");
    writeFileSync(join(repo, "README.md"), "init\n");
    git(repo, "add README.md");
    git(repo, "commit -m init");
    const id = "builder-dead";
    const branch = `conductor-wt/${id}`;
    const wt = join(repo, ".worktrees", "conductor-wt", id);
    git(repo, `worktree add -b ${branch} ${JSON.stringify(wt)}`);
    writeFileSync(join(wt, "work.ts"), "two hours of work\n");
    git(wt, "add work.ts");
    git(wt, `commit -m "dead builder's work"`);

    process.env.HOME = join(root, "home");
    const runsRoot = join(root, "runs");
    const dir = join(runsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), "{}\n");
    const record = toRunRecord(
      fullRun(dir, {
        id,
        pid: 999_999,
        parentPid: 999_998,
        parentSessionId: undefined,
        cwd: repo,
        worktreePath: wt,
        worktreeBranch: branch,
        mergeResult: undefined,
        errorMessage: undefined,
      }),
    );
    writeFileSync(record.recordPath, JSON.stringify(record));

    const registry = new RunRegistry();
    await reconcileOrphansAtStartup({ runsRoot, registry, isAlive: () => false, isParentAlive: () => false, now: 9_000 });
    const run = registry.get(id)!;
    assert.equal(run.status, "killed", "precondition: the dead run is re-adopted as killed");
    assert.equal(run.worktreePath, wt, "precondition: worktree fields survive re-adoption");

    // The resume fails fast, like a retired model ("Model not found").
    const stub = join(root, "pi-stub.mjs");
    writeFileSync(stub, `console.error('Model "retired/x" not found'); process.exit(1);\n`);
    process.env.PI_BIN = stub;
    const sent = sendToRun(run, "please finish", { registry, timeoutMs: 10_000 });
    assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
    await sent.done;
    assert.equal(run.status, "failed", "precondition: the resume failed");

    assert.equal(existsSync(join(wt, "work.ts")), true, "worktree directory and its work kept");
    assert.notEqual(git(repo, `branch --list ${branch}`).trim(), "", "worktree branch kept");
    assert.equal(run.worktreePath, wt, "worktree path kept for worktree merge|clean and GC");
    assert.equal(run.worktreeBranch, branch);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (a) a conductor child's session_start never reconciles ──────────

/**
 * Fire session_start against a runs root holding one dead `running`
 * record and return its on-disk status once session_start's deferred
 * work settles. setImmediate is captured so the reconcile callback's
 * returned promise can be awaited (a positive control below proves it).
 */
async function statusAfterSessionStart(child: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "conductor-child-reconcile-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  const realSetImmediate = globalThis.setImmediate;
  process.env.HOME = join(root, "home");
  if (child) process.env.CONDUCTOR_SUBAGENT = "1";
  else delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
    const dir = join(root, "home", ".pi", "agent", "conductor", "runs", "builder-lead");
    mkdirSync(dir, { recursive: true });
    const record = toRunRecord(
      fullRun(dir, { id: "builder-lead", pid: 999_999, parentPid: undefined, parentSessionId: undefined }),
    );
    writeFileSync(record.recordPath, JSON.stringify(record));

    const fire = loadConductor();
    const deferred: Array<() => unknown> = [];
    globalThis.setImmediate = ((cb: (...a: unknown[]) => unknown, ...args: unknown[]) => {
      deferred.push(() => cb(...args));
      return { unref: () => {}, ref: () => {}, hasRef: () => false } as unknown as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      await fire("session_start", {}, stubCtx(root));
    } finally {
      globalThis.setImmediate = realSetImmediate;
    }
    await Promise.all(deferred.map((run) => run()));
    await fire("session_shutdown", { reason: "reload" }, stubCtx(root));
    return JSON.parse(readFileSync(record.recordPath, "utf8")).status;
  } finally {
    globalThis.setImmediate = realSetImmediate;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("a lead session_start reconciles the dead orphan (positive control)", async () => {
  assert.equal(await statusAfterSessionStart(false), "killed");
});

test("a child session_start does not call reconcile", async () => {
  assert.equal(await statusAfterSessionStart(true), "running", "the lead's record is untouched");
});
