// M7 (docs/m7/requirements.md R1–R3): effort readers on the subprocess and herdr runtimes, the normal
// validation hook in the reader's view, and exit/hook/owner/pane proofs before review evidence or release.
// Herdr is an in-process fake CLI only; a run without one refuses to launch, and a refusing shim records any real call.
// First import: throws on an inherited herdr/child scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { git } from "./helpers/effort-integration.ts";
import { land } from "./helpers/effort-merger.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, forceTerminate, prepareSpawnEffort, runDir, sendToRun, spawnRun, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { buildOnChainCallback } from "../src/tools.ts";
import { dispatchHerdrSettlement, readoptHerdrRun } from "../src/run-pipeline.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { effortOwner, openEffort } from "../src/effort/open.ts";
import { adoptEffort, effortDir, readEffort, releaseClaim } from "../src/effort/store.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { holdsSlot } from "../src/effort/admit.ts";
import { DEFAULT_CONFIG, emptyUsage, isSettled, type Persona, type Run } from "../src/types.ts";
import type { HerdrTransport } from "../src/runtime.ts";

sandboxPi();
assert.equal(process.env.HERDR_SOCKET_PATH, undefined, "no herdr routing may reach this file");
assert.equal(process.env.HERDR_ENV, undefined, "no herdr routing may reach this file");

const shimDir = tmpDir("m7r-herdr-shim-"), shimCalls = join(shimDir, "calls.log"), shim = join(shimDir, "herdr");
writeFileSync(shim, `#!/bin/sh\necho "$*" >> '${shimCalls}'\nexit 97\n`, { mode: 0o755 });
/** Explicit per-spawn routing to a never-listening private socket and the refusing shim; process env stays unset. */
const herdrEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(shimDir, "never.sock"), HERDR_PANE_ID: "fake-parent", HERDR_WORKSPACE_ID: "workspace", CONDUCTOR_HERDR_BIN: shim, PATH: process.env.PATH };
const fakes = new Map<string, ReturnType<typeof herdrFixture>>();
/** A test may let runs it cannot name in advance (chain successors) get their own fake on first launch. */
let autoFake: ((run: Run) => ReturnType<typeof herdrFixture> | undefined) | undefined;
const realLaunch = HerdrRuntime.prototype.launch;
mock.method(HerdrRuntime.prototype, "launch", function (this: HerdrRuntime, run: Run, ...rest: unknown[]) {
  const h = fakes.get(run.id) ?? autoFake?.(run);
  if (!h) throw new Error(`no fake herdr for ${run.id}; refusing a real launch`);
  fakes.set(run.id, h);
  return (realLaunch as (...a: unknown[]) => unknown).call(h.runtime, run, ...rest);
});
after(() => assert.equal(existsSync(shimCalls), false, "0 real herdr CLI calls"));

const common = { description: "test", inheritContext: "filtered" as const, inheritSkills: false, defaultReads: [], timeoutMinutes: 1, source: "builtin" as const, sourcePath: "/fake" };
const critic: Persona = { ...common, name: "critic", systemPrompt: "Review only.", worktree: true, readOnly: true, excludeTools: ["edit", "write"] };
const finalizer: Persona = { ...common, name: "finalizer", systemPrompt: "Judge completeness.", worktree: false, readOnly: true, excludeTools: ["edit", "write"] };
const parentMessages = [{ role: "user" as const, content: "prior context", timestamp: 0 }];
const VERDICT = "## Verdict: complete\n\n## Completion checklist\n- [✓] Requested outcome satisfied — reviewed the pinned tip.";
const REVIEW = "Reviewed the integrated tip; nothing blocking found after reading every changed file.";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function poll(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`not reached: ${what}`); await delay(10); }
}
const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; signalCode: null; kill(): boolean; unref(): void };
/** Only pi launches (PI_BIN) are doubled; git, hooks and verify run for real against the private repo. */
function fakePi(t: test.TestContext) {
  const real = cp.spawn; const procs: FakeProc[] = [];
  t.mock.method(cp, "spawn", ((command: string, args?: unknown, options?: cp.SpawnOptions) => {
    if (!Array.isArray(args) || args[0] !== process.env.PI_BIN) return (real as (...a: unknown[]) => cp.ChildProcess)(command, args, options);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null,
      unref() {}, kill() { queueMicrotask(() => proc.emit("close", 143)); return true; } }) as FakeProc;
    procs.push(proc); return proc;
  }) as never);
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return procs;
}
function finishProc(proc: FakeProc, text: string) {
  proc.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } }) + "\n");
  proc.emit("close", 0);
}

