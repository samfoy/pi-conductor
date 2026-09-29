import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunRegistry, forceTerminate } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { openEffort } from "../src/effort/open.ts";
import { shellQuote } from "../src/effort/git.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { gitTestEnv } from "./helpers/git-env.ts";
import { git, until } from "./helpers/effort-integration.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const artifact = "dist/über space.json";
const node = (code: string) => `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
const generate = node(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(artifact)}, JSON.stringify({a:fs.readFileSync('a','utf8'),b:fs.readFileSync('b','utf8')})); console.log('generated');`);
const verify = `if test -n "$CONDUCTOR_CANDIDATE"; then ${node(`const fs=require('node:fs'),assert=require('node:assert/strict'); assert.deepEqual(JSON.parse(fs.readFileSync(${JSON.stringify(artifact)},'utf8')),{a:fs.readFileSync('a','utf8'),b:fs.readFileSync('b','utf8'),hooked:true});`)} || exit 1; fi; git rev-parse HEAD; git rev-parse HEAD^{tree}`;
function fixture(t: TestContext, opts: { conflictKind?: "rename" | "delete"; mode?: "conflict" | "mixed" | "clean" | "source"; command?: string; verify?: string; configured?: boolean; timeout?: number; hook?: string; paths?: string[] } = {}) {
  const root = tmpDir("m3-git-");
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  mkdirSync(join(root, "dist"));
  const initial = { a: "0", b: "0", [artifact]: '{"a":"0","b":"0"}', "dist/remove.json": "old", ".gitignore": ".worktrees/\nignored/\ndist/*.new\n" };
  for (const [path, data] of Object.entries(initial)) writeFileSync(join(root, path), data);
  git(root, "add", "a", "b", "dist", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), index = readFileSync(join(root, ".git", "index"));
  const mode = opts.mode ?? "conflict";
  const record = openEffort(root, "generated", "owner", { verify: opts.verify ?? verify, verifyRetries: 0, verifyTimeoutSeconds: opts.timeout ?? 5,
    ...(opts.configured === false ? {} : { generated: { paths: opts.paths ?? ["dist/**"], command: opts.command ?? generate } }) });
  const tipPath = join(root, ".worktrees", "tip"), writer = join(root, ".worktrees", "writer");
  for (const [path, name] of [[tipPath, "tip"], [writer, "writer"]]) git(root, "worktree", "add", "-b", name!, path!, base);
  writeFileSync(join(tipPath, "a"), "1");
  if (mode === "conflict" || mode === "mixed") writeFileSync(join(tipPath, artifact), '{"a":"1","b":"0"}');
  if (opts.conflictKind === "rename") git(tipPath, "mv", "dist/remove.json", "dist/ours ü.json");
  if (opts.conflictKind === "delete") git(tipPath, "rm", "dist/remove.json");
  git(tipPath, "add", "a", "dist"); git(tipPath, "commit", "-m", "tip");
  const tip = git(tipPath, "rev-parse", "HEAD"); git(root, "update-ref", record.intRef, tip, base);
  writeFileSync(join(writer, mode === "mixed" ? "a" : "b"), "2");
  if (mode !== "source") writeFileSync(join(writer, artifact), '{"a":"0","b":"2"}');
  if (opts.conflictKind === "rename") git(writer, "mv", "dist/remove.json", "dist/theirs ü.json");
  if (opts.conflictKind === "delete") writeFileSync(join(writer, "dist/remove.json"), "edited");
  git(writer, "add", "a", "b", "dist"); git(writer, "commit", "-m", "writer");
  const head = git(writer, "rev-parse", "HEAD"), dir = tmpDir("m3-run-");
  const run: Run = { id: "builder-generated", persona: "builder", task: "Regenerate artifacts", mode: "background", status: "integrating", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), cwd: root,
    parentSessionId: "owner", parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
    effort: { name: record.name, gitRoot: root, role: "writer", spawnBase: base, cwd: writer },
    integration: { state: "queued", branchHead: head, enqueuedAt: Date.now(), attempts: 0, verifyIdentity: { command: record.policy.verify, timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: 0 } },
    worktreePath: writer, worktreeBranch: "writer", recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const registry = new RunRegistry(); registry.register(run);
  const hook = opts.hook ?? `${node(`const fs=require('node:fs'); const path=${JSON.stringify(artifact)}; const obj=JSON.parse(fs.readFileSync(path,'utf8')); obj.hooked=true; fs.writeFileSync(path,JSON.stringify(obj));`)}\ngit add -- '${artifact}'\necho policy-hook`;
  writeFileSync(join(root, ".git", "hooks", "pre-commit"), `#!/bin/sh\nset -e\n${hook}\n`, { mode: 0o755 });
  const start = () => registry.integrations.enqueue(run, () => registry.notify(run)).then(outcome => { run.status = outcome.terminal; run.landedCommit = outcome.landedCommit; run.mergeResult = outcome.mergeResult; registry.notify(run); return outcome; });
  const unchanged = () => assert.equal(git(root, "rev-parse", record.intRef), tip, "unverified content must not advance integration ref");
  t.after(async () => {
    await run.integrationControl?.suspend(); await run.recordWrite;
    assert.equal(git(root, "rev-parse", "HEAD"), base); assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
    for (const [path, data] of Object.entries(initial)) assert.equal(readFileSync(join(root, path), "utf8"), data);
    assert.equal(git(root, "status", "--porcelain"), ""); assert.equal(git(root, "rev-parse", "writer"), head);
  });
  return { root, run, registry, record, tip, start, unchanged };
}

