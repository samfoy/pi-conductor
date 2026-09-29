import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunRegistry, spawnRun, forceTerminate, sendToRun, settleWorktree, applyMergeToTerminal, applyChainIfPresent, applyRetryIfNeeded } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { openEffort } from "../src/effort/open.ts";
import { readEffort } from "../src/effort/store.ts";
import { toRunRecord, emptyUsage, type Persona, type Run } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { registerTools } from "../src/tools.ts";
import { runWorktreeCmd, registerCommands } from "../src/commands.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { executeReclaim } from "../src/gc/executor.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { buildCompletionMessage, formatCompletionNotification } from "../src/notifications.ts";
import { classifyRecord, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";

sandboxPi();
const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
const persona: Persona = { name: "builder", description: "test", inheritContext: "filtered", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake", readOnly: false };
function repo() {
  const cwd = tmpDir("effort-spawn-");
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  mkdirSync(join(cwd, "pkg"));
  writeFileSync(join(cwd, "pkg", "file"), "base\n");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "pkg", ".gitignore"); git(cwd, "commit", "-m", "base");
  openEffort(cwd, "one", "owner", { verify: "" });
  return cwd;
}
function fake(t: test.TestContext) {
  const realSpawn = cp.spawn;
  const procs: any[] = []; const launches: cp.SpawnOptions[] = []; // ChildProcess protocol doubles
  t.mock.method(cp, "spawn", (command: string, args: string[] | cp.SpawnOptions, options?: cp.SpawnOptions) => {
    if (!Array.isArray(args) && command !== "m1-hook") return realSpawn(command, args);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {}, kill() { queueMicrotask(() => proc.emit("close", 0)); return true; } });
    procs.push(proc); launches.push(options ?? args as cp.SpawnOptions); if (command === "m1-hook") queueMicrotask(() => proc.emit("close", 0, null)); return proc;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { procs, launches };
}
function emit(proc: any, event: unknown) { proc.stdout.write(JSON.stringify(event) + "\n"); }
function finish(proc: any) {
  emit(proc, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented the assigned change with a preserved commit and verified it successfully." }] } });
  proc.emit("close", 0);
}
function options(cwd: string, registry: RunRegistry) {
  return { registry, cwd, persona, task: "original", mode: "background" as const, timeoutMs: 5000, worktree: false,
    mergeStrategy: "squash" as const, parentSessionId: "owner", effort: "one", touches: ["pkg/**"],
    parentMessages: [{ role: "user" as const, content: "prior context", timestamp: 0 }] };
}

test("M1 queue resolves NEW integration tip at dequeue, forces isolated writer, preserves base and branch", { timeout: 15000 }, async t => {
  const cwd = repo(); const { procs, launches } = fake(t); const registry = new RunRegistry();
  const blocker: Run = { id: "builder-busy", persona: "builder", task: "t", mode: "background", status: "running", cwd, startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), recordPath: "/unused", transcriptPath: "/unused", finalPath: "/unused" };
  registry.register(blocker);
  const queue = new SpawnQueue(registry, 1);
  let completed!: (r: Run) => void; const done = new Promise<Run>(resolve => { completed = resolve; });
  const accepted = options(join(cwd, "pkg"), registry);
  const queued = queue.enqueueOrSpawn({ ...accepted, onComplete: completed });
  accepted.touches[0] = "../mutated-after-acceptance";
  if (queued.kind === "queued") assert.deepEqual(queued.pending.spawn.touches, ["pkg/**"], "queue owns the accepted scope snapshot");
  assert.equal(queued.kind, "queued"); if (queued.kind !== "queued") return;
  assert.equal(procs.length, 0);
  assert.equal(queued.placeholderRun.effort?.name, "one");
  assert.equal(classifyRecord(toRunRecord(queued.placeholderRun), () => false, Date.now(), process.pid, () => true, "sibling"), "skip-foreign", "persisted queued member belongs to the live effort owner");
  assert.deepEqual(readEffort(cwd, "one")!.members, [queued.pending.id]);
  const base = git(cwd, "rev-parse", "HEAD");
  const index = readFileSync(join(cwd, ".git", "index"));
  const nextTree = tmpDir("effort-next-tip-");
  git(cwd, "worktree", "add", "--detach", nextTree, base);
  writeFileSync(join(nextTree, "pkg", "new-tip"), "new tip\n"); git(nextTree, "add", "pkg/new-tip"); git(nextTree, "commit", "-m", "new-tip");
  const next = git(nextTree, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/heads/conductor-int/one", next, base);
  blocker.status = "completed"; registry.notify(blocker);
  const run = registry.get(queued.pending.id)!;
  const path = run.worktreePath!; const branch = run.worktreeBranch!;
  assert.ok(path && path !== cwd, "writer must get a worktree despite worktree:false");
  assert.equal(run.effort?.spawnBase, next, "dequeued writer branches from the NEW tip");
  assert.deepEqual(run.effort?.touches, ["pkg/**"], "queue keeps accepted scope snapshot");
  assert.equal(git(path, "rev-parse", "HEAD"), next);
  assert.equal(launches[0].cwd, join(path, "pkg"));
  assert.equal(launches[0].env?.TMPDIR, join(dirname(run.recordPath), "tmp"));
  assert.equal(JSON.parse(readFileSync(run.sessionPath!, "utf8").split("\n")[0]).cwd, join(path, "pkg"));
  writeFileSync(join(path, "pkg", "work"), "work\n"); git(path, "add", "pkg/work"); git(path, "commit", "-m", "work");
  finish(procs[0]); await done;
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(run.mergeResult?.success, true, "M2 integrates without ordinary base merge");
  assert.equal(git(cwd, "show", `${branch}:pkg/work`), "work");
  assert.equal(git(cwd, "rev-parse", "HEAD"), base);
  assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), "main");
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assert.equal(readFileSync(join(cwd, "pkg", "file"), "utf8"), "base\n");
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.match(formatCompletionNotification(run), /integrated|no-op/);
  assert.match(buildCompletionMessage(run).details.stats.join(" "), /integrated|no-op/);
  const status = await tools(cwd, registry, queue).get("ensemble_status").execute("status", { agent_id: run.id }, undefined, undefined, { mode: "json" });
  assert.deepEqual(status.details.finished[0].effort, run.effort);
  assert.match(status.content[0].text, /integrated|no-op/);
  assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).effort, run.effort);
});

