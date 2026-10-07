// M7: effort readers in detached views, owned chain/retry forwarding, an OID-pinned finalizer verdict.
// First import: throws on an inherited herdr/child scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { git } from "./helpers/effort-integration.ts";
import { land } from "./helpers/effort-merger.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, applyChainIfPresent, applyRetryIfNeeded, availableActions, forceTerminate, prepareSpawnEffort, sendToRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { effortOwner, openEffort } from "../src/effort/open.ts";
import { adoptEffort, effortDir, readEffort, releaseClaim } from "../src/effort/store.ts";
import { admitEffortWriter } from "../src/effort/admit.ts";
import { parseFinalizerVerdict } from "../src/effort/reader.ts";
import { recoverEffort, requeueEffortRun, resolveEffortRun } from "../src/effort/reconcile.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { buildOnChainCallback, buildOnRetryCallback, registerTools } from "../src/tools.ts";
import { formatCompletionNotification } from "../src/notifications.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { DEFAULT_CONFIG, emptyUsage, isSettled, type Persona, type Run } from "../src/types.ts";

sandboxPi();
assert.equal(process.env.HERDR_SOCKET_PATH, undefined, "no herdr routing may reach this file");
assert.equal(process.env.HERDR_ENV, undefined, "no herdr routing may reach this file");

const common = { description: "test", inheritContext: "filtered" as const, inheritSkills: false, defaultReads: [], timeoutMinutes: 1, source: "builtin" as const, sourcePath: "/fake" };
const builder: Persona = { ...common, name: "builder", systemPrompt: "Write and commit.", worktree: true, readOnly: false };
// The persona flag `worktree: true` must never give a reader a writer worktree.
const critic: Persona = { ...common, name: "critic", systemPrompt: "Review only.", worktree: true, readOnly: true, excludeTools: ["edit", "write"] };
const finalizer: Persona = { ...common, name: "finalizer", systemPrompt: "Judge completeness.", worktree: false, readOnly: true, excludeTools: ["edit", "write"] };
const parentMessages = [{ role: "user" as const, content: "prior context", timestamp: 0 }];
const VERDICT = "## Verdict: complete\n\n## Completion checklist\n- [✓] Requested outcome satisfied — reviewed the tip.";

type FakeProc = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; signalCode: null; kill(): boolean; unref(): void };
/** Only pi launches (PI_BIN) are doubled; git, hooks and verify run for real against the private repo. */
function fakePi(t: test.TestContext) {
  const real = cp.spawn; const procs: FakeProc[] = []; const launches: { args: string[]; cwd: string }[] = [];
  t.mock.method(cp, "spawn", ((command: string, args?: unknown, options?: cp.SpawnOptions) => {
    if (!Array.isArray(args) || args[0] !== process.env.PI_BIN) return (real as (...a: unknown[]) => cp.ChildProcess)(command, args, options);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, signalCode: null,
      unref() {}, kill() { queueMicrotask(() => proc.emit("close", 143)); return true; } }) as FakeProc;
    procs.push(proc); launches.push({ args: args as string[], cwd: String(options?.cwd) });
    return proc;
  }) as never);
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { procs, launches };
}
const emit = (proc: FakeProc, event: unknown) => proc.stdout.write(JSON.stringify(event) + "\n");
function finish(proc: FakeProc, text = "Reviewed the integrated tip; nothing blocking found after reading every changed file.", code = 0) {
  emit(proc, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
  proc.emit("close", code);
}
function fail(proc: FakeProc, stderr: string) { proc.stderr.write(stderr); proc.emit("close", 1); }
function ask(proc: FakeProc, question: string) {
  const details = { askId: "ask-1", question, evidence: "" };
  emit(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: "ask-1" }] } });
  emit(proc, { type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_owner", args: { question } });
  emit(proc, { type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_owner", isError: false, result: { terminate: true, details } });
  emit(proc, { type: "agent_settled" });
}
const settledRun = (registry: RunRegistry, run: Run) => new Promise<Run>(resolve => {
  if (isSettled(run.status)) return resolve(run);
  const off = registry.onChange(r => { if (r === run && isSettled(r.status)) { off(); resolve(r); } });
});
async function poll(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`not reached: ${what}`); await new Promise(r => setTimeout(r, 10)); }
}

/** A private repo with a landed commit on the effort ref; the main checkout must end byte-identical. */
function fixture(t: test.TestContext, opts: { policy?: Record<string, unknown>; maxConcurrent?: number } = {}) {
  const root = tmpDir("m7-readers-"); git(root, "init", "-b", "main");
  git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  mkdirSync(join(root, "pkg")); writeFileSync(join(root, "pkg", "file"), "base\n");
  writeFileSync(join(root, ".gitignore"), ".worktrees/\n*.ignored\n.pi/\n");
  git(root, "add", "pkg", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), index = readFileSync(join(root, ".git", "index"));
  const record = openEffort(root, "probe", "owner", { verify: "true", ...opts.policy });
  const landed = land(root, record.intRef, { "pkg/landed": "landed\n" });
  const registry = new RunRegistry(); const queue = new SpawnQueue(registry, opts.maxConcurrent ?? 4, 1);
  const branches = () => git(root, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(b => !b.endsWith("/probe"));
  const initialBranches = branches();
  t.after(() => {
    // A failed assertion must not leave a fake child holding its (persona-length) timeout timer.
    for (const run of registry.list()) if (!isSettled(run.status)) forceTerminate(run, "killed", registry);
    assert.equal(git(root, "rev-parse", "HEAD"), base, "main HEAD unchanged");
    assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "main index bytes unchanged");
    assert.equal(readFileSync(join(root, "pkg", "file"), "utf8"), "base\n");
    assert.equal(git(root, "status", "--porcelain"), "", "main checkout files unchanged");
  });
  const view = (run: Run) => join(root, ".worktrees", "conductor-view", run.id);
  return { root, base, record, landed, registry, queue, branches, initialBranches, view, tip: () => git(root, "rev-parse", record.intRef) };
}
type Fixture = ReturnType<typeof fixture>;
function reader(f: Fixture, persona: Persona = critic, extra: Record<string, unknown> = {}) {
  return f.queue.enqueueOrSpawn({ registry: f.registry, cwd: join(f.root, "pkg"), persona, task: "Review the effort tip.", mode: "background", timeoutMs: 10000,
    parentSessionId: "owner", effort: "probe", parentMessages, worktree: persona.worktree, mergeStrategy: "squash", ...extra } as never);
}
function spawned(result: ReturnType<SpawnQueue["enqueueOrSpawn"]>): Run {
  assert.equal(result.kind, "spawned"); if (result.kind !== "spawned") throw new Error("queued");
  return result.run;
}
/** A real effort writer: its fake pi commits in the isolated worktree, then integration runs for real. */
async function integrateWriter(f: Fixture, procs: FakeProc[], files: Record<string, string>, extra: Record<string, unknown> = {}): Promise<Run> {
  const before = procs.length;
  const run = spawned(f.queue.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona: { ...builder, inheritContext: "none" }, task: `write ${Object.keys(files).join(",")}`, mode: "background", timeoutMs: 10000,
    parentSessionId: "owner", effort: "probe", touches: Object.keys(files), worktree: true, mergeStrategy: "squash", ...extra } as never));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(run.worktreePath!, path), text);
  git(run.worktreePath!, "add", "--", ...Object.keys(files)); git(run.worktreePath!, "commit", "-m", `work ${run.id}`);
  finish(procs[before]!, "Implemented and committed the assigned change after verifying it.");
  await settledRun(f.registry, run);
  assert.equal(run.status, "completed", run.errorMessage); assert.ok(run.landedCommit);
  return run;
}
function tools(f: Fixture) {
  const map = new Map<string, any>();
  registerTools({ registerTool: (t: any) => map.set(t.name, t) } as any, { getCwd: () => f.root, getRegistry: () => f.registry, getQueue: () => f.queue, getSessionId: () => "owner",
    getParentMessages: () => parentMessages, pushCompletionNotification: () => {}, openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }) } as any, {});
  return map;
}

