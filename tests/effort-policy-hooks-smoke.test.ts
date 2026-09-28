import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, git, until } from "./helpers/effort-integration.ts";
import { sandboxPi } from "./helpers/tmp.ts";
import { forceTerminate } from "../src/runs.ts";

sandboxPi();
for (const [label, hook] of [
  ["rejecting repository hook", "echo policy-refused >&2; exit 1"],
  ["missing local dependencies", "test -d node_modules || { echo dependencies-missing >&2; exit 1; }"],
  ["hook leaves unstaged changes", "echo dirty > not-committed"],
] as const) test(label + " preserves evidence and cannot advance intRef", { timeout: 10000 }, async t => {
  const f = fixture(t, "true"); f.hook(hook); const done = f.start();
  await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.equal(f.run.status, "integrating"); f.unchanged();
  assert.ok(existsSync(f.run.integration!.candidatePath!));
  assert.ok(existsSync(f.run.integration!.commitHook!.logPath));
  assert.equal(existsSync(join(f.root, "node_modules")), false, "driver never installs or modifies base dependencies");
  forceTerminate(f.run, "killed", f.registry); await done; f.unchanged();
});

test("hook edits are committed and effort verify sees the exact post-hook OID/tree", { timeout: 10000 }, async t => {
  const f = fixture(t, 'if test -n "$CONDUCTOR_CANDIDATE"; then test "$(cat change)" = hook-edited || exit 1; fi; git rev-parse HEAD');
  f.hook('echo hook-edited > change; git add change');
  const outcome = await f.start();
  assert.equal(outcome.terminal, "completed"); assert.ok(outcome.landedCommit);
  assert.notEqual(outcome.landedCommit, f.head);
  assert.equal(git(f.root, "show", `${outcome.landedCommit}:change`), "hook-edited");
  assert.equal(readFileSync(outcome.mergeResult.verify!.logPath, "utf8").trim(), outcome.landedCommit);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), outcome.landedCommit);
  assert.equal(git(f.root, "show", "-s", "--format=%P", outcome.landedCommit), f.base);
});

test('verify:"" disables only effort verification, never repository hooks', { timeout: 10000 }, async t => {
  const f = fixture(t, ""); f.hook('echo required-hook-executed');
  const outcome = await f.start();
  assert.equal(outcome.terminal, "completed"); assert.equal(outcome.mergeResult.verifyDisabled, true);
  assert.equal(f.run.integration!.commitHook!.passed, true);
  assert.match(readFileSync(f.run.integration!.commitHook!.logPath, "utf8"), /required-hook-executed/);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), outcome.landedCommit);
});

test("no-op requires equality to a verified tip and creates no candidate commit", { timeout: 10000 }, async t => {
  const f = fixture(t, "test -f base", {}, false); f.hook("exit 1");
  const outcome = await f.start();
  assert.equal(outcome.terminal, "completed"); assert.equal(outcome.mergeResult.nothingToCommit, true);
  assert.equal(f.run.integration!.candidateOid, undefined); assert.equal(outcome.landedCommit, undefined);
  f.unchanged();
});

test("transient red retries the same candidate and records flaky acceptance", { timeout: 10000 }, async t => {
  const f = fixture(t, 'if test -n "$CONDUCTOR_CANDIDATE"; then if test ! -f "$TMPDIR/once"; then touch "$TMPDIR/once"; exit 1; fi; fi; git rev-parse HEAD');
  const outcome = await f.start();
  assert.equal(outcome.terminal, "completed"); assert.equal(outcome.mergeResult.flakyVerify, true);
  assert.equal(f.run.integration!.attempts, 2); assert.equal(outcome.mergeResult.verify!.tailText, outcome.landedCommit);
});

test("merge-tree textual conflict is distinct from a command error", { timeout: 10000 }, async t => {
  const f = fixture(t, "true");
  const other = join(f.root, ".worktrees", "other"); git(f.root, "worktree", "add", "--detach", other, f.base);
  writeFileSync(join(other, "change"), "other work"); git(other, "add", "change"); git(other, "commit", "-m", "other");
  const moved = git(other, "rev-parse", "HEAD"); git(f.root, "update-ref", f.record.intRef, moved, f.base);
  const outcome = await f.start();
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "conflict");
  assert.deepEqual(outcome.mergeResult.conflicts, ["change"]); assert.equal(outcome.landedCommit, undefined);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), moved);
});