test("M1 linked-caller subdirectory and A6 answer retain same assignment/worktree without merging", { timeout: 15000 }, async t => {
  const cwd = repo(); const caller = tmpDir("effort-linked-");
  git(cwd, "worktree", "add", "-b", "caller", caller);
  const { procs, launches } = fake(t); const registry = new RunRegistry();
  const result = spawnRun({ ...options(join(caller, "pkg"), registry), onCompleteHook: "m1-hook" }); const run = result.run;
  const path = run.worktreePath!; const branch = run.worktreeBranch!;
  assert.equal(run.effort?.gitRoot, cwd); assert.ok(path.startsWith(join(cwd, ".worktrees")));
  assert.equal(launches[0].cwd, join(path, "pkg"));
  const ask = { askId: "a", question: "Which option?", evidence: "" };
  emit(procs[0], { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: "a" }] } });
  emit(procs[0], { type: "tool_execution_start", toolCallId: "a", toolName: "ask_owner", args: { question: ask.question } });
  emit(procs[0], { type: "tool_execution_end", toolCallId: "a", toolName: "ask_owner", isError: false, result: { terminate: true, details: ask } });
  emit(procs[0], { type: "agent_settled" }); await result.done;
  assert.equal(run.status, "blocked"); assert.equal(run.worktreePath, path);
  const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
  const restored = new RunRegistry();
  await reconcileOrphansAtStartup({ registry: restored, runsRoot: dirname(dirname(run.recordPath)), now: Date.now(), isAlive: () => false, isParentAlive: () => false });
  assert.deepEqual(restored.get(run.id)?.effort, run.effort);
  const resumed = sendToRun(run, "Use A", { registry, timeoutMs: 5000, sessionId: "owner" });
  assert.equal(resumed.kind, "started"); if (resumed.kind !== "started") return;
  assert.equal(launches[1].cwd, join(path, "pkg"));
  assert.equal(run.task, "original"); assert.equal(run.worktreeBranch, branch);
  emit(procs[1], { type: "agent_start" }); finish(procs[1]); await resumed.done;
  assert.equal(run.status, "completed"); assert.equal(run.mergeResult?.nothingToCommit, true);
  assert.equal(launches[2].cwd, join(path, "pkg"), "hook runs in the same isolated subdirectory");
  assert.equal(run.hookResult?.passed, true);
  assert.match(formatCompletionNotification(run), /integrated|no-op/);
});

