import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunRegistry, forceTerminate, spawnRun } from "../src/runs.ts";
import { registerTools } from "../src/tools.ts";
import { SpawnQueue } from "../src/queue.ts";
import { openEffort } from "../src/effort/open.ts";
import { type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";

sandboxPi();
const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
const persona: Persona = { name: "custom-writer", description: "test", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake", readOnly: false };
function setup(t: test.TestContext, maxConcurrent = 4, maxParallel = 3, generated?: { paths: string[]; command: string }) {
  const cwd = tmpDir("m4-admit-"); git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src", "old"), "base\n");
  writeFileSync(join(cwd, "src", "mode"), "mode"); writeFileSync(join(cwd, "src", "delete"), "delete");
  git(cwd, "add", ".gitignore", "src"); git(cwd, "commit", "-m", "base");
  openEffort(cwd, "one", "owner", { verify: "", maxParallel, generated });
  const registry = new RunRegistry(); const started: Promise<Run>[] = [];
  const queue = new SpawnQueue(registry, maxConcurrent, 1, opts => { const result = spawnRun(opts); started.push(result.done); return result; });
  const realSpawn = cp.spawn;
  t.mock.method(cp, "spawn", (command: string, args: string[] | cp.SpawnOptions, opts?: cp.SpawnOptions) => {
    if (command !== process.env.PI_BIN) return Array.isArray(args) ? realSpawn(command, args, opts ?? {}) : realSpawn(command, args);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {}, kill() { queueMicrotask(() => proc.emit("close", 0)); return true; } });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    for (const p of [...queue.list()]) queue.removeQueued(p.id);
    for (const r of registry.list()) { if (r.status === "integrating" && !r.integrationControl) r.status = "running"; forceTerminate(r, "killed", registry); }
    await Promise.all(started); t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const spawn = (touches?: string[], effort: string | null = "one", name = persona.name) => queue.enqueueOrSpawn({ registry, cwd, persona: { ...persona, name }, effort: effort ?? undefined, touches, parentSessionId: "owner", task: "test", mode: "background", timeoutMs: 10000 });
  return { cwd, registry, queue, spawn };
}
function getRun(r: ReturnType<SpawnQueue["enqueueOrSpawn"]>): Run { return r.kind === "spawned" ? r.run : r.placeholderRun; }

test("M4 production admission: disjoint custom writers escape legacy cap, overlap waits, later independent work advances", { timeout: 15000 }, t => {
  const { spawn, registry } = setup(t);
  const a = spawn(["src/a/**"]), b = spawn(["src/b/**"]), overlap = spawn(["src/a/file"]), c = spawn(["src/c/**"]);
  assert.equal(a.kind, "spawned"); assert.equal(b.kind, "spawned", "disjoint writer must launch alongside first");
  assert.equal(overlap.kind, "queued", "touch gate prevents conflicting activation"); assert.equal(c.kind, "spawned");
  assert.equal(registry.countActive(), 3);
  assert.notEqual(getRun(a).worktreePath, getRun(b).worktreePath);
});
for (const [a, b] of [ [["src/*.ts"], ["src/*.md"]], [["**"], ["other/**"]], [undefined, ["other/**"]], [[], ["other/**"]] ] as const) {
  test(`M4 uncertain or empty footprint serializes: ${JSON.stringify(a)}`, { timeout: 15000 }, t => {
    const { spawn } = setup(t); spawn(a ? [...a] : undefined);
    assert.equal(spawn([...b]).kind, "queued");
  });
}
for (const generated of [false, true]) test(`M4 generated full-region coverage only (${generated})`, { timeout: 15000 }, t => {
  const { spawn } = setup(t, 4, 4, generated ? { paths: ["dist/**"], command: "true" } : undefined);
  spawn(["src/a/**", "dist/**"]);
  assert.equal(spawn(["src/b/**", "dist/**"]).kind, generated ? "spawned" : "queued");
  assert.equal(spawn(["**"]).kind, "queued", "generated intersection must not discard broad source footprint");
});
for (const cap of ["global", "effort"]) test(`M4 ${cap} cap applies at immediate admission and dequeue`, { timeout: 15000 }, t => {
  const { spawn, queue, registry } = setup(t, cap === "global" ? 2 : 4, cap === "effort" ? 2 : 4);
  const a = getRun(spawn(["a/**"])); spawn(["b/**"]);
  const c = spawn(["c/**"]), d = spawn(["d/**"]);
  assert.equal(c.kind, "queued"); assert.equal(d.kind, "queued");
  a.status = "integrating"; registry.notify(a);
  assert.equal(getRun(c).status, "queued", "placeholder object is not the launched run");
  assert.equal(registry.get(getRun(c).id)!.status, "running"); assert.equal(registry.get(getRun(d).id)!.status, "queued");
  assert.equal(registry.countActive(), 2); assert.equal(queue.size(), 1);
});
test("M4 reentrant notification counts pre-launch reservations and preserves queued identity", { timeout: 15000 }, t => {
  const { spawn, registry } = setup(t, 1, 4); let next: ReturnType<typeof spawn> | undefined;
  registry.onChange(r => { if (r.status === "running" && !next) { next = { kind: "spawned", run: r, done: Promise.resolve(r) }; next = spawn(["b/**"]); } });
  const first = spawn(["a/**"]); assert.equal(next?.kind, "queued", "register-before-launch reserves the execution slot");
  assert.equal(registry.countActive(), 1); assert.equal(getRun(first).parentSessionId, "owner");
});
test("M4 non-effort builders still obey their cap independently of effort writers", { timeout: 15000 }, t => {
  const { spawn } = setup(t);
  const effort = spawn(["a/**"]); assert.equal(effort.kind, "spawned");
  const ordinary = spawn(undefined, null, "builder");
  assert.equal(ordinary.kind, "spawned");
  assert.equal(spawn(undefined, null, "builder").kind, "queued");
});
test("M4 same-repo efforts collide; generated policy in only one effort is not shared permission", { timeout: 15000 }, t => {
  const { cwd, spawn } = setup(t, 4, 4, { paths: ["dist/**"], command: "true" });
  openEffort(cwd, "two", "owner", { verify: "" });
  spawn(["src/a/**", "dist/**"]);
  assert.equal(spawn(["src/b/**", "dist/**"], "two").kind, "queued");
});
test("M4 actual diff widens scope BEFORE slot release: rename endpoints, delete, mode and unusual filename", { timeout: 15000 }, async t => {
  const { cwd, spawn, registry } = setup(t, 1);
  const first = spawn(["src/**"]); assert.equal(first.kind, "spawned"); if (first.kind !== "spawned") return;
  const run = first.run, wt = run.worktreePath!;
  const odd = "outside\tname\nfile";
  mkdirSync(join(wt, "outside")); git(wt, "mv", "src/old", "outside/renamed");
  writeFileSync(join(wt, odd), "odd"); chmodSync(join(wt, "src/mode"), 0o755); unlinkSync(join(wt, "src/delete"));
  git(wt, "add", "--", "src", "outside/renamed", odd); git(wt, "commit", "-m", "rename delete mode");
  const queued = spawn(["outside/**"]); assert.equal(queued.kind, "queued");
  let observed: Run["integration"], waited = false;
  registry.onChange(r => { if (r.id === run.id && r.status === "integrating") { observed = structuredClone(r.integration); waited = registry.get(getRun(queued).id)!.status === "queued"; } });
  run.proc!.emit("close", 0); await first.done;
  assert.ok(observed); assert.equal(waited, true, "out-of-scope diff must reserve outside before drain sees a free process slot");
  assert.deepEqual(new Set(observed.touchViolations), new Set([odd, "outside/renamed"]));
  assert.deepEqual(new Set(observed.changedPaths), new Set(["src/old", "src/delete", "src/mode", "outside/renamed", odd]));
  assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).integration.touchViolations, observed.touchViolations);
  assert.equal(registry.get(getRun(queued).id)!.status, "running", "reservation releases after successful integration");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});