test("M7 a reader views the CURRENT tip in a detached .worktrees/conductor-view checkout; the main checkout and branches stay untouched", { timeout: 20000 }, async t => {
  const f = fixture(t); const { procs, launches } = fakePi(t);
  const run = spawned(reader(f));
  const view = f.view(run);
  assert.equal(run.effort?.role, "reader");
  assert.equal(run.effort?.spawnBase, f.landed, "frozen at the tip at launch");
  assert.equal(run.worktreePath, view); assert.equal(run.worktreeBranch, undefined, "a view is never a branch");
  assert.equal(git(view, "rev-parse", "HEAD"), f.landed);
  assert.equal(git(view, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
  assert.equal(readFileSync(join(view, "pkg", "landed"), "utf8"), "landed\n", "the view contains the landed commit");
  assert.equal(existsSync(join(f.root, ".worktrees", "conductor-wt", run.id)), false, "the persona's worktree flag creates no writer worktree");
  assert.deepEqual(f.branches(), f.initialBranches, "a reader creates no branch");
  assert.equal(run.effort?.cwd, join(view, "pkg"), "repo-subdirectory mapping into the view");
  assert.equal(launches[0]!.cwd, join(view, "pkg"));
  assert.equal(JSON.parse(readFileSync(run.sessionPath!, "utf8").split("\n")[0]!).cwd, join(view, "pkg"), "seeded session header names the view cwd");
  const prompt = launches[0]!.args.at(-1)!;
  assert.match(prompt, new RegExp(`detached.*view.*${f.landed}`, "s"), "the child is told the exact commit it views");
  assert.equal(run.mode, "background");
  finish(procs[0]!); await settledRun(f.registry, run);
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(run.integration, undefined, "a reader never enters integration");
  assert.equal(run.mergeResult, undefined, "a reader never legacy-merges");
  assert.equal(run.landedCommit, undefined);
  assert.equal(run.effort?.reviewed, f.landed, "a clean view at spawnBase proves what was reviewed");
  assert.equal(existsSync(view), false, "a clean view is removed");
  assert.equal(run.worktreePath, undefined);
  assert.equal(git(f.root, "worktree", "list", "--porcelain").includes(view), false);
  assert.equal(f.tip(), f.landed, "a reader never moves the integration tip");
  assert.equal(existsSync(join(f.root, ".worktrees", "conductor-cand")), false, "no candidate checkout");
  assert.deepEqual(f.branches(), f.initialBranches);
  assert.equal(readEffort(f.root, "probe")!.queue?.length ?? 0, 0, "readers never enter the integration queue");
  assert.match(formatCompletionNotification(run), /probe: reader at [0-9a-f]{12}, integrates nothing/);
  await run.recordWrite;
  assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).effort, run.effort, "role and frozen view facts are durable");
});

test("M7 a configured on_complete hook never runs for a reader, on its first invocation or after an answer", { timeout: 20000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const marker = join(tmpDir("m7-hook-marker-"), "ran");
  // Project config for the requested cwd (gitignored .pi/): the writer gate a reader must never run.
  mkdirSync(join(f.root, "pkg", ".pi"), { recursive: true });
  writeFileSync(join(f.root, "pkg", ".pi", "conductor.json"), JSON.stringify({ personaOverrides: { critic: { onCompleteHook: `echo ran >> '${marker}'` } } }));
  const first = spawned(reader(f));
  finish(procs[0]!); await settledRun(f.registry, first);
  assert.equal(first.status, "completed", first.errorMessage); assert.equal(first.hookResult, undefined); assert.equal(first.effort?.gate, undefined);
  const asked = spawned(reader(f));
  ask(procs[1]!, "Which file?"); await poll(() => asked.status === "blocked", "blocked");
  assert.equal(sendToRun(asked, "pkg/landed", { registry: f.registry, timeoutMs: 5000, sessionId: "owner", persona: critic }).kind, "started");
  emit(procs[2]!, { type: "agent_start" }); finish(procs[2]!); await settledRun(f.registry, asked);
  assert.equal(asked.status, "completed", asked.errorMessage); assert.equal(asked.hookResult, undefined);
  assert.equal(existsSync(marker), false, "no reader ran the configured hook");
});

