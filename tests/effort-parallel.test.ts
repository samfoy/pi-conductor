import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { RunRegistry, sendToRun, forceTerminate, availableActions } from "../src/runs.ts";
import { registerTools } from "../src/tools.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { SpawnQueue } from "../src/queue.ts";
import { openEffort } from "../src/effort/open.ts";
import type { Persona, Run } from "../src/types.ts";

const { piBin } = sandboxPi();
writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});\n`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", timeout: 5000, stdio: "pipe" }).trim();
const persona: Persona = { name: "custom-writer", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: false, source: "builtin", sourcePath: "test" };
function setup(t: test.TestContext, maxConcurrent = 4, maxParallel = 2) {
  const cwd = tmpDir("m4-native-"); git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "base"), "base"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "test: base");
  openEffort(cwd, "one", "owner", { verify: "git diff --check HEAD", maxParallel });
  const base = git(cwd, "rev-parse", "HEAD"), index = readFileSync(join(cwd, ".git", "index"));
  const registry = new RunRegistry(), queue = new SpawnQueue(registry, maxConcurrent, 1);
  t.after(async () => {
    for (const p of [...queue.list()]) queue.removeQueued(p.id);
    for (const run of registry.list()) {
      if (run.status === "integrating") await run.integrationControl?.suspend();
      else if (run.proc) { const close = once(run.proc, "close"); forceTerminate(run, "killed", registry); await close; }
    }
  });
  const spawn = (task: string, touches: string[]) => queue.enqueueOrSpawn({ registry, cwd, persona, task, touches, effort: "one", parentSessionId: "owner", mode: "background", timeoutMs: 20000 });
  const untouched = () => { assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.equal(git(cwd, "branch", "--show-current"), "main"); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index); assert.equal(readFileSync(join(cwd, "base"), "utf8"), "base"); assert.equal(git(cwd, "status", "--porcelain"), ""); };
  return { cwd, base, registry, queue, spawn, untouched };
}
function barrier(run: Run): Promise<ChildProcess> {
  const proc = run.proc!;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const close = () => reject(new Error(`writer ${run.id} exited before native barrier`));
    const data = (chunk: Buffer) => {
      buffer += chunk.toString(); let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const e = JSON.parse(line);
        if (e.type === "probe" && e.point === "before-settle") { proc.off("close", close); proc.stdout!.off("data", data); resolve(proc); }
      }
    };
    proc.once("close", close); proc.stdout!.on("data", data);
  });
}
function nextLaunch(registry: RunRegistry, id: string): Promise<Run> {
  return new Promise(resolve => {
    const off = registry.onChange(r => { if (r.id === id && r.status === "running") { off(); queueMicrotask(() => resolve(r)); } });
  });
}
function terminal(registry: RunRegistry, id: string): Promise<Run> {
  return new Promise(resolve => { const off = registry.onChange(r => { if (r.id === id && r.status === "completed") { off(); resolve(r); } }); });
}
function integrated(cwd: string, run: Run) {
  assert.equal(run.status, "completed", run.errorMessage); assert.ok(run.landedCommit); assert.equal(run.integration?.attempts, 1);
  assert.equal(git(cwd, "log", "conductor-int/one", "--format=%B").split(`Conductor-Run: ${run.id}`).length - 1, 1);
  assert.equal(git(cwd, "show", "-s", "--format=%P", run.landedCommit).split(" ").length, 1);
}

test("M4 native barriers: two real disjoint worktree writers are alive before either finishes, then exactly one verified integration each", { timeout: 40000 }, async t => {
  const h = setup(t);
  const a = h.spawn("M4_CONTROL M4_FILE=a", ["a"]), b = h.spawn("M4_CONTROL M4_FILE=b", ["b"]);
  assert.equal(a.kind, "spawned"); assert.equal(b.kind, "spawned", "positive concurrency control"); if (a.kind !== "spawned" || b.kind !== "spawned") return;
  const [pa, pb] = await Promise.all([barrier(a.run), barrier(b.run)]);
  let aExited = false, bExited = false; pa.once("exit", () => { aExited = true; }); pb.once("exit", () => { bExited = true; });
  assert.notEqual(pa.pid, pb.pid); assert.notEqual(a.run.worktreePath, b.run.worktreePath);
  assert.equal(a.run.status, "running"); assert.equal(b.run.status, "running"); assert.equal(h.registry.countActive(), 2);
  assert.equal(pa.signalCode, null); assert.equal(pb.signalCode, null); assert.equal(aExited || bExited, false);
  assert.equal(a.run.effort?.spawnBase, h.base); assert.equal(b.run.effort?.spawnBase, h.base);
  h.untouched(); pa.kill("SIGUSR2"); await a.done; integrated(h.cwd, a.run);
  assert.equal(b.run.status, "running"); assert.equal(bExited, false);
  pb.kill("SIGUSR2"); await b.done; integrated(h.cwd, b.run); h.untouched();
  assert.equal(git(h.cwd, "show", "conductor-int/one:a"), `Written by ${a.run.id}`);
  assert.equal(git(h.cwd, "show", "conductor-int/one:b"), `Written by ${b.run.id}`);
});
for (const cap of ["global", "effort"]) test(`M4 native blocked answer respects ${cap} cap, keeps pending ask on refusal, and resumes ahead of its own waiter`, { timeout: 50000 }, async t => {
  const h = setup(t, cap === "global" ? 1 : 4, cap === "effort" ? 1 : 4);
  const a = h.spawn("Original assignment: ask owner", ["a"]); assert.equal(a.kind, "spawned"); if (a.kind !== "spawned") return;
  await a.done; assert.equal(a.run.status, "blocked"); assert.equal(h.registry.countActive(), 0);
  const ask = structuredClone(a.run.pendingAsk), before = readFileSync(a.run.recordPath, "utf8");
  const assignment = { ...a.run.effort }, path = a.run.worktreePath, branch = a.run.worktreeBranch;
  const b = h.spawn("M4_CONTROL M4_FILE=b", ["b"]); assert.equal(b.kind, "spawned"); if (b.kind !== "spawned") return;
  const pb = await barrier(b.run);
  const c = h.spawn("M4_CONTROL M4_FILE=c", ["a", "c"]); assert.equal(c.kind, "queued"); if (c.kind !== "queued") return;
  const refused = sendToRun(a.run, "Use B M4_CONTROL M4_FILE=a", { registry: h.registry, timeoutMs: 20000, sessionId: "owner" });
  assert.equal(refused.kind, "rejected", "blocked answers cannot bypass execution limits"); assert.deepEqual(a.run.pendingAsk, ask); assert.equal(readFileSync(a.run.recordPath, "utf8"), before);
  assert.equal(h.registry.countActive(), 1); assert.equal(a.run.status, "blocked");
  assert.equal(availableActions(a.run, false, "owner", h.registry).includes("send"), false);
  const tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, { getCwd: () => h.cwd, getRegistry: () => h.registry, getQueue: () => h.queue, getSessionId: () => "owner" } as any, {});
  const status = await tools.get("ensemble_status").execute("status", { agent_id: a.run.id }, undefined, undefined, { mode: "json" });
  assert.match(status.details.blocked[0].wait_reason, /maxConcurrent|maxParallel/);
  assert.equal(status.details.blocked[0].available_actions.includes("send"), false);
  assert.equal(buildCompletionMessage(a.run, false, "owner", h.registry).details.available_actions?.includes("send"), false);
  pb.kill("SIGUSR2"); await b.done; integrated(h.cwd, b.run);
  assert.equal(h.registry.get(c.pending.id)!.status, "queued", "blocked owner keeps footprint after competing writer integration");
  const launched = nextLaunch(h.registry, c.pending.id), completed = terminal(h.registry, c.pending.id);
  const reply = sendToRun(a.run, "Use B M4_CONTROL M4_FILE=a", { registry: h.registry, timeoutMs: 20000, sessionId: "owner" });
  assert.equal(reply.kind, "started", "owner answer must not wait on its own queued conflict"); if (reply.kind !== "started") return;
  const pa = await barrier(a.run); assert.equal(a.run.pendingAsk, undefined); assert.equal(h.registry.countActive(), 1);
  assert.deepEqual(a.run.effort, assignment); assert.equal(a.run.worktreePath, path); assert.equal(a.run.worktreeBranch, branch);
  pa.kill("SIGUSR2"); await reply.done; integrated(h.cwd, a.run);
  const queuedRun = await launched; const pc = await barrier(queuedRun);
  assert.equal(queuedRun.effort?.spawnBase, a.run.landedCommit, "actual dequeue branches from the new integration tip");
  assert.equal(queuedRun.id, c.pending.id); assert.equal(queuedRun.parentSessionId, "owner");
  pc.kill("SIGUSR2"); await completed; integrated(h.cwd, queuedRun); h.untouched();
});