/** A private repo and HOME per test; the main checkout must end byte-identical. */
function repo(t: test.TestContext) {
  process.env.HOME = tmpDir("m7r-home-");
  const root = tmpDir("m7r-repo-"); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  mkdirSync(join(root, "pkg")); writeFileSync(join(root, "pkg", "file"), "base\n");
  writeFileSync(join(root, ".gitignore"), ".worktrees/\n*.ignored\n.pi/\n");
  git(root, "add", "pkg", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), index = readFileSync(join(root, ".git", "index"));
  const record = openEffort(root, "probe", "owner", { verify: "true" });
  const landed = land(root, record.intRef, { "pkg/landed": "landed\n" });
  const f = { root, base, record, landed, registry: new RunRegistry(), procs: fakePi(t), cards: [] as string[], chains: [] as string[],
    view: (run: Run) => join(root, ".worktrees", "conductor-view", run.id), tip: () => git(root, "rev-parse", record.intRef),
    hookConfig: (command: string, extra: Record<string, unknown> = {}) => {
      mkdirSync(join(root, "pkg", ".pi"), { recursive: true });
      writeFileSync(join(root, "pkg", ".pi", "conductor.json"), JSON.stringify({ personaOverrides: { critic: { onCompleteHook: command, ...extra }, finalizer: { onCompleteHook: command, ...extra } } }));
    } };
  t.after(() => {
    for (const run of f.registry.list()) {
      clearTimeout(run.timeoutTimer);
      if (run.runtime !== "herdr" && !isSettled(run.status)) forceTerminate(run, "killed", f.registry);
    }
    assert.equal(git(root, "rev-parse", "HEAD"), base, "main HEAD unchanged");
    assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "main index bytes unchanged");
    assert.equal(readFileSync(join(root, "pkg", "file"), "utf8"), "base\n");
    assert.equal(git(root, "status", "--porcelain"), "", "main checkout files unchanged");
  });
  return f;
}
type Fixture = ReturnType<typeof repo>;
let seq = 0;
/** Through spawnRun on either runtime; a herdr reader gets its own fake CLI, which completes on its own in "healthy" mode. */
function launch(f: Fixture, runtime: "subprocess" | "herdr", persona: Persona, extra: Partial<SpawnOptions> = {}, fake: { mode?: string; text?: string } = {}) {
  const id = `${persona.name}-m7r${++seq}`, text = fake.text ?? REVIEW, at = f.procs.length;
  const h = runtime === "herdr" ? herdrFixture(fake.mode ?? "healthy", { id, dir: runDir(id), cwd: f.root, target: () => f.registry.get(id), finalText: text }) : undefined;
  if (h) fakes.set(id, h);
  const { run, done } = spawnRun({ registry: f.registry, preAllocatedId: id, persona, task: "Review the effort tip.", mode: "background", cwd: join(f.root, "pkg"), timeoutMs: 20000,
    parentSessionId: "owner", effort: "probe", parentMessages, runtime, ...(h ? { runtimeEnv: herdrEnv } : {}),
    onComplete: r => { f.cards.push(`${r.id}:${r.status}`); }, onChain: r => { f.chains.push(r.id); }, ...extra } as SpawnOptions);
  return { run, done, h, finish: () => { if (!h) finishProc(f.procs[at]!, text); } };
}
const transport = (run: Run) => run.transport as HerdrTransport;
const paneCloses = (h: ReturnType<typeof herdrFixture>) => h.calls.filter(c => c === "pane close").length;
const takeOver = (f: Fixture) => {
  const before = readEffort(f.root, "probe")!;
  releaseClaim(join(effortDir(f.root, "probe"), "effort.lock"), before.owner);
  return adoptEffort(before, effortOwner("successor"));
};

test("M7 readers admit herdr and explicit hooks; touches and a foreign owner still refuse before effects", t => {
  const f = repo(t);
  assert.doesNotThrow(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "owner", runtime: "herdr" } as never));
  assert.doesNotThrow(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "owner", onCompleteHook: "true" } as never));
  assert.throws(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "owner", touches: ["pkg/**"] } as never), /readers take no touches/);
  assert.throws(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "intruder" } as never), /owned by another|generation|owner/);
  assert.deepEqual(readEffort(f.root, "probe")!.members, []);
});

