/**
 * Tests for v0.14 worktree auto-merge additions:
 *   - `resolveMergeStrategy`: cascade permutations + built-in class defaults
 *   - `buildMergeCommitMessage`: truncation at 72, Conventional Commit format
 *   - `mergeWorktree`: real git — squash success, conflict abort, empty diff
 *
 * Real git operations use `git init` temp repos — no subprocess forks
 * of `pi` required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  resolveMergeStrategy,
  buildMergeCommitMessage,
  mergeWorktree,
} from "../src/worktree.ts";
import type { MergeStrategy } from "../src/types.ts";

// ── helpers ────────────────────────────────────────────────────────────

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "conductor-wm-test-")));
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_") && k !== "GIT_EDITOR") delete env[k];
  }
  return env;
}

/**
 * Create a minimal git repo at `dir` with one commit on `mainline`.
 * Returns `dir`.
 */
function initRepo(dir: string): void {
  const env = cleanEnv();
  const opts = { cwd: dir, stdio: "pipe" as const, env };
  execSync("git init -b mainline", opts);
  execSync("git config user.email test@test.com", opts);
  execSync("git config user.name Test", opts);
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add README.md", opts);
  execSync("git commit -m init", opts);
}

/**
 * Create a worktree branch off HEAD and return its path.
 * The branch will have one new commit.
 */
function makeWorktreeBranch(
  gitRoot: string,
  branch: string,
  filename: string,
  content: string,
): string {
  const env = cleanEnv();
  const wtPath = join(gitRoot, ".worktrees", "conductor-wt", branch);
  mkdirSync(wtPath, { recursive: true });
  execSync(`git worktree add -b ${branch} ${wtPath}`, {
    cwd: gitRoot,
    stdio: "pipe",
    env,
  });
  writeFileSync(join(wtPath, filename), content);
  const opts = { cwd: wtPath, stdio: "pipe" as const, env };
  execSync(`git add ${filename}`, opts);
  execSync(`git commit -m "feat: ${filename}"`, opts);
  return wtPath;
}

// ── resolveMergeStrategy ───────────────────────────────────────────────

test("resolveMergeStrategy: per-call wins over all lower layers", () => {
  const result = resolveMergeStrategy({
    perCall: "merge",
    projectOverride: "squash",
    userOverride: "squash",
    personaFrontmatter: "squash",
    personaName: "builder",
  });
  assert.equal(result, "merge");
});

test("resolveMergeStrategy: project override wins over user + frontmatter", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: "none",
    userOverride: "squash",
    personaFrontmatter: "squash",
    personaName: "builder",
  });
  assert.equal(result, "none");
});

test("resolveMergeStrategy: user override wins over frontmatter", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: "merge",
    personaFrontmatter: "none",
    personaName: "builder",
  });
  assert.equal(result, "merge");
});

test("resolveMergeStrategy: persona frontmatter wins over built-in default", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: undefined,
    personaFrontmatter: "none",
    personaName: "builder",
  });
  assert.equal(result, "none");
});

test("resolveMergeStrategy: built-in default — builder defaults to squash", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: undefined,
    personaFrontmatter: undefined,
    personaName: "builder",
  });
  assert.equal(result, "squash");
});

test("resolveMergeStrategy: built-in default — simplifier defaults to squash", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: undefined,
    personaFrontmatter: undefined,
    personaName: "simplifier",
  });
  assert.equal(result, "squash");
});

test("resolveMergeStrategy: built-in default — oracle defaults to none", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: undefined,
    personaFrontmatter: undefined,
    personaName: "oracle",
  });
  assert.equal(result, "none");
});

test("resolveMergeStrategy: built-in default — unknown persona defaults to none", () => {
  const result = resolveMergeStrategy({
    perCall: undefined,
    projectOverride: undefined,
    userOverride: undefined,
    personaFrontmatter: undefined,
    personaName: "my-custom-persona",
  });
  assert.equal(result, "none");
});

// ── buildMergeCommitMessage ────────────────────────────────────────────

test("buildMergeCommitMessage: basic format", () => {
  const msg = buildMergeCommitMessage("builder", "builder-abc1", "implement the hook");
  assert.equal(msg, "builder(builder-abc1): implement the hook");
});

test("buildMergeCommitMessage: task truncated at 72 chars", () => {
  const longTask = "a".repeat(100);
  const msg = buildMergeCommitMessage("builder", "builder-abc1", longTask);
  // prefix is "builder(builder-abc1): " = 23 chars, task fills to 72 total
  assert.ok(msg.length <= 72 + 3, `message too long: ${msg.length}`);
  assert.ok(msg.endsWith("…"), "truncated message should end with ellipsis");
});

