import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, git } from "./helpers/effort-integration.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { stopOwnedProcessGroup } from "../src/effort/process-group.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { forceTerminate, spawnRun, RunRegistry } from "../src/runs.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import type { Persona } from "../src/types.ts";

sandboxPi();
const persona: Persona = { name: "builder", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: true, timeoutMinutes: 1, readOnly: false, source: "builtin", sourcePath: "test" };
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, "fixture barrier reached before deadline"); await delay(10); }
}
function identity(pid: number) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0], pgid: Number(fields[2]), sid: Number(fields[3]), startTime: Number(fields[19]) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

for (const resistant of [true, false]) for (const mode of ["kill", "reload", "quit"] as const) {
  test(`${mode} awaits ${resistant ? "TERM-resistant closed-stdio" : "fast cooperative"} verifier group teardown`, { timeout: 15000, skip: process.platform !== "linux" }, async t => {
    const dir = tmpDir("m2-teardown-");
    const pidFile = join(dir, "descendant.json"); const script = join(dir, "verifier.mjs");
    const childCode = `import {writeFileSync,readFileSync} from 'node:fs';
      ${resistant ? "process.on('SIGTERM',()=>{});" : ""}
      const raw=readFileSync('/proc/'+process.pid+'/stat','utf8'); const fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
      writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,startTime:Number(fields[19]),pgid:Number(fields[2]),sid:Number(fields[3])}));
      setInterval(()=>{},1000);`;
    writeFileSync(script, `import {spawn} from 'node:child_process'; process.on('SIGTERM',()=>process.exit(0));
      spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{stdio:'ignore'}); setInterval(()=>{},1000);`);
    const f = fixture(t, `if test -n "$CONDUCTOR_CANDIDATE"; then exec '${process.execPath}' '${script}'; fi`);
    const pi = join(dir, "pi.mjs");
    writeFileSync(pi, `import {writeFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
      import {gitTestEnv} from ${JSON.stringify(new URL("./helpers/git-env.ts", import.meta.url).href)};
      writeFileSync('native-change','work'); execFileSync('git',['add','native-change'],{env:gitTestEnv()}); execFileSync('git',['commit','-m','fixture-change'],{env:gitTestEnv()});
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Committed the requested change with complete verification evidence.'}]}}));
      console.log(JSON.stringify({type:'agent_settled'}));`);
    const previous = process.env.PI_BIN; process.env.PI_BIN = pi;
    t.after(() => { if (previous === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = previous; });
    const registry = new RunRegistry(); let callbacks = 0, resolutions = 0;
    const { run, done } = spawnRun({ registry, persona, cwd: f.root, task: "fixture", effort: "probe", parentSessionId: "owner", mode: "background", timeoutMs: 10000, onComplete: () => { callbacks++; } });
    const writer = run.proc!; const writerStart = readProcessStartTime(writer.pid!); let writerExited = false;
    writer.once("exit", () => { writerExited = true; });
    void done.then(() => { resolutions++; });
    const child = () => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; startTime: number; pgid: number; sid: number } : undefined;
    const runnable = () => {
      const saved = child(); if (!saved) return false;
      const observed = identity(saved.pid);
      return !!observed && observed.startTime === saved.startTime && observed.state !== "Z" && observed.state !== "X";
    };
    t.after(async () => {
      try { run.integrationSuspended = true; await run.integrationControl?.suspend(); }
      finally {
        const saved = child();
        if (saved && runnable()) {
          const observed = identity(saved.pid)!;
          assert.equal(observed.startTime, saved.startTime, "cleanup requires exact PID/start identity");
          assert.equal(observed.pgid, saved.pgid); assert.equal(observed.sid, saved.sid);
          assert.ok(readFileSync(`/proc/${saved.pid}/cmdline`, "utf8").includes(pidFile), "cleanup signals only this fixture's descendant");
          process.kill(saved.pid, "SIGKILL");
          await waitFor(() => !runnable());
        }
        if (!writerExited && writer.signalCode === null) {
          assert.equal(readProcessStartTime(writer.pid!), writerStart);
          writer.kill("SIGKILL");
        }
      }
    });
    await waitFor(() => !!child());
    const saved = child()!;
    assert.equal(saved.pgid, run.integration!.process!.pid, "descendant is in the recorded verifier group");
    assert.equal(saved.sid, saved.pgid, "runHook detached session owns the group");
    assert.equal(runnable(), true); assert.equal(callbacks, 0); assert.equal(resolutions, 0);
    const branchHead = git(f.root, "rev-parse", run.worktreeBranch!);
    const start = Date.now();
    if (mode === "kill") {
      forceTerminate(run, "killed", registry); forceTerminate(run, "killed", registry);
      await done;
    } else {
      await handleSessionShutdown({ reason: mode }, { runs: [run], resetSanitizer() {}, reconcileRunning() { assert.fail("integrating must be preserved"); } });
    }
    assert.equal(runnable(), false, `${mode} must reap owned TERM-resistant descendant before returning, not merely close the shell`);
    const elapsed = Date.now() - start;
    t.diagnostic(`${mode}: ${resistant ? "resistant" : "cooperative"} group stopped before return in ${elapsed}ms`);
    if (!resistant) assert.ok(elapsed < 1900, "cooperative teardown must not pay the two-second escalation grace");
    f.unchanged(); assert.equal(run.landedCommit, undefined);
    assert.equal(run.status, mode === "kill" ? "killed" : "integrating");
    assert.equal(callbacks, mode === "kill" ? 1 : 0); assert.equal(resolutions, mode === "kill" ? 1 : 0);
    assert.equal(run.integration!.verify?.passed, true, "leader exited zero on TERM without authorizing acceptance");
    assert.equal(git(f.root, "rev-parse", run.worktreeBranch!), branchHead, "writer branch remains unchanged");
    assert.ok(existsSync(run.worktreePath!)); assert.ok(existsSync(run.integration!.candidatePath!));
    assert.ok(existsSync(run.integration!.logPath!));
  });
}


