import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toRunRecord } from "../src/types.ts";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { sandboxPi } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { createWorktree } from "../src/worktree.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { runWorktreeCmd } from "../src/commands.ts";
sandboxPi();

for (const command of ["clean", "merge"] as const) {
  for (const race of ["none", "durable-resume", "malformed", "missing", "invalid-runtime", "invalid-worktree", "registry-replacement", "mutated-alias", "cleared-path", "after-close", "invalid-base"] as const) {
    test(`H9 manual ${command} effect-time ownership: ${race}`, { timeout: 10000 }, async () => {
      const h = setup("healthy");
      const transport = h.runtime.launch(h.run, [], h.path, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", h.opts.core);
      h.run.transport = transport; await transport.ready; await h.run.recordWrite;
      h.run.status = command === "merge" ? "merge_conflict" : "failed";
      const record = toRunRecord(h.run);
      writeFileSync(h.run.recordPath, JSON.stringify(record));
      const beforeHead = git(h.root, "rev-parse", "HEAD"), beforeBranch = git(h.root, "rev-parse", "writer"), beforeIndex = git(h.root, "write-tree");
      const statePath = join(h.root, "fake");
      const replacement = { ...record, status: "running", herdr: { ...record.herdr!, launchNonce: "fresh-durable-invocation" } };
      writeFileSync(statePath, JSON.stringify({ calls: [], pane: h.pane,
        ...(race === "durable-resume" ? { rewriteRecord: { path: h.run.recordPath, value: replacement } } : {}) }));
      const cli = createHerdrCli({ socketPath: `${statePath}.socket`, env: {
        HOME: h.root, TMPDIR: h.root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: new URL("fixtures/fake-herdr.mjs", import.meta.url).pathname,
      } });
      let lookedUp = false;
      h.cli.json = async (args, limits) => {
        const result = await cli.json(args, limits);
        if (args[1] === "get" && !lookedUp) {
          lookedUp = true;
          if (race === "malformed") writeFileSync(h.run.recordPath, "{");
          if (race === "missing") unlinkSync(h.run.recordPath);
          if (race === "invalid-runtime") writeFileSync(h.run.recordPath, JSON.stringify({ ...record, runtime: null }));
          if (race === "invalid-worktree") writeFileSync(h.run.recordPath, JSON.stringify({ ...record, worktreeBranch: { invalid: true } }));
          if (race === "registry-replacement") h.registry.register({ ...h.run, status: "running", herdr: { ...h.run.herdr!, launchNonce: "registry-resume" } });
          if (race === "cleared-path") h.run.worktreePath = undefined;
          if (race === "mutated-alias") {
            h.run.herdr!.launchNonce = "mutated-in-place";
            writeFileSync(h.run.recordPath, JSON.stringify(toRunRecord(h.run)));
          }
        }
        if (args[1] === "close" && race === "after-close") writeFileSync(h.run.recordPath, JSON.stringify(replacement));
        return result;
      };
      if (race === "invalid-base") {
        Object.assign(h.run, { worktreeBaseBranch: null });
        writeFileSync(h.run.recordPath, JSON.stringify(toRunRecord(h.run)));
      }
      const notices: string[] = [];
      await runWorktreeCmd({ getRegistry: () => h.registry } as any, { ui: { notify: (message: string) => notices.push(message) } } as any, `${command} ${h.run.id}`);
      assert.equal(lookedUp, race !== "invalid-base", "reject malformed ownership before lookup; otherwise exercise async pane lookup");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      if (race === "none") {
        assert.equal(existsSync(h.path), false, "positive control cleans the worktree");
        assert.equal(state.calls.filter((c: any) => c.args[1] === "close").length, 1);
        assert.throws(() => git(h.root, "rev-parse", "--verify", "writer"));
        assert.match(notices.join("\n"), command === "clean" ? /Cleaned 1 worktree/ : /Merged/);
        if (command === "clean") assert.equal(git(h.root, "rev-parse", "HEAD"), beforeHead);
      } else {
        assert.equal(existsSync(h.path), true, "contradictory ownership must not delete the worktree");
        assert.equal(git(h.root, "rev-parse", "writer"), beforeBranch, "preserve unmerged branch");
        assert.equal(git(h.root, "rev-parse", "HEAD"), beforeHead, "no old-branch merge into base");
        assert.equal(git(h.root, "write-tree"), beforeIndex, "base index unchanged");
        assert.equal(state.calls.filter((c: any) => c.args[1] === "close").length, race === "after-close" ? 1 : 0, "no pane close with contradictory ownership");
        assert.doesNotMatch(notices.join("\n"), /Cleaned 1|✔ Merged/);
        if (race === "durable-resume") assert.equal(readFileSync(h.run.recordPath, "utf8"), JSON.stringify(replacement));
        if (race === "malformed") assert.equal(readFileSync(h.run.recordPath, "utf8"), "{");
        if (race === "missing") assert.equal(existsSync(h.run.recordPath), false);
      }
    });
  }
}

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
