/**
 * Finalize's worktree step (`settleWorktree`): a successful merge-back
 * removes the worktree directory and deletes its branch; a merge_conflict
 * keeps both for manual resolution; a run that isn't merged keeps a branch
 * holding unmerged commits and loses only its clean directory (v0.20 W2).
 * With no merge-back (`none`), the branch is
 * the deliverable: only a clean worktree directory goes (v0.20 B3). The
 * on_complete_hook gate runs in the worktree, not the main checkout (B4).
 * A leftover uncommitted change is never force-removed, and a run settled
 * by forceTerminate (kill, stall, timeout) keeps its partial work. A resume
 * that doesn't complete never releases a worktree it didn't merge.
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

import { forceTerminate, RunRegistry, sendToRun, settleWorktree, spawnRun } from "../src/runs.ts";
import { runWorktreeCmd } from "../src/commands.ts";
import { formatCompletionNotification } from "../src/notifications.ts";
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

/**
 * A PI_BIN stub that handles cwd the way pi 0.87.1 does. A fresh spawn
 * writes a session file whose header cwd is the process cwd, then runs
 * `onSpawn`. A resume (`--session`) moves to the header's cwd, or exits 1
 * like pi's MissingSessionCwdError when it's gone, then runs `onResume`.
 */
function writePiStub(root: string, parts: { onSpawn: string; onResume: string }): string {
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(
    stub,
    `import { execSync } from "node:child_process";\n` +
      `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\n` +
      `const commit = (file, text, msg) => { writeFileSync(file, text); execSync(\`git add \${file} && git -c user.email=t@t -c user.name=T commit -m \${msg}\`, { env, stdio: "pipe" }); };\n` +
      `if (args.includes("--session")) {\n` +
      `  const header = JSON.parse(readFileSync(args[args.indexOf("--session") + 1], "utf8").split("\\n")[0]);\n` +
      `  if (!existsSync(header.cwd)) { process.stderr.write("Stored session working directory does not exist: " + header.cwd + "\\n"); process.exit(1); }\n` +
      `  process.chdir(header.cwd);\n` +
      `${parts.onResume}\n} else {\n` +
      `  const sd = args[args.indexOf("--session-dir") + 1];\n` +
      `  mkdirSync(sd, { recursive: true });\n` +
      `  writeFileSync(join(sd, "s.jsonl"), JSON.stringify({ type: "session", cwd: process.cwd() }) + "\\n");\n` +
      `${parts.onSpawn}\n}\n`,
  );
  return stub;
}