test("buildMergeCommitMessage: task at exactly 72 chars not truncated", () => {
  // "builder(builder-abc1): " = 23 chars; task = 49 chars → total = 72
  const task = "b".repeat(49);
  const msg = buildMergeCommitMessage("builder", "builder-abc1", task);
  assert.equal(msg.length, 72);
  assert.ok(!msg.endsWith("…"));
});

test("buildMergeCommitMessage: persona with hyphen", () => {
  const msg = buildMergeCommitMessage("my-persona", "my-persona-abc1", "do stuff");
  assert.equal(msg, "my-persona(my-persona-abc1): do stuff");
});

// ── mergeWorktree: integration ─────────────────────────────────────────

test(
  "mergeWorktree squash: success — squash commit appears on base branch",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      const wtPath = makeWorktreeBranch(root, "conductor-wt/builder-t1", "new.ts", "hello\n");
      const result = await mergeWorktree(
        { gitRoot: root, worktreePath: wtPath, branch: "conductor-wt/builder-t1" },
        { strategy: "squash", baseBranch: "mainline", commitMessage: "builder(builder-t1): new.ts" },
      );
      assert.ok(result.success, `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.conflicts, undefined);
      // squash commit should be on mainline
      const log = execSync("git log --oneline mainline", {
        cwd: root,
        env: cleanEnv(),
        encoding: "utf8",
      });
      assert.ok(log.includes("builder(builder-t1): new.ts"), `log: ${log}`);
      // new.ts should exist on mainline
      const content = readFileSync(join(root, "new.ts"), "utf8");
      assert.equal(content, "hello\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "mergeWorktree squash: conflict — returns conflicts array, aborts cleanly",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      // Create the worktree branch (changes README.md)
      const wtPath = makeWorktreeBranch(root, "conductor-wt/builder-t2", "README.md", "from branch\n");
      // Also mutate README.md on the base branch (conflict)
      const env = cleanEnv();
      writeFileSync(join(root, "README.md"), "from base\n");
      execSync("git add README.md", { cwd: root, env, stdio: "pipe" });
      execSync("git commit -m 'base change'", { cwd: root, env, stdio: "pipe" });

      const result = await mergeWorktree(
        { gitRoot: root, worktreePath: wtPath, branch: "conductor-wt/builder-t2" },
        { strategy: "squash", baseBranch: "mainline", commitMessage: "builder(builder-t2): readme" },
      );
      assert.ok(!result.success, "expected failure on conflict");
      assert.ok(result.conflicts && result.conflicts.length > 0, "expected conflict list");
      assert.ok(result.conflicts!.some((f) => f.includes("README")));
      // Verify working tree is clean of conflicts (untracked .worktrees/ is OK)
      const status = execSync("git status --porcelain --untracked-files=no", {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.equal(status.trim(), "", `expected clean status after abort, got: ${status}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "mergeWorktree squash: empty diff — succeeds without creating a commit",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      // Create a worktree branch but don't add any new commits (no-op)
      const env = cleanEnv();
      const wtPath = join(root, ".worktrees", "conductor-wt", "builder-t3");
      mkdirSync(wtPath, { recursive: true });
      execSync(`git worktree add -b conductor-wt/builder-t3 ${wtPath}`, {
        cwd: root,
        stdio: "pipe",
        env,
      });
      // No commit on the worktree branch — it's identical to base
      const before = execSync("git rev-parse mainline", {
        cwd: root,
        env,
        encoding: "utf8",
      }).trim();
      const result = await mergeWorktree(
        { gitRoot: root, worktreePath: wtPath, branch: "conductor-wt/builder-t3" },
        { strategy: "squash", baseBranch: "mainline", commitMessage: "builder(builder-t3): noop" },
      );
      assert.ok(result.success, `expected success, got: ${JSON.stringify(result)}`);
      assert.ok(result.nothingToCommit === true, "expected nothingToCommit flag");
      // HEAD of mainline should not have moved
      const after = execSync("git rev-parse mainline", {
        cwd: root,
        env,
        encoding: "utf8",
      }).trim();
      assert.equal(before, after, "mainline HEAD should not move on empty diff");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "mergeWorktree merge strategy: success — merge commit appears on base",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      const wtPath = makeWorktreeBranch(root, "conductor-wt/builder-t4", "feat.ts", "feat\n");
      const result = await mergeWorktree(
        { gitRoot: root, worktreePath: wtPath, branch: "conductor-wt/builder-t4" },
        { strategy: "merge", baseBranch: "mainline", commitMessage: "builder(builder-t4): feat.ts" },
      );
      assert.ok(result.success, `expected success, got: ${JSON.stringify(result)}`);
      const log = execSync("git log --oneline mainline", {
        cwd: root,
        env: cleanEnv(),
        encoding: "utf8",
      });
      assert.ok(log.includes("builder(builder-t4): feat.ts"), `log: ${log}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
