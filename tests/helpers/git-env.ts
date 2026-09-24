/**
 * Env for every git subprocess a test spawns (and for scripts that shell
 * out to git, like the pre-commit hook fixtures). Strips all GIT_* keys:
 * a `git commit` from a linked worktree exports GIT_DIR / GIT_INDEX_FILE
 * to the hook, and an inheriting child git rewrites the REAL repo instead
 * of the temp one (see tests/git-env.test.ts). Overrides apply after the
 * strip, so an explicit GIT_CONFIG_GLOBAL survives.
 */
export function gitTestEnv(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("GIT_")));
  return { ...scrubbed, ...overrides };
}