test("M7 a queued reader resolves the NEW tip at dequeue; its placeholder already carries the reader role", { timeout: 20000 }, async t => {
  const f = fixture(t, { maxConcurrent: 1 }); const { procs } = fakePi(t);
  const blocker: Run = { id: "other-busy", persona: "scribe", task: "t", mode: "background", status: "running", cwd: f.root, startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), recordPath: "/unused", transcriptPath: "/unused", finalPath: "/unused" };
  f.registry.register(blocker);
  const queued = reader(f);
  assert.equal(queued.kind, "queued"); if (queued.kind !== "queued") return;
  const placeholder = queued.placeholderRun;
  assert.equal(placeholder.effort?.role, "reader"); assert.equal(placeholder.effort?.spawnBase, undefined); assert.equal(placeholder.worktreePath, undefined);
  assert.equal(existsSync(join(f.root, ".worktrees", "conductor-view", placeholder.id)), false, "no view before the actual launch");
  const next = land(f.root, f.record.intRef, { "pkg/next": "next\n" });
  blocker.status = "completed"; f.registry.notify(blocker);
  const run = f.registry.get(placeholder.id)!;
  assert.equal(run.status, "running");
  assert.equal(run.effort?.spawnBase, next, "the dequeued reader views the tip at its launch, not at request time");
  assert.equal(git(f.view(run), "rev-parse", "HEAD"), next);
  assert.equal(readFileSync(join(f.view(run), "pkg", "next"), "utf8"), "next\n");
  finish(procs[0]!); await settledRun(f.registry, run);
  assert.equal(run.effort?.reviewed, next);
});

test("M7 admission: a reader holds no footprint and no maxParallel charge; the general cap still applies, including an N3 closing reservation", { timeout: 20000 }, async t => {
  const f = fixture(t, { policy: { maxParallel: 1 } }); const { procs } = fakePi(t);
  // A running writer with the universal footprint holds the effort's only maxParallel slot.
  const w = spawned(f.queue.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona: { ...builder, inheritContext: "none" }, task: "w", mode: "background", timeoutMs: 10000, parentSessionId: "owner", effort: "probe", worktree: true } as never));
  const r = reader(f);
  assert.equal(r.kind, "spawned", "a reader is not charged maxParallel or a footprint");
  const limits = { maxConcurrent: 3, maxConcurrentWriteCapable: 1 };
  const record = readEffort(f.root, "probe")!;
  const writerCandidate = { persona: "custom-writer", effort: { owner: record.owner, name: "probe", gitRoot: f.root, role: "writer" as const, touches: ["other/**"] } };
  const readerCandidate = { persona: "critic", effort: { owner: record.owner, name: "probe", gitRoot: f.root, role: "reader" as const } };
  const others = f.registry.list().filter(x => x.id !== w.id);
  const withoutW = { ...record, members: record.members.filter(id => id !== w.id) };
  assert.equal(admitEffortWriter(writerCandidate, others, limits, withoutW, [withoutW]), undefined, "a running reader neither charges maxParallel nor reserves paths");
  assert.match(admitEffortWriter(writerCandidate, f.registry.list(), limits, record, [record]) ?? "", /maxParallel/, "positive control: the writer still charges maxParallel");
  const closing: Run = { ...(r.kind === "spawned" ? r.run : w), id: "critic-closing", status: "completed", processOpen: true };
  assert.match(admitEffortWriter(readerCandidate, [closing], { maxConcurrent: 1, maxConcurrentWriteCapable: 1 }, record, [record]) ?? "", /maxConcurrent \(1\)/, "a settled reader whose process is closing keeps its slot");
  assert.equal(admitEffortWriter(readerCandidate, [{ ...closing, processOpen: undefined }], { maxConcurrent: 1, maxConcurrentWriteCapable: 1 }, record, [record]), undefined);
  const capped = new SpawnQueue(f.registry, 2, 1);
  const third = capped.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona: critic, task: "third", mode: "background", timeoutMs: 10000, parentSessionId: "owner", effort: "probe" } as never);
  assert.equal(third.kind, "queued"); if (third.kind === "queued") { assert.match(third.placeholderRun.waitReason ?? "", /maxConcurrent \(2\)/); capped.removeQueued(third.pending.id); }
  for (const proc of procs) finish(proc);
  await Promise.all(f.registry.list().filter(x => x.status === "running").map(x => settledRun(f.registry, x)));
});

test("M7 reader refusals happen before any effect: touches, herdr runtime, an explicit on_complete hook, a foreign owner", { timeout: 20000 }, async t => {
  const f = fixture(t);
  const members = () => readEffort(f.root, "probe")!.members;
  const views = () => existsSync(join(f.root, ".worktrees", "conductor-view"));
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ touches: ["pkg/**"] }, /readers? .*touches|touches.*reader/i],
    [{ runtime: "herdr" }, /reader.*subprocess/i],
    [{ onCompleteHook: "touch marker" }, /reader.*hook/i],
    [{ parentSessionId: "intruder" }, /owned by another|generation|owner/i],
  ];
  // A private, never-contacted socket path: the refusal precedes any herdr effect.
  const fakeHerdr = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(tmpDir("m7-no-herdr-"), "absent.sock"), HERDR_PANE_ID: "fake-pane" };
  for (const [extra, refusal] of cases) {
    assert.throws(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "owner", ...extra } as never), refusal);
    assert.throws(() => reader(f, critic, extra.runtime ? { ...extra, runtimeEnv: fakeHerdr } : extra), refusal);
  }
  assert.deepEqual(members(), []); assert.equal(f.registry.list().length, 0); assert.equal(views(), false);
  assert.doesNotThrow(() => prepareSpawnEffort({ persona: critic, cwd: f.root, effort: "probe", parentSessionId: "owner", onCompleteHook: "" } as never), "the explicit disable sentinel is not a hook");
});

