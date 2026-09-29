import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { git } from "./helpers/effort-integration.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import { openEffort } from "../src/effort/open.ts";
import { readEffort } from "../src/effort/store.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import type { Run, RunRecord } from "../src/types.ts";

const { piBin } = sandboxPi();
writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});\n`);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Port of critic-sjpp's native overlap repro; release I/O outside shutdown to test a waiting lifecycle.
for (const phase of ["control", "reload-final", "reload-intent", "reload-final-error", "reload-callback-error", "reload-intent-write-error", "transition-single", "transition-concurrent", "transition-reentrant"] as const) {
  test(`M5 settlement ${phase}: same-PID reload dispatches and records an outcome at most once`, { timeout: 30000 }, async t => {
    const root = tmpDir("m5-reload-settlement-");
    const memory = join(root, ".git", "outcomes.jsonl");
    const previousMemory = process.env.CONDUCTOR_MEMORY_PATH;
    process.env.CONDUCTOR_MEMORY_PATH = memory;
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
    writeFileSync(join(root, "base"), "base\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
    git(root, "add", "base", ".gitignore"); git(root, "commit", "-m", "base");
    const index = readFileSync(join(root, ".git", "index"));
    const effort = openEffort(root, "overlap", "same-session", { verify: "test -f base" });
    const registry = new RunRegistry(), replacement = new RunRegistry();
    const callbacks: string[] = [];
    const intentBoundary = phase === "reload-intent" || phase === "reload-intent-write-error";
    const ioError = phase === "reload-final-error" || phase === "reload-intent-write-error";
    const transitionBoundary = phase.startsWith("transition-");
    let run: Run | undefined, intercepted = false, transitionHit = false;
    const shutdownReturned: boolean[] = [], shutdowns: Promise<void>[] = [];
    let callbacksAtIntentShutdown: number | undefined, suspensionVisibleAtReentry: boolean | undefined;
    const reached = barrier(), release = barrier(), paused = barrier();
    const off = registry.onChange(r => { if (r.integration?.reason?.startsWith("terminal persistence uncertain:")) paused.resolve(); });
    const launchShutdown = () => {
      const slot = shutdownReturned.length; shutdownReturned.push(false);
      const waiting = handleSessionShutdown({ reason: "reload" }, { runs: [run!], resetSanitizer() {} }).then(() => { shutdownReturned[slot] = true; });
      shutdowns.push(waiting); return waiting;
    };
    const beginShutdown = () => shutdowns[0] ?? launchShutdown();
    const durable = (): RunRecord | undefined => run && existsSync(run.recordPath) ? JSON.parse(readFileSync(run.recordPath, "utf8")) : undefined;
    const mkdir = fs.mkdir, fsync = syncFs.fsyncSync, rename = syncFs.renameSync;
    t.mock.method(syncFs, "renameSync", (from: syncFs.PathLike, to: syncFs.PathLike) => {
      const wal = run && String(to) === run.recordPath ? JSON.parse(readFileSync(from, "utf8")) as RunRecord : undefined;
      rename(from, to);
      if (transitionBoundary && !transitionHit && wal?.status === "integrating" && wal.integration?.state === "accepted") {
        transitionHit = true;
        assert.equal(run!.integrationSettlement, undefined, "probe must hit the driver-to-settlement transition");
        if (phase === "transition-reentrant") {
          let control = run!.integrationControl, reentered = false;
          Object.defineProperty(run!, "integrationControl", { configurable: true, get: () => control, set: (value: Run["integrationControl"]) => {
            control = value;
            if (value === undefined && !reentered) {
              reentered = true; suspensionVisibleAtReentry = !!run!.integrationSuspension;
              void launchShutdown();
            }
          } });
        }
        void beginShutdown();
        if (phase === "transition-concurrent") void launchShutdown();
      }
    });
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      const wal = durable();
      const boundary = intentBoundary ? wal?.integration?.delivery === "intent" && callbacks.length === 1 : wal?.status === "completed" && !wal.integration?.delivery;
      if (!intercepted && run && args[0] === dirname(run.finalPath) && boundary) {
        intercepted = true; reached.resolve(); await release.promise;
        if (ioError) throw Object.assign(new Error("injected settlement persistence failure"), { code: "EIO" });
      }
      return mkdir(...args);
    });
    t.mock.method(syncFs, "fsyncSync", (fd: number) => {
      fsync(fd);
      if (intentBoundary && !shutdowns.length && durable()?.integration?.delivery === "intent") {
        callbacksAtIntentShutdown = callbacks.length;
        void beginShutdown();
      }
    });
    syncBuiltinESMExports();
    const spawned = spawnRun({
      registry, cwd: root, effort: effort.name, parentSessionId: "same-session",
      persona: { name: "builder", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: true, timeoutMinutes: 1, readOnly: false, source: "builtin", sourcePath: "test" },
      mode: "background", timeoutMs: 15000, task: "CONTROL M4_FILE=a Complete and commit native faux-provider assignment.",
      onComplete: () => { callbacks.push("original"); if (phase === "reload-callback-error") throw new Error("opaque callback rejected"); },
    });
    run = spawned.run;
    const child = run.proc;
    let exited = !child; child?.once("exit", () => { exited = true; });
    t.after(async () => {
      release.resolve(); off();
      await run?.integrationControl?.suspend();
      if (child && !exited && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
      await run?.recordWrite;
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (previousMemory === undefined) delete process.env.CONDUCTOR_MEMORY_PATH;
      else process.env.CONDUCTOR_MEMORY_PATH = previousMemory;
    });
    const recover = async () => {
      const result = await recoverEffort(readEffort(root, effort.name)!, { registry: replacement, sessionId: "same-session", onComplete: () => { callbacks.push("recovered"); } });
      await result.done;
    };
    try {
      await Promise.race([reached.promise, spawned.done.then(() => { throw new Error(`missed settlement boundary: ${run!.status}: ${run!.errorMessage}`); })]);
      if (phase !== "control") void beginShutdown();
      await nextTurn();
      const returnedWhileHeld = [...shutdownReturned];
      // Under the old lifecycle, recovery can finish while original final I/O is held.
      if (returnedWhileHeld.some(Boolean)) await recover();
      release.resolve();
      await Promise.all(shutdowns);
      if (ioError) await paused.promise;
      else await spawned.done;
      if (!returnedWhileHeld.some(Boolean)) await recover();
      await recover();
      const wal = durable()!;
      const outcomes = existsSync(memory) ? readFileSync(memory, "utf8").trim().split("\n").filter(Boolean).length : 0;
      const commits = git(root, "rev-list", "--count", `${effort.baseOid}..${effort.intRef}`);
      t.diagnostic(JSON.stringify({ phase, callbacks, outcomes, commits, returnedWhileHeld, delivery: wal.integration?.delivery }));
      assert.equal(callbacks.length, 1, "at-most-once automatic callback dispatch across same-session/PID reload overlap");
      assert.equal(outcomes, 1, "local memory outcome must not repeat across registry objects");
      assert.equal(commits, "1", "reload never reintegrates to recreate delivery");
      const expectedShutdowns = phase === "control" ? 0 : phase === "transition-concurrent" || phase === "transition-reentrant" ? 2 : 1;
      assert.deepEqual(returnedWhileHeld, Array(expectedShutdowns).fill(false), "every shutdown must wait for the transition and final I/O tail");
      if (transitionBoundary) assert.equal(transitionHit, true);
      if (phase === "transition-reentrant") assert.equal(suspensionVisibleAtReentry, true, "suspension promise must precede reentrant control clearing");
      assert.equal(run.integrationSuspension, undefined, "successful suspension releases its shared transition");
      assert.equal(run.integrationSettlement, undefined, "settlement tail clears after finishing");
      if (intentBoundary) assert.equal(callbacksAtIntentShutdown, 0, "reload begins after durable intent and before callback invocation");
      assert.notEqual(registry.get(run.id), replacement.get(run.id), "recovery must use a separate Run object");
      assert.deepEqual(readEffort(root, effort.name)!.owner, effort.owner, "same session/PID reuses ownership, not simulated death");
      assert.equal(wal.status, "completed");
      assert.equal(wal.integration?.delivery, phase === "reload-intent-write-error" ? "uncertain" : "attempted");
      assert.notEqual(readFileSync(run.finalPath, "utf8"), "(no output)");
      assert.equal(git(root, "rev-parse", "HEAD"), effort.baseOid); assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
    } finally { release.resolve(); }
  });
}

test("M5 rejected suspension stays visible to concurrent and later shutdown callers", { timeout: 15000 }, async t => {
  const { fixture, until } = await import("./helpers/effort-integration.ts");
  const { stopOwnedProcessGroup } = await import("../src/effort/process-group.ts");
  const f = fixture(t, "if test -f change; then sleep 30; fi", { verifyTimeoutSeconds: 10 });
  let completions = 0;
  void f.start().then(() => { completions++; });
  await until(f.registry, f.run, run => run.integration?.state === "verifying" && !!run.integration.process);
  const group = { ...f.run.integration!.process! };
  const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -group.pid) throw Object.assign(new Error("fixture group permission ambiguous"), { code: "EPERM" });
    return kill(pid, signal);
  });
  try {
    const first = handleSessionShutdown({ reason: "reload" }, { runs: [f.run], resetSanitizer() {} });
    const transition = f.run.integrationSuspension;
    const second = handleSessionShutdown({ reason: "reload" }, { runs: [f.run], resetSanitizer() {} });
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"], "no concurrent caller may treat failed suspension as a completed transition");
    assert.ok(transition);
    assert.equal(f.run.integrationSuspension, transition, "rejection must not erase the only remaining transition evidence");
    assert.equal(f.run.integrationControl, undefined);
    await assert.rejects(handleSessionShutdown({ reason: "reload" }, { runs: [f.run], resetSanitizer() {} }), /unconfirmed/);
    assert.equal(completions, 0); f.unchanged();
  } finally {
    t.mock.restoreAll();
    await stopOwnedProcessGroup(group);
    await f.registry.integrations.whenIdle(f.root);
    await f.run.recordWrite;
  }
});