test("a real already-exited verifier group requires no teardown grace or signals", { timeout: 5000, skip: process.platform !== "linux" }, async t => {
  const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 20)"], { detached: true, stdio: "ignore", env: gitTestEnv(), cwd: tmpDir("m2-gone-group-") });
  const group = { pid: child.pid!, startTime: readProcessStartTime(child.pid!) };
  let exited = false; child.once("exit", () => { exited = true; });
  t.after(() => {
    if (!exited && child.signalCode === null) {
      assert.equal(readProcessStartTime(group.pid), group.startTime); child.kill("SIGKILL");
    }
  });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  assert.equal(child.exitCode, 0); assert.equal(exited, true);
  const start = Date.now();
  await stopOwnedProcessGroup(group, { signal: (pid, sig) => { assert.equal(pid, -group.pid); assert.equal(sig, 0, "already-gone group must not be signalled"); return process.kill(pid, sig); } });
  assert.ok(Date.now() - start < 1900);
});

for (const mode of ["kill", "reload", "quit"] as const) test(`${mode} fails closed when group teardown cannot be confirmed`, { timeout: 10000, skip: process.platform !== "linux" }, async t => {
  const f = fixture(t, 'if test -n "$CONDUCTOR_CANDIDATE"; then sleep 30; fi');
  const spawn = cp.spawn; let verifier: cp.ChildProcess | undefined, closed: Promise<void> | undefined;
  let exited = false;
  t.mock.method(cp, "spawn", (command: string, options: cp.SpawnOptions) => {
    const child = spawn(command, options);
    if (f.run.integration!.state === "verifying") {
      verifier = child; child.once("exit", () => { exited = true; });
      closed = new Promise(resolve => child.once("close", () => resolve()));
    }
    return child;
  }); syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (verifier && !exited && verifier.signalCode === null) {
      const observed = identity(verifier.pid!)!;
      assert.equal(observed.startTime, f.run.integration!.process!.startTime);
      assert.equal(observed.pgid, verifier.pid); assert.equal(observed.sid, verifier.pid);
      process.kill(-verifier.pid!, "SIGKILL");
    }
    await closed;
  });
  let resolutions = 0; void f.start().then(() => { resolutions++; });
  await waitFor(() => !!verifier);
  const pgid = verifier!.pid!; const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, sig: NodeJS.Signals | number = "SIGTERM") => {
    if (pid === -pgid) throw Object.assign(new Error("fixture permission refusal"), { code: "EPERM" });
    return kill(pid, sig);
  });
  const shutdown = () => handleSessionShutdown({ reason: mode === "kill" ? "quit" : mode }, { runs: [f.run], resetSanitizer() {} });
  if (mode === "kill") forceTerminate(f.run, "killed", f.registry);
  else await assert.rejects(shutdown(), /unconfirmed/);
  await waitFor(() => !!f.run.integration!.teardownError);
  await f.run.recordWrite;
  assert.match(JSON.parse(readFileSync(f.run.recordPath, "utf8")).integration.teardownError, /unconfirmed/);
  await assert.rejects(shutdown(), /unconfirmed/, "retrying shutdown must not forget failed teardown");
  assert.equal(f.run.status, "integrating"); assert.equal(resolutions, 0); f.unchanged();
  assert.ok(existsSync(f.run.integration!.candidatePath!)); assert.ok(existsSync(f.run.integration!.logPath!));
});