for (const terminal of ["failed", "hook_failed", "killed", "completed"] as const) {
  test(`M1 ${terminal} preserves dirty work and all branch commits; legacy merge and callbacks cannot escape`, { timeout: 10000 }, async t => {
    const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry();
    const result = spawnRun(options(cwd, registry)); const run = result.run;
    const path = run.worktreePath!; const branch = run.worktreeBranch!;
    assert.ok(path, "effort worktree required");
    const base = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(path, "committed"), "valuable"); git(path, "add", "committed"); git(path, "commit", "-m", "valuable");
    writeFileSync(join(path, "dirty"), "unfinished");
    if (terminal === "killed") forceTerminate(run, "killed", registry);
    else { run.status = terminal; await settleWorktree(run, terminal); }
    procs[0].emit("close", terminal === "failed" ? 1 : 0); await result.done;
    assert.equal(readFileSync(join(path, "dirty"), "utf8"), "unfinished");
    assert.equal(git(cwd, "show", `${branch}:committed`), "valuable");
    await applyMergeToTerminal(run, cwd, "completed");
    assert.equal(git(cwd, "rev-parse", "HEAD"), base, "legacy merge must not touch base");
    let chains = 0, retries = 0;
    applyChainIfPresent(run, "completed", () => { chains++; });
    run.status = "failed"; run.failureClass = "environment"; run.retryPolicy = { maxAttempts: 2, retryableClasses: ["environment"] };
    applyRetryIfNeeded(run, () => { retries++; });
    assert.equal(chains, 0); assert.equal(retries, 0);
  });
}

function tools(cwd: string, registry: RunRegistry, queue: SpawnQueue) {
  const map = new Map<string, any>();
  registerTools({ registerTool: (t: any) => map.set(t.name, t) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getSessionId: () => "owner",
    getParentMessages: () => [], pushCompletionNotification: () => {},
  } as any, {});
  return map;
}
test("M1 registered spawn exposes effort/touches and foreground downgrade; rejects reader/auto/invalid input before queue", { timeout: 15000 }, async t => {
  const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry(); const queue = new SpawnQueue(registry, 1);
  t.after(() => { for (const run of registry.list()) forceTerminate(run, "killed", registry); });
  const map = tools(cwd, registry, queue); const tool = map.get("ensemble_spawn");
  assert.ok(tool.parameters.properties.effort); assert.ok(tool.parameters.properties.touches);
  for (const params of [ { persona: "inspector", effort: "one" }, { persona: "builder", effort: "../bad" }, { persona: "builder", effort: "one", touches: ["../bad"] }, { persona: "builder", touches: ["src/**"] } ]) {
    const r = await tool.execute("bad", { task: "t", foreground: false, ...params });
    assert.ok(r.details.error, r.content[0].text); assert.equal(queue.size(), 0); assert.equal(registry.list().length, 0); assert.equal(procs.length, 0);
  }
  const auto = await map.get("ensemble_auto").execute("auto", { goal: "g", max_steps: 1, effort: "one", steps: [{ persona: "builder", task: "t" }] });
  assert.match(auto.content[0].text, /effort.*unsupported/i); assert.equal(registry.list().length, 0);
  const spawned = await tool.execute("good", { persona: "builder", task: "t", effort: "one", touches: ["pkg/**"], foreground: true });
  assert.match(spawned.content[0].text, /Foreground effort spawn downgraded to background/);
  const run = registry.get(spawned.details.agent_id)!; assert.equal(run.mode, "background"); assert.equal(run.effort?.name, "one");
  finish(procs[0]);
  await new Promise<void>(resolve => { const off = registry.onChange(r => { if (r.id === run.id && r.status === "completed") { off(); resolve(); } }); });
});

