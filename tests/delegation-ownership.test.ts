/**
 * N4: direct ownership of delegated leaves.
 *
 * A delegating parent's own leaves are cancelled (queued ones first) and
 * proven exited before any of the parent's hook, merge, footprint,
 * integration, final.md, terminal record or card; an unconfirmed exit
 * withholds all of those and still settles the parent once. Kills cascade
 * leaves first through exact, current lineage only. A depth-2 leaf accepts
 * only kill (focus is a read-only view), the lead never gets a leaf card,
 * reconcile orphans a leaf whose parent is terminal or missing without
 * signalling it, and envelopes, status and the auto budget carry the subtree.
 *
 * Fake pi processes stand in for real ones (`cp.spawn` is mocked for PI_BIN
 * only); hooks, git, the broker, the queue and the effort driver are real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { projectPersonasDir, resolvePersonas } from "../src/personas.ts";
import {
  RunRegistry, computeAvailableActions, forceTerminate, observeRunActions, pauseRun, resumeRun, runsRoot, sendToRun, spawnRun,
  validateSendable, writeFinal,
} from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { childrenOf, delegatePaths, subtreeCost } from "../src/delegation.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { formatCompletionNotification, pushCompletionCard } from "../src/notifications.ts";
import { buildOrphanRun, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { registerTools } from "../src/tools.ts";
import { formatRow } from "../src/widget.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { ConductorEventEmitter } from "../src/conductor-events.ts";
import { openEffort } from "../src/effort/open.ts";
import { holdsSlot } from "../src/effort/admit.ts";
import { appendFileEvidence, resultRef } from "../src/file-evidence.ts";
import { emptyUsage, isTerminal, toRunRecord, type MergeStrategy, type Persona, type Run, type RunRecord } from "../src/types.ts";

sandboxPi();

// ── Fake pi processes ────────────────────────────────────────────────

/** prompt: exits on any signal; hold: ignores SIGTERM until SIGKILL; never: ignores both; stdio: exits on SIGTERM but its pipes stay open. */
type ExitMode = "prompt" | "hold" | "never" | "stdio";
interface Fake extends EventEmitter {
  pid: number; role: "parent" | "leaf"; runId: string; mode: ExitMode;
  stdout: PassThrough; stderr: PassThrough; stdin: PassThrough;
  exitCode: number | null; signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean; unref(): void;
  exit(code: number | null, signal?: NodeJS.Signals | null, close?: boolean): void;
  close(): void; line(event: unknown): void;
}
// Above Linux PID_MAX_LIMIT (2^22): no real process can ever carry one of these.
let nextPid = 2_000_000_000;

function fakePi(t: test.TestContext, modeFor: (role: "parent" | "leaf") => ExitMode = () => "prompt") {
  const procs: Fake[] = [], log: string[] = [];
  const real = cp.spawn;
  t.mock.method(cp, "spawn", (...a: any[]) => {
    if (!Array.isArray(a[1]) || a[1][0] !== process.env.PI_BIN) return (real as any)(...a);
    const env = (a[2]?.env ?? {}) as NodeJS.ProcessEnv;
    const role = env.CONDUCTOR_DEPTH === "2" ? "leaf" : "parent";
    let closed = false;
    const proc = Object.assign(new EventEmitter(), {
      pid: ++nextPid, role, runId: env.CONDUCTOR_RUN_ID!, mode: modeFor(role),
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      unref() {},
      kill(signal: NodeJS.Signals = "SIGTERM") {
        log.push(`${proc.runId} ${signal}`);
        if (proc.exitCode !== null || proc.signalCode !== null) return false;
        const m = proc.mode;
        if (m === "prompt" || m === "stdio" || (m === "hold" && signal === "SIGKILL")) setImmediate(() => proc.exit(null, signal, m !== "stdio"));
        return true;
      },
      exit(code: number | null, signal: NodeJS.Signals | null = null, close = true) {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        proc.exitCode = code; proc.signalCode = signal;
        log.push(`${proc.runId} exit`);
        proc.emit("exit", code, signal);
        if (close) proc.close();
      },
      close() {
        if (closed) return;
        closed = true;
        proc.stdout.end(); proc.stderr.end();
        proc.emit("close", proc.exitCode, proc.signalCode);
      },
      line(event: unknown) { proc.stdout.write(JSON.stringify(event) + "\n"); },
    });
    procs.push(proc as unknown as Fake);
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { procs, log, of: (run: Run) => procs.find(p => p.runId === run.id) };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;
function project(): string {
  const cwd = tmpDir("n4-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  for (const [f, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n"), "scout.md": doc("scout", "read_only: true\n"), "plain.md": doc("plain", "read_only: true\n") })) {
    writeFileSync(join(projectPersonasDir(cwd), f), text);
  }
  return cwd;
}
const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe", timeout: 10_000 }).trim();
function repo(): string {
  const cwd = project();
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "base\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n.pi/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  return cwd;
}

const tick = () => new Promise(r => setImmediate(r));
async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}
const start = (id: string, task = `N4 leaf ${id}`) => ({ type: "tool_execution_start", toolCallId: id, toolName: "delegate", args: { persona: "scout", task } });
const update = (id: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: "delegate", partialResult: { content: [] } });
const end = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "delegate", result: { content: [{ type: "text", text: "delegate aborted" }] }, isError: true });
const final = (text: string, cost = 0) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 1, output: 1, cost: { total: cost } } } });
const response = (parent: Run, id: string) => JSON.parse(readFileSync(delegatePaths(dirname(parent.recordPath), id).response, "utf8"));

class HookSpy extends ConductorEventEmitter {
  constructor(private readonly log: string[]) { super(undefined); }
  override emitHookStarted(): void { this.log.push("hook started"); }
}

/** Log each run's first terminal status, in order, into the fakes' signal/exit log. */
function transitions(registry: RunRegistry, log: string[]) {
  const seen = new Set<string>();
  registry.onChange(r => { if (isTerminal(r.status) && !seen.has(r.id)) { seen.add(r.id); log.push(`${r.id} ${r.status}`); } });
}
function before(log: string[], ...entries: string[]) {
  const at = entries.map(e => log.indexOf(e));
  assert.ok(at.every(i => i >= 0) && at.every((v, i) => i === 0 || at[i - 1]! < v), `expected order ${JSON.stringify(entries)} in ${JSON.stringify(log)}`);
}