for (const mode of ["conflict", "clean"] as const) test(`${mode}: generated output is rebuilt then post-hook OID/tree is independently verified and accepted`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode }); const outcome = await f.start();
  assert.equal(outcome.terminal, "completed", JSON.stringify(outcome));
  const oid = outcome.landedCommit!;
  assert.equal(git(f.root, "rev-parse", f.record.intRef), oid, "integration ref must equal the verified post-generation OID");
  assert.equal(git(f.root, "show", "-s", "--format=%P", oid), f.tip);
  assert.equal(git(f.root, "rev-list", "--count", `${f.tip}..${oid}`), "1");
  assert.deepEqual(JSON.parse(git(f.root, "show", `${oid}:${artifact}`)), { a: "1", b: "2", hooked: true });
  assert.equal(readFileSync(outcome.mergeResult.verify!.logPath, "utf8").trim(), `${oid}\n${git(f.root, "rev-parse", `${oid}^{tree}`)}`);
  assert.match(readFileSync(f.run.integration!.commitHook!.logPath, "utf8"), /policy-hook/);
  const entry = f.run.integration!;
  assert.deepEqual(entry.conflicts, mode === "conflict" ? [artifact] : []);
  const original = readFileSync(entry.mergeEvidencePath!, "utf8");
  assert.equal(original.split("\0")[0], entry.mergeTree);
  const savedIndex = join(entry.mergeEvidencePath!, "..", "merge.index");
  assert.equal(execFileSync("git", ["write-tree"], { cwd: entry.candidatePath!, env: { ...gitTestEnv(), GIT_INDEX_FILE: savedIndex }, encoding: "utf8", timeout: 5000 }).trim(), entry.mergeTree);
  assert.deepEqual(JSON.parse(git(f.root, "show", `${entry.preGenerationTree}:${artifact}`)), mode === "conflict" ? { a: "1", b: "0" } : { a: "0", b: "2" });
  assert.equal(entry.generation!.tailText, "generated");
  t.diagnostic(`integration ${f.tip} -> ${oid}; verify ${outcome.mergeResult.verify!.durationMs}ms`);
});

test("generator uses the private bounded runner with inherited git/herdr state scrubbed", { timeout: 15000 }, async t => {
  const check = node(`const assert=require('node:assert/strict'),fs=require('node:fs'); assert.equal(Object.keys(process.env).some(k=>k.startsWith('GIT_')||k.startsWith('HERDR_')),false); assert.ok(process.env.TMPDIR.startsWith(process.env.HOME+'/')); assert.notEqual(process.env.TMPDIR,process.cwd()); fs.writeFileSync(process.env.TMPDIR+'/generator-only','private');`);
  const f = fixture(t, { command: `${check} && ${generate}` });
  const oldGit = process.env.GIT_INDEX_FILE, oldHerdr = process.env.HERDR_M3_TEST;
  process.env.GIT_INDEX_FILE = "/foreign/index"; process.env.HERDR_M3_TEST = "foreign";
  t.after(() => {
    if (oldGit === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = oldGit;
    if (oldHerdr === undefined) delete process.env.HERDR_M3_TEST; else process.env.HERDR_M3_TEST = oldHerdr;
  });
  const outcome = await f.start(); assert.equal(outcome.terminal, "completed");
  assert.equal(existsSync(join(f.root, "generator-only")), false);
  assert.equal(readFileSync(join(f.run.integration!.generation!.logPath, "..", "tmp", "generator-only"), "utf8"), "private");
});

for (const conflictKind of ["rename", "delete"] as const) test(`generated ${conflictKind} conflict preserves paths and seeds the current tip`, { timeout: 15000 }, async t => {
  const f = fixture(t, { conflictKind }); const done = f.start();
  await until(f.registry, f.run, r => r.status === "completed" || r.integration?.state === "paused");
  assert.notEqual(f.run.integration!.state, "paused", f.run.integration!.reason);
  const outcome = await done;
  assert.equal(outcome.terminal, "completed");
  assert.ok(f.run.integration!.conflicts!.includes("dist/remove.json"));
  if (conflictKind === "rename") {
    assert.ok(f.run.integration!.conflicts!.includes("dist/ours ü.json"));
    assert.ok(f.run.integration!.conflicts!.includes("dist/theirs ü.json"));
    assert.equal(git(f.root, "show", `${outcome.landedCommit}:dist/ours ü.json`), "old");
  }
  assert.ok(!git(f.root, "ls-tree", "-r", "--name-only", "-z", outcome.landedCommit!).split("\0").includes("dist/remove.json"));
});

test("mixed conflict retains original paths and never invokes generator", { timeout: 15000 }, async t => {
  const marker = join(tmpDir("m3-marker-"), "ran");
  const f = fixture(t, { mode: "mixed", command: `touch ${shellQuote(marker)}` });
  const outcome = await f.start();
  assert.equal(outcome.terminal, "merge_conflict"); assert.deepEqual(outcome.mergeResult.conflicts, ["a", artifact]);
  assert.equal(existsSync(marker), false); f.unchanged();
});

for (const configured of [true, false]) test(`no generated diff/config preserves M2 (${configured})`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: configured ? "source" : "clean", configured, command: "exit 88", verify: "true", hook: "echo hook" });
  const outcome = await f.start(); assert.equal(outcome.terminal, "completed");
  assert.equal(git(f.root, "show", `${outcome.landedCommit}:b`), "2");
});

