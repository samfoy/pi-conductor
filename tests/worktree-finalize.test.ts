/**
 * Finalize's worktree step (`settleWorktree`): a successful merge-back
 * removes the worktree directory and deletes its branch; a merge_conflict
 * keeps both for manual resolution; a non-completed run still gets its
 * worktree removed (v0.13).
 *
 * Real git in temp repos, every call through gitTestEnv(). The spawnRun
 * smoke forks a PI_BIN stub, not pi.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRegistry, settleWorktree, spawnRun } from "../src/runs.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, env: gitTestEnv(), stdio: "pipe" }).toString();
}

function initRepo(): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-wt-finalize-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init -b mainline");
  git(repo, "config user.email t@t");
  git(repo, "config user.name T");
  writeFileSync(join(repo, "README.md"), "init\n");
  git(repo, "add README.md");
  git(repo, "commit -m init");
  return { root, repo };
}

/** A worktree at the spawnRun layout with one commit touching `file`. */
function worktreeWithCommit(repo: string, id: string, file: string, content: string): { path: string; branch: string } {
  const branch = `conductor-wt/${id}`;
  const path = join(repo, ".worktrees", "conductor-wt", id);
  git(repo, `worktree add -b ${branch} ${JSON.stringify(path)}`);
  writeFileSync(join(path, file), content);
  git(path, `add ${file}`);
  git(path, `commit -m "work ${file}"`);
  return { path, branch };
}

const branchExists = (repo: string, branch: string): boolean => git(repo, `branch --list ${branch}`).trim() !== "";

function makeRun(id: string, over: Partial<Run>): Run {
  const dir = mkdtempSync(join(tmpdir(), "conductor-wt-finalize-run-"));
  return {
    id,
    persona: "builder",
    task: "t",
    mode: "background",
    status: "completed",
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    worktreeBaseBranch: "mainline",
    mergeStrategy: "squash",
    ...over,
  };
}

test("settleWorktree: a successful merge removes the worktree and deletes its branch", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-ok01", "new.ts", "hello\n");
    const run = makeRun("builder-ok01", { worktreePath: wt.path, worktreeBranch: wt.branch });

    assert.equal(await settleWorktree(run, "completed"), "completed");

    assert.equal(run.mergeResult?.success, true);
    assert.match(git(repo, "show --stat --oneline mainline"), /new\.ts/, "the work is on mainline");
    assert.equal(existsSync(wt.path), false, "worktree directory removed");
    assert.equal(branchExists(repo, wt.branch), false, "worktree branch deleted");
    assert.equal(run.worktreePath, undefined);
    assert.equal(run.worktreeBranch, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settleWorktree: merge_conflict keeps the worktree, its branch, and the run's worktree fields", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-cf01", "README.md", "from branch\n");
    writeFileSync(join(repo, "README.md"), "from base\n");
    git(repo, "commit -am base");
    const run = makeRun("builder-cf01", { worktreePath: wt.path, worktreeBranch: wt.branch });

    assert.equal(await settleWorktree(run, "completed"), "merge_conflict");

    assert.equal(existsSync(join(wt.path, "README.md")), true, "worktree directory kept");
    assert.equal(branchExists(repo, wt.branch), true, "worktree branch kept");
    assert.equal(run.worktreePath, wt.path);
    assert.equal(run.worktreeBranch, wt.branch);
    assert.ok(run.errorMessage?.includes(`git merge ${wt.branch}`), run.errorMessage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settleWorktree: a re-adopted run's refused merge keeps its worktree and branch too", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-ra01", "y.ts", "y\n");
    const run = makeRun("builder-ra01", { worktreePath: wt.path, worktreeBranch: wt.branch, reconciledAtStartup: true });

    assert.equal(await settleWorktree(run, "completed"), "merge_conflict");

    assert.equal(existsSync(join(wt.path, "y.ts")), true);
    assert.equal(branchExists(repo, wt.branch), true);
    assert.doesNotMatch(git(repo, "log --oneline mainline"), /y\.ts|work/, "nothing merged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settleWorktree: a failed run's worktree is still removed (no merge attempted)", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-fl01", "x.ts", "x\n");
    const run = makeRun("builder-fl01", { status: "failed", worktreePath: wt.path, worktreeBranch: wt.branch });

    assert.equal(await settleWorktree(run, "failed"), "failed");

    assert.equal(run.mergeResult, undefined);
    assert.equal(existsSync(wt.path), false);
    assert.equal(branchExists(repo, wt.branch), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawnRun: a completed worktree run is merged back, then its worktree and branch are gone", { timeout: 20_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = join(root, "pi-stub.mjs");
  // The stub is the "sub-agent": commit one file in its cwd (the worktree).
  writeFileSync(
    stub,
    `import { execSync } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\n` +
      `writeFileSync("work.ts", "done\\n");\n` +
      `execSync("git add work.ts && git -c user.email=t@t -c user.name=T commit -m work", { env, stdio: "pipe" });\n`,
  );
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = stub;
  try {
    const persona: Persona = {
      name: "builder",
      description: "probe",
      inheritContext: "none",
      inheritSkills: false,
      defaultReads: [],
      worktree: true,
      timeoutMinutes: 1,
      systemPrompt: "You are builder.",
      source: "builtin",
      sourcePath: "/fake/builder.md",
      readOnly: false,
    };
    const { run, done } = spawnRun({
      registry: new RunRegistry(),
      persona,
      task: "probe",
      mode: "background",
      cwd: repo,
      timeoutMs: 15_000,
      worktree: true,
      mergeStrategy: "squash",
    });
    const wtPath = run.worktreePath;
    const branch = run.worktreeBranch;
    assert.ok(wtPath && branch, "spawnRun created a worktree");

    await done;

    assert.equal(run.status, "completed", run.errorMessage);
    assert.match(git(repo, "show --stat --oneline mainline"), /work\.ts/, "the sub-agent's commit is on mainline");
    assert.equal(existsSync(wtPath), false, "worktree directory removed");
    assert.equal(branchExists(repo, branch), false, "worktree branch deleted");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
