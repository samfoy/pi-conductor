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
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { git } from "./helpers/effort-integration.ts";
import { land } from "./helpers/effort-merger.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, availableActions, forceTerminate, prepareSpawnEffort, runDir, sendToRun, spawnRun, writeFinal, writeRecord, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { buildOnChainCallback, registerTools } from "../src/tools.ts";
import { pushCompletionCard, type NotificationMessage } from "../src/notifications.ts";
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
/** R4: a stale owner's waiter must end, not watch a settled run with no process forever. */
const ended = <T>(done: Promise<T>, what = "the waiter ended") => Promise.race([done, delay(5000).then((): never => { throw new Error(`not reached: ${what}`); })]);

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; signalCode: null; kill(): boolean; unref(): void };
/** Hook commands whose shell cannot start: a synchronous spawn throw, or an `error` event from a child that never ran. */
const SPAWN_THROWS = "m7-hook-spawn-throws", SPAWN_ERRORS = "m7-hook-spawn-error-event";
/** Only pi launches (PI_BIN) and the two unstartable hooks are doubled; git, hooks and verify run for real against the private repo. */
function fakePi(t: test.TestContext) {
  const real = cp.spawn; const procs: FakeProc[] = [];
  t.mock.method(cp, "spawn", ((command: string, args?: unknown, options?: cp.SpawnOptions) => {
    if (command === SPAWN_THROWS) throw Object.assign(new Error("spawn /bin/sh EACCES"), { code: "EACCES" });
    if (command === SPAWN_ERRORS) {
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" })));
      return child;
    }
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

for (const runtime of ["subprocess", "herdr"] as const) for (const failure of ["sync", "async"] as const) {
  test(`M7 ${runtime} finalizer hook spawn_error (${failure === "sync" ? "spawn throws" : "async error event"}): hook_failed with a clean view; no review, verdict or chain`, { timeout: 20000 }, async t => {
    const f = repo(t), command = failure === "sync" ? SPAWN_THROWS : SPAWN_ERRORS;
    f.hookConfig(command);
    const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
    r.finish(); await r.done;
    const run = r.run;
    assert.equal(run.status, "hook_failed", run.errorMessage);
    assert.equal(run.hookResult?.passed, false); assert.equal(run.hookResult?.failureKind, "spawn_error"); assert.equal(run.hookResult?.command, command);
    assert.equal(run.effort?.reviewed, undefined); assert.equal(run.effort?.verdict, undefined);
    assert.equal(readEffort(f.root, "probe")!.finalizer, undefined, "a clean view does not turn a failed hook into a verdict");
    assert.deepEqual(f.chains, []); assert.deepEqual(f.cards, [`${run.id}:hook_failed`]);
    assert.equal(existsSync(f.view(run)), false, "the view was clean: nothing to keep"); assert.equal(run.integration, undefined);
    if (r.h) assert.equal(paneCloses(r.h), 1);
  });
}

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

/** Per test: the memory outcome log, so "no outcome" is observable. */
function outcomeLog(t: test.TestContext): () => number {
  const path = join(tmpDir("m7r-memory-"), "outcomes.jsonl"), before = process.env.CONDUCTOR_MEMORY_PATH;
  process.env.CONDUCTOR_MEMORY_PATH = path;
  t.after(() => { if (before === undefined) delete process.env.CONDUCTOR_MEMORY_PATH; else process.env.CONDUCTOR_MEMORY_PATH = before; });
  return () => lines(path).length;
}
/** Another writer's record for this run id: a marker, a newer status and the caller's identity change. */
function newerRecord(run: Run, change: (saved: Record<string, any>) => void): Buffer {
  const saved = JSON.parse(readFileSync(run.recordPath, "utf8"));
  saved.status = "running"; saved.marker = "newer-writer"; change(saved);
  writeFileSync(run.recordPath, JSON.stringify(saved));
  return readFileSync(run.recordPath);
}
/** R3: a live invocation whose record or registry entry changed keeps the view and a diagnostic, and publishes nothing. */
async function assertPreserved(f: Fixture, run: Run, record: Buffer, outcomes: () => number, when: "before" | "during") {
  const hint = `reader view kept \\(durable record or registry changed ${when} release\\)`;
  assert.deepEqual(f.cards, [], "no card"); assert.deepEqual(f.chains, [], "no chain"); assert.equal(outcomes(), 0, "no memory outcome");
  assert.deepEqual(readFileSync(run.recordPath), record, "the newer record's marker, nonce and status are byte-identical");
  assert.equal(existsSync(run.finalPath), false, "no final result published");
  assert.equal(existsSync(f.view(run)), true, "the view is kept"); assert.equal(git(f.view(run), "rev-parse", "HEAD"), f.landed);
  assert.match(run.worktreeKept ?? "", new RegExp(`^${hint}: ${f.view(run)}, detached at ${f.landed}`));
  assert.match(run.errorMessage ?? "", new RegExp(`settlement preserved: ${hint}`));
  assert.equal(run.status, "failed", "the waiter completed: no running run without a process");
  // Later writes honor the preservation: a plain write is dropped, a fenced one is refused, no final appears.
  await writeRecord(run); await assert.rejects(writeRecord(run, () => {}), /settlement preserved/); await writeFinal(run, true);
  assert.deepEqual(readFileSync(run.recordPath), record); assert.equal(existsSync(run.finalPath), false);
}

const HERDR_RACES = ["busy", "replaced", "registry", "record", "owner"] as const;
const SUBPROCESS_RACES = ["record", "registry", "transport"] as const;
type Race = "none" | (typeof HERDR_RACES)[number] | (typeof SUBPROCESS_RACES)[number];
/**
 * The race fires inside the release, after the review evidence was decided: herdr at its empty-pane proof,
 * a subprocess reader inside `releaseRunPane`'s current-registry lookup. A passing hook ran first.
 */
function raceRelease(t: test.TestContext, runtime: "subprocess" | "herdr", race: Race) {
  const f = repo(t), outcomes = outcomeLog(t);
  f.hookConfig("true");
  const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
  const run = r.run, h = r.h;
  const state = { raced: false, record: undefined as Buffer | undefined, effort: undefined as Buffer | undefined, transport: run.transport };
  const inject = () => {
    state.raced = true;
    if (race === "busy") h!.pane.agent = "manual";
    if (race === "replaced") h!.pane.terminal_id = "another-terminal";
    if (race === "registry") f.registry.register({ ...run });
    if (race === "owner") takeOver(f);
    if (race === "transport") { state.transport = run.transport; run.transport = { ...run.transport! }; }
    if (race === "record") state.record = newerRecord(run, saved => { if (runtime === "herdr") saved.herdr.launchNonce = "another-invocation"; else saved.effort.spawnBase = f.base; });
    else state.record = readFileSync(run.recordPath);
    state.effort = readFileSync(join(effortDir(f.root, "probe"), "effort.json"));
  };
  if (h) {
    const json = h.cli.json.bind(h.cli);
    h.cli.json = async (args, limits) => {
      if (!state.raced && race !== "none" && args[0] === "pane" && args[1] === "get" && run.effort?.reviewed) inject();
      return json(args, limits);
    };
  } else {
    const get = f.registry.get.bind(f.registry);
    f.registry.get = (id: string) => {
      if (!state.raced && race !== "none" && id === run.id && run.effort?.reviewed) inject();
      return get(id);
    };
  }
  r.finish();
  return { f, r, run, h, state, outcomes };
}

for (const runtime of ["subprocess", "herdr"] as const) {
  test(`M7 ${runtime} reader control: a normal release after a passing hook reviews, records the verdict, chains and records an outcome`, { timeout: 20000 }, async t => {
    const { f, r, run, h, outcomes } = raceRelease(t, runtime, "none");
    await r.done;
    assert.equal(run.status, "completed", run.errorMessage); assert.equal(run.hookResult?.passed, true);
    assert.equal(run.effort?.reviewed, f.landed); assert.equal(readEffort(f.root, "probe")!.finalizer?.verdict, "complete");
    assert.deepEqual(f.cards, [`${run.id}:completed`]); assert.deepEqual(f.chains, [run.id]); assert.equal(outcomes(), 1);
    assert.equal(existsSync(f.view(run)), false); assert.equal(run.worktreeKept, undefined); assert.equal(run.errorMessage, undefined);
    assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "completed");
    if (h) assert.equal(paneCloses(h), 1);
  });
}

for (const race of HERDR_RACES) {
  test(`M7 herdr reader view release refuses a ${race} race during the pane proof; the view stays`, { timeout: 20000 }, async t => {
    const { f, r, run, h: fake, state, outcomes } = raceRelease(t, "herdr", race), h = fake!;
    // A replaced registry entry keeps the H10 fence's silent retirement; a stale effort owner's waiter ends (R4).
    if (race === "registry") { await poll(() => state.raced, "release raced"); await delay(400); }
    else await ended(r.done);
    const view = f.view(run);
    assert.equal(existsSync(view), true, "the view is never removed without the proofs"); assert.equal(git(view, "rev-parse", "HEAD"), f.landed);
    assert.equal(state.raced, true, "the release went through the pane proof");
    assert.equal(run.effort?.reviewed, f.landed, "review evidence decided before the release stays valid");
    assert.deepEqual(readFileSync(join(effortDir(f.root, "probe"), "effort.json")), state.effort, "no evidence is published after the race");
    if (race === "owner") assert.equal(paneCloses(h), 1, "an empty owned pane may close; the view waits for the current owner");
    else assert.equal(paneCloses(h), 0);
    if (race === "record") await assertPreserved(f, run, state.record!, outcomes, "during");
    else if (race === "registry" || race === "owner") {
      // Herdr's registry entry is part of the invocation fence (H10): a replaced entry retires the old pipeline silently.
      assert.deepEqual(f.cards, [], "a stale invocation or owner publishes no card"); assert.deepEqual(f.chains, []); assert.equal(outcomes(), 0);
      assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "running", "no stale terminal record");
      assert.equal(existsSync(run.finalPath), false, "no final result published");
      if (race === "owner") { assert.equal(run.status, "completed"); assert.match(run.worktreeKept ?? "", /reader view kept \(effort owner changed\)/); }
    } else {
      assert.deepEqual(f.cards, [`${run.id}:completed`], "the herdr owner claim authorizes publication of an unproven pane release");
      assert.match(run.worktreeKept ?? "", /reader view kept \(pane release unproven\)/);
    }
  });
}

for (const race of SUBPROCESS_RACES) {
  test(`M7 subprocess reader view release under a ${race} race: ${race === "transport" ? "a replaced invocation retires silently" : "the current invocation preserves everything"}`, { timeout: 20000 }, async t => {
    const { f, r, run, state, outcomes } = raceRelease(t, "subprocess", race);
    t.after(() => { run.transport = state.transport; });
    await r.done;
    assert.equal(state.raced, true, "the race fired inside the release");
    assert.equal(run.effort?.reviewed, f.landed, "review evidence decided before the release stays valid");
    assert.deepEqual(readFileSync(join(effortDir(f.root, "probe"), "effort.json")), state.effort, "no evidence is published after the race");
    if (race !== "transport") return assertPreserved(f, run, state.record!, outcomes, "during");
    assert.deepEqual(f.cards, []); assert.deepEqual(f.chains, []); assert.equal(outcomes(), 0);
    assert.deepEqual(readFileSync(run.recordPath), state.record, "nothing written for the replaced invocation");
    assert.equal(existsSync(f.view(run)), true); assert.equal(run.worktreeKept, undefined, "silent: no diagnostic on the replacement's run");
    assert.equal(run.status, "running", "the replacement owns the run");
  });
}

for (const runtime of ["subprocess", "herdr"] as const) {
  test(`M7 ${runtime} reader whose durable record changes during the hook: no evidence, card, chain or outcome; the newer record and view stay`, { timeout: 20000 }, async t => {
    const f = repo(t), outcomes = outcomeLog(t), fixture = tmpDir("m7r-hook-"), started = join(fixture, "started"), release = join(fixture, "release");
    f.hookConfig(`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`);
    const r = launch(f, runtime, finalizer, {}, { text: VERDICT });
    r.finish();
    await poll(() => existsSync(started), "hook started");
    const record = newerRecord(r.run, saved => { if (runtime === "herdr") saved.herdr.launchNonce = "another-invocation"; else saved.effort.spawnBase = f.base; });
    writeFileSync(release, "go");
    await r.done;
    assert.equal(r.run.hookResult?.passed, true);
    assert.equal(r.run.effort?.reviewed, undefined, "no review evidence under the uncertain state"); assert.equal(readEffort(f.root, "probe")!.finalizer, undefined);
    await assertPreserved(f, r.run, record, outcomes, "before");
    if (r.h) assert.equal(paneCloses(r.h), 0);
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
    if (runtime === "subprocess" || event === "owner") await ended(r.done); else await delay(500);
    assert.equal(run.effort?.reviewed, undefined); assert.equal(run.effort?.verdict, undefined);
    assert.equal(readEffort(f.root, "probe")!.finalizer, undefined, "no evidence under a changed owner or a shut-down pipeline");
    assert.equal(existsSync(f.view(run)), true); assert.deepEqual(f.chains, []);
    if (runtime === "herdr") {
      assert.equal(paneCloses(r.h!), 0); assert.deepEqual(f.cards, []); assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "running");
      assert.equal(existsSync(run.finalPath), false, "no final result published");
    }
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
  await ended(r.done);
  assert.equal(r.run.status, "blocked"); assert.equal(r.run.errorMessage, "herdr settlement preserved: effort owned by another session or generation");
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

// ── R4: completion surfaces honor preservation and owner fencing ──────────────

test("M7 R4 writeRecord reads settlementPreserved when the write runs, after its last await, not when it is queued", { timeout: 10000 }, async t => {
  const dir = join(tmpDir("m7r-record-"), "run"), recordPath = join(dir, "record.json");
  const run: Run = { id: "critic-m7r-fence", persona: "critic", task: "t", mode: "background", status: "running", startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), cwd: dir,
    recordPath, transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  // Hold the write's last await (its mkdir) open: the flag is set after both writes were queued and the first one started.
  const real = fsp.mkdir.bind(fsp); let release!: () => void, entered = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fsp, "mkdir", (async (path: string, options?: unknown) => {
    if (path === dir) { entered++; await held; }
    return real(path, options as never);
  }) as never);
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const plain = writeRecord(run), fenced = writeRecord(run, () => {});
  await poll(() => entered === 1, "the first write is running, held at its last await");
  run.settlementPreserved = "reader view kept (probe)";
  release();
  await plain;
  await assert.rejects(fenced, /settlement preserved; record write refused: reader view kept \(probe\)/);
  assert.equal(entered, 2, "both writes ran");
  assert.equal(existsSync(recordPath), false, "the plain write is dropped and the fenced one refused: nothing lands");
});

test("M7 R4 completion cards: a reader's card needs its current effort owner, a kill's included; writer and non-effort cards are unchanged", { timeout: 20000 }, async t => {
  const f = repo(t), messages: NotificationMessage[] = [];
  const card = (run: Run) => pushCompletionCard(run, { sendMessage: message => { messages.push(message); } }, false, "owner", f.registry);
  const killedBefore = launch(f, "subprocess", critic, { onComplete: card }), killedAfter = launch(f, "subprocess", critic, { onComplete: card });
  const record = readEffort(f.root, "probe")!;
  const settled = (id: string, role?: "reader" | "writer"): Run => {
    const dir = runDir(id); mkdirSync(dir, { recursive: true });
    return { id, persona: role === "writer" ? "builder" : "critic", task: "t", mode: "background", status: "completed", startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), cwd: f.root,
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      parentSessionId: "owner", parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
      ...(role ? { effort: { owner: record.owner, name: "probe", gitRoot: f.root, role, ...(role === "reader" ? { spawnBase: f.landed } : {}) } } : {}) };
  };
  const reader = settled("critic-m7r-card", "reader"), writer = settled("builder-m7r-card", "writer"), plain = settled("scribe-m7r-card");
  forceTerminate(killedBefore.run, "killed", f.registry, killedBefore.run.onComplete);
  assert.equal(card(reader), true, "positive control: the current owner gets a reader card");
  takeOver(f);
  forceTerminate(killedAfter.run, "killed", f.registry, killedAfter.run.onComplete);
  assert.equal(killedAfter.run.status, "killed");
  assert.equal(card(reader), false, "a stale owner gets no reader card");
  assert.equal(card(writer), true, "a writer's card is unchanged"); assert.equal(card(plain), true, "a non-effort card is unchanged");
  assert.deepEqual(messages.map(m => (m.details as { id: string }).id), [killedBefore.run.id, reader.id, writer.id, plain.id], "the stale owner's kill and reader cards were never sent");
  await Promise.all([killedBefore.done, killedAfter.done]);
});

/** A fake subprocess child ends its turn on an owner question, as Pi's ask_owner tool does. */
function askProc(proc: FakeProc) {
  const line = (event: unknown) => proc.stdout.write(JSON.stringify(event) + "\n");
  line({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: "ask-1" }] } });
  line({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_owner", args: { question: "Choose?" } });
  line({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_owner", isError: false, result: { terminate: true, details: { askId: "ask-1", question: "Choose?", evidence: "" } } });
  line({ type: "agent_settled" });
}
/**
 * The real ensemble_spawn and ensemble_send tools. Every card goes through pushCompletionCard, as index.ts sends it.
 * `detach` resolves the foreground detach signal at once, so the post-detach listener owns a foreground card.
 */
function conductorTools(f: Fixture, runtime: "subprocess" | "herdr", opts: { detach?: boolean; queue?: SpawnQueue } = {}) {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>(), cards: NotificationMessage[] = [];
  registerTools({ registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<any> }) => { tools.set(tool.name, tool); } } as never, {
    getCwd: () => join(f.root, "pkg"), getRegistry: () => f.registry, getQueue: () => opts.queue ?? new SpawnQueue(f.registry, 4, 1), getSessionId: () => "owner",
    getParentMessages: () => parentMessages, openFocusedOverlay: () => {},
    pushCompletionNotification: (run: Run) => { pushCompletionCard(run, { sendMessage: message => { cards.push(message); } }, false, "owner", f.registry); },
    registerForegroundDetach: () => ({ detachSignal: opts.detach ? Promise.resolve() : new Promise<void>(() => {}), unregister: () => {} }),
  } as never, runtime === "herdr" ? herdrEnv : {});
  return { send: tools.get("ensemble_send")!, spawn: tools.get("ensemble_spawn")!, cards };
}
const blockingHook = (f: Fixture) => {
  const dir = tmpDir("m7r-hook-"), started = join(dir, "started"), release = join(dir, "release");
  f.hookConfig(`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`);
  return { started: () => existsSync(started), release: () => writeFileSync(release, "go") };
};
/** Settlement has run its course: a herdr pipeline reached its preserved catch, a subprocess one its dispatch. */
const settledFor = async (run: Run, status: string) => {
  await poll(() => run.status === status && (run.runtime !== "herdr" || /settlement preserved/.test(run.errorMessage ?? "")), `settled ${status}`);
  await delay(200);
};

for (const runtime of ["subprocess", "herdr"] as const) for (const race of ["record", "owner"] as const) for (const detach of [true, false]) {
  const surface = detach ? "the detached answer's post-detach listener" : "the foreground answer's own waiter";
  const outcome = race === "record" ? (detach ? "posts one failed card with no actions to the current owner" : "returns failed") : (detach ? "posts no card" : "ends with no card");
  test(`M7 R4 ${runtime} reader, ${race === "record" ? "a durable record" : "an effort owner"} change during the answer's hook: ${surface} ${outcome}`, { timeout: 20000 }, async t => {
    const f = repo(t), hook = blockingHook(f);
    const r = launch(f, runtime, critic, {}, { mode: "ask" }), run = r.run, h = r.h;
    if (h) h.onSleep(h.exit); else askProc(f.procs.at(-1)!);
    await ended(r.done);
    assert.equal(run.status, "blocked", run.errorMessage); assert.equal(hook.started(), false, "a question is not a completion: no hook");
    if (h) { h.onSleep(() => {}); h.setMode("healthy"); }
    const { send, cards } = conductorTools(f, runtime, { detach }), launched = f.procs.length;
    const answer = send.execute("answer", { agent_id: run.id, message: "Yes" }, undefined, undefined, undefined);
    if (!h) {
      await poll(() => f.procs.length > launched, "answer launched");
      const proc = f.procs.at(-1)!;
      proc.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n"); finishProc(proc, REVIEW);
    }
    if (detach) assert.match((await answer).content[0].text, /detach/i, "the foreground answer detached while running");
    await poll(hook.started, "the answer's hook started");
    const record = race === "record"
      ? newerRecord(run, saved => { if (runtime === "herdr") saved.herdr.launchNonce = "another-invocation"; else saved.effort.spawnBase = f.base; }) : undefined;
    if (race === "owner") takeOver(f);
    hook.release();
    if (detach) await settledFor(run, race === "record" ? "failed" : "completed");
    else assert.equal((await ended(answer, "the foreground answer returned")).details.status, race === "record" ? "failed" : "completed");
    assert.equal(run.effort?.reviewed, undefined); assert.deepEqual(f.chains, []);
    assert.equal(existsSync(f.view(run)), true, "the view is kept");
    if (race === "record") {
      assert.deepEqual(readFileSync(run.recordPath), record, "the newer record stays byte for byte");
      const hint = "reader view kept \\(durable record or registry changed before release\\)";
      assert.match(run.errorMessage ?? "", new RegExp(`settlement preserved: ${hint}`));
      if (!detach) return assert.deepEqual(cards, [], "the waiter is the tool result; no card");
      assert.equal(cards.length, 1, "exactly one card, from the post-detach listener");
      const details = cards[0]!.details as { kind: string; id: string; status: string; available_actions: string[]; notes: { slot: string; text: string }[] };
      assert.deepEqual([details.kind, details.id, details.status], ["completed", run.id, "failed"]);
      assert.deepEqual(details.available_actions, [], "no actions: a settled reader is never resumed");
      assert.deepEqual(availableActions(run, true, "owner", f.registry), ["focus"], "a TUI adds only the read-only focus view");
      assert.ok(details.notes.some(n => n.slot === "error" && new RegExp(`settlement preserved: ${hint}`).test(n.text)), "the card names the preservation");
      assert.ok(details.notes.some(n => n.slot === "warning" && new RegExp(`^${hint}: ${f.view(run)}`).test(n.text)), "and the kept view");
    } else {
      assert.deepEqual(cards, [], "a stale effort owner gets no card from any surface");
      assert.match(run.worktreeKept ?? "", /^reader view kept \(effort owner changed\)/);
      assert.notEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "completed", "no terminal record under the stale owner");
      if (runtime === "herdr") {
        assert.equal(run.errorMessage, "herdr settlement preserved: effort owned by another session or generation");
        assert.equal(existsSync(run.finalPath), false, "a herdr reader writes no final under a stale owner");
      } else assert.equal(existsSync(run.finalPath), true, "documented limit: a subprocess reader still writes its own final.md");
    }
  });
}