const MUTATIONS: [string, (view: string, f: Fixture) => void, RegExp][] = [
  ["tracked edit", view => writeFileSync(join(view, "pkg", "file"), "edited\n"), /changes|untracked|ignored/],
  ["untracked file", view => writeFileSync(join(view, "pkg", "notes.md"), "notes\n"), /changes|untracked|ignored/],
  ["ignored file", view => writeFileSync(join(view, "pkg", "out.ignored"), "cache\n"), /changes|untracked|ignored/],
  ["HEAD moved", (view, f) => git(view, "checkout", "-q", "--detach", f.base), /moved|not detached at/],
  ["hidden index flag", view => { git(view, "update-index", "--skip-worktree", "pkg/file"); writeFileSync(join(view, "pkg", "file"), "hidden\n"); }, /index flags/],
];
for (const [name, mutate, reason] of MUTATIONS) test(`M7 a reader view with a ${name} is kept with a hint: no verdict, no chain, nothing reset, merged or deleted`, { timeout: 20000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  let chains = 0;
  const run = spawned(reader(f, finalizer, { onChain: () => { chains++; } }));
  const view = f.view(run);
  mutate(view, f);
  const head = git(view, "rev-parse", "HEAD"), status = git(view, "status", "--porcelain", "--ignored", "--untracked-files=all");
  finish(procs[0]!, VERDICT); await settledRun(f.registry, run);
  assert.equal(run.status, "completed");
  assert.equal(existsSync(view), true, "never removed"); assert.equal(run.worktreePath, view);
  assert.match(run.worktreeKept ?? "", new RegExp(`reader view kept \\(.*(?:${reason.source})`));
  assert.equal(git(view, "rev-parse", "HEAD"), head, "no reset");
  assert.equal(git(view, "status", "--porcelain", "--ignored", "--untracked-files=all"), status, "nothing discarded");
  assert.equal(run.effort?.reviewed, undefined); assert.equal(run.effort?.verdict, undefined);
  assert.equal(readEffort(f.root, "probe")!.finalizer, undefined, "no finalizer evidence from an unproven view");
  assert.equal(chains, 0, "an unproven review chains nothing");
  assert.equal(run.integration, undefined); assert.equal(run.mergeResult, undefined);
  assert.deepEqual(f.branches(), f.initialBranches, "no branch created or deleted");
  assert.equal(f.tip(), f.landed);
});

test("M7 finalizer verdict parsing accepts only one leading, exact verdict heading", () => {
  for (const verdict of ["complete", "continue", "failed"] as const) {
    assert.equal(parseFinalizerVerdict(`## Verdict: ${verdict}\n\n## Completion checklist\n- ok`), verdict);
    assert.equal(parseFinalizerVerdict(`\n\n## Verdict: ${verdict}\r\nbody`), verdict);
  }
  for (const text of [
    "> ## Verdict: complete", // quoted
    "Summary first.\n## Verdict: complete", // interior
    "## Verdict: complete\n\n## Verdict: failed", // contradictory
    "## Verdict: complete\n## Verdict: complete", // repeated
    "## Verdict: complete\n```\n## Verdict: failed\n```", // fenced lookalike
    "## Verdict: complete\n  ### verdict: continue", // indented lookalike
    "## Verdict: complete!", "## Verdict: Complete", "## Verdict: complete | continue | failed", "## Verdict:complete", " ## Verdict: complete",
    "```\n## Verdict: complete\n```", "", "(no output)",
  ]) assert.equal(parseFinalizerVerdict(text), undefined, JSON.stringify(text));
});

test("M7 a live, clean finalizer records its verdict pinned to the viewed OID; a later integration makes it STALE in status", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const run = spawned(reader(f, finalizer));
  // The tip moves while the finalizer is still reviewing: its verdict holds only for what it viewed.
  const moved = land(f.root, f.record.intRef, { "pkg/during": "during\n" });
  finish(procs[0]!, VERDICT); await settledRun(f.registry, run);
  const evidence = readEffort(f.root, "probe")!.finalizer!;
  assert.ok(evidence, "verdict recorded");
  assert.equal(evidence.runId, run.id); assert.equal(evidence.verdict, "complete");
  assert.equal(evidence.tip, f.landed, "pinned to the OID the finalizer viewed, not the tip at settlement");
  assert.ok(Number.isFinite(evidence.at));
  assert.equal(run.effort?.verdict, "complete"); assert.equal(run.effort?.reviewed, f.landed);
  const effort = tools(f).get("ensemble_effort");
  const stale = await effort.execute("s", { action: "status", effort: "probe" });
  assert.equal(stale.details.tip, moved);
  assert.equal(stale.details.finalizer.stale, true);
  assert.match(stale.content[0].text, new RegExp(`complete at ${f.landed} is STALE: the tip is now ${moved}`));
  // A fresh finalizer at the new tip is current until another integration lands.
  const second = spawned(reader(f, finalizer));
  finish(procs[1]!, VERDICT.replace("complete", "continue")); await settledRun(f.registry, second);
  const current = await effort.execute("s", { action: "status", effort: "probe" });
  assert.equal(current.details.finalizer.runId, second.id); assert.equal(current.details.finalizer.stale, false);
  assert.match(current.content[0].text, new RegExp(`continue at the current tip ${moved}`));
  const later = await integrateWriter(f, procs, { "pkg/later": "later\n" });
  const after = await effort.execute("s", { action: "status", effort: "probe" });
  assert.equal(after.details.tip, later.landedCommit);
  assert.equal(after.details.finalizer.stale, true, "a later integration never leaves the verdict looking ready");
  assert.doesNotMatch(after.content[0].text, /land_ready|ready to land/i, "M7 grants no landing capability");
});