for (const runtime of ["subprocess", "herdr"] as const) for (const hook of ["configured", "explicit", "disabled"] as const) {
  test(`M7 ${runtime} reader, ${hook} hook: ordinary precedence, run in the mapped view after exit; evidence, removal, no integration`, { timeout: 20000 }, async t => {
    const f = repo(t), marker = join(tmpDir("m7r-marker-"), "hook");
    f.hookConfig(`printf 'configured %s\\n' "$(pwd)" >> '${marker}'`);
    const extra = hook === "explicit" ? { onCompleteHook: `printf 'explicit %s\\n' "$(pwd)" >> '${marker}'` } : hook === "disabled" ? { onCompleteHook: "" } : {};
    const r = launch(f, runtime, critic, extra);
    r.finish(); await r.done;
    const run = r.run, view = f.view(run);
    assert.equal(run.status, "completed", run.errorMessage);
    assert.equal(run.runtime, runtime); assert.equal(run.effort?.role, "reader"); assert.equal(run.effort?.cwd, join(view, "pkg"));
    if (hook === "disabled") {
      assert.equal(existsSync(marker), false, "the explicit disable sentinel wins over configuration");
      assert.equal(run.hookResult, undefined); assert.equal(run.effort?.gate, null, "a known no-hook gate is persisted");
    } else {
      assert.deepEqual(lines(marker), [`${hook} ${join(view, "pkg")}`], "exactly the winning hook ran once, in the view");
      assert.equal(run.hookResult?.passed, true); assert.match(run.effort?.gate?.command ?? "", new RegExp(`^printf '${hook}`));
    }
    assert.equal(run.effort?.reviewed, f.landed, "a passed or known-absent hook and a clean pinned view prove the review");
    assert.equal(existsSync(view), false); assert.equal(run.worktreePath, undefined);
    assert.equal(run.integration, undefined); assert.equal(run.mergeResult, undefined); assert.equal(run.landedCommit, undefined);
    assert.equal(f.tip(), f.landed);
    assert.deepEqual(f.cards, [`${run.id}:completed`]); assert.deepEqual(f.chains, [run.id]);
    assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).effort.gate ?? null, run.effort?.gate ?? null);
    if (r.h) {
      assert.equal(paneCloses(r.h), 1, "the proven-empty owned pane closes before the view goes");
      assert.equal(run.herdr?.settlement?.delivery, "attempted", "the nonce-fenced ordinary ledger, not writer integration");
      assert.equal(run.processOpen, undefined, "the reservation ends with the proven exit");
    }
  });
}

test("M7 herdr finalizer: the proven exit precedes the hook, the hook precedes evidence; the verdict pins the viewed OID", { timeout: 20000 }, async t => {
  const f = repo(t), marker = join(tmpDir("m7r-marker-"), "hook");
  const effortJson = join(effortDir(f.root, "probe"), "effort.json");
  f.hookConfig(`if grep -q '"finalizer"' '${effortJson}'; then exit 3; fi; printf '%s\\n' "$(pwd)" >> '${marker}'`);
  const r = launch(f, "herdr", finalizer, {}, { mode: "running", text: VERDICT });
  const run = r.run, h = r.h!;
  await transport(run).ready;
  const moved = land(f.root, f.record.intRef, { "pkg/during": "during\n" });
  let sleeps = 0;
  h.onSleep(() => { sleeps++; assert.equal(existsSync(marker), false, "no hook before the child's exit is proven"); h.exit(); });
  h.emit({ type: "agent_settled" }); transport(run).drain();
  await r.done;
  assert.ok(sleeps > 0, "settlement waited for the exit proof");
  assert.equal(run.status, "completed", run.errorMessage);
  assert.deepEqual(lines(marker), [join(f.view(run), "pkg")]);
  const evidence = readEffort(f.root, "probe")!.finalizer!;
  assert.deepEqual({ runId: evidence.runId, tip: evidence.tip, verdict: evidence.verdict }, { runId: run.id, tip: f.landed, verdict: "complete" });
  assert.notEqual(moved, f.landed); assert.equal(f.tip(), moved, "the tip moved during review: the verdict is for the viewed OID only");
  assert.equal(existsSync(f.view(run)), false); assert.equal(paneCloses(h), 1); assert.deepEqual(f.cards, [`${run.id}:completed`]);
});

