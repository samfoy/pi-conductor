import cp from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fixture, git, until } from "./helpers/effort-integration.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { effortDir, readEffort } from "../src/effort/store.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { classifyRecord } from "../src/reconcile-startup.ts";
import { toRunRecord, type Run } from "../src/types.ts";
import { availableActions, forceTerminate } from "../src/runs.ts";

sandboxPi();
for (const [name, command, reason] of [
  ["red baseline", "exit 1", /baseline.*failed/],
  ["missing verifier", "m2_nonexistent_command", /baseline.*failed/],
] as const) test(name + " pauses without accepting or changing the ref", { timeout: 10000 }, async t => {
  const f = fixture(t, command); const done = f.start();
  await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.equal(f.run.status, "integrating"); assert.match(f.run.integration!.reason!, reason);
  assert.equal(readEffort(f.root, "probe")?.status, "paused"); f.unchanged();
  forceTerminate(f.run, "killed", f.registry); const outcome = await done;
  assert.equal(outcome.terminal, "killed"); f.unchanged();
});

for (const [label, command, reason] of [
  ["red candidate twice", "test ! -f change", "verify_failed"],
  ["candidate timeout twice", "if test -f change; then sleep 30; fi", "verify_timeout"],
] as const) test(label + " preserves failed candidate and writer", { timeout: 10000 }, async t => {
  const f = fixture(t, command, { verifyTimeoutSeconds: 1 }); const outcome = await f.start();
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, reason);
  assert.equal(f.run.integration!.attempts, 2); assert.ok(existsSync(f.run.integration!.verify!.logPath));
  assert.ok(existsSync(f.run.integration!.candidatePath!)); f.unchanged();
});

test("candidate dirtied by successful verifier is rejected", { timeout: 10000 }, async t => {
  const f = fixture(t, "if test -f change; then echo unverified > dirty; fi"); const done = f.start();
  await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.match(f.run.integration!.reason!, /dirty/); f.unchanged();
  assert.equal(readFileSync(join(f.run.integration!.candidatePath!, "dirty"), "utf8"), "unverified\n");
  forceTerminate(f.run, "killed", f.registry); await done;
});

for (const scenario of ["WAL write failure", "owner change before CAS", "stale CAS", "checked-out intRef"] as const) test(scenario + " prevents acceptance and ref update", { timeout: 10000 }, async t => {
  const f = fixture(t, "true");
  const lock = join(effortDir(f.root, "probe"), "effort.lock"); const previous = readFileSync(lock);
  const rename = fs.renameSync; let injected = false;
  t.mock.method(fs, "renameSync", (src: fs.PathLike, dst: fs.PathLike) => {
    if (String(dst) === f.run.recordPath && readFileSync(src, "utf8").includes('"state": "verified"')) {
      injected = true;
      if (scenario === "WAL write failure") throw new Error("injected WAL failure");
      if (scenario === "owner change before CAS") writeFileSync(lock, JSON.stringify({ ...f.record.owner, sessionId: "new-owner" }));
      if (scenario === "stale CAS") git(f.root, "update-ref", f.record.intRef, f.head, f.base);
      if (scenario === "checked-out intRef") git(f.root, "worktree", "add", join(f.root, ".worktrees", "int-ref"), "conductor-int/probe");
    }
    rename(src, dst);
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(lock, previous); });
  const done = f.start(); await until(f.registry, f.run, r => r.integration?.state === "paused" || r.status !== "integrating");
  assert.equal(injected, true);
  assert.equal(git(f.root, "rev-parse", f.record.intRef), scenario === "stale CAS" ? f.head : f.base, "driver must not overwrite external ref or advance without WAL/owner");
  assert.equal(f.run.status, "integrating"); assert.equal(f.run.landedCommit, undefined, "run must not be accepted");
  t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(lock, previous);
  if (scenario !== "owner change before CAS") { forceTerminate(f.run, "killed", f.registry); await done; }
});

