import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { join } from "node:path";
import { RunRegistry, spawnRun, forceTerminate, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { openEffort } from "../src/effort/open.ts";
import { type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";

const { piBin } = sandboxPi();
fs.writeFileSync(piBin, `process.on("SIGUSR2", () => { console.log(JSON.stringify({type:"agent_settled"})); process.exit(0); });
console.log(JSON.stringify({type:"probe", point:"ready"})); setInterval(() => {}, 1000);
`);
const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
const persona: Persona = { name: "custom-writer", description: "test", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake", readOnly: false };
type Fault = "resolve" | "add" | "session" | "started" | "replacement" | "none";
function setup(t: test.TestContext, fault: Fault) {
  const cwd = tmpDir("m4-unwind-"); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.com");
  fs.writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: base");
  const userPath = join(cwd, ".worktrees", "user-owned"); git(cwd, "worktree", "add", "--detach", userPath, "HEAD"); fs.writeFileSync(join(userPath, "valuable"), "user work");
  openEffort(cwd, "one", "owner", { verify: "", maxParallel: 4 });
  const base = git(cwd, "rev-parse", "HEAD");
  const registry = new RunRegistry(), done: Promise<Run>[] = [], notices: Run[] = [], failures: Run[] = [];
  registry.onChange(r => { if (r.status === "failed") failures.push(r); });
  let injected: Run | undefined;
  const target = () => registry.list().find(r => r.task === "target" && r.status === "running" && !r.proc);
  const inject = (r: Run) => { injected = r; throw new Error(`injected post-registration ${fault} failure`); };
  const realExec = cp.execSync, realMkdir = fs.mkdirSync;
  t.mock.method(cp, "execSync", (command: string, opts: cp.ExecSyncOptions) => {
    const r = target();
    if (!injected && r && ((fault === "resolve" && command === "git rev-parse --show-toplevel") || (fault === "add" && command.startsWith("git worktree add ")))) inject(r);
    return realExec(command, opts);
  });
  t.mock.method(fs, "mkdirSync", (path: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
    const r = target();
    if (!injected && r && fault === "session" && String(path).endsWith("/session")) {
      assert.ok(r.worktreePath, "session preparation fault must follow workspace creation");
      fs.writeFileSync(join(r.worktreePath, "evidence"), "valuable committed work"); git(r.worktreePath, "add", "evidence"); git(r.worktreePath, "commit", "-m", "test: preserve evidence");
      inject(r);
    }
    return realMkdir(path, opts);
  });
  syncBuiltinESMExports();
  const queue = new SpawnQueue(registry, 4, 1, opts => {
    if (fault === "replacement" && opts.task === "target") {
      const replacement: Run = { ...registry.get(opts.preAllocatedId!)!, status: "running" };
      registry.register(replacement); inject(replacement);
    }
    const result = spawnRun(opts); done.push(result.done); return result;
  });
  t.after(async () => {
    for (const p of [...queue.list()]) queue.removeQueued(p.id);
    for (const run of registry.list()) {
      const proc = run.proc;
      const closed = proc && proc.exitCode === null && proc.signalCode === null ? once(proc, "close") : undefined;
      forceTerminate(run, "killed", registry); await closed;
    }
    await Promise.all(done); t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const spawn = (task: string) => queue.enqueueOrSpawn({ registry, cwd, persona, task, touches: [`${task}/**`], effort: "one", parentSessionId: "owner", mode: "background", timeoutMs: 10000,
    onComplete: r => { notices.push(r); },
    onChain: () => assert.fail("effort launch failure must not chain"), onRetry: () => assert.fail("effort launch failure must not retry"),
    events: fault === "started" && task === "target" ? { emitCreated() {}, emitStarted() { inject(target()!); } } as unknown as SpawnOptions["events"] : undefined });
  const preserved = () => { assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.equal(git(userPath, "rev-parse", "HEAD"), base); assert.equal(fs.readFileSync(join(userPath, "valuable"), "utf8"), "user work"); };
  return { cwd, registry, queue, notices, failures, spawn, preserved, injected: () => injected };
}
async function ready(run: Run) {
  const proc = run.proc!; assert.ok(proc?.pid);
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    const onClose = () => reject(new Error("child exited before explicit ready barrier"));
    const onData = (data: Buffer) => { buffer += data.toString(); if (buffer.includes('"point":"ready"')) { proc.off("close", onClose); proc.stdout!.off("data", onData); resolve(); } };
    proc.once("close", onClose); proc.stdout!.on("data", onData);
  });
  assert.equal(proc.signalCode, null); assert.equal(run.status, "running");
}
for (const mode of ["immediate", "queued"] as const) for (const fault of ["resolve", "add", "session", "started"] as const) {
  test(`M4 ${mode} post-registration ${fault} failure unwinds current launch reservation`, { timeout: 15000 }, async t => {
    const h = setup(t, fault);
    const live = h.spawn("live"); assert.equal(live.kind, "spawned"); if (live.kind !== "spawned") return;
    await ready(live.run); const liveProc = live.run.proc;
    if (mode === "queued") h.queue.setMaxConcurrent(1);
    let result: ReturnType<typeof h.spawn> | undefined, thrown: unknown;
    try { result = h.spawn("target"); } catch (e) { thrown = e; }
    const placeholder = result?.kind === "queued" ? result.placeholderRun : undefined;
    if (mode === "queued") { assert.ok(placeholder); h.queue.setMaxConcurrent(2); }
    const run = h.registry.list().find(r => r.task === "target")!;
    assert.ok(h.injected(), "fault must hit after registration, not preflight");
    assert.equal(run, h.injected(), "registry owns the actual launch object");
    assert.equal(run.status, "failed", "current run must fail instead of retaining ghost running capacity");
    assert.equal(thrown, undefined, "immediate failure returns a settled done promise");
    assert.equal(run.proc, undefined); assert.equal(run.timeoutTimer, undefined); assert.equal(run.integration, undefined);
    assert.equal(h.registry.countActive(), 1, "only the real barrier-held child consumes capacity"); assert.equal(h.queue.size(), 0);
    if (placeholder) { assert.notEqual(run, placeholder); assert.equal(placeholder.status, "queued", "obsolete placeholder is not mutated"); }
    if (result?.kind === "spawned") assert.equal(await result.done, run);
    else await new Promise<void>(resolve => { if (h.notices.includes(run)) resolve(); else { const off = h.registry.onChange(r => { if (r === run && r.status === "failed") { off(); queueMicrotask(resolve); } }); } });
    assert.deepEqual(h.notices, [run]); assert.deepEqual(h.failures, [run]);
    const record = JSON.parse(fs.readFileSync(run.recordPath, "utf8")); assert.equal(record.status, "failed"); assert.equal(record.id, run.id); assert.equal(record.parentSessionId, "owner"); assert.equal(record.pid, undefined);
    h.queue.setMaxConcurrent(1); const later = h.spawn("later"); assert.equal(later.kind, "queued"); h.queue.setMaxConcurrent(2);
    const laterRun = h.registry.get(later.pending.id)!;
    if (fault === "session") {
      assert.equal(laterRun.status, "queued", "actual preserved branch retains failed-work footprint");
      assert.equal(fs.readFileSync(join(run.worktreePath!, "evidence"), "utf8"), "valuable committed work");
      assert.equal(git(h.cwd, "show", `${run.worktreeBranch}:evidence`), "valuable committed work");
    } else { assert.equal(laterRun.status, "running", "later safe queued launch advances after reservation release"); await ready(laterRun); }
    assert.equal(live.run.proc, liveProc); assert.equal(live.run.status, "running"); h.preserved();
  });
}

test("M4 drain fallback fails a replacement object rather than its obsolete placeholder", { timeout: 15000 }, async t => {
  const h = setup(t, "replacement"); const live = h.spawn("live"); assert.equal(live.kind, "spawned"); if (live.kind !== "spawned") return;
  await ready(live.run); h.queue.setMaxConcurrent(1);
  const next = h.spawn("target"); assert.equal(next.kind, "queued"); if (next.kind !== "queued") return;
  h.queue.setMaxConcurrent(2);
  const current = h.registry.get(next.pending.id)!;
  assert.notEqual(current, next.placeholderRun); assert.equal(current.status, "failed", "replacement must not retain ghost running capacity");
  assert.equal(next.placeholderRun.status, "queued"); assert.equal(h.registry.countActive(), 1); assert.equal(h.queue.size(), 0);
  await new Promise<void>(resolve => { const off = h.registry.onChange(r => { if (r === current && r.status === "failed") { off(); queueMicrotask(resolve); } }); });
  assert.deepEqual(h.notices, [current]); assert.deepEqual(h.failures, [current]); assert.equal(JSON.parse(fs.readFileSync(current.recordPath, "utf8")).status, "failed"); h.preserved();
});

test("M4 normal launch control has a real process and settles once after barrier release", { timeout: 15000 }, async t => {
  const h = setup(t, "none"); const result = h.spawn("target"); assert.equal(result.kind, "spawned"); if (result.kind !== "spawned") return;
  await ready(result.run); assert.equal(h.registry.countActive(), 1); result.run.proc!.kill("SIGUSR2");
  assert.equal(await result.done, result.run); assert.equal(result.run.status, "completed"); assert.equal(h.registry.countActive(), 0);
  assert.deepEqual(h.notices, [result.run]); assert.deepEqual(h.failures, []); h.preserved();
});