for (const [runtime, kind] of [["subprocess", "fail"], ["subprocess", "timeout"], ["herdr", "fail"]] as const) {
  test(`M7 ${runtime} finalizer hook ${kind}: no review, verdict or chain; diagnostics and hook output retained`, { timeout: 20000 }, async t => {
    const f = repo(t);
    if (kind === "fail") f.hookConfig("echo 'hook diagnostic' >&2; echo out > hook-out.txt; exit 4");
    else f.hookConfig("sleep 5", { onCompleteHookTimeoutSeconds: 1 });
    const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
    r.finish(); await r.done;
    const run = r.run, view = f.view(run);
    assert.equal(run.status, "hook_failed", run.errorMessage);
    assert.equal(run.hookResult?.passed, false); assert.ok(run.hookResult?.logPath && existsSync(run.hookResult.logPath), "hook log retained");
    assert.equal(run.effort?.reviewed, undefined); assert.equal(run.effort?.verdict, undefined);
    assert.equal(readEffort(f.root, "probe")!.finalizer, undefined); assert.deepEqual(f.chains, []);
    assert.equal(run.integration, undefined);
    if (kind === "fail") {
      assert.match(run.hookResult?.tailText ?? "", /hook diagnostic/);
      assert.equal(readFileSync(join(view, "pkg", "hook-out.txt"), "utf8"), "out\n", "hook output preserved in the kept view");
      assert.match(run.worktreeKept ?? "", /reader view kept \(changes, untracked or ignored files\)/);
    } else {
      assert.equal(run.hookResult?.failureKind, "timeout");
      assert.equal(existsSync(view), false, "a still-clean view after a failed hook holds nothing to lose");
    }
    if (r.h) assert.equal(paneCloses(r.h), 0, "a dirty view is never released");
  });
}

const HOOK_MUTATIONS: [string, string, RegExp, boolean][] = [
  ["tracked edit", "echo edited > file", /changes, untracked or ignored files/, false],
  ["untracked file", "echo notes > notes.md", /changes, untracked or ignored files/, true],
  ["ignored file", "echo cache > out.ignored", /changes, untracked or ignored files/, true],
  ["HEAD move", "git checkout -q --detach HEAD~1", /not detached at|HEAD moved/, true],
  ["branch checkout", "git switch -q -c hook-branch", /not detached at/, false],
  ["hidden index flag", "git update-index --skip-worktree file && echo hidden > file", /unsafe index flags/, false],
];
for (const [name, command, reason, onHerdr] of HOOK_MUTATIONS) for (const runtime of onHerdr ? ["subprocess", "herdr"] as const : ["subprocess"] as const) {
  test(`M7 ${runtime} reader whose passing hook leaves a ${name}: no proof, view kept untouched, nothing reset or released`, { timeout: 20000 }, async t => {
    const f = repo(t);
    f.hookConfig(command);
    const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
    r.finish(); await r.done;
    const run = r.run, view = f.view(run);
    assert.equal(run.status, "completed", run.errorMessage); assert.equal(run.hookResult?.passed, true);
    assert.equal(run.effort?.reviewed, undefined); assert.equal(readEffort(f.root, "probe")!.finalizer, undefined);
    assert.deepEqual(f.chains, [], "an unproven review chains nothing");
    assert.equal(existsSync(view), true); assert.equal(run.worktreePath, view);
    assert.match(run.worktreeKept ?? "", new RegExp(`reader view kept \\((?:${reason.source})`));
    if (name === "HEAD move") assert.equal(git(view, "rev-parse", "HEAD"), f.base, "no reset after the hook moved HEAD");
    if (name === "ignored file") assert.equal(readFileSync(join(view, "pkg", "out.ignored"), "utf8"), "cache\n");
    if (r.h) assert.equal(paneCloses(r.h), 0);
    assert.equal(run.integration, undefined); assert.equal(f.tip(), f.landed);
  });
}