interface DelegatorOpts { modeFor?: (role: "parent" | "leaf") => ExitMode; maxConcurrent?: number; hook?: string; cwd?: string; persona?: Persona; effort?: string; worktree?: boolean;
  timeoutMs?: number; mergeStrategy?: MergeStrategy }
async function delegator(t: test.TestContext, o: DelegatorOpts = {}) {
  const fp = fakePi(t, o.modeFor);
  const cwd = o.cwd ?? project();
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, o.maxConcurrent ?? 1, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env: {} });
  transitions(registry, fp.log);
  const cards: { run: Run; status: Run["status"]; content: string; leaves: string[] }[] = [];
  const persona = o.persona ?? (await resolvePersonas({ cwd })).personas.get("lead")!;
  const card = (r: Run) => void cards.push({ run: r, status: r.status, content: formatCompletionNotification(r, [], registry.list()), leaves: registry.list().filter(l => l.depth === 2).map(l => `${l.id} ${l.status}`) });
  const { run, done } = spawnRun({
    registry, persona, task: "N4 parent", cwd, mode: "background", timeoutMs: o.timeoutMs ?? 60_000, runtimeEnv: {}, worktree: o.worktree, mergeStrategy: o.mergeStrategy,
    effort: o.effort, parentSessionId: o.effort ? "owner" : undefined, onCompleteHook: o.hook ?? "", events: new HookSpy(fp.log), onComplete: card,
  });
  const parent = fp.of(run)!;
  const leaf = (id: string) => registry.list().find(r => r.delegateToolCallId === id && r.parentRunId === run.id);
  const delegate = async (id: string) => {
    parent.line(start(id)); parent.line(update(id));
    await until(() => !!leaf(id), `leaf for ${id}`);
    return leaf(id)!;
  };
  const finish = async (text = "parent final answer", cost = 0) => { parent.line(final(text, cost)); await tick(); parent.exit(0); };
  return { ...fp, cwd, registry, queue, run, done, parent, cards, card, leaf, delegate, finish };
}

// ── Finalization gate ────────────────────────────────────────────────

test("N4 gate: a parent ending with a running and a queued leaf cancels the queued one first, waits for the held leaf's exit, then runs its hook and posts one card", { timeout: 20_000 }, async t => {
  const marker = join(tmpDir("n4-marker-"), "leaf-exited");
  const h = await delegator(t, { modeFor: role => role === "leaf" ? "hold" : "prompt", hook: `test -f '${marker}'` });
  const running = await h.delegate("d_run");
  const queued = await h.delegate("d_queued");
  assert.deepEqual([running.status, queued.status], ["running", "queued"], "cap 1: the first leaf runs on the parent's lent slot, the second waits");
  h.of(running)!.once("exit", () => writeFileSync(marker, "exited"));
  await h.finish();
  await h.done;
  assert.equal(h.run.status, "completed", h.run.errorMessage ?? h.run.hookResult?.tailText);
  assert.equal(h.run.hookResult?.passed, true, "the hook ran only after the leaf had exited");
  before(h.log, `${queued.id} killed`, `${running.id} SIGTERM`, `${running.id} SIGKILL`, `${running.id} exit`, "hook started", `${h.run.id} completed`);
  assert.equal(h.procs.filter(p => p.role === "leaf").length, 1, "the cancelled queued leaf never launched");
  assert.equal(h.cards.length, 1, "exactly one card, the parent's");
  assert.equal(h.cards[0]!.run, h.run);
  assert.deepEqual(h.cards[0]!.leaves.sort(), [`${queued.id} killed`, `${running.id} killed`].sort(), "the card comes after its leaves settled");
  const card = h.cards[0]!.content;
  assert.match(card, /<abandoned-children>/);
  for (const leaf of [running, queued]) assert.match(card, new RegExp(`<child id="${leaf.id}" persona="scout" status="killed" exit="confirmed"/>`));
  assert.equal(readFileSync(h.run.finalPath, "utf8"), "parent final answer");
  for (const id of ["d_run", "d_queued"]) assert.match(response(h.run, id).reason ?? response(h.run, id).status, /cancelled|killed/);
});

test("N4 gate: a leaf whose exit is never confirmed withholds the parent's hook, worktree release, final.md and result, and the parent still settles once as failed", { timeout: 20_000 }, async t => {
  const hookRan = join(tmpDir("n4-hook-"), "hook-ran");
  const cwd = repo();
  const h = await delegator(t, { cwd, worktree: true, modeFor: role => role === "leaf" ? "never" : "prompt", hook: `touch '${hookRan}'` });
  const leaf = await h.delegate("d_never");
  await h.finish();
  await h.done;
  assert.equal(h.run.status, "failed");
  assert.match(h.run.errorMessage ?? "", new RegExp(`delegated child ${leaf.id} exit unconfirmed`));
  assert.equal(existsSync(hookRan), false, "no hook while a child's exit is unconfirmed");
  assert.equal(h.run.hookResult, undefined);
  assert.equal(existsSync(h.run.finalPath), false, "no final.md publication");
  assert.ok(h.run.worktreePath && existsSync(h.run.worktreePath), "the worktree is retained");
  assert.match(h.run.worktreeKept ?? "", /preserved/);
  assert.equal(git(cwd, "rev-parse", "--verify", `refs/heads/${h.run.worktreeBranch}`).length, 40, "the branch is retained");
  assert.deepEqual(h.of(leaf)!.exitCode, null);
  assert.equal(h.cards.length, 1, "exactly one failure card");
  const card = h.cards[0]!.content;
  assert.match(card, new RegExp(`<child id="${leaf.id}" persona="scout" status="killed" exit="unconfirmed"/>`));
  assert.doesNotMatch(card, /parent final answer|<result-ref>/, "no assistant result is presented");
  assert.match(card, /no final result published/);
  const record = JSON.parse(readFileSync(h.run.recordPath, "utf8")) as RunRecord;
  assert.equal(record.status, "failed");
  assert.deepEqual(record.abandonedChildren, [{ id: leaf.id, persona: "scout", status: "killed", exit: "unconfirmed" }]);
});

