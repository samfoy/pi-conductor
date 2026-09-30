import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { createWorktree } from "../src/worktree.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { runWorktreeCmd } from "../src/commands.ts";
sandboxPi();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
function setup(mode = "held") {
  const h = herdrFixture(mode), root = h.run.cwd;
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "base"), "base"); writeFileSync(join(root, ".gitignore"), ".worktrees/\noracle-h7/\n");
  git(root, "add", "base", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), path = join(root, ".worktrees", "conductor-wt", h.run.id);
  createWorktree({ gitRoot: root, worktreePath: path, branch: "writer" });
  writeFileSync(join(path, "change"), "verified change"); git(path, "add", "change"); git(path, "commit", "-m", "change");
  Object.assign(h.run, { worktreePath: path, worktreeBranch: "writer", worktreeBaseBranch: "main", mergeStrategy: "squash" });
  return { ...h, root, path, base };
}
for (const command of ["merge", "clean"]) test(`H7 manual ${command} refuses unproven child before merge/delete effects`, { timeout: 5000 }, async () => {
  const h = setup(); h.run.status = command === "merge" ? "merge_conflict" : "failed";
  const messages: string[] = [];
  await runWorktreeCmd({ getRegistry: () => h.registry } as any, { ui: { notify: (message: string) => messages.push(message) } } as any, `${command} ${h.run.id}`);
  assert.equal(git(h.root, "rev-parse", "HEAD"), h.base, "unsafe base commit before child exit proof");
  assert.equal(existsSync(h.path), true, "unsafe directory delete before pane proof"); assert.equal(h.run.worktreePath, h.path);
});
for (const replaced of [false, true]) test(`H7 hook -> merge -> exact empty-pane release -> directory cleanup (replaced=${replaced})`, { timeout: 10000 }, async () => {
  const h = setup();
  h.onSleep(() => { assert.equal(h.run.hookResult, undefined, "unsafe hook before child exit"); assert.equal(git(h.root, "rev-parse", "HEAD"), h.base); h.exit(); if (replaced) h.pane.terminal_id = "foreign"; });
  await createRunPipeline(h.run, [], { ...h.opts, cwd: h.path, resolvedHook: { command: "test -f change", timeoutSeconds: 5, source: "per-call" } });
  assert.equal(h.run.status, "completed", h.run.errorMessage); assert.equal(h.run.hookResult?.passed, true);
  assert.notEqual(git(h.root, "rev-parse", "HEAD"), h.base);
  assert.equal(existsSync(h.path), replaced, "unsafe directory delete without exact empty-pane proof");
  assert.equal(h.calls.filter(c => c === "pane close").length, replaced ? 0 : 1);
  assert.equal(h.run.worktreePath, replaced ? h.path : undefined);
});