/** Point HOME and PI_BIN at the test's temp dirs for `fn`, then restore them. */
async function withPiStub(root: string, stub: string, fn: () => Promise<void>): Promise<void> {
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = stub;
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const danglingCommits = (repo: string): number =>
  git(repo, "fsck --no-reflogs").split("\n").filter((l) => l.startsWith("dangling commit")).length;

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

for (const status of ["failed", "hook_failed"] as const) {
  test(`settleWorktree: a ${status} run keeps its branch with the unmerged commit; only the clean directory goes`, { timeout: 15_000 }, async () => {
    const { root, repo } = initRepo();
    try {
      const wt = worktreeWithCommit(repo, "builder-fl01", "x.ts", "x\n");
      const run = makeRun("builder-fl01", { status, worktreePath: wt.path, worktreeBranch: wt.branch });

      assert.equal(await settleWorktree(run, status), status);

      assert.equal(run.mergeResult, undefined, "no merge attempted");
      assert.equal(existsSync(wt.path), false, "clean worktree directory removed");
      assert.match(git(repo, `log --stat --oneline mainline..${wt.branch}`), /x\.ts/, "the branch still holds the work");
      assert.doesNotMatch(git(repo, "log --stat --oneline mainline"), /x\.ts/, "nothing merged");
      assert.equal(run.worktreePath, undefined, "no directory to point at");
      assert.equal(run.worktreeBranch, wt.branch, "the kept branch is recorded");
      assert.ok(run.worktreeKept?.includes(wt.branch), `the card names the kept branch: ${run.worktreeKept}`);
      assert.equal(run.errorMessage, undefined, "the hint is not an error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("settleWorktree: a failed run whose branch has no unmerged commits loses the branch too", { timeout: 15_000 }, async () => {
  const { root, repo } = initRepo();
  try {
    const branch = "conductor-wt/builder-fl02";
    const path = join(repo, ".worktrees", "conductor-wt", "builder-fl02");
    git(repo, `worktree add -b ${branch} ${JSON.stringify(path)}`);
    const run = makeRun("builder-fl02", { status: "failed", worktreePath: path, worktreeBranch: branch });

    assert.equal(await settleWorktree(run, "failed"), "failed");

    assert.equal(existsSync(path), false);
    assert.equal(branchExists(repo, branch), false, "nothing to lose, so the branch goes");
    assert.equal(run.worktreePath, undefined);
    assert.equal(run.worktreeBranch, undefined);
    assert.equal(run.errorMessage, undefined);
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
    assert.equal(run.errorMessage, "pi subprocess exited with code 1", "the genuine error, alone");
    assert.match(run.worktreeKept ?? "", /uncommitted/);
    assert.ok(run.worktreeKept?.includes(wt.path), run.worktreeKept);
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
    assert.equal(run.errorMessage, undefined, "a successful merge reports no error");
    assert.match(run.worktreeKept ?? "", /uncommitted/);
    const card = formatCompletionNotification(run);
    assert.doesNotMatch(card, /<error>/, "the card doesn't read as a failure");
    assert.ok(card.includes(`<worktree-kept path="${wt.path}" branch="${wt.branch}">worktree kept: uncommitted`), card);
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
    assert.ok(run.worktreeKept?.includes(wtPath) && run.worktreeKept.includes(branch), run.worktreeKept);
    assert.equal(run.errorMessage, undefined, "the hint is not an error");
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

// A resume runs in the session header's cwd, the worktree, so it can add
// commits there. One that doesn't complete must leave the kept worktree
// and branch alone; GC rule 5b reclaims them later.
test("sendToRun: a killed worktree run's worktree and branch survive a failed resume", { timeout: 30_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = writePiStub(root, {
    onSpawn: `commit("partial.ts", "half done\\n", "partial"); setInterval(() => {}, 1000);`,
    onResume: `process.stderr.write("resume boom\\n"); process.exit(1);`,
  });
  try {
    await withPiStub(root, stub, async () => {
      const registry = new RunRegistry();
      const { run, done } = spawnRun({
        registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
        timeoutMs: 15_000, worktree: true, mergeStrategy: "squash",
      });
      const wtPath = run.worktreePath!;
      const branch = run.worktreeBranch!;
      const deadline = Date.now() + 10_000;
      while (git(repo, `log --oneline mainline..${branch}`).trim() === "") {
        assert.ok(Date.now() < deadline, "the stub committed its partial work");
        await new Promise((r) => setTimeout(r, 50));
      }
      forceTerminate(run, "killed", registry);
      await done;
      assert.ok(existsSync(join(wtPath, "partial.ts")), "precondition: the kill kept the worktree");
      assert.ok(run.sessionPath && existsSync(run.sessionPath), `resumable: ${run.sessionPath}`);

      const sent = sendToRun(run, "please continue", { registry, timeoutMs: 10_000 });
      assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
      await sent.done;

      assert.equal(run.status, "failed");
      assert.equal(readFileSync(join(wtPath, "partial.ts"), "utf8"), "half done\n", "worktree kept");
      assert.match(git(repo, `log --oneline mainline..${branch}`), /partial/, "branch kept with the partial commit");
      assert.equal(run.worktreePath, wtPath);
      assert.equal(run.worktreeBranch, branch);
      assert.equal(danglingCommits(repo), 0, "no commit left dangling");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendToRun: a merge_conflict run's worktree and branch survive a failed resume", { timeout: 30_000 }, async () => {
  const { root, repo } = initRepo();
  // The spawn commits one side of a conflict in the worktree and the other on mainline.
  const stub = writePiStub(root, {
    onSpawn:
      `commit("README.md", "builder side\\n", "builder");\n` +
      `execSync("git -c user.email=t@t -c user.name=T commit -am base-side", { env, stdio: "pipe", cwd: ${JSON.stringify(repo)} });`,
    onResume: `process.stderr.write("resume boom\\n"); process.exit(1);`,
  });
  try {
    writeFileSync(join(repo, "README.md"), "base side\n");
    await withPiStub(root, stub, async () => {
      const registry = new RunRegistry();
      const { run, done } = spawnRun({
        registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
        timeoutMs: 15_000, worktree: true, mergeStrategy: "squash",
      });
      const wtPath = run.worktreePath!;
      const branch = run.worktreeBranch!;
      await done;
      assert.equal(run.status, "merge_conflict", `precondition: conflict (${run.errorMessage})`);
      assert.ok(run.sessionPath && existsSync(run.sessionPath), `resumable: ${run.sessionPath}`);

      const sent = sendToRun(run, "please fix the conflict", { registry, timeoutMs: 10_000 });
      assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
      await sent.done;

      assert.equal(run.status, "failed");
      assert.equal(readFileSync(join(wtPath, "README.md"), "utf8"), "builder side\n", "worktree kept");
      assert.match(git(repo, `log --oneline mainline..${branch}`), /builder/, "branch kept with the builder's commit");
      assert.equal(run.worktreePath, wtPath);
      assert.equal(run.worktreeBranch, branch);
      assert.equal(danglingCommits(repo), 0, "no commit left dangling");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// v0.20 B4 runs the hook gate against the worktree, so hook_failed is the
// normal outcome for work that fails it. That work must survive.
test("spawnRun: a builder whose work fails the on_complete_hook keeps it on its branch", { timeout: 20_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = writePiStub(root, {
    onSpawn: `commit("work.ts", "rejected by the gate\\n", "work");`,
    onResume: `process.exit(0);`,
  });
  try {
    await withPiStub(root, stub, async () => {
      const registry = new RunRegistry();
      const { run, done } = spawnRun({
        registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
        timeoutMs: 15_000, worktree: true, mergeStrategy: "squash", onCompleteHook: "exit 1",
      });
      const wtPath = run.worktreePath!;
      const branch = run.worktreeBranch!;
      await done;

      assert.equal(run.status, "hook_failed", run.errorMessage);
      assert.match(git(repo, `log --stat --oneline mainline..${branch}`), /work\.ts/, "the rejected work is on its branch");
      assert.equal(existsSync(wtPath), false, "the clean directory is removed");
      assert.equal(run.worktreeBranch, branch);
      const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
      assert.equal(record.worktreeBranch, branch, "record.json keeps the branch for GC");

      const notes: string[] = [];
      await runWorktreeCmd(
        { getRegistry: () => registry, getCwd: () => repo } as any,
        { ui: { notify: (m: string) => notes.push(m) } } as any,
        "list",
      );
      assert.ok(notes.join("\n").includes(run.id) && notes.join("\n").includes(branch), notes.join("\n"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A merge removes the worktree, and pi resumes in the session header's cwd,
// so a resume must put a worktree back at that path first (v0.20 W3).
/** Resume body that waits for `<root>/go`, so the test can inspect the restored worktree mid-resume. */
const gatedResume = (root: string, body: string): string =>
  `const go = ${JSON.stringify(join(root, "go"))};\n` +
  `const until = Date.now() + 10000;\n` +
  `while (!existsSync(go)) { if (Date.now() > until) process.exit(3); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }\n` +
  `writeFileSync(${JSON.stringify(join(root, "resume-cwd.txt"))}, process.cwd());\n` +
  body;

async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("sendToRun: a merged builder's resume re-creates its worktree at the same path from the base tip, then merges back", { timeout: 30_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = writePiStub(root, {
    onSpawn: `commit("work.ts", "v1\\n", "work");`,
    onResume: gatedResume(root, `if (!existsSync("work.ts")) process.exit(4);\ncommit("fix.ts", "critic fix\\n", "fix");`),
  });
  try {
    await withPiStub(root, stub, async () => {
      const registry = new RunRegistry();
      const { run, done } = spawnRun({
        registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
        timeoutMs: 15_000, worktree: true, mergeStrategy: "squash",
      });
      const wtPath = run.worktreePath!;
      await done;
      assert.equal(run.status, "completed", run.errorMessage);
      assert.equal(existsSync(wtPath), false, "precondition: the merge removed the worktree");
      const baseTip = git(repo, "rev-parse mainline").trim();

      const sent = sendToRun(run, "fix the critic findings", { registry, timeoutMs: 10_000 });
      assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
      const fresh = `conductor-wt/${run.id}-r1`;
      assert.equal(run.worktreePath, wtPath, "the worktree is back at its old path");
      assert.equal(run.worktreeBranch, fresh);
      assert.equal(git(wtPath, "rev-parse HEAD").trim(), baseTip, "on a fresh branch from the base tip");
      await waitFor("record.json to name the fresh branch", () =>
        JSON.parse(readFileSync(run.recordPath, "utf8")).worktreeBranch === fresh);
      writeFileSync(join(root, "go"), "");
      await sent.done;

      assert.equal(run.status, "completed", run.errorMessage);
      assert.equal(readFileSync(join(root, "resume-cwd.txt"), "utf8"), wtPath, "the resume ran in the worktree");
      assert.match(git(repo, "show --stat --oneline mainline"), /fix\.ts/, "the fix merged back");
      assert.equal(existsSync(wtPath), false, "removed again after the merge");
      assert.equal(branchExists(repo, fresh), false);
      assert.equal(run.worktreePath, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendToRun: a hook_failed builder's resume continues on its kept branch, and both commits land", { timeout: 30_000 }, async () => {
  const { root, repo } = initRepo();
  const stub = writePiStub(root, {
    onSpawn: `commit("work.ts", "v1\\n", "work");`,
    onResume: `if (!existsSync("work.ts")) process.exit(4);\ncommit("fix.ts", "gate fix\\n", "fix");`,
  });
  try {
    await withPiStub(root, stub, async () => {
      const registry = new RunRegistry();
      const { run, done } = spawnRun({
        registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
        timeoutMs: 15_000, worktree: true, mergeStrategy: "squash", onCompleteHook: "test -f fix.ts",
      });
      const wtPath = run.worktreePath!;
      const branch = run.worktreeBranch!;
      await done;
      assert.equal(run.status, "hook_failed", run.errorMessage);
      assert.equal(existsSync(wtPath), false, "precondition: the clean directory went");

      const sent = sendToRun(run, "make the gate pass", { registry, timeoutMs: 10_000 });
      assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
      assert.equal(run.worktreeBranch, branch, "the kept branch, not a fresh one");
      await sent.done;

      assert.equal(run.status, "completed", run.errorMessage ?? run.hookResult?.tailText);
      assert.match(git(repo, "show --stat --oneline mainline"), /work\.ts[\s\S]*fix\.ts|fix\.ts[\s\S]*work\.ts/, "both commits merged");
      assert.equal(existsSync(wtPath), false);
      assert.equal(branchExists(repo, branch), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const gone of ["base branch", "repo"] as const) {
  test(`sendToRun: resuming a merged builder whose ${gone} is gone fails before spawning, and changes nothing`, { timeout: 30_000 }, async () => {
    const { root, repo } = initRepo();
    const resumed = join(root, "resumed.txt");
    const stub = writePiStub(root, {
      onSpawn: `commit("work.ts", "v1\\n", "work");`,
      onResume: `writeFileSync(${JSON.stringify(resumed)}, "");`,
    });
    try {
      await withPiStub(root, stub, async () => {
        const registry = new RunRegistry();
        const { run, done } = spawnRun({
          registry, persona: builderPersona(), task: "probe", mode: "background", cwd: repo,
          timeoutMs: 15_000, worktree: true, mergeStrategy: "squash",
        });
        const wtPath = run.worktreePath!;
        await done;
        assert.equal(run.status, "completed", run.errorMessage);
        if (gone === "base branch") {
          git(repo, "checkout -b elsewhere");
          git(repo, "branch -D mainline");
        } else {
          rmSync(repo, { recursive: true, force: true });
        }
        const before = JSON.stringify(run, (k, v) => (k === "proc" ? undefined : v));

        const sent = sendToRun(run, "fix the critic findings", { registry, timeoutMs: 10_000 });

        assert.equal(sent.kind, "rejected");
        assert.match(sent.kind === "rejected" ? sent.reason : "", new RegExp(`${gone}[\\s\\S]*spawn a fresh builder`));
        assert.equal(JSON.stringify(run, (k, v) => (k === "proc" ? undefined : v)), before, "no Run mutation");
        assert.equal(existsSync(wtPath), false, "no worktree created");
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(existsSync(resumed), false, "pi was never spawned");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("forceTerminate: a stalled worktree run keeps its error and failure class; the kept hint is separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-wt-finalize-stall-"));
  try {
    const bare = makeRun("builder-st01", { status: "running", recordPath: join(dir, "a.json"), finalPath: join(dir, "a.md") });
    const kept = makeRun("builder-st02", {
      status: "running",
      recordPath: join(dir, "b.json"),
      finalPath: join(dir, "b.md"),
      worktreePath: "/r/.worktrees/conductor-wt/builder-st02",
      worktreeBranch: "conductor-wt/builder-st02",
    });
    const registry = new RunRegistry();
    forceTerminate(bare, "stalled", registry);
    forceTerminate(kept, "stalled", registry);

    assert.equal(kept.errorMessage, bare.errorMessage, "the stall error, untouched");
    assert.equal(kept.failureClass, bare.failureClass);
    assert.ok(kept.worktreeKept?.includes("/r/.worktrees/conductor-wt/builder-st02"), kept.worktreeKept);
    assert.equal(bare.worktreeKept, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
