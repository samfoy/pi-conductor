/**
 * v0.14 worktree auto-merge — finalize integration tests.
 *
 * Tests the exported `applyMergeToTerminal` helper which is the seam
 * for the merge-back logic in finalize(). Mirrors the pattern from
 * runs-hook-integration.test.ts / applyHookToTerminal.
 *
 * Coverage:
 *   - squash success: run.mergeResult.success, worktreePath cleared
 *   - merge conflict: run.status flips to merge_conflict, worktreePath kept
 *   - none strategy: no-op, run unchanged
 *   - terminal !== completed: no-op
 *   - empty diff (nothingToCommit): success, worktreePath cleared
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { applyMergeToTerminal } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "conductor-runs-merge-")));
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_") && k !== "GIT_EDITOR") delete env[k];
  }
  return env;
}

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

function makeWorktreeBranch(
  gitRoot: string,
  branch: string,
  filename: string,
  content: string,
): string {
  const env = cleanEnv();
  const wtPath = join(gitRoot, ".worktrees", "conductor-wt", branch.replace("/", "-"));
  mkdirSync(wtPath, { recursive: true });
  execSync(`git worktree add -b ${branch} ${JSON.stringify(wtPath)}`, {
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

function makeRun(overrides: Partial<Run> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "conductor-run-paths-"));
  return {
    id: "builder-abc1",
    persona: "builder",
    task: "test task",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test(
  "applyMergeToTerminal: squash success — mergeResult.success, worktreePath cleared",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      const wtPath = makeWorktreeBranch(root, "conductor-wt/builder-abc1", "new.ts", "hello\n");
      const run = makeRun({
        worktreePath: wtPath,
        worktreeBranch: "conductor-wt/builder-abc1",
        worktreeBaseBranch: "mainline",
        mergeStrategy: "squash",
      });

      const terminal = await applyMergeToTerminal(run, root, "completed");

      assert.equal(terminal, "completed", "terminal should stay completed on success");
      assert.ok(run.mergeResult, "mergeResult should be set");
      assert.equal(run.mergeResult!.success, true, "mergeResult.success should be true");
      assert.equal(run.worktreePath, undefined, "worktreePath should be cleared on success");
      assert.equal(run.worktreeBranch, undefined, "worktreeBranch should be cleared on success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "applyMergeToTerminal: conflict — status flips to merge_conflict, worktreePath kept",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      const wtPath = makeWorktreeBranch(root, "conductor-wt/builder-abc2", "README.md", "from branch\n");
      // Create conflict on base
      const env = cleanEnv();
      writeFileSync(join(root, "README.md"), "from base\n");
      execSync("git add README.md", { cwd: root, env, stdio: "pipe" });
      execSync("git commit -m 'base conflict'", { cwd: root, env, stdio: "pipe" });

      const run = makeRun({
        id: "builder-abc2",
        worktreePath: wtPath,
        worktreeBranch: "conductor-wt/builder-abc2",
        worktreeBaseBranch: "mainline",
        mergeStrategy: "squash",
      });

      const terminal = await applyMergeToTerminal(run, root, "completed");

      assert.equal(terminal, "merge_conflict", "terminal must flip to merge_conflict on conflict");
      assert.ok(run.mergeResult, "mergeResult should be set");
      assert.equal(run.mergeResult!.success, false, "mergeResult.success should be false");
      assert.ok(run.mergeResult!.conflicts && run.mergeResult!.conflicts.length > 0, "conflicts list must be populated");
      assert.ok(run.worktreePath, "worktreePath should be preserved for manual resolution");
      assert.ok(run.errorMessage, "errorMessage should be set with recovery hint");
      assert.ok(run.errorMessage!.includes("conflict"), "errorMessage should mention conflict");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "applyMergeToTerminal: strategy=none — no-op, terminal unchanged",
  async () => {
    const run = makeRun({
      worktreePath: "/some/path",
      worktreeBranch: "conductor-wt/builder-abc3",
      worktreeBaseBranch: "mainline",
      mergeStrategy: "none",
    });

    const terminal = await applyMergeToTerminal(run, "/tmp", "completed");

    assert.equal(terminal, "completed", "terminal must not change when strategy=none");
    assert.equal(run.mergeResult, undefined, "mergeResult must not be set when strategy=none");
    assert.equal(run.worktreePath, "/some/path", "worktreePath must not be touched when strategy=none");
  },
);

test(
  "applyMergeToTerminal: no worktreePath — no-op",
  async () => {
    const run = makeRun({ mergeStrategy: "squash" });
    // no worktreePath set

    const terminal = await applyMergeToTerminal(run, "/tmp", "completed");

    assert.equal(terminal, "completed", "terminal must not change when no worktreePath");
    assert.equal(run.mergeResult, undefined, "mergeResult must not be set without worktreePath");
  },
);

test(
  "applyMergeToTerminal: terminal !== completed — no-op",
  async () => {
    const run = makeRun({
      worktreePath: "/some/path",
      worktreeBranch: "conductor-wt/builder-abc4",
      worktreeBaseBranch: "mainline",
      mergeStrategy: "squash",
    });

    for (const t of ["failed", "killed", "timeout", "hook_failed"] as const) {
      run.mergeResult = undefined;
      const terminal = await applyMergeToTerminal(run, "/tmp", t);
      assert.equal(terminal, t, `terminal must stay ${t} when not completed`);
      assert.equal(run.mergeResult, undefined, `mergeResult must not be set for terminal=${t}`);
    }
  },
);

test(
  "applyMergeToTerminal: no mergeStrategy — no-op",
  async () => {
    const run = makeRun({
      worktreePath: "/some/path",
      worktreeBranch: "conductor-wt/builder-abc5",
      worktreeBaseBranch: "mainline",
      // no mergeStrategy
    });

    const terminal = await applyMergeToTerminal(run, "/tmp", "completed");

    assert.equal(terminal, "completed");
    assert.equal(run.mergeResult, undefined, "mergeResult must not be set without mergeStrategy");
  },
);

test(
  "applyMergeToTerminal: empty diff (nothingToCommit) — success, worktreePath cleared",
  { timeout: 15_000 },
  async () => {
    const root = tmpDir();
    try {
      initRepo(root);
      // Worktree with no new commits
      const env = cleanEnv();
      const wtPath = join(root, ".worktrees", "conductor-wt", "builder-abc6");
      mkdirSync(wtPath, { recursive: true });
      execSync(`git worktree add -b conductor-wt/builder-abc6 ${JSON.stringify(wtPath)}`, {
        cwd: root,
        stdio: "pipe",
        env,
      });

      const run = makeRun({
        id: "builder-abc6",
        worktreePath: wtPath,
        worktreeBranch: "conductor-wt/builder-abc6",
        worktreeBaseBranch: "mainline",
        mergeStrategy: "squash",
      });

      const terminal = await applyMergeToTerminal(run, root, "completed");

      assert.equal(terminal, "completed");
      assert.ok(run.mergeResult, "mergeResult should be set");
      assert.equal(run.mergeResult!.success, true);
      assert.ok(run.mergeResult!.nothingToCommit === true, "nothingToCommit should be flagged");
      assert.equal(run.worktreePath, undefined, "worktreePath cleared even on nothingToCommit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
