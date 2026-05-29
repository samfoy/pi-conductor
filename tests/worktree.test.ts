/**
 * Tests for src/worktree.ts — v0.13 worktree-per-persona.
 *
 * Coverage:
 *   - `resolveWorktreeSpec`: correct paths for git vs non-git cwds
 *   - `detectBrazilWorkspaceRoot`: walks up and finds .brazil marker
 *   - `ensureWorktreeGitignore`: idempotent .gitignore append
 *   - `worktreeSpecFromRun`: reconstructs spec from RunRecord
 *   - `createWorktree` + `removeWorktree`: real git repo integration
 *
 * Real git operations use `git init` temp repos — no subprocess forks
 * of `pi` required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  resolveWorktreeSpec,
  createWorktree,
  removeWorktree,
  ensureWorktreeGitignore,
  detectBrazilWorkspaceRoot,
  worktreeSpecFromRun,
} from "../src/worktree.ts";
import { emptyUsage, type RunRecord } from "../src/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "conductor-wt-test-"));
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) { if (k.startsWith("GIT_") && k !== "GIT_EDITOR") delete env[k]; }
  return env;
}

/** Create a minimal git repo with one commit so worktree add works. */
function initGitRepo(dir: string): void {
  const env = { ...process.env };
  for (const k of Object.keys(env)) { if (k.startsWith("GIT_") && k !== "GIT_EDITOR") delete env[k]; }
  const opts = { cwd: dir, stdio: "pipe" as const, env };
  execSync("git init", opts);
  execSync("git config user.email test@test.com", opts);
  execSync("git config user.name Test", opts);
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add README.md", opts);
  execSync("git commit -m init", opts);
}

function stubRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "builder-abcd",
    persona: "builder",
    task: "test",
    mode: "background",
    status: "completed",
    startTime: 1_700_000_000_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    finalPath: "/tmp/f.md",
    ...overrides,
  };
}

// ── resolveWorktreeSpec ────────────────────────────────────────────────