test("N4 gate: a leaf that exited with its pipes still held proceeds truthfully; its slot stays reserved and the exiting parent admits no extra work", { timeout: 20_000 }, async t => {
  const h = await delegator(t, { maxConcurrent: 2, modeFor: role => role === "leaf" ? "stdio" : "prompt" });
  const leaf = await h.delegate("d_stdio");
  const plain = (await resolvePersonas({ cwd: h.cwd })).personas.get("plain")!;
  const enqueue = (task: string) => { const r = h.queue.enqueueOrSpawn({ persona: plain, task, cwd: h.cwd, mode: "background", timeoutMs: 60_000, runtimeEnv: {} }); return r.kind === "spawned" ? r.run : r.placeholderRun; };
  const x = enqueue("N4 lead-level x");
  assert.equal(x.status, "queued");
  await h.finish();
  await until(() => h.log.includes(`${leaf.id} exit`), "the leaf exited");
  assert.equal(h.registry.get(x.id)!.status, "queued", "while the parent's gate waits, nothing is admitted");
  await h.done;
  assert.equal(h.run.status, "completed", h.run.errorMessage);
  assert.match(h.cards[0]!.content, new RegExp(`<child id="${leaf.id}" persona="scout" status="killed" exit="stdio-open"/>`));
  assert.equal(h.registry.get(leaf.id)!.processOpen, true, "terminal is not closed: the leaf still holds its reservation");
  await until(() => h.registry.get(x.id)!.status === "running", "x takes only the parent's freed slot");
  const y = enqueue("N4 lead-level y");
  assert.equal(y.status, "queued", "the exited leaf's open pipes still count");
  h.of(leaf)!.close();
  await until(() => h.registry.get(y.id)!.status === "running", "y runs once the leaf's pipes close");
});

test("N4 gate: a parent that aborted its own call and then asked its owner blocks only after the cancelled leaf exited", { timeout: 20_000 }, async t => {
  const h = await delegator(t, { modeFor: role => role === "leaf" ? "hold" : "prompt" });
  h.registry.onChange(r => { if (r === h.run && r.status === "blocked" && !h.log.includes("parent blocked")) h.log.push("parent blocked"); });
  const leaf = await h.delegate("d_abort");
  h.parent.line(end("d_abort"));
  await until(() => h.registry.get(leaf.id)!.status === "killed", "the broker cancelled the leaf");
  const question = "Pick A or B?";
  h.parent.line({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "ask_1", name: "ask_owner", arguments: { question } }] } });
  h.parent.line({ type: "tool_execution_start", toolCallId: "ask_1", toolName: "ask_owner", args: { question } });
  h.parent.line({ type: "tool_execution_end", toolCallId: "ask_1", toolName: "ask_owner", isError: false, result: { content: [], details: { askId: "ask_1", question, evidence: "" } } });
  const session = join(dirname(h.run.recordPath), "session", "s.jsonl");
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, JSON.stringify({ type: "session", id: "s", cwd: h.cwd }) + "\n");
  await tick();
  h.parent.exit(0);
  await h.done;
  assert.equal(h.run.status, "blocked", h.run.errorMessage);
  assert.equal(h.run.pendingAsk?.askId, "ask_1");
  before(h.log, `${leaf.id} SIGTERM`, `${leaf.id} SIGKILL`, `${leaf.id} exit`, "parent blocked");
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0]!.run.status, "blocked");
  assert.match(response(h.run, "d_abort").reason, /^cancelled: /);
});

// ── Effort writer ────────────────────────────────────────────────────

const writer = (): Persona => ({ name: "builder", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: true,
  timeoutMinutes: 1, readOnly: false, source: "builtin", sourcePath: "test", agents: ["scout"] });

for (const mode of ["hold", "never"] as const) {
  test(`N4 effort writer with a ${mode === "hold" ? "slow-exiting" : "never-exiting"} leaf: ${mode === "hold" ? "the leaf exits before the hook, footprint and integration" : "no hook, footprint, integration or final; work preserved"}`, { timeout: 20_000 }, async t => {
    const cwd = repo();
    const base = git(cwd, "rev-parse", "HEAD");
    const record = openEffort(cwd, "n4", "owner", { verify: "" });
    const marker = join(tmpDir("n4-effort-marker-"), "leaf-exited");
    const h = await delegator(t, { cwd, persona: writer(), effort: "n4", modeFor: role => role === "leaf" ? mode : "prompt", hook: `test -f '${marker}'` });
    const enqueue = t.mock.method(h.registry.integrations, "enqueue");
    assert.ok(h.run.worktreePath, "the writer has its own worktree");
    writeFileSync(join(h.run.worktreePath!, "work"), "work\n");
    git(h.run.worktreePath!, "add", "work"); git(h.run.worktreePath!, "commit", "-m", "work");
    const leaf = await h.delegate("d_effort");
    let exitedAt = 0;
    h.of(leaf)!.once("exit", () => { exitedAt = Date.now(); writeFileSync(marker, "exited"); });
    await h.finish("Implemented and committed the requested change with verification evidence.");
    await h.done;
    if (mode === "hold") {
      assert.equal(h.run.status, "completed", h.run.errorMessage ?? h.run.hookResult?.tailText);
      assert.equal(h.run.hookResult?.passed, true, "the effort hook ran after the leaf exited");
      before(h.log, `${leaf.id} exit`, "hook started", `${h.run.id} completed`);
      assert.ok(h.run.integration && h.run.integration.enqueuedAt >= exitedAt, "integration was enqueued after the leaf exited");
      assert.deepEqual(h.run.integration.changedPaths, ["work"]);
      assert.notEqual(git(cwd, "rev-parse", record.intRef), base, "the verified work integrated");
    } else {
      assert.equal(h.run.status, "failed");
      assert.match(h.run.errorMessage ?? "", /exit unconfirmed/);
      assert.equal(h.run.hookResult, undefined, "no hook");
      assert.equal(h.run.integration, undefined, "no integration");
      assert.equal(enqueue.mock.callCount(), 0, "nothing was enqueued");
      assert.equal(h.run.effort?.changedPaths, undefined, "no footprint was measured");
      assert.equal(git(cwd, "rev-parse", record.intRef), base, "the integration ref did not move");
      assert.ok(existsSync(h.run.worktreePath!), "the worktree is preserved");
      assert.equal(git(cwd, "rev-parse", `refs/heads/${h.run.worktreeBranch}`), git(h.run.worktreePath!, "rev-parse", "HEAD"), "the branch keeps the work");
      assert.equal(existsSync(h.run.finalPath), false);
    }
    assert.equal(h.cards.length, 1, "one card");
    assert.equal(git(cwd, "rev-parse", "HEAD"), base, "the main checkout never moved");
  });
}