test("M7 herdr reader with an unconfirmed exit: no hook, evidence or release; the view and its N3 reservation stay", { timeout: 20000 }, async t => {
  const f = repo(t), marker = join(tmpDir("m7r-marker-"), "hook");
  f.hookConfig(`touch '${marker}'`);
  const r = launch(f, "herdr", finalizer, {}, { mode: "running", text: VERDICT });
  const run = r.run, h = r.h!;
  await transport(run).ready;
  h.unknown(); h.emit({ type: "agent_settled" }); transport(run).drain();
  await r.done;
  assert.equal(run.status, "failed"); assert.equal(run.herdrExitUnconfirmed, true);
  assert.equal(existsSync(marker), false, "no hook without a proven exit");
  assert.equal(run.effort?.reviewed, undefined); assert.equal(readEffort(f.root, "probe")!.finalizer, undefined);
  assert.equal(existsSync(f.view(run)), true); assert.equal(paneCloses(h), 0);
  assert.equal(run.processOpen, true, "the slot stays reserved until the exit is proven"); assert.equal(holdsSlot(run), true);
  assert.deepEqual(f.chains, []);
});

test("M7 subprocess reader killed while its hook runs: nothing recorded, view kept", { timeout: 20000 }, async t => {
  const f = repo(t), fixture = tmpDir("m7r-hook-"), started = join(fixture, "started"), release = join(fixture, "release");
  f.hookConfig(`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`);
  const r = launch(f, "subprocess", finalizer, {}, { text: VERDICT });
  r.finish();
  await poll(() => existsSync(started), "hook started");
  forceTerminate(r.run, "killed", f.registry); writeFileSync(release, "go");
  await r.done;
  assert.equal(r.run.status, "killed");
  assert.equal(r.run.effort?.reviewed, undefined); assert.equal(readEffort(f.root, "probe")!.finalizer, undefined);
  assert.equal(existsSync(f.view(r.run)), true); assert.match(r.run.worktreeKept ?? "", /reader view kept \(terminated \(killed\)/);
  assert.deepEqual(f.chains, []);
});

for (const race of ["busy", "replaced", "registry", "record", "owner"] as const) {
  test(`M7 herdr reader view release refuses a ${race} race during the pane proof; the view stays`, { timeout: 20000 }, async t => {
    const f = repo(t);
    const r = launch(f, "herdr", finalizer, {}, { text: VERDICT });
    const run = r.run, h = r.h!, json = h.cli.json.bind(h.cli);
    let raced = false;
    h.cli.json = async (args, limits) => {
      if (!raced && args[0] === "pane" && args[1] === "get" && run.effort?.reviewed) {
        raced = true;
        if (race === "busy") h.pane.agent = "manual";
        if (race === "replaced") h.pane.terminal_id = "another-terminal";
        if (race === "registry") f.registry.register({ ...run });
        if (race === "record") { const saved = JSON.parse(readFileSync(run.recordPath, "utf8")); saved.herdr.launchNonce = "another-invocation"; writeFileSync(run.recordPath, JSON.stringify(saved)); }
        if (race === "owner") takeOver(f);
      }
      return json(args, limits);
    };
    if (race === "busy" || race === "replaced" || race === "record") await r.done;
    else { await poll(() => raced, "release raced"); await delay(400); }
    const view = f.view(run);
    assert.equal(existsSync(view), true, "the view is never removed without the proofs"); assert.equal(git(view, "rev-parse", "HEAD"), f.landed);
    assert.equal(raced, true, "the release went through the pane proof");
    assert.equal(run.effort?.reviewed, f.landed, "review evidence decided before the release stays valid");
    if (race === "owner") assert.equal(paneCloses(h), 1, "an empty owned pane may close; the view waits for the current owner");
    else assert.equal(paneCloses(h), 0);
    if (race === "registry" || race === "owner") {
      assert.deepEqual(f.cards, [], "a stale invocation or owner publishes no card");
      assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "running", "no stale terminal record");
    } else {
      assert.deepEqual(f.cards, [`${run.id}:completed`], "the herdr owner claim, not record contents, authorizes publication");
      // A changed durable record means another writer touched this run: the release stops without mutating it further.
      if (race !== "record") assert.match(run.worktreeKept ?? "", /reader view kept \(pane release unproven\)/);
    }
  });
}

