/**
 * Regression: git subprocesses spawned by tests must not inherit the
 * pre-commit hook's GIT_* env.
 *
 * A `git commit` run from a linked worktree (where builder sub-agents
 * commit) exports GIT_DIR=<main>/.git/worktrees/<wt> and GIT_INDEX_FILE to
 * the hook. A test's `git init` / `git config` in a temp dir that inherits
 * them rewrites the REAL repo instead: worktree gitdirs share the main
 * `.git/config`, and `git init` guesses a non-`.git` GIT_DIR is bare.
 * Witnessed as core.bare=true plus user.name=Test / user.email=test@test.com
 * in the real config, misattributing 13 master commits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTestEnv } from "./helpers/git-env.ts";

interface Sentinel {
  root: string;
  config: string;
  worktreeGitDir: string;
  worktreeIndex: string;
  /** The env a pre-commit hook sees when the commit runs in the sentinel's linked worktree. */
  hookEnv: NodeJS.ProcessEnv;
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  return spawnSync("git", args, { cwd, env, stdio: "pipe" }).status ?? -1;
}

/**
 * Build the sentinel from a from-scratch env (own HOME, no system config)
 * so the fixture never depends on the outer environment or on the helper
 * under test.
 */
function makeSentinel(): Sentinel {
  const root = mkdtempSync(join(tmpdir(), "conductor-git-env-sentinel-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const main = join(root, "main");
  const ok = (args: string[], cwd: string) => assert.equal(git(args, cwd, env), 0, `sentinel: git ${args.join(" ")}`);
  ok(["init", "-q", main], root);
  writeFileSync(join(main, "f"), "sentinel\n");
  ok(["add", "f"], main);
  ok(["-c", "user.name=S", "-c", "user.email=s@s", "commit", "-q", "-m", "sentinel"], main);
  ok(["worktree", "add", "-q", join(root, "wt"), "-b", "wt"], main);
  const worktreeGitDir = join(main, ".git", "worktrees", "wt");
  const worktreeIndex = join(worktreeGitDir, "index");
  return {
    root,
    config: join(main, ".git", "config"),
    worktreeGitDir,
    worktreeIndex,
    hookEnv: { ...env, GIT_DIR: worktreeGitDir, GIT_INDEX_FILE: worktreeIndex },
  };
}

/** The temp-repo bootstrap every git-using test file performs. Returns each step's exit status. */
function bootstrapTempRepo(dir: string, env: NodeJS.ProcessEnv): number[] {
  writeFileSync(join(dir, "README.md"), "init\n");
  return [
    git(["init", "-q"], dir, env),
    git(["config", "user.email", "test@test.com"], dir, env),
    git(["config", "user.name", "Test"], dir, env),
    git(["add", "README.md"], dir, env),
    git(["commit", "-q", "-m", "init"], dir, env),
  ];
}

function snapshot(s: Sentinel): { config: string; index: Buffer } {
  return { config: readFileSync(s.config, "utf8"), index: readFileSync(s.worktreeIndex) };
}

test("fixture validity: the raw hook env DOES rewrite the sentinel repo", { timeout: 10_000 }, () => {
  const s = makeSentinel();
  const temp = mkdtempSync(join(tmpdir(), "conductor-git-env-temp-"));
  try {
    bootstrapTempRepo(temp, s.hookEnv);
    const config = readFileSync(s.config, "utf8");
    assert.match(config, /bare = true/, "leaked git init should flip the sentinel's core.bare");
    assert.match(config, /name = Test/, "leaked git config should land in the sentinel's config");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gitTestEnv: a temp-repo bootstrap under the hook env leaves the sentinel untouched", { timeout: 10_000 }, () => {
  const s = makeSentinel();
  const temp = mkdtempSync(join(tmpdir(), "conductor-git-env-temp-"));
  try {
    const before = snapshot(s);
    const statuses = bootstrapTempRepo(temp, gitTestEnv({ HOME: s.root, GIT_CONFIG_NOSYSTEM: "1" }, s.hookEnv));
    const after = snapshot(s);

    assert.equal(after.config, before.config, "sentinel .git/config must be byte-identical");
    assert.ok(after.index.equals(before.index), "sentinel worktree index must be byte-identical");
    assert.deepEqual(statuses, [0, 0, 0, 0, 0], "bootstrap must succeed against the temp repo");
    assert.ok(existsSync(join(temp, ".git", "HEAD")), "temp repo must own its own .git");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gitTestEnv: strips every GIT_* key and applies overrides after the strip", () => {
  const env = gitTestEnv(
    { GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/override" },
    { GIT_DIR: "/x", GIT_INDEX_FILE: "/x/index", GIT_EDITOR: "vi", GIT_AUTHOR_NAME: "A", PATH: "/base", HOME: "/h" },
  );
  assert.deepEqual(env, { GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/override", HOME: "/h" });
});
