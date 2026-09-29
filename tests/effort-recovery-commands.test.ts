import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as commands from "../src/commands.ts";
import { fixture, git, until } from "./helpers/effort-integration.ts";
import { sandboxPi } from "./helpers/tmp.ts";
sandboxPi();
test("M5 human requeue refuses unknown original hook; explicit replacement gates exact source in a fresh worktree", { timeout: 15000 }, async t => {
  const f = fixture(t, "true"); f.run.status = "killed";
  let confirms = 0; const messages: string[] = [];
  const ctx = { hasUI: true, ui: { confirm: async () => { confirms++; return true; }, notify: (m: string) => messages.push(m) } } as any;
  const opts = { getCwd: () => f.root, getRegistry: () => f.registry, getSessionId: () => "owner" };
  assert.equal(typeof commands.runEffortCmd, "function", "human recovery command must be available");
  await commands.runEffortCmd(opts, ctx, `requeue ${f.run.id}`);
  assert.match(messages.at(-1)!, /hook.*unknown|hook.*reconstruct|original.*hook/i);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), f.base);
  const receipt = join(f.root, ".git", "gate-receipt");
  await commands.runEffortCmd(opts, ctx, `requeue ${f.run.id} --hook printf 'two  spaces\\n' > '${receipt}'; pwd >> '${receipt}'`);
  await until(f.registry, f.run, r => r.status === "completed");
  assert.equal(readFileSync(receipt, "utf8").split("\n")[0], "two  spaces", "human replacement shell command must preserve quoted whitespace");
  assert.notEqual(readFileSync(receipt, "utf8").trim().split("\n").at(-1), f.run.worktreePath, "requeue hook must use a fresh private checkout");
  assert.ok(confirms > 0);
  assert.equal(git(f.root, "rev-list", "--count", `${f.base}..${f.record.intRef}`), "1");
});
test("M5 requeue has no noninteractive bypass and preserves a dirty source", { timeout: 10000 }, async t => {
  const f = fixture(t, "true"); f.run.status = "killed"; f.run.effort!.gate = null;
  const messages: string[] = [], opts = { getCwd: () => f.root, getRegistry: () => f.registry, getSessionId: () => "owner" };
  const ctx = { hasUI: false, ui: { confirm: async () => true, notify: (m: string) => messages.push(m) } } as any;
  await commands.runEffortCmd(opts, ctx, `requeue ${f.run.id}`);
  assert.match(messages.at(-1)!, /human|interactive/i);
  writeFileSync(join(f.run.worktreePath!, "change"), "dirty evidence");
  ctx.hasUI = true;
  await commands.runEffortCmd(opts, ctx, `requeue ${f.run.id}`);
  assert.match(messages.at(-1)!, /dirty/);
  assert.equal(readFileSync(join(f.run.worktreePath!, "change"), "utf8"), "dirty evidence");
  assert.equal(git(f.root, "rev-parse", f.record.intRef), f.base);
});

test("M5 requeue of the paused member must recheck baseline rather than blindly reuse its old gate", { timeout: 15000 }, async t => {
  const f = fixture(t, "true"); f.run.status = "killed"; f.run.effort!.gate = null;
  const { writeEffort } = await import("../src/effort/store.ts");
  writeEffort({ ...f.record, status: "paused", pausedReason: "source branch head changed", pausedRun: f.run.id });
  const messages: string[] = [];
  await commands.runEffortCmd({ getCwd: () => f.root, getRegistry: () => f.registry, getSessionId: () => "owner" }, { hasUI: true, ui: { confirm: async () => true, notify: (m: string) => messages.push(m) } } as any, `requeue ${f.run.id}`);
  assert.match(messages.at(-1)!, /Recovery checked/, "human recovery of the pause-causing member is supported");
  await until(f.registry, f.run, run => run.status === "completed");
  assert.equal(f.run.integration!.expectedTip, f.base);
});