for (const runtime of ["subprocess", "herdr"] as const) for (const event of ["owner", "reload"] as const) {
  test(`M7 ${runtime} reader: ${event === "owner" ? "an effort owner change" : "a reload"} during the hook leaves the old pipeline without evidence or cleanup`, { timeout: 20000 }, async t => {
    const f = repo(t), fixture = tmpDir("m7r-hook-"), started = join(fixture, "started"), release = join(fixture, "release");
    f.hookConfig(`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`);
    const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
    const run = r.run;
    r.finish();
    await poll(() => existsSync(started), "hook started");
    if (event === "owner") takeOver(f);
    else { run.herdrPipeline?.suspend(); run.integrationSuspended = true; }
    writeFileSync(release, "go");
    if (runtime === "subprocess") await r.done; else await delay(500);
    assert.equal(run.effort?.reviewed, undefined); assert.equal(run.effort?.verdict, undefined);
    assert.equal(readEffort(f.root, "probe")!.finalizer, undefined, "no evidence under a changed owner or a shut-down pipeline");
    assert.equal(existsSync(f.view(run)), true); assert.deepEqual(f.chains, []);
    if (runtime === "herdr") { assert.equal(paneCloses(r.h!), 0); assert.deepEqual(f.cards, []); assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "running"); }
    else if (event === "owner") { assert.deepEqual(f.cards, [], "no card for a stale owner"); assert.match(run.worktreeKept ?? "", /reader view kept \(effort owner changed\)/); }
    else assert.match(run.worktreeKept ?? "", /reader view kept \(owner runtime shut down\)/);
  });
}

test("M7 herdr blocked reader keeps its view and question; a header mismatch or a failed acceptance changes nothing; the answer keeps the frozen policy", { timeout: 30000 }, async t => {
  const f = repo(t), marker = join(tmpDir("m7r-marker-"), "hook");
  f.hookConfig(`printf '%s\\n' "$(pwd)" >> '${marker}'`);
  const r = launch(f, "herdr", critic, {}, { mode: "ask" });
  const run = r.run, h = r.h!;
  h.onSleep(h.exit);
  await r.done;
  h.onSleep(() => {});
  assert.equal(run.status, "blocked", run.errorMessage); assert.equal(run.pendingAsk?.question, "Choose?");
  assert.equal(existsSync(f.view(run)), true); assert.equal(run.effort?.reviewed, undefined); assert.equal(existsSync(marker), false);
  assert.deepEqual(f.cards, [`${run.id}:blocked`]); assert.equal(run.herdr?.settlement?.delivery, "attempted");
  const ask = { ...run.pendingAsk! }, prompt = run.systemPrompt, excluded = run.excludeTools;
  const session = run.sessionPath!, original = readFileSync(session, "utf8"), [header, ...rest] = original.split("\n");
  writeFileSync(session, [JSON.stringify({ ...JSON.parse(header!), cwd: f.root }), ...rest].join("\n"));
  const record = readFileSync(run.recordPath), calls = h.calls.length;
  const elsewhere = sendToRun(run, "Answer", { registry: f.registry, timeoutMs: 20000, sessionId: "owner" });
  assert.equal(elsewhere.kind, "rejected"); if (elsewhere.kind === "rejected") assert.match(elsewhere.reason, /session header cwd/);
  assert.equal(h.calls.length, calls); assert.deepEqual(readFileSync(run.recordPath), record); assert.deepEqual(run.pendingAsk, ask); assert.equal(run.status, "blocked");
  writeFileSync(session, original);
  h.setMode("busy-ack");
  const refused = sendToRun(run, "Answer", { registry: f.registry, timeoutMs: 20000, sessionId: "owner" });
  assert.equal(refused.kind, "started"); if (refused.kind !== "started") return;
  await refused.done;
  assert.equal(run.status, "blocked"); assert.deepEqual(run.pendingAsk, ask); assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).pendingAsk, ask);
  assert.equal(existsSync(f.view(run)), true); assert.equal(existsSync(marker), false);
  h.setMode("healthy");
  const override: Persona = { ...critic, readOnly: false, systemPrompt: "An overriding writable body.", excludeTools: [] };
  const answered = sendToRun(run, "Yes", { registry: f.registry, timeoutMs: 20000, sessionId: "owner", persona: override });
  assert.equal(answered.kind, "started"); if (answered.kind !== "started") return;
  await answered.done;
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(run.effort?.role, "reader"); assert.equal(run.systemPrompt, prompt); assert.deepEqual(run.excludeTools, excluded);
  const prompts = readdirSync(dirname(run.recordPath)).filter(x => x.startsWith("system-prompt-"));
  assert.ok(prompts.length >= 2 && prompts.every(x => readFileSync(join(dirname(run.recordPath), x), "utf8") === prompt), "every launch used the frozen prompt");
  assert.deepEqual(lines(marker), [join(f.view(run), "pkg")], "the hook ran once, in the view, on the completed answer");
  assert.equal(run.effort?.reviewed, f.landed); assert.equal(existsSync(f.view(run)), false); assert.equal(paneCloses(h), 1);
});