// ── A resume replaces the invocation the gate belongs to ─────────────

/**
 * A killed or timed-out parent is resumable while its old gate still waits on a
 * leaf (up to 2.5 s after its process closed). The resume starts after
 * forceTerminate's own 2 s SIGKILL timer, so only the gate can reach the new
 * invocation. `parent` closes on SIGTERM (prompt) or only on that timer's
 * SIGKILL (hold, closing at about +2005 ms).
 */
interface StaleCase { leaf: ExitMode; parent: ExitMode; resumeAt: number; merge?: boolean; ask?: boolean }
async function staleResume(t: test.TestContext, c: StaleCase) {
  const cwd = c.merge ? repo() : project();
  const h = await delegator(t, { cwd, timeoutMs: 400, hook: "true", worktree: c.merge, mergeStrategy: c.merge ? "merge" : undefined,
    modeFor: role => role === "leaf" ? c.leaf : c.parent });
  const base = c.merge ? git(cwd, "rev-parse", "main") : "";
  if (c.merge) { writeFileSync(join(h.run.worktreePath!, "work"), "work\n"); git(h.run.worktreePath!, "add", "work"); git(h.run.worktreePath!, "commit", "-m", "work"); }
  // As a seeded session or an earlier invocation's discovery leaves it.
  const session = join(dirname(h.run.recordPath), "session", "s.jsonl");
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(session, JSON.stringify({ type: "session", id: "s", cwd: h.run.worktreePath ?? cwd }) + "\n");
  h.run.sessionPath = session;
  const hooks = () => h.log.filter(e => e === "hook started").length;
  const leaf = await h.delegate("s_leaf");
  let oldDone = false;
  void h.done.then(() => { oldDone = true; });
  const old = h.of(h.run)!;
  let closedAt = 0;
  old.once("close", () => { closedAt = Date.now(); });
  await until(() => h.cards.length === 1, "the production hard timer's card");
  const killedAt = Date.now();
  assert.equal(h.run.status, "timeout");
  await until(() => Date.now() - killedAt >= c.resumeAt, "the resume time", c.resumeAt + 2000);
  assert.ok(closedAt > 0, "the old parent process has closed");
  if (c.parent === "hold") assert.ok(closedAt - killedAt >= 1990, `the TERM-ignoring parent closed only on the 2 s SIGKILL (+${closedAt - killedAt} ms)`);
  assert.equal(oldDone, false, "the old invocation's gate is still waiting on its leaf");
  const resumed = sendToRun(h.run, "continue", { registry: h.registry, timeoutMs: 60_000, onComplete: h.card, events: new HookSpy(h.log) });
  assert.equal(resumed.kind, "started", resumed.kind === "rejected" ? resumed.reason : "");
  const fresh = h.procs.at(-1)!;
  assert.ok(fresh !== old && fresh.runId === h.run.id && fresh.role === "parent");
  const question = "Use A or B?";
  if (c.ask) {
    fresh.line({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "ask_new", name: "ask_owner", arguments: { question } }] } });
    fresh.line({ type: "tool_execution_start", toolCallId: "ask_new", toolName: "ask_owner", args: { question } });
    fresh.line({ type: "tool_execution_end", toolCallId: "ask_new", toolName: "ask_owner", isError: false, result: { content: [], details: { askId: "ask_new", question, evidence: "" } } });
    await until(() => h.run.pendingAsk?.askId === "ask_new", "the new invocation's question");
  }
  await until(() => oldDone, "the old invocation's pipeline finished", 6000);
  await new Promise(r => setTimeout(r, 100)); // any stale effect would have landed
  if (c.merge) {
    assert.equal(git(cwd, "rev-parse", "main"), base, "the killed invocation merged nothing into main");
    assert.ok(existsSync(h.run.worktreePath!), "its worktree is still the new invocation's");
  }
  assert.equal(h.run.status, "running", h.run.errorMessage);
  assert.equal(h.cards.length, 1, "one card: the old invocation's timeout");
  assert.equal(hooks(), 0, "no hook for the killed invocation");
  assert.equal(h.run.abandonedChildren, undefined, "the old gate wrote no abandoned children into the new invocation");
  assert.equal(h.run.errorMessage, undefined);
  assert.equal(h.run.pendingAsk?.askId, c.ask ? "ask_new" : undefined, "the new invocation's question is untouched");
  assert.equal((h.run.transport as { proc?: unknown } | undefined)?.proc, fresh, "the new process is still the run's");
  assert.equal(h.registry.get(leaf.id)!.status === "killed" || h.registry.get(leaf.id)!.status === "timeout", true, "the old leaf stays cancelled");
  if (!c.ask) fresh.line(final("resumed answer"));
  await tick();
  fresh.exit(0);
  await (resumed as { done: Promise<Run> }).done;
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(h.cards.map(x => x.status), ["timeout", c.ask ? "blocked" : "completed"], "the new invocation settled once");
  if (c.ask) return;
  assert.equal(h.run.status, "completed", h.run.errorMessage);
  assert.equal(hooks(), 1, "only the new invocation ran its hook");
  assert.equal(readFileSync(h.run.finalPath, "utf8"), "resumed answer");
  assert.equal(resultRef(h.run), `run:${h.run.id}`);
  if (c.merge) {
    assert.equal(git(cwd, "show", "main:work"), "work", "the new invocation merged once");
    assert.equal(git(cwd, "rev-list", "--count", `${base}..main`), "2", "one merge of one commit");
    assert.equal(h.run.worktreePath, undefined, "released by the new invocation's merge");
  }
}

