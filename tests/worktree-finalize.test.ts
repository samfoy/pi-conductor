/**
 * Finalize's worktree step (`settleWorktree`): a successful merge-back
 * removes the worktree directory and deletes its branch; a merge_conflict
 * keeps both for manual resolution; a non-completed run still gets its
 * worktree removed (v0.13). With no merge-back (`none`), the branch is
 * the deliverable: only a clean worktree directory goes (v0.20 B3). The
 * on_complete_hook gate runs in the worktree, not the main checkout (B4).
 * A leftover uncommitted change is never force-removed, and a run settled
 * by forceTerminate (kill, stall, timeout) keeps its partial work.
 *
 * Real git in temp repos, every call through gitTestEnv(). The spawnRun
 * smoke forks a PI_BIN stub, not pi.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forceTerminate, RunRegistry, settleWorktree, spawnRun } from "../src/runs.ts";
import { runWorktreeCmd } from "../src/commands.ts";
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

function builderPersona(): Persona {
  return {
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
}

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

for (const strategy of ["none", undefined] as const) {
  test(`settleWorktree: merge strategy ${strategy ?? "unset"} keeps the branch and removes only the clean worktree dir`, { timeout: 15_000 }, async () => {
    const { root, repo } = initRepo();
    try {
      const wt = worktreeWithCommit(repo, "builder-nm01", "gated.ts", "for the critic\n");
      const run = makeRun("builder-nm01", { worktreePath: wt.path, worktreeBranch: wt.branch, mergeStrategy: strategy });

      assert.equal(await settleWorktree(run, "completed"), "completed");

      assert.equal(existsSync(wt.path), false, "clean worktree directory removed");
      assert.equal(branchExists(repo, wt.branch), true, "branch kept for the critic-gated merge");
      assert.match(git(repo, `show --stat --oneline ${wt.branch}`), /gated\.ts/, "the branch still holds the work");
      assert.doesNotMatch(git(repo, "log --stat --oneline mainline"), /gated\.ts/, "nothing merged");
      assert.equal(run.worktreePath, undefined, "no directory to point at");
      assert.equal(run.worktreeBranch, wt.branch, "branch name kept for the chain template");
      assert.equal(run.errorMessage, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("settleWorktree: merge strategy none with uncommitted changes keeps worktree, branch and fields, with a hint", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-nd01", "done.ts", "committed\n");
    writeFileSync(join(wt.path, "half.ts"), "never committed\n");
    const run = makeRun("builder-nd01", {
      status: "failed",
      worktreePath: wt.path,
      worktreeBranch: wt.branch,
      mergeStrategy: "none",
      errorMessage: "pi subprocess exited with code 1",
    });

    assert.equal(await settleWorktree(run, "failed"), "failed");

    assert.equal(readFileSync(join(wt.path, "half.ts"), "utf8"), "never committed\n", "uncommitted work kept");
    assert.equal(branchExists(repo, wt.branch), true);
    assert.equal(run.worktreePath, wt.path);
    assert.equal(run.worktreeBranch, wt.branch);
    assert.match(run.errorMessage ?? "", /^pi subprocess exited with code 1; /, "the original error is kept");
    assert.match(run.errorMessage ?? "", /uncommitted/);
    assert.ok(run.errorMessage?.includes(wt.path), run.errorMessage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settleWorktree: a successful merge with an uncommitted leftover keeps the worktree, with a hint", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const wt = worktreeWithCommit(repo, "builder-lo01", "new.ts", "hello\n");
    writeFileSync(join(wt.path, "notes.txt"), "not part of the merge\n");
    const run = makeRun("builder-lo01", { worktreePath: wt.path, worktreeBranch: wt.branch });

    assert.equal(await settleWorktree(run, "completed"), "completed");

    assert.match(git(repo, "show --stat --oneline mainline"), /new\.ts/, "the committed work is merged");
    assert.equal(readFileSync(join(wt.path, "notes.txt"), "utf8"), "not part of the merge\n", "leftover kept");
    assert.equal(run.worktreePath, wt.path);
    assert.match(run.errorMessage ?? "", /uncommitted/);
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
    const { run, done } = spawnRun({
      registry: new RunRegistry(),
      persona: builderPersona(),
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

test("spawnRun: the on_complete_hook runs in the worktree, so it sees the sub-agent's unmerged change", { timeout: 20_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = join(root, "pi-stub.mjs");
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
    const { run, done } = spawnRun({
      registry: new RunRegistry(),
      persona: builderPersona(),
      task: "probe",
      mode: "background",
      cwd: repo,
      timeoutMs: 15_000,
      worktree: true,
      mergeStrategy: "squash",
      onCompleteHook: `pwd -P > "$CONDUCTOR_RUN_DIR/hook-cwd.txt"; echo "$CONDUCTOR_WORKTREE_PATH" > "$CONDUCTOR_RUN_DIR/hook-env.txt"; test -f work.ts`,
    });
    const wtPath = run.worktreePath;
    assert.ok(wtPath, "spawnRun created a worktree");

    await done;

    const runDir = join(root, "home", ".pi", "agent", "conductor", "runs", run.id);
    assert.equal(readFileSync(join(runDir, "hook-cwd.txt"), "utf8").trim(), wtPath, "hook cwd is the worktree");
    assert.equal(readFileSync(join(runDir, "hook-env.txt"), "utf8").trim(), wtPath, "CONDUCTOR_WORKTREE_PATH is set");
    assert.equal(run.status, "completed", run.errorMessage ?? run.hookResult?.tailText);
    assert.equal(run.hookResult?.passed, true);
    assert.match(git(repo, "show --stat --oneline mainline"), /work\.ts/, "merged after the gate passed");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("forceTerminate: a killed worktree run keeps its worktree, branch and fields, and says so", { timeout: 20_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = join(root, "pi-stub.mjs");
  // Commits partial work, then keeps running until it is killed.
  writeFileSync(
    stub,
    `import { execSync } from "node:child_process";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\n` +
      `writeFileSync("partial.ts", "half done\\n");\n` +
      `execSync("git add partial.ts && git -c user.email=t@t -c user.name=T commit -m partial", { env, stdio: "pipe" });\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const { run, done } = spawnRun({
      registry,
      persona: builderPersona(),
      task: "probe",
      mode: "background",
      cwd: repo,
      timeoutMs: 15_000,
      worktree: true,
      mergeStrategy: "squash",
    });
    const wtPath = run.worktreePath!;
    const branch = run.worktreeBranch!;
    assert.ok(wtPath && branch, "spawnRun created a worktree");
    const deadline = Date.now() + 10_000;
    while (git(repo, `log --oneline mainline..${branch}`).trim() === "") {
      assert.ok(Date.now() < deadline, "the stub committed its partial work");
      await new Promise((r) => setTimeout(r, 50));
    }

    forceTerminate(run, "killed", registry);
    await done;

    assert.equal(run.status, "killed");
    assert.equal(readFileSync(join(wtPath, "partial.ts"), "utf8"), "half done\n", "worktree kept");
    assert.match(git(repo, `log --oneline mainline..${branch}`), /partial/, "branch kept with the partial commit");
    assert.equal(run.worktreePath, wtPath);
    assert.equal(run.worktreeBranch, branch);
    assert.ok(run.errorMessage?.includes(wtPath) && run.errorMessage.includes(branch), run.errorMessage);
    const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
    assert.equal(record.worktreePath, wtPath, "record.json points GC at the worktree");

    const notes: string[] = [];
    await runWorktreeCmd(
      { getRegistry: () => registry, getCwd: () => repo } as any,
      { ui: { notify: (m: string) => notes.push(m) } } as any,
      "list",
    );
    assert.ok(notes.join("\n").includes(run.id) && notes.join("\n").includes(wtPath), notes.join("\n"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
