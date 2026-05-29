/**
 * pi-conductor — git worktree management for v0.13 worktree-per-persona.
 *
 * Provides pure-resolution + imperative-action separation:
 *   - `resolveWorktreeSpec`  — path computation + git root detection (I/O: git CLI only)
 *   - `createWorktree`       — `git worktree add` + `ensureWorktreeGitignore`
 *   - `removeWorktree`       — `git worktree remove --force` + `git branch -D` (best-effort)
 *   - `ensureWorktreeGitignore` — idempotent `.gitignore` append
 *   - `detectBrazilWorkspaceRoot` — walks up dir tree looking for `.brazil` marker
 *   - `worktreeSpecFromRun`  — reconstruct spec from a persisted RunRecord (for GC)
 *
 * Design: docs/v0.13-worktree-design.md
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { RunRecord } from "./types.ts";

/**
 * Strip git environment variables that git passes to hooks (GIT_INDEX_FILE,
 * GIT_DIR, GIT_WORK_TREE, etc.) from child processes. Without this, git
 * commands in temp repos launched from inside the pre-commit hook inherit
 * the parent repo's git context and behave incorrectly.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && key !== "GIT_EDITOR" && key !== "GIT_AUTHOR_NAME" && key !== "GIT_AUTHOR_EMAIL") {
      delete env[key];
    }
  }
  return env;
}

function gitExec(args: string, cwd: string): string {
  return execSync(args, { cwd, encoding: "utf-8", stdio: "pipe", env: gitEnv() }).trim();
}

function tryGitExec(args: string, cwd: string): string | null {
  try {
    return gitExec(args, cwd);
  } catch {
    return null;
  }
}

export interface WorktreeSpec {
  /** Absolute real path to the git repo root (realpathSync resolved). */
  gitRoot: string;
  /** Absolute path where the worktree will be / was created. */
  worktreePath: string;
  /** Git branch name: `conductor-wt/<run-id>`. */
  branch: string;
}

/**
 * Resolve the worktree spec for a run. Makes one I/O call to find the
 * git root (`git rev-parse --show-toplevel`).
 *
 * Returns `null` when `cwd` is not inside a git repo (no .git, bare
 * clone, /tmp, network share). Callers MUST fall back to shared-cwd
 * spawn in this case — never throw on a non-git cwd.
 *
 * Does NOT mutate `.gitignore` or touch the filesystem beyond the git
 * CLI call. Gitignore bootstrap lives in `createWorktree`.
 */
export function resolveWorktreeSpec(cwd: string, runId: string): WorktreeSpec | null {
  const rawRoot = tryGitExec("git rev-parse --show-toplevel", cwd);
  if (rawRoot === null) return null;

  // Resolve symlinks so the worktree is guaranteed to be on the same
  // filesystem volume as the git repo (prevents cross-device link errors
  // — the AIVirtuoso P0 lesson).
  let gitRoot: string;
  try {
    gitRoot = realpathSync(rawRoot);
  } catch {
    gitRoot = rawRoot; // best-effort: use unresolved if realpath fails
  }

  const branch = `conductor-wt/${runId}`;
  const worktreePath = join(gitRoot, ".worktrees", "conductor-wt", runId);

  return { gitRoot, worktreePath, branch };
}

/**
 * Create the worktree on disk.
 *
 * Steps:
 *   1. `ensureWorktreeGitignore(gitRoot)` — idempotent gitignore entry.
 *   2. `git worktree add <worktreePath> -b <branch> HEAD` from `gitRoot`.
 *
 * Throws on failure (branch already exists, disk full, etc.). Callers
 * in `spawnRun` must catch and flip the run to `failed`.
 *
 * @param opts.skipGitignore - Set `true` in tests to skip .gitignore mutation.
 */