for (const [label, command] of [
  ["source edit", "echo forbidden > a"],
  ["source index edit", "echo forbidden > a; git add a; printf 1 > a"],
  ["assume-unchanged source", "git update-index --assume-unchanged a; echo forbidden > a"],
  ["untracked source", "echo forbidden > surprise"],
  ["ignored source", "mkdir -p ignored; echo forbidden > ignored/source"],
  ["rename outside policy", "mv dist/remove.json outside.json"],
  ["delete source", "rm a"],
  ["symlink outside policy", "ln -s a surprise-link"],
] as const) test(`actual generator boundary rejects ${label}`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", command: `${generate}; ${command}`, verify: "true", hook: "echo hook" });
  const done = f.start(); await until(f.registry, f.run, r => r.integration?.state === "paused" || r.status === "completed");
  assert.equal(f.run.integration!.state, "paused", "out-of-policy generator must be rejected before commit/CAS");
  assert.match(f.run.integration!.reason!, /generated.*outside|outside.*generated/);
  f.unchanged(); assert.ok(existsSync(f.run.integration!.candidatePath!));
  assert.equal(f.run.integration!.commitHook, undefined, "boundary rejects before committing");
  forceTerminate(f.run, "killed", f.registry); await done;
});

for (const [label, command, reason] of [
  ["generated symlink", "ln -s ../a dist/link", /generated symlink artifacts are unsupported/],
  ["hidden index flags", "git update-index --skip-worktree a", /index flags/],
  ["changed HEAD", "git checkout --detach HEAD^", /changed candidate HEAD/],
] as const) test(`generation rejects ${label}`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", command: `${generate}; ${command}`, verify: "true", hook: "echo hook" });
  const done = f.start(); await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.match(f.run.integration!.reason!, reason); f.unchanged();
  forceTerminate(f.run, "killed", f.registry); await done;
});

test("allowed generated adds, deletes and renames are explicitly staged, including ignored outputs", { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", command: `${generate}; git mv dist/remove.json 'dist/renamed ü.json'; echo added > dist/added.new; echo literal > 'dist/:(glob)*?.json'` });
  const outcome = await f.start(); assert.equal(outcome.terminal, "completed");
  const files = git(f.root, "ls-tree", "-r", "--name-only", "-z", outcome.landedCommit!).split("\0");
  assert.ok(!files.includes("dist/remove.json")); assert.ok(files.includes("dist/renamed ü.json")); assert.ok(files.includes("dist/added.new")); assert.ok(files.includes("dist/:(glob)*?.json"));
});