test("resolveWorktreeSpec: returns null when cwd is not a git repo", () => {
  const dir = tmpDir();
  try {
    const spec = resolveWorktreeSpec(dir, "builder-test1");
    assert.equal(spec, null, "non-git cwd must return null (graceful degradation)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeSpec: returns correct paths inside a git repo", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const spec = resolveWorktreeSpec(dir, "builder-abc1");
    assert.ok(spec, "git repo returns a WorktreeSpec");
    assert.ok(spec!.gitRoot.length > 0, "gitRoot is non-empty");
    assert.ok(spec!.worktreePath.includes(".worktrees"), "worktreePath includes .worktrees");
    assert.ok(spec!.worktreePath.includes("conductor-wt"), "worktreePath includes conductor-wt");
    assert.ok(spec!.worktreePath.includes("builder-abc1"), "worktreePath includes run-id");
    assert.equal(spec!.branch, "conductor-wt/builder-abc1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeSpec: worktreePath is inside gitRoot", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const spec = resolveWorktreeSpec(dir, "builder-xyz9");
    assert.ok(spec);
    assert.ok(
      spec!.worktreePath.startsWith(spec!.gitRoot),
      `worktreePath (${spec!.worktreePath}) must be inside gitRoot (${spec!.gitRoot})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorktreeSpec: works from a subdirectory of the git repo", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const subdir = join(dir, "src", "pkg");
    mkdirSync(subdir, { recursive: true });
    const spec = resolveWorktreeSpec(subdir, "builder-sub1");
    assert.ok(spec, "subdirectory inside git repo returns a spec");
    assert.ok(spec!.worktreePath.startsWith(spec!.gitRoot));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ensureWorktreeGitignore ────────────────────────────────────────────

test("ensureWorktreeGitignore: creates .gitignore with .worktrees/ when file absent", () => {
  const dir = tmpDir();
  try {
    ensureWorktreeGitignore(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(content.includes(".worktrees/"), ".worktrees/ added to new .gitignore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorktreeGitignore: appends to existing .gitignore", () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    ensureWorktreeGitignore(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(content.includes("node_modules/"), "existing entries preserved");
    assert.ok(content.includes(".worktrees/"), ".worktrees/ appended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorktreeGitignore: idempotent — does not double-append", () => {
  const dir = tmpDir();
  try {
    ensureWorktreeGitignore(dir);
    ensureWorktreeGitignore(dir);
    ensureWorktreeGitignore(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    const count = content.split("\n").filter((l) => l.trim() === ".worktrees/").length;
    assert.equal(count, 1, ".worktrees/ appears exactly once after repeated calls");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── detectBrazilWorkspaceRoot ──────────────────────────────────────────

test("detectBrazilWorkspaceRoot: returns null when no .brazil marker found", () => {
  const dir = tmpDir();
  try {
    const result = detectBrazilWorkspaceRoot(dir);
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectBrazilWorkspaceRoot: returns workspace root when .brazil present", () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, ".brazil"), { recursive: true });
    const pkgDir = join(root, "src", "MyPackage");
    mkdirSync(pkgDir, { recursive: true });
    const result = detectBrazilWorkspaceRoot(pkgDir);
    assert.ok(result, "found .brazil marker");
    assert.equal(result, root, "returns the workspace root (where .brazil lives)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectBrazilWorkspaceRoot: finds marker in parent of immediate parent", () => {
  const root = tmpDir();
  try {
    mkdirSync(join(root, ".brazil"), { recursive: true });
    const deep = join(root, "src", "Pkg", "subdir");
    mkdirSync(deep, { recursive: true });
    assert.equal(detectBrazilWorkspaceRoot(deep), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── worktreeSpecFromRun ────────────────────────────────────────────────

test("worktreeSpecFromRun: returns undefined for record without worktreePath", () => {
  const r = stubRunRecord();
  assert.equal(worktreeSpecFromRun(r), undefined);
});

test("worktreeSpecFromRun: returns undefined when only one field is set", () => {
  const r = stubRunRecord({ worktreePath: "/some/path" });
  assert.equal(worktreeSpecFromRun(r), undefined);
});

test("worktreeSpecFromRun: reconstructs spec from worktreePath + worktreeBranch", () => {
  const r = stubRunRecord({
    worktreePath: "/workplace/user/Rosie/src/MyPkg/.worktrees/conductor-wt/builder-abc1",
    worktreeBranch: "conductor-wt/builder-abc1",
  });
  const spec = worktreeSpecFromRun(r);
  assert.ok(spec);
  assert.equal(spec!.worktreePath, r.worktreePath);
  assert.equal(spec!.branch, r.worktreeBranch);
  // gitRoot should be 3 levels up from worktreePath
  assert.equal(spec!.gitRoot, "/workplace/user/Rosie/src/MyPkg");
});

// ── createWorktree + removeWorktree (real git) ─────────────────────────

test(
  "createWorktree: creates worktree dir and branch; removeWorktree cleans up",
  { timeout: 15_000 },
  () => {
    const dir = tmpDir();
    try {
      initGitRepo(dir);
      const spec = resolveWorktreeSpec(dir, "builder-integ1");
      assert.ok(spec, "spec resolves for git repo");

      createWorktree(spec!, { skipGitignore: true });
      assert.ok(existsSync(spec!.worktreePath), "worktree dir exists after create");

      // Branch should appear in git branch list
      const branches = execSync("git branch", { cwd: dir, encoding: "utf-8", stdio: "pipe", env: cleanGitEnv() });
      assert.ok(
        branches.includes("conductor-wt/builder-integ1"),
        "worktree branch created",
      );

      const ok = removeWorktree(spec!);
      assert.equal(ok, true, "removeWorktree returns true on success");
      assert.ok(!existsSync(spec!.worktreePath), "worktree dir removed");

      // Branch should be gone
      const branchesAfter = execSync("git branch", {
        cwd: dir,
        encoding: "utf-8",
        stdio: "pipe",
        env: cleanGitEnv(),
      });
      assert.ok(
        !branchesAfter.includes("conductor-wt/builder-integ1"),
        "worktree branch deleted",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "createWorktree: gitignore bootstrap appended when skipGitignore not set",
  { timeout: 10_000 },
  () => {
    const dir = tmpDir();
    try {
      initGitRepo(dir);
      const spec = resolveWorktreeSpec(dir, "builder-gitignore-test");
      assert.ok(spec);
      createWorktree(spec!); // no skipGitignore
      const content = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(content.includes(".worktrees/"), ".gitignore populated by createWorktree");
      removeWorktree(spec!); // cleanup
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("createWorktree: throws on duplicate branch name (LOAD-BEARING — W1 create failure)", {
  timeout: 10_000,
}, () => {
  // W1 mutation: if createWorktree silently ignores git failures, this
  // test goes red — confirms the throw-on-failure contract.
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const spec = resolveWorktreeSpec(dir, "builder-dup1");
    assert.ok(spec);
    createWorktree(spec!, { skipGitignore: true });
    // Try to create again with same branch — must throw
    assert.throws(
      () => createWorktree(spec!, { skipGitignore: true }),
      /git worktree add failed/,
      "duplicate branch throws descriptive error",
    );
    removeWorktree(spec!); // cleanup
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree: returns false (not throws) for non-existent worktree", () => {
  const dir = tmpDir();
  try {
    initGitRepo(dir);
    const spec = {
      gitRoot: dir,
      worktreePath: join(dir, ".worktrees", "conductor-wt", "nonexistent"),
      branch: "conductor-wt/nonexistent",
    };
    const ok = removeWorktree(spec);
    assert.equal(ok, false, "removal of non-existent worktree returns false, not throws");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
