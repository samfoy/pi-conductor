import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openEffort } from "../src/effort/open.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import type { Persona } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
const persona: Persona = { name: "builder", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: true, timeoutMinutes: 1, readOnly: false, source: "builtin", sourcePath: "test" };
test("two stale-base writers integrate as verified linear squashes without changing the main checkout", { timeout: 15000 }, async t => {
  const cwd = tmpDir("m2-linear-");
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "original bytes\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD"); const index = readFileSync(join(cwd, ".git", "index"));
  const record = openEffort(cwd, "linear", "owner", { verify: 'git rev-parse HEAD; test -f base' });
  const realSpawn = cp.spawn; const procs: any[] = [];
  t.mock.method(cp, "spawn", (command: string, args: string[] | cp.SpawnOptions, options?: cp.SpawnOptions) => {
    if (!Array.isArray(args)) return realSpawn(command, args);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {}, kill() { queueMicrotask(() => proc.emit("close", 0)); return true; } });
    procs.push(proc); return proc;
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const registry = new RunRegistry(); let completions = 0;
  const launch = () => spawnRun({ registry, persona, cwd, task: "Implement a disjoint change", effort: "linear", parentSessionId: "owner", mode: "background", timeoutMs: 10000, onComplete: () => completions++ });
  const a = launch(), b = launch();
  for (const [result, path] of [[a, "a"], [b, "b"]] as const) {
    writeFileSync(join(result.run.worktreePath!, path), path); git(result.run.worktreePath!, "add", path); git(result.run.worktreePath!, "commit", "-m", path);
  }
  function finish(i: number) { procs[i].stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented and committed the requested change with verification evidence." }] } }) + "\n"); procs[i].emit("close", 0); }
  finish(0); await a.done; finish(1); await b.done;
  assert.equal(a.run.status, "completed", a.run.errorMessage); assert.equal(b.run.status, "completed", b.run.errorMessage);
  const tip = git(cwd, "rev-parse", record.intRef);
  assert.notEqual(tip, base, "accepted writers must advance integration ref only after verify");
  assert.equal(git(cwd, "rev-list", "--count", `${base}..${tip}`), "2");
  assert.equal(git(cwd, "show", `${tip}:a`), "a"); assert.equal(git(cwd, "show", `${tip}:b`), "b");
  for (const result of [a, b]) assert.match(git(cwd, "log", record.intRef, "--format=%B"), new RegExp(`Conductor-Run: ${result.run.id}`));
  assert.equal(completions, 2);
  assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), "main");
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index); assert.equal(readFileSync(join(cwd, "base"), "utf8"), "original bytes\n");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});