for (const mode of ["kill", "reload", "timeout"] as const) test(`generator ${mode} awaits owned resistant descendant teardown without acceptance`, { timeout: 15000, skip: process.platform !== "linux" }, async t => {
  const pidFile = join(tmpDir("m3-group-"), "child.json");
  const child = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); const raw=fs.readFileSync('/proc/'+process.pid+'/stat','utf8'); const fields=raw.slice(raw.lastIndexOf(')')+2).split(' '); fs.writeFileSync(${JSON.stringify(pidFile + ".tmp")},JSON.stringify({pid:process.pid,startTime:Number(fields[19]),pgid:Number(fields[2])})); fs.renameSync(${JSON.stringify(pidFile + ".tmp")},${JSON.stringify(pidFile)}); setInterval(()=>{},1000);`;
  const command = `exec ${node(`const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>process.exit(0)); spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{},1000);`)}`;
  const f = fixture(t, { mode: "clean", command, timeout: mode === "timeout" ? 1 : 5 });
  const saved = () => existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; startTime: number; pgid: number } : undefined;
  function live() {
    const info = saved(); if (!info) return false;
    try {
      const raw = readFileSync(`/proc/${info.pid}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      assert.equal(Number(fields[19]), info.startTime, "observe only the fixture-owned PID/start identity");
      return fields[0] !== "Z" && fields[0] !== "X";
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async function waitFor(predicate: () => boolean) {
    const end = Date.now() + 6000;
    while (!predicate()) { assert.ok(Date.now() < end, "fixture group barrier deadline"); await delay(10); }
  }
  let resolutions = 0; const done = f.start().then(outcome => { resolutions++; return outcome; });
  t.after(async () => {
    await f.run.integrationControl?.suspend();
    if (live()) {
      assert.ok(readFileSync(`/proc/${saved()!.pid}/cmdline`, "utf8").includes(pidFile));
      process.kill(saved()!.pid, "SIGKILL"); await waitFor(() => !live());
    }
  });
  await waitFor(() => !!saved());
  assert.equal(saved()!.pgid, f.run.integration!.process!.pid); assert.equal(live(), true);
  const start = Date.now();
  if (mode === "kill") { forceTerminate(f.run, "killed", f.registry); forceTerminate(f.run, "killed", f.registry); await done; }
  else if (mode === "reload") await handleSessionShutdown({ reason: "reload" }, { runs: [f.run], resetSanitizer() {}, reconcileRunning() { assert.fail("integrating work is retained"); } });
  else await until(f.registry, f.run, r => r.integration?.state === "paused", 8000);
  assert.equal(live(), false, "leader exit alone must not authorize acceptance or release");
  f.unchanged(); assert.equal(f.run.landedCommit, undefined);
  assert.equal(resolutions, mode === "kill" ? 1 : 0);
  assert.ok(f.run.integration!.generation, "generator result remains evidence even when cancellation fences acceptance");
  assert.equal(f.run.integration!.generation!.failureKind, mode === "timeout" ? "timeout" : undefined);
  assert.ok(existsSync(f.run.integration!.candidatePath!)); assert.ok(existsSync(f.run.integration!.logPath!));
  t.diagnostic(`${mode}: resistant generator group stopped before return in ${Date.now() - start}ms; intRef ${f.tip} unchanged`);
  if (mode === "timeout") { forceTerminate(f.run, "killed", f.registry); await done; }
});

for (const [command, reason] of [["echo dirty > a", /unexpected dirty/], ["git reset --soft HEAD^", /HEAD changed/]] as const) test(`post-generation verify mutation is rejected: ${command}`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", verify: `if test -n "$CONDUCTOR_CANDIDATE"; then ${command}; fi` });
  const done = f.start(); await until(f.registry, f.run, r => r.integration?.state === "paused");
  assert.match(f.run.integration!.reason!, reason); f.unchanged();
  forceTerminate(f.run, "killed", f.registry); await done;
});

test("generator changes output but independent verify fails: no CAS", { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", verify: 'if test -n "$CONDUCTOR_CANDIDATE"; then echo independent-red; exit 1; fi' });
  const outcome = await f.start(); assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "verify_failed");
  assert.ok(f.run.integration!.candidateOid); assert.match(outcome.mergeResult.verify!.tailText, /independent-red/); f.unchanged();
});

for (const [label, command, hook, reason] of [
  ["generator error", "echo generation-refused; exit 7", "echo hook", /generat.*exited/],
  ["generator timeout", "sleep 30", "echo hook", /generat.*timeout/],
  ["hook rejection", generate, "echo policy-refused; exit 1", /commit hooks failed/],
] as const) test(`${label} preserves ref, workspace and evidence`, { timeout: 15000 }, async t => {
  const f = fixture(t, { mode: "clean", command, hook, timeout: 1 });
  const done = f.start(); await until(f.registry, f.run, r => r.integration?.state === "paused", 8000);
  assert.match(f.run.integration!.reason!, reason); f.unchanged();
  assert.ok(existsSync(f.run.integration!.candidatePath!)); assert.ok(existsSync(f.run.integration!.logPath!));
  forceTerminate(f.run, "killed", f.registry); await done;
});