test("M7 no finalizer evidence from a non-finalizer, a failed or malformed finalizer, or a changed effort owner", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const nonFinalizer = spawned(reader(f, critic));
  finish(procs[0]!, VERDICT); await settledRun(f.registry, nonFinalizer);
  assert.equal(nonFinalizer.effort?.reviewed, f.landed, "positive control: the view was clean");
  const failed = spawned(reader(f, finalizer));
  finish(procs[1]!, VERDICT, 1); await settledRun(f.registry, failed);
  assert.equal(failed.status, "failed");
  const malformed = spawned(reader(f, finalizer));
  finish(procs[2]!, `${VERDICT}\n\n> ## Verdict: failed`); await settledRun(f.registry, malformed);
  assert.equal(malformed.status, "completed"); assert.equal(malformed.effort?.reviewed, f.landed);
  assert.equal(readEffort(f.root, "probe")!.finalizer, undefined);
  assert.match(formatCompletionNotification(malformed), /finalizer verdict NOT recorded/);
  // The effort changes owner while the finalizer runs: its evidence must not land under the successor.
  const fenced = spawned(reader(f, finalizer));
  const before = readEffort(f.root, "probe")!;
  releaseClaim(join(effortDir(f.root, "probe"), "effort.lock"), before.owner);
  const successor = adoptEffort(before, effortOwner("successor"));
  finish(procs[3]!, VERDICT); await settledRun(f.registry, fenced);
  const after = readEffort(f.root, "probe")!;
  assert.deepEqual(after.owner, successor.owner); assert.equal(after.finalizer, undefined, "no mark under a changed owner");
  assert.equal(fenced.effort?.verdict, undefined);
  assert.equal(existsSync(f.view(fenced)), true, "an unowned view is kept, never removed");
  // Shutdown (quit or /reload) suspends this pipeline's effort authority before its child settles.
  const f2 = fixture(t); const suspended = spawned(reader(f2, finalizer));
  suspended.integrationSuspended = true;
  finish(procs[4]!, VERDICT); await settledRun(f2.registry, suspended);
  assert.equal(readEffort(f2.root, "probe")!.finalizer, undefined); assert.equal(suspended.effort?.reviewed, undefined);
  assert.match(suspended.worktreeKept ?? "", /reader view kept \(owner runtime shut down\)/); assert.equal(existsSync(f2.view(suspended)), true);
});

test("M7 chain: an effort writer chains a critic only after its accepted integration, with the effort template and a view at the landed tip", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs, launches } = fakePi(t);
  const cfg = { ...DEFAULT_CONFIG, worktreeMode: "conductor" as const };
  const onChain = buildOnChainCallback({ chainEnabled: true, personaName: "builder", cfg, queue: f.queue, registry: f.registry, cwd: f.root, pushNotification: () => {}, getParentMessages: () => [], getSessionId: () => "owner" });
  const w = await integrateWriter(f, procs, { "pkg/feature": "feature\n" }, { onChain });
  await poll(() => f.registry.list().some(r => r.persona === "critic"), "chained critic");
  const c = f.registry.list().find(r => r.persona === "critic")!;
  assert.equal(c.effort?.name, "probe"); assert.equal(c.effort?.role, "reader", "the builtin read-only critic joins as a reader");
  assert.equal(c.effort?.spawnBase, w.landedCommit); assert.equal(git(f.view(c), "rev-parse", "HEAD"), w.landedCommit);
  assert.equal(readFileSync(join(f.view(c), "pkg", "feature"), "utf8"), "feature\n");
  assert.match(c.task, new RegExp(`effort probe`)); assert.match(c.task, new RegExp(`integrated into the effort tip as ${w.landedCommit}`));
  assert.match(c.task, new RegExp(`git show ${w.landedCommit}`));
  assert.match(launches.at(-1)!.args.at(-1)!, new RegExp(`view.*${w.landedCommit}`, "s"));
  finish(procs.at(-1)!); await settledRun(f.registry, c);
  assert.equal(f.registry.list().filter(r => r.persona === "critic").length, 1, "chain fired once");
});

test("M7 chain: a successor that launches after the tip moved is labelled honestly; uncertain, recovered or unproven sources chain nothing", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs, launches } = fakePi(t);
  const blocker: Run = { id: "other-busy", persona: "scribe", task: "t", mode: "background", status: "running", cwd: f.root, startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), recordPath: "/unused", transcriptPath: "/unused", finalPath: "/unused" };
  const cfg = { ...DEFAULT_CONFIG, worktreeMode: "conductor" as const };
  const capped = new SpawnQueue(f.registry, 1, 1);
  const onChain = buildOnChainCallback({ chainEnabled: true, personaName: "builder", cfg, queue: capped, registry: f.registry, cwd: f.root, pushNotification: () => {}, getParentMessages: () => [], getSessionId: () => "owner" });
  const w = spawned(capped.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona: { ...builder, inheritContext: "none" }, task: "write pkg/a", mode: "background", timeoutMs: 10000,
    parentSessionId: "owner", effort: "probe", touches: ["pkg/a"], worktree: true, onChain } as never));
  // The only slot is taken by unrelated work once the writer is running: its chained critic must queue.
  f.registry.register(blocker);
  writeFileSync(join(w.worktreePath!, "pkg", "a"), "a\n"); git(w.worktreePath!, "add", "pkg/a"); git(w.worktreePath!, "commit", "-m", "a");
  finish(procs[0]!, "Implemented and committed pkg/a after verifying it."); await settledRun(f.registry, w);
  assert.equal(w.status, "completed", w.errorMessage);
  await poll(() => f.registry.list().some(r => r.persona === "critic"), "queued critic");
  const queued = f.registry.list().find(r => r.persona === "critic")!;
  assert.equal(queued.status, "queued", "the blocker keeps the critic queued");
  const later = land(f.root, f.record.intRef, { "pkg/b": "b\n" });
  blocker.status = "completed"; f.registry.notify(blocker);
  // The dequeued launch registers a new Run object under the placeholder's id.
  await poll(() => f.registry.get(queued.id)?.status === "running", "critic launched");
  const launched = f.registry.get(queued.id)!;
  assert.equal(launched.effort?.spawnBase, later, "the successor views the tip at its own launch");
  assert.match(launched.task, new RegExp(`integrated into the effort tip as ${w.landedCommit}`), "the task names the source's landed commit");
  assert.match(launched.task, new RegExp(`if that is not ${w.landedCommit}, later integrations landed after it`), "and says honestly that the view may be later");
  assert.match(launches.at(-1)!.args.at(-1)!, new RegExp(`view.*${later}`, "s"), "the workspace notes name the actual view commit");
  finish(procs.at(-1)!); await settledRun(f.registry, launched);

  // Pure gate: only a live writer inside its own first dispatch with a landed commit, or a live reader with a proven review.
  let calls = 0; const chain = () => { calls++; };
  const writer = (patch: Partial<Run> = {}): Run => ({ ...w, reconciledAtStartup: undefined, integration: { ...w.integration!, delivery: "intent" }, ...patch });
  applyChainIfPresent(writer(), "completed", chain); assert.equal(calls, 1, "positive control");
  for (const delivery of ["uncertain", "attempted", undefined] as const) applyChainIfPresent(writer({ integration: { ...w.integration!, delivery } }), "completed", chain);
  applyChainIfPresent(writer({ reconciledAtStartup: true }), "completed", chain);
  applyChainIfPresent(writer({ mergeResult: { success: false, reason: "conflict" } }), "completed", chain);
  applyChainIfPresent(writer({ landedCommit: undefined, mergeResult: { success: true, nothingToCommit: true } }), "completed", chain);
  const r = launched;
  applyChainIfPresent({ ...r, reconciledAtStartup: undefined }, "completed", chain); assert.equal(calls, 2, "positive control: proven reader review");
  applyChainIfPresent({ ...r, effort: { ...r.effort!, reviewed: undefined } }, "completed", chain);
  applyChainIfPresent({ ...r, reconciledAtStartup: true }, "completed", chain);
  applyChainIfPresent({ ...r, effort: { ...r.effort!, reviewed: f.base } }, "completed", chain);
  assert.equal(calls, 2, "uncertain/attempted/missing delivery, recovered, failed, no-op and unproven sources chain nothing");
});