test("M4 a partially intersecting generated glob cannot exempt a broad source declaration", { timeout: 15000 }, t => {
  const { spawn } = setup(t, 4, 4, { paths: ["src/generated/**"], command: "true" });
  spawn(["src/**"]); assert.equal(spawn(["src/real/**"]).kind, "queued");
});
test("M4 unresolved failed writers retain universal reservations; foreign effort ownership fails closed", { timeout: 15000 }, t => {
  const { cwd, spawn, registry } = setup(t);
  const run = getRun(spawn(["src/**"])); forceTerminate(run, "killed", registry);
  assert.equal(spawn(["other/**"]).kind, "queued", "killed writer's unmeasured changes are not integration evidence");
  openEffort(cwd, "foreign", "another-owner", { verify: "" });
  const next = spawn(["another/**"]); assert.equal(next.kind, "queued");
  assert.match(getRun(next).waitReason!, /foreign effort/);
});

test("M4 missing touches stays serial even beside a generated-only writer", { timeout: 15000 }, t => {
  const { spawn } = setup(t, 4, 4, { paths: ["dist/**"], command: "true" });
  spawn(["dist/**"]); assert.equal(spawn([]).kind, "queued");
});

test("M4 foreground owner-answer result reports busy actions after a new ask frees a queued writer", { timeout: 15000 }, async t => {
  const { cwd, spawn, registry, queue } = setup(t, 1);
  const first = spawn(["a/**"]); assert.equal(first.kind, "spawned"); if (first.kind !== "spawned") return;
  const run = first.run;
  run.sessionPath = join(dirname(run.recordPath), "session", "fake.jsonl");
  writeFileSync(run.sessionPath, JSON.stringify({ type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: run.effort!.cwd }) + "\n");
  run.pendingAsk = { askId: "first", question: "Which option?", evidence: "" };
  run.proc!.stdout!.emit("data", Buffer.from('{"type":"agent_settled"}\n')); await first.done;
  assert.equal(run.status, "blocked");
  const tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, { getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getSessionId: () => "owner", registerForegroundDetach: () => ({ detachSignal: new Promise(() => {}), unregister() {} }) } as any, {});
  const launched = new Promise<void>(resolve => { const off = registry.onChange(r => { if (r.id === run.id && r.status === "running") { off(); queueMicrotask(resolve); } }); });
  const answer = tools.get("ensemble_send").execute("answer", { agent_id: run.id, message: "Use A", foreground: true }, undefined, undefined, { mode: "json" });
  await launched;
  run.proc!.stdout!.emit("data", Buffer.from('{"type":"agent_start"}\n'));
  const next = spawn(["b/**"]); assert.equal(next.kind, "queued");
  run.pendingAsk = { askId: "second", question: "Another decision?", evidence: "" };
  run.proc!.stdout!.emit("data", Buffer.from('{"type":"agent_settled"}\n'));
  const result = await answer;
  assert.equal(result.details.status, "blocked"); assert.equal(registry.countActive(), 1);
  assert.equal(result.details.available_actions.includes("send"), false, "foreground action snapshot must observe the newly occupied slot");
});