test("N4 stale gate: a leaf exited with pipes held, a merging worktree parent timed out by its hard timer and resumed at +2102 ms; the old gate merges, hooks and publishes nothing", { timeout: 20_000 }, async t => {
  await staleResume(t, { leaf: "stdio", parent: "prompt", resumeAt: 2102, merge: true });
});

test("N4 stale gate: a never-exiting leaf, resume at +2102 ms while the new invocation holds a question; the old gate fails, clears and publishes nothing", { timeout: 20_000 }, async t => {
  await staleResume(t, { leaf: "never", parent: "prompt", resumeAt: 2102, ask: true });
});

test("N4 stale gate, wide window: the parent ignores SIGTERM and closes at about +2005 ms, the leaf never exits, resume at +3003 ms", { timeout: 20_000 }, async t => {
  await staleResume(t, { leaf: "never", parent: "hold", resumeAt: 3003 });
});

for (const [mode, exit] of [["never", "unconfirmed"], ["prompt", "confirmed"]] as const) {
  test(`N4 a hard-timer timeout with partial text and a ${exit} leaf: the kill-time final.md is ${exit === "unconfirmed" ? "refused as result-ref and run: evidence" : "a valid result-ref and run: evidence"}`, { timeout: 20_000 }, async t => {
    const h = await delegator(t, { timeoutMs: 400, modeFor: role => role === "leaf" ? mode : "prompt" });
    h.parent.line(final("partial answer before the timeout"));
    const leaf = await h.delegate("r_leaf");
    await h.done;
    assert.equal(h.run.status, "timeout");
    await until(() => existsSync(h.run.finalPath), "the kill-time final.md");
    assert.equal(readFileSync(h.run.finalPath, "utf8"), "partial answer before the timeout", "the kill wrote a diagnostic final.md");
    const evidence = () => appendFileEvidence("task", [`run:${h.run.id}`], { cwd: h.cwd, registry: h.registry });
    if (exit === "unconfirmed") {
      assert.deepEqual(h.run.abandonedChildren?.map(c => [c.id, c.exit]), [[leaf.id, "unconfirmed"]]);
      assert.equal(resultRef(h.run), undefined, "no result-ref while a child's exit is unconfirmed");
      assert.throws(evidence, /no usable final result/, "run: evidence is refused");
    } else {
      assert.equal(h.run.abandonedChildren?.some(c => c.exit === "unconfirmed") ?? false, false);
      assert.equal(resultRef(h.run), `run:${h.run.id}`, "a proven exit keeps the ref");
      assert.match(evidence(), /partial answer before the timeout/);
    }
  });
}

// ── Kill cascade ─────────────────────────────────────────────────────