for (const mode of ["kill", "reload", "quit"] as const) test(mode + " during verify reaps owned work and cannot later CAS", { timeout: 10000 }, async t => {
  const f = fixture(t, "if test -f change; then sleep 30; fi");
  const spawn = cp.spawn; let verifier: cp.ChildProcess | undefined; let verifierExited = false;
  t.mock.method(cp, "spawn", (command: string, options: cp.SpawnOptions) => {
    const child = spawn(command, options);
    if (f.run.integration!.state === "verifying") { verifier = child; child.once("exit", () => { verifierExited = true; }); }
    return child;
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const done = f.start(); let settled = 0; void done.then(() => { settled++; });
  await until(f.registry, f.run, r => r.integration?.state === "verifying" && r.integration.logPath?.includes("verify-1.log") === true);
  assert.equal(f.registry.countActive(), 0);
  assert.deepEqual(availableActions(f.run, true, "owner"), ["kill", "focus"]);
  if (mode === "kill") {
    forceTerminate(f.run, "killed", f.registry); forceTerminate(f.run, "killed", f.registry);
    const outcome = await done; assert.equal(outcome.terminal, "killed"); assert.equal(settled, 1);
  } else {
    await handleSessionShutdown({ reason: mode }, { runs: [f.run], resetSanitizer() {}, reconcileRunning() { assert.fail("integrating cannot become generic killed"); } });
    assert.equal(f.run.status, "integrating"); assert.equal(settled, 0);
    assert.equal(classifyRecord(toRunRecord(f.run), () => false, Date.now(), process.pid, () => false, "owner"), "restore-integrating");
  }
  assert.ok(verifier && (verifierExited || verifier.signalCode !== null), "owned verification shell exited before cancellation/shutdown returns");
  f.unchanged();
});


test("queued integration is durable and cancelling it does not stop the active verifier", { timeout: 10000 }, async t => {
  const f = fixture(t, 'if test -f change; then while test ! -f "$CONDUCTOR_RUN_DIR/release"; do sleep 0.02; done; fi');
  const first = f.start();
  t.after(async () => { await f.run.integrationControl?.suspend(); });
  await until(f.registry, f.run, r => r.integration?.state === "verifying" && !!r.integration.logPath?.includes("verify-1.log"));
  const dir = tmpDir("m2-queued-record-");
  const queued: Run = { ...f.run, id: "builder-queued", recordPath: join(dir, "record.json"), finalPath: join(dir, "final.md"), integrationControl: undefined, recordWrite: undefined,
    integration: { state: "queued", branchHead: f.head, enqueuedAt: Date.now(), attempts: 0, verifyIdentity: f.run.integration!.verifyIdentity } };
  f.registry.register(queued);
  const second = f.registry.integrations.enqueue(queued, () => f.registry.notify(queued));
  await until(f.registry, queued, () => existsSync(queued.recordPath));
  assert.equal(JSON.parse(readFileSync(queued.recordPath, "utf8")).status, "integrating");
  assert.deepEqual(readEffort(f.root, "probe")!.queue, [f.run.id, queued.id]);
  forceTerminate(queued, "killed", f.registry);
  assert.equal((await second).terminal, "killed");
  assert.equal(queued.integration!.candidatePath, undefined, "queued cancellation creates no candidate");
  assert.equal(f.run.status, "integrating");
  writeFileSync(join(f.run.recordPath, "..", "release"), "go");
  assert.equal((await first).terminal, "completed");
  assert.deepEqual(readEffort(f.root, "probe")!.queue, []);
});

test("owner loss while verify runs latches rejection even when the verifier exits zero", { timeout: 10000 }, async t => {
  const f = fixture(t, 'if test -f change; then trap "exit 0" TERM; sleep 30; fi');
  const lock = join(effortDir(f.root, "probe"), "effort.lock"); const before = readFileSync(lock);
  t.after(() => { writeFileSync(lock, before); });
  void f.start();
  await until(f.registry, f.run, r => r.integration?.state === "verifying" && !!r.integration.logPath?.includes("verify-1.log"));
  writeFileSync(lock, JSON.stringify({ ...f.record.owner, sessionId: "other-owner" }));
  await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.equal(f.run.integration!.verify?.passed, true, "TERM trap proves a zero exit cannot undo lost ownership");
  assert.equal(f.run.status, "integrating"); f.unchanged();
  assert.deepEqual(availableActions(f.run, true, "owner"), ["focus"]);
});
