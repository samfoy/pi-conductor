import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as store from "../src/effort/store.ts";
import { effortOwner, openEffort } from "../src/effort/open.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";

sandboxPi();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe", timeout: 5000 }).trim();
function repo() {
  const cwd = tmpDir("m5-reconcile-"); git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "base\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base"); return cwd;
}
test("M5 live owner refuses takeover without changing durable ownership", async () => {
  const cwd = repo(), before = openEffort(cwd, "one", "original", { verify: "" });
  assert.equal(typeof store.adoptEffort, "function", "recovery must expose a fenced owner claim");
  assert.throws(() => store.adoptEffort(before, effortOwner("other")), /live|unknown|owner/);
  assert.deepEqual(store.readEffort(cwd, "one"), before);
  const { recoverEffort } = await import("../src/effort/reconcile.ts");
  const { RunRegistry } = await import("../src/runs.ts");
  await assert.rejects(recoverEffort(before, { registry: new RunRegistry(), sessionId: "other" }), /live.*takeover refused/);
  assert.equal(existsSync(join(store.effortDir(cwd, "integration-driver"), "driver.lock")), false, "foreign recovery must not claim the live owner's repository driver");
});

test("M5 two native dead-owner claimants have one winner; old generation cannot write or CAS", { timeout: 15000 }, async () => {
  const cwd = repo();
  const imports = `import {openEffort,effortOwner} from ${JSON.stringify(new URL("../src/effort/open.ts", import.meta.url).href)}; import * as s from ${JSON.stringify(new URL("../src/effort/store.ts", import.meta.url).href)};`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `${imports} openEffort(process.argv[1], "one", "dead", {verify:""});`, cwd], { env: gitTestEnv(), timeout: 5000 });
  const old = store.readEffort(cwd, "one")!;
  const source = `${imports} process.send("ready"); process.on("message",()=>{try { const r=s.adoptEffort(s.readEffort(process.argv[1],"one"),effortOwner(process.argv[2])); process.send({won:true,owner:r.owner}); } catch(e) {process.send({won:false,error:e.message});}});`;
  const children = ["a", "b"].map(id => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, cwd, id], { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  const exits = children.map(child => once(child, "exit"));
  try {
    await Promise.all(children.map(child => once(child, "message")));
    const results = children.map(child => once(child, "message"));
    children.forEach(child => child.send("go"));
    const replies = (await Promise.all(results)).map(([r]) => r);
    assert.equal(replies.filter(r => r.won).length, 1, "exclusive successor generation must have one claimant");
    const winner = store.readEffort(cwd, "one")!;
    assert.equal(winner.owner.generation, 1);
    assert.throws(() => store.writeEffort({ ...old, status: "paused" }), /generation|fenced|owner/, "old-generation record write must be fenced");
    const { checkedCas } = await import("../src/effort/git.ts");
    assert.throws(() => checkedCas(cwd, old.intRef, old.baseOid, old.baseOid, () => store.assertEffortOwner(old, old.owner)), /generation|fenced|owner/, "old-generation CAS must be fenced");
    assert.deepEqual(store.readEffort(cwd, "one"), winner);
    assert.equal(git(cwd, "rev-parse", old.intRef), old.baseOid);
  } finally {
    children.forEach(child => child.kill("SIGTERM")); await Promise.all(exits);
  }
});
test("M5 PID reuse, missing start identity and EPERM refuse death certification", async () => {
  const { processIdentityState } = await import("../src/effort/process-group.ts");
  const identity = { pid: 1234, startTime: 99 };
  assert.equal(processIdentityState(identity, { signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } }), "unknown");
  assert.equal(processIdentityState(identity, { signal: () => {}, processes: () => [{ pid: 1234, startTime: 100, pgid: 1234, sid: 1234, state: "S" }] }), "unknown");
  assert.equal(processIdentityState({ pid: 1234 }, { signal: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), "unknown");
  assert.equal(processIdentityState(identity, { signal: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), "dead");
});

test("M5 recovery proof requires exact reachable candidate correlation, not JSON status or a foreign trailer", async () => {
  const cwd = repo(), effort = openEffort(cwd, "one", "owner", { verify: "" });
  const { integratedCandidate } = await import("../src/effort/git.ts");
  const wt = join(cwd, ".worktrees", "proof"); git(cwd, "worktree", "add", "--detach", wt, effort.baseOid);
  writeFileSync(join(wt, "a"), "a"); git(wt, "add", "a");
  git(wt, "commit", "-m", "test: candidate\n\nConductor-Effort: one\nConductor-Run: builder-proof");
  const candidateOid = git(wt, "rev-parse", "HEAD");
  const run = { id: "builder-proof", status: "completed", integration: { state: "verified", verifiedOid: candidateOid, expectedTip: effort.baseOid, candidateOid, candidateTree: git(wt, "rev-parse", "HEAD^{tree}"), branchHead: candidateOid, verifyIdentity: { command: "", timeoutSeconds: effort.policy.verifyTimeoutSeconds, retries: effort.policy.verifyRetries } } } as any;
  assert.equal(integratedCandidate(effort, run), undefined, "unreachable candidate cannot certify completion");
  git(cwd, "update-ref", effort.intRef, candidateOid, effort.baseOid);
  assert.equal(integratedCandidate(effort, run), candidateOid);
  assert.equal(integratedCandidate(effort, { ...run, id: "builder-foreign" }), undefined, "foreign run trailer cannot certify completion");
  assert.equal(integratedCandidate({ ...effort, name: "foreign" }, run), undefined, "foreign effort trailer cannot certify completion");
  writeFileSync(join(wt, "b"), "b"); git(wt, "add", "b"); git(wt, "commit", "-m", "test: later\n\nConductor-Effort: one\nConductor-Run: later");
  git(cwd, "update-ref", effort.intRef, git(wt, "rev-parse", "HEAD"), candidateOid);
  assert.equal(integratedCandidate(effort, run), candidateOid, "a descendant tip containing the exact candidate proves integration");
});

test("M5 stale CAS recomputes against actual tip and accepts only the rebuilt candidate", { timeout: 15000 }, async t => {
  const { fixture } = await import("./helpers/effort-integration.ts");
  const f = fixture(t, "true"); let moved = false;
  f.registry.onChange(run => {
    if (!moved && run.integration?.state === "verified") { moved = true; git(f.root, "update-ref", f.record.intRef, f.head, f.base); }
  });
  const result = await f.start();
  assert.equal(moved, true);
  assert.equal(result.terminal, "completed", "stale tip must be reverified, not wedged");
  assert.equal(f.run.integration?.expectedTip, f.head, "stale CAS must recompute expectedTip instead of overwriting the moved ref");
  assert.equal(f.run.integration?.casFailures, 1);
  assert.equal(result.mergeResult.nothingToCommit, true);
});

test("M5 three stale CAS failures pause without overwriting any external tip", { timeout: 15000 }, async t => {
  const { fixture, until } = await import("./helpers/effort-integration.ts");
  const { forceTerminate } = await import("../src/runs.ts");
  const f = fixture(t, "true");
  const external = join(f.root, ".worktrees", "external"); git(f.root, "worktree", "add", "--detach", external, f.base);
  let count = 0, movedTip = f.base; const seen = new Set<string>();
  f.registry.onChange(run => {
    if (run.integration?.state !== "verified" || seen.has(run.integration.candidateOid!)) return;
    seen.add(run.integration.candidateOid!);
    writeFileSync(join(external, "external"), String(++count)); git(external, "add", "external"); git(external, "commit", "-m", `test: external ${count}`);
    const tip = git(external, "rev-parse", "HEAD"); git(f.root, "update-ref", f.record.intRef, tip, movedTip); movedTip = tip;
  });
  const done = f.start();
  await until(f.registry, f.run, run => run.integration?.state === "paused");
  assert.equal(count, 3, "CAS recomputation must stop after exactly three failures");
  assert.equal(f.run.integration!.casFailures, 3);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), movedTip, "stale candidates never overwrite actual tip");
  forceTerminate(f.run, "killed", f.registry); await done;
});

test("M5 procfs exit race ignores malformed identity only after a second read proves disappearance", async t => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { linuxProcesses } = await import("../src/effort/process-group.ts");
  t.mock.method(fs, "readdirSync", () => ["1234"]);
  let count = 0;
  t.mock.method(fs, "readFileSync", () => {
    if (++count === 1) return "";
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(linuxProcesses(), [], "a vanished procfs task is not an unknown live process");
  t.mock.method(fs, "readFileSync", () => ""); syncBuiltinESMExports();
  assert.throws(() => linuxProcesses(), /unreadable process identity/, "persistently malformed identity still fails closed");
});