test("M7 herdr blocked reader under a changed effort owner: no card, the question and view stay", { timeout: 20000 }, async t => {
  const f = repo(t);
  const r = launch(f, "herdr", critic, {}, { mode: "ask" });
  const h = r.h!;
  let taken = false;
  h.onSleep(() => { if (!taken) { taken = true; takeOver(f); } h.exit(); });
  await poll(() => r.run.status === "blocked", "blocked in memory"); await delay(300);
  assert.equal(r.run.pendingAsk?.question, "Choose?", "the question is retained"); assert.equal(existsSync(f.view(r.run)), true);
  assert.deepEqual(f.cards, [], "a stale owner dispatches no blocked card"); assert.equal(r.run.herdr?.settlement, undefined, "no ledger intent under a stale owner");
});

test("M7 subprocess blocked reader under a changed effort owner: no card, the question and view stay", { timeout: 20000 }, async t => {
  const f = repo(t);
  const r = launch(f, "subprocess", critic);
  const proc = f.procs.at(-1)!, line = (event: unknown) => proc.stdout.write(JSON.stringify(event) + "\n");
  takeOver(f);
  line({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: "ask-1" }] } });
  line({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_owner", args: { question: "Which file?" } });
  line({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_owner", isError: false, result: { terminate: true, details: { askId: "ask-1", question: "Which file?", evidence: "" } } });
  line({ type: "agent_settled" });
  await r.done;
  assert.equal(r.run.status, "blocked"); assert.equal(r.run.pendingAsk?.question, "Which file?", "the question is retained");
  assert.equal(existsSync(f.view(r.run)), true); assert.deepEqual(f.cards, [], "a stale owner dispatches no blocked card");
});

test("M7 a chained read-only successor of a herdr reader runs on herdr in its own view, inside the effort", { timeout: 30000 }, async t => {
  const f = repo(t);
  autoFake = run => run.persona === "finalizer" ? herdrFixture("healthy", { id: run.id, dir: dirname(run.recordPath), cwd: f.root, target: () => f.registry.get(run.id), finalText: VERDICT }) : undefined;
  t.after(() => { autoFake = undefined; });
  const queue = new SpawnQueue(f.registry, 4, 1);
  const onChain = buildOnChainCallback({ runtimeEnv: herdrEnv, chainEnabled: true, personaName: "critic", cfg: { ...DEFAULT_CONFIG, chains: { critic: { then: "finalizer" } } },
    queue, registry: f.registry, cwd: join(f.root, "pkg"), pushNotification: c => { f.cards.push(`${c.id}:${c.status}`); }, getParentMessages: () => parentMessages, getSessionId: () => "owner" })!;
  const r = launch(f, "herdr", critic, { onChain });
  await r.done;
  assert.equal(r.run.effort?.reviewed, f.landed);
  await poll(() => f.registry.list().some(x => x.persona === "finalizer" && isSettled(x.status)), "chained finalizer settled");
  const successor = f.registry.list().find(x => x.persona === "finalizer")!;
  assert.equal(successor.status, "completed", successor.errorMessage);
  assert.equal(successor.runtime, "herdr", "the selected herdr backend, never a silent subprocess downgrade");
  assert.equal(successor.effort?.role, "reader"); assert.equal(successor.effort?.name, "probe"); assert.equal(successor.effort?.spawnBase, f.landed);
  assert.match(successor.task, new RegExp(`reviewed the effort tip ${f.landed}`));
  assert.equal(readEffort(f.root, "probe")!.finalizer?.runId, successor.id);
  assert.equal(existsSync(f.view(successor)), false); assert.equal(paneCloses(fakes.get(successor.id)!), 1);
});

test("M7 a readopted herdr reader waits for effort recovery, keeps the same object and settles once without evidence", { timeout: 30000 }, async t => {
  const f = repo(t);
  const r = launch(f, "herdr", finalizer, {}, { mode: "running", text: VERDICT });
  await transport(r.run).ready;
  await handleSessionShutdown({ reason: "reload" }, { runs: f.registry.list(), resetSanitizer() {} });
  const saved = JSON.parse(readFileSync(r.run.recordPath, "utf8"));
  f.registry = new RunRegistry();
  // Before any stream is attached: an unattached non-integrating herdr reader is skipped, never converted into a lost reader.
  await (await recoverEffort(readEffort(f.root, "probe")!, { registry: f.registry, sessionId: "owner" })).done;
  assert.equal(f.registry.get(r.run.id), undefined); assert.equal(JSON.parse(readFileSync(r.run.recordPath, "utf8")).status, "running");
  const { run } = readoptHerdrRun(saved, { registry: f.registry, runtime: r.h!.runtime, sessionId: "owner", onComplete: c => { f.cards.push(`${c.id}:${c.status}`); } });
  await transport(run).ready;
  r.h!.exit(); r.h!.emit({ type: "agent_settled" }); transport(run).drain();
  await delay(300);
  assert.equal(run.status, "running", "stream ownership is not effort authority: settlement waits"); assert.deepEqual(f.cards, []);
  const recover = async () => { const result = await recoverEffort(readEffort(f.root, "probe")!, { registry: f.registry, sessionId: "owner", onComplete: c => { f.cards.push(`${c.id}:${c.status}`); } }); await result.done; };
  await recover();
  assert.equal(f.registry.get(run.id), run, "the attached object, never a rebuilt lost reader");
  await poll(() => f.cards.length === 1, "one settlement card");
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(run.effort?.reviewed, undefined); assert.equal(readEffort(f.root, "probe")!.finalizer, undefined, "a recovered reader cannot create a verdict");
  assert.equal(existsSync(f.view(run)), true); assert.match(run.worktreeKept ?? "", /reader view kept \(recovered settlement/);
  assert.equal(run.herdr?.settlement?.delivery, "attempted");
  await recover(); await delay(100);
  assert.deepEqual(f.cards, [`${run.id}:completed`], "repeated recovery dispatches nothing more");
});

test("M7 herdr reader settlement uses the ordinary nonce ledger; writers and integrations stay refused; a stale owner dispatches nothing", { timeout: 20000 }, async t => {
  const f = repo(t), record = readEffort(f.root, "probe")!;
  const reader = (id: string, settlement?: { launchNonce: string; delivery: "intent" | "attempted" | "uncertain" }): Run => {
    const dir = runDir(id); mkdirSync(dir, { recursive: true });
    return { id, runtime: "herdr", persona: "finalizer", task: "t", mode: "background", status: "completed", startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), cwd: f.root,
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      parentSessionId: "owner", parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
      effort: { owner: record.owner, name: "probe", gitRoot: f.root, role: "reader", spawnBase: f.landed },
      herdr: { runId: id, launchNonce: "n1", ...(settlement ? { settlement } : {}) } as Run["herdr"] };
  };
  let calls = 0;
  const interrupted = reader("finalizer-intent", { launchNonce: "n1", delivery: "intent" });
  await dispatchHerdrSettlement(interrupted, () => { calls++; });
  assert.equal(calls, 0); assert.equal(interrupted.herdr?.settlement?.delivery, "uncertain"); assert.match(interrupted.errorMessage ?? "", /delivery uncertain/);
  const rebuilt = { ...interrupted, herdrDelivery: undefined, herdr: JSON.parse(readFileSync(interrupted.recordPath, "utf8")).herdr };
  await dispatchHerdrSettlement(rebuilt, () => { calls++; });
  assert.equal(calls, 0, "a repeated recovery never replays an uncertain intent");
  const fresh = reader("finalizer-fresh");
  await dispatchHerdrSettlement(fresh, () => { calls++; }); await dispatchHerdrSettlement(fresh, () => { calls++; });
  assert.equal(calls, 1); assert.equal(fresh.herdr?.settlement?.delivery, "attempted");
  assert.throws(() => dispatchHerdrSettlement({ ...reader("builder-w"), effort: { ...fresh.effort!, role: "writer" } }, () => { calls++; }), /ordinary herdr settlement required/);
  assert.throws(() => dispatchHerdrSettlement({ ...reader("finalizer-int"), integration: { state: "queued" } as Run["integration"] }, () => { calls++; }), /ordinary herdr settlement required/);
  const stale = reader("finalizer-stale");
  takeOver(f);
  await assert.rejects(dispatchHerdrSettlement(stale, () => { calls++; }), /owned by another|generation|fenced/);
  assert.equal(calls, 1); assert.equal(stale.herdr?.settlement, undefined);
});