test("M7 chain from a reader: the successor gets the reader template (nothing integrated, the reviewed OID) and its own view; ownership errors never fall back", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const cfg = { ...DEFAULT_CONFIG, worktreeMode: "conductor" as const, chains: { critic: { then: "finalizer" } } };
  const cards: Run[] = [];
  const onChain = buildOnChainCallback({ chainEnabled: true, personaName: "critic", cfg, queue: f.queue, registry: f.registry, cwd: join(f.root, "pkg"), pushNotification: r => cards.push(r), getParentMessages: () => [], getSessionId: () => "owner" });
  const c = spawned(reader(f, critic, { onChain }));
  finish(procs[0]!); await settledRun(f.registry, c);
  await poll(() => f.registry.list().some(r => r.persona === "finalizer"), "chained finalizer");
  const fin = f.registry.list().find(r => r.persona === "finalizer")!;
  assert.equal(fin.effort?.role, "reader"); assert.equal(fin.effort?.spawnBase, f.landed);
  assert.match(fin.task, /integrated nothing \(landed commit: none\)/);
  assert.match(fin.task, new RegExp(`reviewed the effort tip ${f.landed}`));
  assert.doesNotMatch(fin.task, /integrated into the effort tip as/, "a reader is never presented as integrated");
  finish(procs[1]!, VERDICT); await settledRun(f.registry, fin);
  // The owner changes before a chain from a later reader: the successor is refused, never spawned outside the effort.
  const late = spawned(reader(f, critic, { onChain }));
  const before = readEffort(f.root, "probe")!;
  releaseClaim(join(effortDir(f.root, "probe"), "effort.lock"), before.owner);
  adoptEffort(before, effortOwner("successor"));
  late.effort!.reviewed = late.effort!.spawnBase; // a proven review that the chain gate would accept
  const count = f.registry.list().length;
  await onChain!(late);
  const added = f.registry.list().slice(count);
  assert.equal(added.length, 1); assert.equal(added[0]!.status, "failed");
  assert.equal(added[0]!.effort, undefined); assert.match(added[0]!.errorMessage ?? "", /chain: finalizer not started after .*: .*(owner|generation)/);
  assert.equal(procs.length, 3, "no successor process started");
  finish(procs[2]!); await settledRun(f.registry, late);
  assert.equal(f.registry.list().filter(r => r.persona === "finalizer" && r.effort).length, 1, "never a successor outside the effort");
});

test("M7 the integration driver itself refuses a reader, even one forged into integrating", { timeout: 10000 }, t => {
  const f = fixture(t);
  const record = readEffort(f.root, "probe")!;
  const forged: Run = { id: "critic-forged", persona: "critic", task: "t", mode: "background", status: "integrating", startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), cwd: f.root,
    recordPath: join(tmpDir("m7-forged-"), "record.json"), transcriptPath: "/unused", finalPath: "/unused", parentSessionId: "owner", parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
    effort: { owner: record.owner, name: "probe", gitRoot: f.root, role: "reader", spawnBase: f.landed },
    integration: { state: "queued", branchHead: f.landed, enqueuedAt: 0, attempts: 0, verifyIdentity: { command: "true", timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: record.policy.verifyRetries } } };
  f.registry.register(forged);
  assert.throws(() => f.registry.integrations.enqueue(forged, () => {}), /only observed hook-passed writer completions/);
  assert.equal(f.tip(), f.landed); assert.deepEqual(readEffort(f.root, "probe")!.queue ?? [], []);
  forged.status = "killed";
});