function toolsFor(registry: RunRegistry, queue: SpawnQueue, cwd: string, cards: Run[] = []) {
  const tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
  registerTools({ registerTool: (t: any) => void tools.set(t.name, t) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [],
    openFocusedOverlay: () => {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
    pushCompletionNotification: (r: Run) => void cards.push(r),
  } as any, {});
  return tools;
}

test("N4 ensemble_kill of a delegating parent cancels its queued leaf, then its running leaf, then the parent; tool kills post no card", { timeout: 20_000 }, async t => {
  const h = await delegator(t);
  const running = await h.delegate("k_run");
  const queued = await h.delegate("k_queued");
  const lead: Run[] = [];
  const kill = toolsFor(h.registry, h.queue, h.cwd, lead).get("ensemble_kill")!;
  const out = await kill.execute("c1", { agent_id: h.run.id });
  assert.equal(out.details.status, "killed");
  before(h.log, `${queued.id} killed`, `${running.id} SIGTERM`, `${running.id} killed`, `${h.run.id} SIGTERM`, `${h.run.id} killed`);
  await h.done;
  assert.deepEqual([lead.length, h.cards.length], [0, 0], "tool kills stay silent and leaves never post");
  assert.equal(h.procs.filter(p => p.role === "leaf").length, 1, "the cancelled queued leaf never launched");
  assert.deepEqual(h.run.abandonedChildren?.map(c => c.id).sort(), [running.id, queued.id].sort());
  const again = await kill.execute("c2", { agent_id: h.run.id });
  assert.match(again.content[0].text, /already killed/, "idempotent");
});

for (const reason of ["timeout", "stalled"] as const) {
  test(`N4 a ${reason} kill (the hard-timer and watchdog call) cascades leaves first and posts exactly one parent card listing them`, { timeout: 20_000 }, async t => {
    const h = await delegator(t);
    const running = await h.delegate("t_run");
    const queued = await h.delegate("t_queued");
    forceTerminate(h.run, reason, h.registry, h.run.onComplete);
    forceTerminate(h.run, reason, h.registry, h.run.onComplete);
    await h.done;
    before(h.log, `${queued.id} killed`, `${running.id} SIGTERM`, `${h.run.id} SIGTERM`);
    assert.equal(h.cards.length, 1, "exactly one card");
    assert.deepEqual(h.cards[0]!.leaves.sort(), [`${queued.id} killed`, `${running.id} killed`].sort(), "the card follows the leaves' cancellation");
    assert.equal(h.cards[0]!.run.status, reason === "timeout" ? "timeout" : "killed");
    for (const leaf of [running, queued]) assert.match(h.cards[0]!.content, new RegExp(`<child id="${leaf.id}" persona="scout" status="killed" exit="(requested|confirmed)"/>`));
  });
}

test("N4 quit stops leaves before their parent and cancels a queued leaf so no freed slot launches it", { timeout: 20_000 }, async t => {
  const h = await delegator(t);
  const running = await h.delegate("q_run");
  const queued = await h.delegate("q_queued");
  const runs = [h.run, ...h.registry.list().filter(r => r !== h.run)];
  await handleSessionShutdown({ reason: "quit" }, { runs, resetSanitizer: () => {}, removeQueued: id => void h.queue.removeQueued(id),
    reconcileRunning: async rs => { for (const r of rs) h.log.push(`${r.id} reconciled`); } });
  before(h.log, `${queued.id} killed`, `${running.id} SIGTERM`, `${h.run.id} SIGTERM`);
  await h.done;
  await until(() => h.procs.every(p => p.exitCode !== null || p.signalCode !== null), "every fake exited");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(h.procs.filter(p => p.role === "leaf").length, 1, "the queued leaf never launched during quit");
  assert.equal(h.registry.get(queued.id)!.status, "killed");
});

test("N4 cascade uses exact current lineage: a stale parent object, a reused id, another parent's leaf, a malformed depth-1 child and a cyclic pair are never signalled", () => {
  const registry = new RunRegistry();
  const signals: string[] = [];
  const now = Date.now();
  let n = 0;
  const run = (over: Partial<Run>): Run => {
    const id = over.id ?? `scout-c${++n}`, dir = join(runsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const r: Run = { id, runtime: "subprocess", persona: "scout", task: "t", cwd: dir, mode: "background", status: "running", startTime: now, lastEventAt: now, messages: [], usage: emptyUsage(),
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      proc: { pid: ++nextPid, kill: (s: string) => { signals.push(`${id} ${s}`); return true; } } as never, ...over };
    registry.register(r);
    return r;
  };
  const parent = run({ id: "lead-own", persona: "lead", depth: 1, delegateAllow: ["scout"] });
  const other = run({ id: "lead-other", persona: "lead", depth: 1, delegateAllow: ["scout"] });
  const mine = run({ depth: 2, delegateAllow: [], parentRunId: parent.id, startTime: now + 1 });
  const reused = run({ depth: 2, delegateAllow: [], parentRunId: parent.id, startTime: now - 60_000 });
  const foreign = run({ depth: 2, delegateAllow: [], parentRunId: other.id, startTime: now + 1 });
  const malformed = run({ depth: 1, delegateAllow: [], parentRunId: parent.id, startTime: now + 1 });
  const a = run({ id: "scout-cyca", depth: 2, delegateAllow: [], parentRunId: "scout-cycb" });
  const b = run({ id: "scout-cycb", depth: 2, delegateAllow: [], parentRunId: "scout-cyca" });
  assert.deepEqual(childrenOf(parent, [...registry.list(), mine]), [mine], "exact lineage, counted once");
  assert.deepEqual(childrenOf(a, registry.list()), [], "a depth-2 run owns nothing");
  forceTerminate({ ...parent, proc: undefined }, "killed", registry);
  assert.equal(mine.status, "running", "a stale parent object cascades to nothing");
  assert.deepEqual(signals.filter(s => !s.startsWith(parent.id)), []);
  forceTerminate(a, "killed", registry);
  assert.equal(b.status, "running", "no traversal through a cyclic pair");
  forceTerminate(parent, "killed", registry);
  assert.equal(mine.status, "killed");
  for (const r of [reused, foreign, malformed, other, b]) assert.equal(r.status, "running", `${r.id} untouched`);
  assert.deepEqual(signals.sort(), [`${a.id} SIGTERM`, `${mine.id} SIGTERM`, `${parent.id} SIGTERM`].sort(), "only the cascade's own lineage was signalled");
});

// ── Depth-2 actions ──────────────────────────────────────────────────

test("N4 a depth-2 leaf offers only kill (and focus, a read-only view); every shared send, steer, follow_up, pause and resume path refuses it", async () => {
  const registry = new RunRegistry();
  const cwd = tmpDir("n4-actions-");
  const session = join(cwd, "s.jsonl");
  writeFileSync(session, JSON.stringify({ type: "session", id: "s", cwd }) + "\n");
  const signalled: string[] = [];
  let n = 0;
  const run = (over: Partial<Run>): Run => {
    const id = `${over.persona ?? "scout"}-a${++n}`, dir = join(runsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const r: Run = { id, runtime: "subprocess", persona: "scout", task: "t", cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(),
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), parentPid: process.pid,
      streamingMode: "rpc", steerable: true, rpcStdinQueue: { writable: true, destroy() {} } as never,
      proc: { pid: ++nextPid, exitCode: null, signalCode: null, kill: () => true } as never, ...over };
    registry.register(r);
    return r;
  };
  const leafScope = { depth: 2 as const, delegateAllow: [], parentRunId: "lead-owner", delegateToolCallId: "call_1" };
  const live = run(leafScope), paused = run({ ...leafScope, status: "paused" }), done = run({ ...leafScope, status: "completed", sessionPath: session, proc: undefined });
  const twins = [run({ persona: "plain", depth: 1, delegateAllow: [] }), run({ persona: "plain", depth: 1, delegateAllow: [], status: "paused" }),
    run({ persona: "plain", depth: 1, delegateAllow: [], status: "completed", sessionPath: session, proc: undefined })];
  const actions = (r: Run) => computeAvailableActions(r, observeRunActions(r, true));
  assert.deepEqual(twins.map(actions), [["steer", "follow_up", "pause", "kill", "focus"], ["resume", "kill", "focus"], ["send", "focus"]], "the same shapes at depth 1 allow every control");
  assert.deepEqual([live, paused, done].map(actions), [["kill", "focus"], ["kill", "focus"], ["focus"]]);
  const owned = /sub-agent scout-a\d+ is owned by lead-owner; only kill/;
  for (const behavior of ["steer", "follow_up", "auto"] as const) {
    const sent = sendToRun(live, "redirect", { registry, timeoutMs: 1000, streamingBehavior: behavior });
    assert.equal(sent.kind, "rejected"); assert.match((sent as { reason: string }).reason, owned, behavior);
  }
  const resumed = sendToRun(done, "continue", { registry, timeoutMs: 1000 });
  assert.equal(resumed.kind, "rejected"); assert.match((resumed as { reason: string }).reason, owned);
  assert.equal(done.status, "completed", "no relaunch");
  assert.match((validateSendable(done) as { reason: string }).reason, owned);
  const signaler = (pid: number, s: NodeJS.Signals | number) => void signalled.push(`${pid} ${s}`);
  assert.equal(pauseRun(live, registry, signaler), false);
  assert.equal(resumeRun(paused, registry, signaler), false);
  assert.deepEqual(signalled, [], "no SIGSTOP/SIGCONT reached a leaf");
  const tools = toolsFor(registry, new SpawnQueue(registry, 4, 1), cwd);
  for (const [name, args] of [["ensemble_send", { agent_id: live.id, message: "x", streaming_behavior: "steer" }], ["ensemble_send", { agent_id: done.id, message: "x" }],
    ["ensemble_pause", { agent_id: live.id }], ["ensemble_resume", { agent_id: paused.id }]] as const) {
    const out = await tools.get(name)!.execute("c", args, undefined, undefined, {});
    assert.match(out.content[0].text, owned, name);
  }
  const focus = await tools.get("ensemble_focus")!.execute("c", { agent_id: live.id }, undefined, undefined, { mode: "tui" });
  assert.equal(focus.details.opened, true, "focus remains a view");
  const killed = await tools.get("ensemble_kill")!.execute("c", { agent_id: live.id }, undefined, undefined, {});
  assert.equal(killed.details.status, "killed");
  assert.equal(live.status, "killed");
});

// ── Cards ────────────────────────────────────────────────────────────

test("N4 the lead never gets a leaf's card, live or readopted; lead-level runs still get theirs", () => {
  const sent: string[] = [];
  const host = { sendMessage: (m: { details: { id: string } }) => void sent.push(m.details.id) };
  const dir = join(runsRoot(), "scout-card1");
  mkdirSync(dir, { recursive: true });
  const leaf: Run = { id: "scout-card1", runtime: "subprocess", persona: "scout", task: "t", cwd: dir, mode: "background", status: "completed", startTime: 1, lastEventAt: 1, finishedAt: 2,
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 2, delegateAllow: [], parentRunId: "lead-card", delegateToolCallId: "call_c" };
  const readopted = buildOrphanRun(toRunRecord(leaf), "completed");
  const lead: Run = { ...leaf, id: "plain-card1", persona: "plain", depth: 1, parentRunId: undefined, delegateToolCallId: undefined };
  assert.equal(pushCompletionCard(leaf, host), false);
  assert.equal(pushCompletionCard(readopted, host), false);
  assert.equal(pushCompletionCard(lead, host), true);
  assert.deepEqual(sent, ["plain-card1"], "only the lead-level card");
});

// ── Reconcile ────────────────────────────────────────────────────────

test("N4 reconcile orphans a running leaf whose parent is terminal, missing or replaced, without signalling it or deleting its work", async () => {
  const root = tmpDir("n4-reconcile-");
  const now = Date.now();
  const write = (over: Partial<RunRecord> & { id: string }) => {
    const dir = join(root, over.id);
    mkdirSync(join(dir, "session"), { recursive: true });
    writeFileSync(join(dir, "session", "s.jsonl"), "{}\n");
    const record: RunRecord = { persona: "scout", task: "t", mode: "background", status: "running", startTime: now - 10_000, pid: ++nextPid, parentPid: process.pid, usage: emptyUsage(), cwd: root,
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), runtime: "subprocess", streamingMode: "print",
      sessionPath: join(dir, "session", "s.jsonl"), ...over };
    writeFileSync(record.recordPath, JSON.stringify(record));
    return record;
  };
  const leaf = (id: string, parentRunId: string, startTime = now - 5_000) => write({ id, depth: 2, delegateAllow: [], parentRunId, delegateToolCallId: `call_${id}`, startTime });
  write({ id: "lead-done", persona: "lead", depth: 1, delegateAllow: ["scout"], status: "killed", finishedAt: now - 1_000 });
  write({ id: "lead-live", persona: "lead", depth: 1, delegateAllow: ["scout"] });
  write({ id: "plain-live", persona: "plain", depth: 1, delegateAllow: [] });
  const orphans = [leaf("scout-o1", "lead-done"), leaf("scout-o2", "lead-gone"), leaf("scout-o3", "lead-replaced")];
  const kept = leaf("scout-k1", "lead-live");
  const registry = new RunRegistry();
  const replacement: Run = { ...buildOrphanRun(write({ id: "lead-replaced", persona: "lead", depth: 1, delegateAllow: ["scout"], startTime: now }), "running") };
  registry.register(replacement);
  const signals: string[] = [];
  const result = await reconcileOrphansAtStartup({ runsRoot: root, registry, isAlive: () => true, isParentAlive: () => true, selfPid: process.pid, now,
    signal: (pid, s) => void signals.push(`${pid} ${s}`) });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(signals, [], "no pid from a record is ever signalled");
  for (const [record, why] of [[orphans[0]!, "terminal"], [orphans[1]!, "missing"], [orphans[2]!, "missing"]] as const) {
    const run = registry.get(record.id)!;
    assert.equal(run.status, "killed", record.id);
    assert.match(run.errorMessage ?? "", new RegExp(`^orphaned: parent ${record.parentRunId} ${why}; process ${record.pid} was not signalled`));
    const disk = JSON.parse(readFileSync(record.recordPath, "utf8")) as RunRecord;
    assert.deepEqual([disk.status, disk.pid, disk.errorMessage], ["killed", record.pid, run.errorMessage], "on disk too, pid kept");
    assert.ok(existsSync(record.sessionPath!), "work is not deleted");
  }
  assert.equal(registry.get(kept.id)!.status, "running", "a live parent's leaf is readopted, not orphaned");
  assert.equal(registry.get("plain-live")!.status, "running", "a run without a parent is never treated as anyone's leaf");
  assert.equal(registry.get("lead-replaced"), replacement, "the replacement is untouched");
});

// ── Results, status and budget ───────────────────────────────────────

test("N4 envelope and status carry children and subtree cost: per-send counts this invocation's leaves, lifetime all, each leaf once", async () => {
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  const t0 = Date.now() - 100_000, t1 = t0 + 50_000;
  let n = 0;
  const run = (over: Partial<Run>): Run => {
    const id = over.id ?? `scout-s${++n}`, dir = join(runsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const r: Run = { id, runtime: "subprocess", persona: "scout", task: "t", cwd: dir, mode: "background", status: "completed", startTime: t0, finishedAt: t1 + 9_000, lastEventAt: t0,
      messages: [{ role: "assistant", content: [{ type: "text", text: `${id} answer` }] } as never], usage: emptyUsage(),
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), ...over };
    registry.register(r);
    return r;
  };
  const cost = (c: number) => ({ ...emptyUsage(), cost: c });
  const parent = run({ id: "lead-sub", persona: "lead", depth: 1, delegateAllow: ["scout"], usage: cost(1), thisInvocationStartedAt: t1, resumeCount: 1,
    thisInvocationUsageBaseline: { turns: 0, input: 0, output: 0, cost: 0.4 } });
  const old = run({ depth: 2, delegateAllow: [], parentRunId: parent.id, startTime: t0 + 1, usage: cost(0.1) });
  const fresh = run({ depth: 2, delegateAllow: [], parentRunId: parent.id, startTime: t1 + 1, usage: cost(0.2) });
  await writeFinal(fresh);
  run({ depth: 2, delegateAllow: [], parentRunId: parent.id, startTime: t0 - 1, usage: cost(9) }); // a reused id's earlier leaf
  run({ depth: 2, delegateAllow: [], parentRunId: "lead-elsewhere", startTime: t1 + 1, usage: cost(5) });
  run({ persona: "plain", depth: 1, delegateAllow: [], parentRunId: parent.id, startTime: t1 + 1, usage: cost(7) });
  const runs = [...registry.list(), { ...fresh }];
  assert.equal(subtreeCost(parent, runs).toFixed(4), "1.3000", "lifetime: own cost plus each owned leaf once");
  const envelope = formatCompletionNotification(parent, [], runs);
  const [perSend, lifetime] = envelope.split("<lifetime>");
  assert.match(perSend!, /<subtree-cost>0\.8000<\/subtree-cost>/, "this invocation: own 0.6 plus its one new leaf");
  assert.match(perSend!, new RegExp(`<children>\\n    <child id="${fresh.id}" persona="scout" status="completed" cost="0.2000" result-ref="run:${fresh.id}"/>\\n  </children>`));
  assert.doesNotMatch(perSend!, new RegExp(old.id), "an earlier invocation's leaf is not this invocation's child");
  assert.match(lifetime!, /<subtree-cost>1\.3000<\/subtree-cost>/);

  const status = await toolsFor(registry, queue, tmpDir("n4-status-")).get("ensemble_status")!.execute("s", {}, undefined, undefined, {});
  const summary = (id: string) => status.details.finished.find((s: { id: string }) => s.id === id);
  assert.deepEqual([summary(parent.id).depth, summary(parent.id).subtree_cost.toFixed(4), summary(parent.id).children.map((c: { id: string }) => c.id).sort()], [1, "1.3000", [old.id, fresh.id].sort()]);
  assert.deepEqual([summary(fresh.id).depth, summary(fresh.id).parent_run_id], [2, parent.id]);
  const line = (id: string) => (status.content[0].text as string).split("\n").find(l => l.trimStart().startsWith(`${id} `))!;
  assert.match(line(parent.id), /children=2 subtree=\$1\.300/);
  assert.match(line(fresh.id), new RegExp(`parent=${parent.id}`));
  const theme = { fg: (_s: string, t: string) => t };
  assert.match(formatRow(fresh, theme, undefined, undefined, runs), /^ {2}\S/, "the panel indents a leaf");
  assert.match(formatRow(parent, theme, undefined, undefined, runs), /^\S/);
});

test("N4 ensemble_auto charges each step its parent plus that parent's own leaves, once, and halts on the subtree budget", { timeout: 20_000 }, async t => {
  const fp = fakePi(t);
  const cwd = project();
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 2, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env: {} });
  const auto = toolsFor(registry, queue, cwd).get("ensemble_auto")!;
  // Each parent delegates once when its task says so; leaves cost 0.6, parents 0.5.
  const drive = async () => {
    for (;;) {
      await new Promise(r => setTimeout(r, 5));
      for (const p of fp.procs) {
        if ((p as any).driven) continue;
        const r = registry.get(p.runId);
        if (!r) continue;
        (p as any).driven = true;
        if (p.role === "leaf") { p.line(final("leaf answer", 0.6)); await tick(); p.exit(0); continue; }
        if (r.task.includes("delegate")) {
          p.line(start(`a_${r.id}`)); p.line(update(`a_${r.id}`));
          void until(() => existsSync(delegatePaths(dirname(r.recordPath), `a_${r.id}`).response), "leaf answer").then(async () => { p.line(final("parent answer", 0.5)); await tick(); p.exit(0); });
        } else { p.line(final("parent answer", 0.3)); await tick(); p.exit(0); }
      }
      if ((fp as any).stop) return;
    }
  };
  const driver = drive();
  try {
    const halted = await auto.execute("a1", { goal: "g", max_steps: 5, budget_usd: 1.0, steps: [{ persona: "lead", task: "delegate one" }, { persona: "lead", task: "never spawned" }] }, undefined, undefined, {});
    assert.equal(halted.details.status, "halted");
    assert.match(halted.details.haltReason, /budget exhausted \(\$1\.10 >= \$1\)/, "0.5 own + 0.6 leaf");
    assert.equal(fp.procs.filter(p => p.role === "parent").length, 1, "the over-budget step never spawned");
    const done = await auto.execute("a2", { goal: "g", max_steps: 5, budget_usd: 3.0, steps: [{ persona: "lead", task: "delegate one" }, { persona: "lead", task: "plain" }] }, undefined, undefined, {});
    assert.equal(done.details.status, "done");
    assert.equal(done.details.spentUsd.toFixed(2), "1.40", "the second root is charged only its own 0.3, never the first root's leaf");
  } finally { (fp as any).stop = true; await driver; }
});