for (const runtime of ["subprocess", "herdr"] as const) {
  test(`M7 R4 ${runtime} reader from a foreground ensemble_spawn under a full cap queues as background with no downgrade listener; a stale owner gets no card`, { timeout: 20000 }, async t => {
    const f = repo(t), hook = blockingHook(f), queue = new SpawnQueue(f.registry, 1, 1);
    const blocker: Run = { id: "other-busy", persona: "scribe", task: "t", mode: "background", status: "running", cwd: f.root, startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(),
      recordPath: "/unused", transcriptPath: "/unused", finalPath: "/unused" };
    f.registry.register(blocker);
    autoFake = run => herdrFixture("healthy", { id: run.id, dir: dirname(run.recordPath), cwd: f.root, target: () => f.registry.get(run.id), finalText: REVIEW });
    t.after(() => { autoFake = undefined; });
    const { spawn, cards } = conductorTools(f, runtime, { queue }), launched = f.procs.length;
    const out = await spawn.execute("spawn", { persona: "critic", task: "Review the effort tip.", effort: "probe", foreground: true, runtime, cwd: join(f.root, "pkg") }, undefined, undefined, undefined);
    assert.equal(out.details.status, "queued", "an effort spawn is background: never queued-as-background, so no downgrade listener");
    blocker.status = "completed"; f.registry.notify(blocker);
    const run = f.registry.get(out.details.agent_id)!;
    assert.equal(run.status, "running"); assert.equal(run.mode, "background"); assert.equal(run.runtime, runtime); assert.equal(run.effort?.role, "reader");
    if (runtime === "subprocess") { await poll(() => f.procs.length > launched, "dequeued launch"); finishProc(f.procs.at(-1)!, REVIEW); }
    await poll(hook.started, "hook started");
    takeOver(f); hook.release();
    await settledFor(run, "completed");
    assert.deepEqual(cards, [], "neither settlement nor any listener posts a card to a stale effort owner");
    assert.match(run.worktreeKept ?? "", /^reader view kept \(effort owner changed\)/); assert.equal(existsSync(f.view(run)), true);
  });
}