test("M7 effort retry gate: ordinary retryable failures only; never integration failures, merge_conflict, integrating, resolving, hook_failed or permission", () => {
  const cwd = tmpDir("m7-retry-gate-");
  const policy = { maxAttempts: 3, retryableClasses: ["environment", "stall", "timeout", "test", "logic", "permission", "unknown"] as const };
  const run = (patch: Partial<Run>): Run => ({ id: "builder-x", persona: "builder", task: "t", mode: "background", status: "failed", startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), cwd, recordPath: join(cwd, "r"), transcriptPath: join(cwd, "t"), finalPath: join(cwd, "f"),
    effort: { name: "probe", gitRoot: cwd, role: "writer" }, failureClass: "environment", retryPolicy: { ...policy, retryableClasses: [...policy.retryableClasses] }, retryAttempt: 0, ...patch });
  let n = 0; const retry = () => { n++; };
  assert.equal(applyRetryIfNeeded(run({}), retry), true, "positive control");
  assert.equal(applyRetryIfNeeded(run({ status: "timeout", failureClass: "timeout" }), retry), true);
  assert.equal(applyRetryIfNeeded(run({ effort: { name: "probe", gitRoot: cwd, role: "reader" } }), retry), true, "readers retry ordinary failures too");
  for (const patch of [
    { status: "merge_conflict" as const, failureClass: "logic" as const },
    { status: "integrating" as const },
    { status: "hook_failed" as const, failureClass: "test" as const },
    { failureClass: "permission" as const },
    { integration: { state: "resolving", branchHead: "x", enqueuedAt: 0, attempts: 0, verifyIdentity: { command: "", timeoutSeconds: 1, retries: 0 } } as Run["integration"] },
    { status: "killed" as const, integration: { state: "cancelled", branchHead: "x", enqueuedAt: 0, attempts: 0, verifyIdentity: { command: "", timeoutSeconds: 1, retries: 0 } } as Run["integration"] },
    { reconciledAtStartup: true },
    { mergerFor: { writerId: "w", runId: "m", nonce: "n", effort: "probe", gitRoot: cwd, owner: { sessionId: "s", pid: 1, startTime: 1 } } },
  ]) assert.equal(applyRetryIfNeeded(run(patch), retry), false, JSON.stringify(patch));
  assert.equal(n, 3);
});

test("M7 a failed writer retries inside its effort from the CURRENT tip with the same touches, past its own preserved reservation", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const cfg = { ...DEFAULT_CONFIG, worktreeMode: "conductor" as const };
  const persona = { ...builder, inheritContext: "none" as const };
  const onRetry = buildOnRetryCallback({ originalTask: "write pkg/x", persona, cfg, queue: f.queue, cwd: f.root, retryMaxAttempts: 2, pushNotification: () => {}, getParentMessages: () => [], getSessionId: () => "owner" });
  const first = spawned(f.queue.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona, task: "write pkg/x", mode: "background", timeoutMs: 10000, parentSessionId: "owner",
    effort: "probe", touches: ["pkg/x"], worktree: true, mergeStrategy: "squash", retryMaxAttempts: 2, onRetry } as never));
  const moved = land(f.root, f.record.intRef, { "pkg/moved": "moved\n" });
  fail(procs[0]!, "fetch failed: ECONNREFUSED 127.0.0.1:443\n"); await settledRun(f.registry, first);
  assert.equal(first.status, "failed"); assert.equal(first.failureClass, "environment");
  await poll(() => f.registry.list().some(r => r.retryAttempt === 1), "retry spawned");
  const retry = f.registry.list().find(r => r.retryAttempt === 1)!;
  assert.equal(retry.status, "running", retry.waitReason ?? retry.errorMessage);
  assert.equal(retry.effort?.name, "probe"); assert.equal(retry.effort?.role, "writer");
  assert.deepEqual(retry.effort?.touches, ["pkg/x"]); assert.deepEqual(retry.effort?.retryOf, [first.id]);
  assert.equal(retry.effort?.spawnBase, moved, "from the current tip, not the failed branch");
  assert.equal(git(retry.worktreePath!, "rev-parse", "HEAD"), moved);
  assert.ok(first.worktreeBranch && git(f.root, "rev-parse", first.worktreeBranch), "the failed attempt's branch is preserved");
  // Another writer still waits on the preserved, unresolved failed attempt.
  const record = readEffort(f.root, "probe")!;
  assert.match(admitEffortWriter({ persona: "custom-writer", effort: { owner: record.owner, name: "probe", gitRoot: f.root, role: "writer", touches: ["other/**"] } }, f.registry.list(), { maxConcurrent: 8, maxConcurrentWriteCapable: 1 }, record, [record]) ?? "", new RegExp(`waits on ${first.id}`));
  finish(procs[1]!); await settledRun(f.registry, retry);
});

test("M7 a reader retry and a reader resume keep the frozen role, view, prompt and tool policy across a persona override", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs, launches } = fakePi(t);
  const map = tools(f);
  const spawnedReader = await map.get("ensemble_spawn").execute("s", { persona: "critic", task: "review the tip", effort: "probe", retry_max_attempts: 2, chain: false });
  const first = f.registry.get(spawnedReader.details.agent_id)!;
  assert.equal(first.effort?.role, "reader");
  const prompt = first.systemPrompt, excluded = first.excludeTools;
  // A project override now makes "critic" a writer with a different body.
  mkdirSync(projectPersonasDir(f.root), { recursive: true });
  writeFileSync(join(projectPersonasDir(f.root), "critic.md"), "---\nname: critic\ndescription: override\nread_only: false\nworktree: true\n---\nYou are an overriding writable critic body long enough to parse.\n");
  const moved = land(f.root, f.record.intRef, { "pkg/moved": "moved\n" });
  fail(procs[0]!, "network error: ETIMEDOUT\n"); await settledRun(f.registry, first);
  await poll(() => f.registry.list().some(r => r.retryAttempt === 1), "reader retry");
  const retry = f.registry.list().find(r => r.retryAttempt === 1)!;
  assert.equal(retry.effort?.role, "reader", "a retry cannot escape the reader role");
  assert.equal(retry.effort?.spawnBase, moved); assert.equal(retry.worktreeBranch, undefined);
  assert.equal(retry.systemPrompt, prompt); assert.deepEqual(retry.excludeTools, excluded);
  // A6: the retry asks; the answer resumes it in the same view with its frozen policy.
  ask(procs[1]!, "Review only the latest commit?");
  await poll(() => retry.status === "blocked", "blocked reader").catch(e => { throw new Error(`${e.message}: ${retry.status} ${retry.errorMessage} ${JSON.stringify(retry.pendingAsk)} procs=${procs.length} | ${f.registry.list().map(r => `${r.id}:${r.status}:${r.retryAttempt}`).join(" ")} same=${f.registry.get(retry.id) === retry}`); });
  assert.equal(existsSync(f.view(retry)), true, "a blocked reader keeps its view");
  assert.deepEqual(availableActions(retry, false, "owner", f.registry).sort(), ["kill", "send"]);
  const foreign = sendToRun(retry, "Answer from elsewhere", { registry: f.registry, timeoutMs: 5000, sessionId: "intruder" });
  assert.equal(foreign.kind, "rejected"); if (foreign.kind === "rejected") assert.match(foreign.reason, /cannot send to effort probe/);
  assert.equal(procs.length, 2, "a foreign owner is refused before any launch"); assert.equal(retry.status, "blocked");
  const resumed = await map.get("ensemble_send").execute("s", { agent_id: retry.id, message: "Yes, the latest commit.", foreground: false });
  assert.doesNotMatch(resumed.content[0].text, /rejected|cannot/i, resumed.content[0].text);
  assert.equal(launches.at(-1)!.cwd, retry.effort!.cwd, "resumed in the frozen view cwd");
  assert.equal(retry.effort?.role, "reader"); assert.equal(retry.systemPrompt, prompt);
  assert.ok(launches.at(-1)!.args.includes("--append-system-prompt") ? launches.at(-1)!.args[launches.at(-1)!.args.indexOf("--append-system-prompt") + 1] === prompt : true);
  emit(procs[2]!, { type: "agent_start" }); finish(procs[2]!); await settledRun(f.registry, retry);
  assert.equal(retry.status, "completed", retry.errorMessage);
  assert.equal(retry.integration, undefined); assert.equal(retry.hookResult, undefined, "a reader runs no on_complete hook");
  assert.equal(existsSync(f.view(retry)), false); assert.equal(retry.effort?.reviewed, moved);
  const terminal = availableActions(retry, false, "owner", f.registry);
  assert.deepEqual(terminal, [], "a settled reader is not resumed");
  const refusal = sendToRun(retry, "again", { registry: f.registry, timeoutMs: 5000, sessionId: "owner" });
  assert.equal(refusal.kind, "rejected"); if (refusal.kind === "rejected") assert.match(refusal.reason, /fresh effort reader/);
});