export function createWorktree(
  spec: WorktreeSpec,
  opts: { skipGitignore?: boolean } = {},
): void {
  if (!opts.skipGitignore) {
    ensureWorktreeGitignore(spec.gitRoot);
  }

  mkdirSync(dirname(spec.worktreePath), { recursive: true });

  try {
    execSync(
      `git worktree add ${JSON.stringify(spec.worktreePath)} -b ${JSON.stringify(spec.branch)} HEAD`,
      { cwd: spec.gitRoot, stdio: "pipe", env: gitEnv() },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Include stderr from the git command when available.
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : "";
    throw new Error(
      `git worktree add failed for ${spec.worktreePath}: ${stderr || msg}`,
    );
  }
}

/**
 * Remove a worktree and its branch. Best-effort — swallows ENOENT and
 * git errors so callers (finalize, GC) are not blocked.
 *
 * Returns `true` when both steps succeeded; `false` when one or both
 * failed (errors are logged to stderr but not re-thrown).
 */
export function removeWorktree(spec: WorktreeSpec): boolean {
  let ok = true;

  try {
    execSync(
      `git worktree remove --force ${JSON.stringify(spec.worktreePath)}`,
      { cwd: spec.gitRoot, stdio: "pipe", env: gitEnv() },
    );
  } catch {
    ok = false;
  }

  try {
    execSync(
      `git branch -D ${JSON.stringify(spec.branch)}`,
      { cwd: spec.gitRoot, stdio: "pipe", env: gitEnv() },
    );
  } catch {
    ok = false;
  }

  // Best-effort prune of stale worktree metadata.
  try {
    execSync("git worktree prune", { cwd: spec.gitRoot, stdio: "pipe", env: gitEnv() });
  } catch {
    // ignore — prune is advisory
  }

  return ok;
}

/**
 * Idempotently append `.worktrees/` to `<gitRoot>/.gitignore`.
 * If `.gitignore` does not exist, creates it. Does nothing if the
 * pattern is already present.
 */
export function ensureWorktreeGitignore(gitRoot: string): void {
  const ignorePath = join(gitRoot, ".gitignore");
  const pattern = ".worktrees/";

  if (existsSync(ignorePath)) {
    const content = readFileSync(ignorePath, "utf-8");
    // Check for the pattern on its own line (with or without trailing newline).
    if (content.split("\n").some((line) => line.trim() === pattern.trim())) {
      return; // already present
    }
    // Append with a leading newline if the file doesn't end with one.
    const prefix = content.endsWith("\n") ? "" : "\n";
    appendFileSync(ignorePath, `${prefix}${pattern}\n`, "utf-8");
  } else {
    appendFileSync(ignorePath, `${pattern}\n`, "utf-8");
  }
}

/**
 * Walk up from `cwd` looking for a `.brazil` directory marker.
 * Returns the workspace root (the directory that contains `.brazil`)
 * or `null` when not inside a Brazil workspace.
 *
 * Used to verify the worktree is placed inside the workspace root
 * (Brazil's `find_workspace_directory_up` requirement).
 */
export function detectBrazilWorkspaceRoot(cwd: string): string | null {
  let dir = cwd;
  // Safety cap to avoid infinite loops on unusual filesystems.
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, ".brazil"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Reconstruct a `WorktreeSpec` from a persisted `RunRecord`.
 * Returns `undefined` when the record has no worktree information
 * (pre-v0.13 record or worktree was already cleaned up).
 *
 * Used by the GC executor to clean up orphaned worktrees.
 */
export function worktreeSpecFromRun(record: RunRecord): WorktreeSpec | undefined {
  if (!record.worktreePath || !record.worktreeBranch) return undefined;

  // Reconstruct gitRoot from worktreePath:
  // worktreePath = <gitRoot>/.worktrees/conductor-wt/<run-id>
  // so gitRoot = worktreePath/../../../ = three levels up
  const gitRoot = dirname(dirname(dirname(record.worktreePath)));

  return {
    gitRoot,
    worktreePath: record.worktreePath,
    branch: record.worktreeBranch,
  };
}

// ── Internal helpers — none (gitExec / tryGitExec above cover all cases) ──────
