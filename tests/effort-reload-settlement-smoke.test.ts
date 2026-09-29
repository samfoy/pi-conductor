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
for (const phase of ["control", "reload-final", "reload-intent", "reload-final-error", "reload-callback-error", "reload-intent-write-error"] as const) {
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
    let run: Run | undefined, intercepted = false, shutdownReturned = false;
    let shutdown: Promise<void> | undefined, callbacksAtIntentShutdown: number | undefined;
    const reached = barrier(), release = barrier(), paused = barrier();
    const off = registry.onChange(r => { if (r.integration?.reason?.startsWith("terminal persistence uncertain:")) paused.resolve(); });
    const beginShutdown = () => shutdown ??= handleSessionShutdown({ reason: "reload" }, { runs: [run!], resetSanitizer() {} }).then(() => { shutdownReturned = true; });
    const durable = (): RunRecord | undefined => run && existsSync(run.recordPath) ? JSON.parse(readFileSync(run.recordPath, "utf8")) : undefined;
    const mkdir = fs.mkdir, fsync = syncFs.fsyncSync;
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
      if (intentBoundary && !shutdown && durable()?.integration?.delivery === "intent") {
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
      const returnedWhileHeld = shutdownReturned;
      // Under the old lifecycle, recovery can finish while original final I/O is held.
      if (returnedWhileHeld) await recover();
      release.resolve();
      await shutdown;
      if (ioError) await paused.promise;
      else await spawned.done;
      if (!returnedWhileHeld) await recover();
      await recover();
      const wal = durable()!;
      const outcomes = existsSync(memory) ? readFileSync(memory, "utf8").trim().split("\n").filter(Boolean).length : 0;
      const commits = git(root, "rev-list", "--count", `${effort.baseOid}..${effort.intRef}`);
      t.diagnostic(JSON.stringify({ phase, callbacks, outcomes, commits, returnedWhileHeld, delivery: wal.integration?.delivery }));
      assert.equal(callbacks.length, 1, "at-most-once automatic callback dispatch across same-session/PID reload overlap");
      assert.equal(outcomes, 1, "local memory outcome must not repeat across registry objects");
      assert.equal(commits, "1", "reload never reintegrates to recreate delivery");
      if (phase !== "control") assert.equal(returnedWhileHeld, false, "reload must wait for final files and dispatch-state handling to finish");
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