test("M1 legacy commands and GC preserve unresolved effort records/worktrees even on forced stale plans", { timeout: 15000 }, async t => {
  const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry();
  const result = spawnRun(options(cwd, registry)); const run = result.run; const path = run.worktreePath!; const branch = run.worktreeBranch!;
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(path, "dirty"), "valuable"); finish(procs[0]); await result.done;
  const notes: string[] = []; const ctx = { ui: { notify: (m: string) => notes.push(m) } } as any;
  const deps = { getRegistry: () => registry, getCwd: () => cwd };
  await runWorktreeCmd(deps, ctx, "clean");
  assert.equal(existsSync(path), true); assert.equal(run.worktreeBranch, branch);
  run.status = "merge_conflict";
  await runWorktreeCmd(deps, ctx, `merge ${run.id}`);
  assert.match(notes.join("\n"), /effort.*UNINTEGRATED|UNINTEGRATED.*effort/s);
  assert.equal(git(cwd, "rev-parse", "HEAD"), base);
  const root = dirname(dirname(run.recordPath));
  const inv = (await walkInventory(root, new RunRegistry())).filter(e => e.id === run.id);
  const plan = planReclaim(inv.map(e => ({ ...e, archived: true, archivedAt: 1 })), { ...DEFAULT_CONFIG.gc, totalSizeBudgetBytes: 1, transcriptSizeCapBytes: 1 }, Date.now() + 999 * 86400000);
  assert.equal(plan.actions[0].kind, "keep");
  const reclaimed = await executeReclaim([{ kind: "delete", id: run.id, reason: "stale plan", bytesReclaimed: 1, losesResume: true }], root, new Set(), Date.now());
  assert.equal(reclaimed.deleted.length, 0); assert.match(reclaimed.failed[0].error, /effort/);
  assert.equal(readFileSync(join(path, "dirty"), "utf8"), "valuable");
  let command: any;
  registerCommands({ registerCommand: (_name: string, c: any) => { command = c; } } as any, deps as any);
  await command.handler("effort list", ctx); await command.handler("effort status one", ctx);
  assert.match(notes.slice(-2).join("\n"), /conductor-int\/one/);
});

test("M4 custom effort writers with overlapping touches remain serial", { timeout: 15000 }, async t => {
  const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry(); const queue = new SpawnQueue(registry, 4, 1);
  const opts = { ...options(cwd, registry), persona: { ...persona, name: "scribe" } };
  const first = queue.enqueueOrSpawn(opts); const second = queue.enqueueOrSpawn(opts);
  assert.equal(first.kind, "spawned"); assert.equal(second.kind, "queued");
  if (second.kind === "queued") queue.removeQueued(second.pending.id);
  finish(procs[0]); if (first.kind === "spawned") await first.done;
});
test("M1 failed worktree creation never falls back to shared cwd", { timeout: 10000 }, async t => {
  const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry();
  git(cwd, "branch", "conductor-wt/builder-collision");
  const base = git(cwd, "rev-parse", "HEAD");
  const result = spawnRun({ ...options(cwd, registry), preAllocatedId: "builder-collision" });
  await result.done;
  assert.equal(result.run.status, "failed"); assert.match(result.run.errorMessage!, /isolation failed/);
  assert.equal(procs.length, 0); assert.equal(git(cwd, "rev-parse", "HEAD"), base);
  assert.equal(git(cwd, "rev-parse", "conductor-wt/builder-collision"), base, "conflicting branch is untouched");
});

test("M1 blocked effort never replaces a lost assignment branch with a fresh base branch", { timeout: 10000 }, async t => {
  const cwd = repo(); const { procs } = fake(t); const registry = new RunRegistry();
  const result = spawnRun(options(cwd, registry)); const run = result.run;
  run.pendingAsk = { askId: "lost", question: "Continue?", evidence: "" };
  emit(procs[0], { type: "agent_settled" }); await result.done;
  assert.equal(run.status, "blocked");
  const path = run.worktreePath!; const branch = run.worktreeBranch!;
  git(cwd, "worktree", "remove", path); git(cwd, "branch", "-D", branch);
  const sent = sendToRun(run, "Continue", { registry, timeoutMs: 5000, sessionId: "owner" });
  assert.equal(sent.kind, "rejected");
  assert.equal(run.status, "blocked"); assert.equal(run.pendingAsk?.askId, "lost"); assert.equal(procs.length, 1);
  assert.equal(existsSync(path), false); assert.equal(run.worktreeBranch, branch);
});