test("M7 recovery: a completed reader is not converted; a lost reader is killed with its view kept; requeue and resolve refuse readers before effects", { timeout: 30000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const done = spawned(reader(f, finalizer)); finish(procs[0]!, VERDICT); await settledRun(f.registry, done); await done.recordWrite;
  const lost = spawned(reader(f, critic)); await lost.recordWrite;
  const blocked = spawned(reader(f, critic)); ask(procs[2]!, "Which file?"); await poll(() => blocked.status === "blocked", "blocked"); await blocked.recordWrite;
  const lostView = f.view(lost), blockedView = f.view(blocked);
  // A fresh registry stands in for a restarted lead; the lost reader's process is gone (no pid).
  const restored = new RunRegistry();
  const record = readEffort(f.root, "probe")!;
  const evidence = record.finalizer;
  const recovery = await recoverEffort(record, { registry: restored, sessionId: "owner" }); await recovery.done;
  const byId = (id: string) => restored.get(id)!;
  assert.equal(byId(done.id).status, "completed", "a completed reader has no integration to prove; never merge_conflict");
  assert.equal(byId(lost.id).status, "killed");
  assert.match(byId(lost.id).errorMessage ?? "", /lost reader; view .* kept/);
  assert.doesNotMatch(byId(lost.id).errorMessage ?? "", /hook|requeue/, "no original gate assumption");
  assert.equal(existsSync(lostView), true);
  assert.equal(byId(blocked.id).status, "blocked"); assert.equal(existsSync(blockedView), true);
  assert.deepEqual(readEffort(f.root, "probe")!.finalizer, evidence, "recovery never writes finalizer evidence");
  const owner = readEffort(f.root, "probe")!.owner;
  const lock = join(effortDir(f.root, "integration-driver"), "driver.lock");
  const lockBefore = existsSync(lock) ? readFileSync(lock, "utf8") : undefined;
  await assert.rejects(requeueEffortRun(byId(lost.id), { registry: restored, sessionId: "owner" }), /writer/);
  await assert.rejects(resolveEffortRun(byId(lost.id), { registry: restored, sessionId: "owner" }, async () => assert.fail("no confirmation for a reader")), /writer/);
  assert.deepEqual(readEffort(f.root, "probe")!.owner, owner, "no adoption");
  assert.equal(existsSync(lock) ? readFileSync(lock, "utf8") : undefined, lockBefore, "no driver claim");
  const inv = (await walkInventory(join(process.env.HOME!, ".pi", "agent", "conductor", "runs"), restored)).filter(e => [lost.id, blocked.id].includes(e.id));
  const plan = planReclaim(inv.map(e => ({ ...e, archived: true, archivedAt: 1 })), { ...DEFAULT_CONFIG.gc, totalSizeBudgetBytes: 1, transcriptSizeCapBytes: 1 }, Date.now() + 999 * 86400000);
  assert.ok(plan.actions.length >= 2 && plan.actions.every(a => a.kind === "keep"), "GC keeps reader assets while the effort is open");
  finish(procs[1]!); await settledRun(f.registry, lost);
});

test("M7 A3 status is truthful about role, view and tip for running, blocked and settled readers", { timeout: 20000 }, async t => {
  const f = fixture(t); const { procs } = fakePi(t);
  const run = spawned(reader(f));
  assert.deepEqual(availableActions(run, false, "owner", f.registry), ["kill"], "a running print-mode reader offers only kill");
  const status = await tools(f).get("ensemble_status").execute("s", { agent_id: run.id }, undefined, undefined, { mode: "json" });
  assert.deepEqual(status.details.running[0].effort, run.effort);
  assert.equal(status.details.running[0].effort.role, "reader"); assert.equal(status.details.running[0].effort.spawnBase, f.landed);
  assert.match(status.content[0].text, new RegExp(`effort=probe: reader at ${f.landed.slice(0, 12)}, integrates nothing; view ${f.view(run)}`));
  finish(procs[0]!); await settledRun(f.registry, run);
  const settled = await tools(f).get("ensemble_status").execute("s", { agent_id: run.id }, undefined, undefined, { mode: "json" });
  assert.match(settled.content[0].text, /reader at [0-9a-f]{12}, integrates nothing; clean review of [0-9a-f]{12}; view removed/);
  assert.doesNotMatch(settled.content[0].text, /UNINTEGRATED/, "a reader has nothing pending integration");
});
