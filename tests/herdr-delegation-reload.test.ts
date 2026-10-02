/**
 * N5: a herdr parent's pending delegation across lead reload and crash. The next
 * owner's readopted pipeline replays the parent's tee from the launch boundary into
 * its own broker, which decides each claimed call once startup reconcile has
 * registered what it will: response -> skip; registered leaf -> rebind; terminal leaf
 * record -> answer from it; anything else -> explicit uncertainty. A claimed call is
 * never re-spawned, and an old broker never answers or cancels after handing over.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { RunRegistry, runsRoot, writeRecord, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker, LEAF_OUTCOME_UNCERTAIN, HERDR_RELOAD_CANCELLED } from "../src/delegation-broker.ts";
import { createRunPipeline, readoptHerdrRun } from "../src/run-pipeline.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { buildOrphanRun, readProcessStartTime } from "../src/reconcile-startup.ts";
import { claimHerdrOwner, herdrModuleEpoch } from "../src/herdr/ownership.ts";
import { publishJson } from "../src/effort/store.ts";
import { delegatePaths, subtreeCost } from "../src/delegation.ts";
import { emptyUsage, toRunRecord, type Run, type RunRecord } from "../src/types.ts";
import type { HerdrTransport } from "../src/runtime.ts";

sandboxPi();
const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;
function project(): string {
  const cwd = tmpDir("n5-reload-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  for (const [f, text] of Object.entries({ "scout.md": doc("scout", "read_only: true\n"), "auditor.md": doc("auditor", "read_only: true\n") })) writeFileSync(join(projectPersonasDir(cwd), f), text);
  return cwd;
}
const start = (id: string, persona = "scout") => ({ type: "tool_execution_start", toolCallId: id, toolName: "delegate", args: { persona, task: `look ${id}` } });
const update = (id: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: "delegate" });
const end = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "delegate", isError: true });
const tick = () => new Promise(r => setTimeout(r, 60));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 5)); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const responsePath = (parent: Run, id: string) => delegatePaths(dirname(parent.recordPath), id).response;
const answer = (parent: Run, id: string) => existsSync(responsePath(parent, id)) ? JSON.parse(readFileSync(responsePath(parent, id), "utf8")) : undefined;

let seq = 0;
/** A herdr leaf this lead launched and owns; its stub transport stands in for a proven pane child. */
function herdrLeaf(registry: RunRegistry, parent: Run, callId: string, over: { id?: string; claim?: boolean } = {}): Run {
  const id = over.id ?? `scout-n5r${++seq}`, dir = join(runsRoot(), id); mkdirSync(dir, { recursive: true });
  const nonce = randomUUID();
  const leaf: Run = { id, runtime: "herdr", persona: "scout", task: "t", cwd: parent.cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 2, delegateAllow: [], parentRunId: parent.id, delegateToolCallId: callId,
    herdr: { runId: id, launchNonce: nonce, sessionId: "s", sessionFile: join(dir, "session", `${nonce}.jsonl`), socketPath: parent.herdr!.socketPath, workspaceId: "workspace", tabId: "tab", paneId: `pane-${id}`, terminalId: `t-${id}`, createdTab: false } };
  if (over.claim !== false) leaf.herdrOwnership = claimHerdrOwner(dir, { epoch: herdrModuleEpoch, sessionId: "s", pid: process.pid, startTime: readProcessStartTime(process.pid),
    socketPath: leaf.herdr!.socketPath, runId: id, launchNonce: nonce, at: Date.now() });
  leaf.transport = { kind: "herdr", initialAccepted: true, childExited: false, cancelled: false, stderr: "", closed: new Promise(() => {}), ready: new Promise(() => {}),
    drain: () => "", stop: async () => {}, cancel: async () => {}, observe() {}, waitForExit: async () => true, releasePane: async () => false } as unknown as HerdrTransport;
  registry.register(leaf);
  return leaf;
}
/** A subprocess leaf this module instance launched: its stdout source cannot move to the next instance. */
function subprocessLeaf(o: SpawnOptions, parent: Run): Run {
  const id = o.preAllocatedId ?? `scout-n5s${++seq}`, dir = join(runsRoot(), id); mkdirSync(dir, { recursive: true });
  const leaf: Run = { id, runtime: "subprocess", persona: "scout", task: "t", cwd: parent.cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 2, delegateAllow: [], parentRunId: parent.id, delegateToolCallId: o.delegation!.delegateToolCallId,
    transport: { kind: "subprocess", closed: new Promise(() => {}), stderr: "", drain: () => "", stop() {} } as never };
  o.registry.register(leaf);
  return leaf;
}
/** One lead instance: registry, queue whose spawner launches owned herdr leaf stubs, broker. */
function lead(maxConcurrent = 4, leafRuntime: "herdr" | "subprocess" = "herdr") {
  const registry = new RunRegistry(), spawned: SpawnOptions[] = [];
  const queue = new SpawnQueue(registry, maxConcurrent, 1, (o: SpawnOptions) => {
    spawned.push(o);
    const parent = o.registry.get(o.delegation!.parentRunId)!;
    const leaf = leafRuntime === "herdr" ? herdrLeaf(o.registry, parent, o.delegation!.delegateToolCallId, { id: o.preAllocatedId }) : subprocessLeaf(o, parent);
    return { run: leaf, done: new Promise<Run>(() => {}) };
  });
  const broker = new DelegationBroker({ registry, queue, env: {} });
  registry.delegation = broker;
  return { registry, queue, broker, spawned };
}
/** A running herdr delegator whose tee events the test writes, nonce-stamped. */
async function herdrParent(owner = lead()) {
  const cwd = project(), id = `lead-n5r${++seq}`;
  const h = herdrFixture("running", { id, cwd, dir: join(runsRoot(), id), run: { persona: "lead", depth: 1, delegateAllow: ["scout", "auditor"], parentSessionId: "lead-session" } });
  const registry = owner.registry; registry.register(h.run);
  void createRunPipeline(h.run, [], { ...h.opts, registry, timeoutMs: 600000, onEvent: (r, e) => owner.broker.observe(r, e, cwd) });
  if (h.run.transport?.kind !== "herdr") throw new Error("transport");
  await h.run.transport.ready;
  // The child keeps writing whoever owns its stream; drain whichever pipeline is attached now.
  let attached: Run = h.run;
  const tee = (...events: object[]) => { for (const e of events) h.emit(e); attached.transport?.drain(); };
  /** A crashed lead runs nothing: its pipeline goes inert and its owner generation is dead. */
  const crash = () => { h.run.herdrPipeline!.suspend(); h.run.herdrOwnership!.release(); };
  return { h, cwd, parent: h.run, tee, owner, crash, attach: (run: Run) => { attached = run; } };
}
/** Lead reload: the old instance quiesces and releases every herdr run it owns, including leaves. */
async function reload(owner: ReturnType<typeof lead>) {
  await handleSessionShutdown({ reason: "reload" }, { runs: owner.registry.list(), resetSanitizer() {}, delegation: owner.broker });
}
/** The next lead: reconcile-ordered readoption of the parent (and, if given, its leaf), then reconcile completes. */
async function nextLead(parentRecord: RunRecord, h: ReturnType<typeof herdrFixture>, leaves: Run[], order: "parent-first" | "child-first" = "parent-first") {
  const owner = lead(), done = deferred();
  owner.broker.reconciling(done.promise);
  const adoptLeaf = (old: Run) => {
    try { old.herdrOwnership?.release(); } catch { /* reload already released it */ }
    const record = JSON.parse(readFileSync(old.recordPath, "utf8")) as RunRecord;
    const run = buildOrphanRun(record, "running");
    run.herdrOwnership = claimHerdrOwner(dirname(run.recordPath), { epoch: herdrModuleEpoch, sessionId: "s2", pid: process.pid, startTime: readProcessStartTime(process.pid),
      socketPath: run.herdr!.socketPath, runId: run.id, launchNonce: run.herdr!.launchNonce, at: Date.now() });
    run.transport = old.transport;
    owner.registry.register(run);
    return run;
  };
  const adopted: Run[] = [];
  let parent!: Run, settled!: Promise<Run>;
  const adoptParent = async () => { ({ run: parent, done: settled } = readoptHerdrRun(parentRecord, { registry: owner.registry, runtime: h.runtime, sessionId: "s2" }));
    if (parent.transport?.kind === "herdr") await parent.transport.ready; };
  if (order === "child-first") { for (const l of leaves) adopted.push(adoptLeaf(l)); await adoptParent(); }
  else { await adoptParent(); await tick(); for (const l of leaves) adopted.push(adoptLeaf(l)); }
  return { owner, parent, adopted, settled: () => settled, reconciled: async () => { done.resolve(); await tick(); } };
}
async function complete(registry: RunRegistry, leaf: Run, text: string, cost = 0.25, persist = true) {
  leaf.messages = [{ role: "assistant", content: [{ type: "text", text }] } as never];
  leaf.usage = { ...leaf.usage, cost, turns: 1 };
  leaf.status = "completed"; leaf.finishedAt = Date.now();
  if (persist) await writeRecord(leaf);
  registry.notify(leaf);
}

for (const order of ["parent-first", "child-first"] as const) test(`N5 reload (${order}): a launched herdr leaf is handed over unanswered and rebound by the next owner; never re-spawned`, { timeout: 15000 }, async () => {
  const t = await herdrParent();
  const { h, parent, tee, owner } = t;
  tee(start("d1"), update("d1"));
  await tick();
  assert.equal(owner.spawned.length, 1);
  const [leaf] = owner.registry.list().filter(r => r.parentRunId === parent.id);
  await writeRecord(leaf!);
  assert.equal(parent.pendingDelegations, 1);
  await reload(owner);
  assert.equal(answer(parent, "d1"), undefined, "the old owner answers nothing at handover");
  assert.equal(leaf!.status, "running", "and cancels nothing");
  assert.equal(parent.pendingDelegations, 0, "its local credit went with the handover");
  const record = JSON.parse(readFileSync(parent.recordPath, "utf8")) as RunRecord;
  const next = await nextLead(record, h, [leaf!], order);
  t.attach(next.parent);
  tee(update("d1")); // a throttled repeat after the handover
  assert.equal(answer(parent, "d1"), undefined, "nothing is decided before reconcile has registered the leaf");
  await next.reconciled();
  assert.equal(next.owner.spawned.length, 0, "a claimed call is never re-spawned");
  assert.equal(next.parent.pendingDelegations, 1, "rebound as one awaiting call, once");
  // The old object finishing in the old registry must not answer for the new owner.
  await complete(owner.registry, leaf!, "stale old-object result", 0.25, false);
  await tick();
  assert.equal(answer(parent, "d1"), undefined, "the old broker never answers after handover");
  const [rebound] = next.adopted;
  await complete(next.owner.registry, rebound!, "N5 rebound leaf result");
  await until(() => !!answer(parent, "d1"), "rebound answer");
  const r = answer(parent, "d1");
  assert.deepEqual([r.ok, r.agentId, r.status, r.parentRunId], [true, rebound!.id, "completed", parent.id]);
  assert.match(r.envelope, /N5 rebound leaf result/);
  assert.equal(next.parent.pendingDelegations, 0);
  assert.equal(subtreeCost(next.parent, next.owner.registry.list()), next.parent.usage.cost + 0.25, "the leaf's cost counted once");
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 crash takeover: claim plus a terminal leaf record without a response is answered once from the record", { timeout: 15000 }, async () => {
  const { h, parent, tee, crash, attach } = await herdrParent();
  crash();
  // The crashed lead claimed and its leaf finished, but no response was written.
  const id = `scout-n5crash${++seq}`, dir = join(runsRoot(), id); mkdirSync(dir, { recursive: true });
  publishJson(delegatePaths(dirname(parent.recordPath), "d2").claim, { v: 1, toolCallId: "d2", parentRunId: parent.id, claimedAt: Date.now() - 1000, launchNonce: parent.herdr!.launchNonce }, () => {});
  const leaf: Run = { id, runtime: "subprocess", persona: "scout", task: "t", cwd: parent.cwd, mode: "background", status: "completed", startTime: Date.now() - 500, lastEventAt: Date.now(),
    messages: [], usage: { ...emptyUsage(), cost: 0.5 }, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 2, delegateAllow: [], parentRunId: parent.id, delegateToolCallId: "d2" };
  writeFileSync(leaf.recordPath, JSON.stringify(toRunRecord(leaf))); writeFileSync(leaf.finalPath, "N5 crash leaf final evidence");
  tee(start("d2"), update("d2"));
  const record = JSON.parse(readFileSync(parent.recordPath, "utf8")) as RunRecord;
  const next = await nextLead(record, h, []);
  attach(next.parent);
  await next.reconciled();
  const r = answer(parent, "d2");
  assert.deepEqual([r?.ok, r?.agentId, r?.status], [true, id, "completed"]);
  assert.match(r.envelope, /N5 crash leaf final evidence/);
  assert.equal(next.owner.spawned.length, 0);
  assert.equal(next.parent.pendingDelegations, 0);
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 a claimed call with an unknown, foreign or unadopted leaf is answered uncertain, not replayed; a response is skipped", { timeout: 15000 }, async () => {
  const { h, parent, tee, crash } = await herdrParent();
  crash();
  const claim = (id: string, over: object = {}) => publishJson(delegatePaths(dirname(parent.recordPath), id).claim,
    { v: 1, toolCallId: id, parentRunId: parent.id, claimedAt: Date.now() - 1000, launchNonce: parent.herdr!.launchNonce, ...over }, () => {});
  claim("u_none");
  // Another launch's claim, even with a finished leaf naming the call, is not this invocation's evidence.
  claim("u_foreign", { launchNonce: "another-launch" });
  const fid = `scout-n5f${++seq}`, fdir = join(runsRoot(), fid); mkdirSync(fdir, { recursive: true });
  writeFileSync(join(fdir, "record.json"), JSON.stringify({ id: fid, runtime: "subprocess", status: "completed", startTime: Date.now() - 500, depth: 2, delegateAllow: [], parentRunId: parent.id, delegateToolCallId: "u_foreign",
    recordPath: join(fdir, "record.json"), transcriptPath: join(fdir, "transcript.jsonl"), finalPath: join(fdir, "final.md"), persona: "scout", task: "t", cwd: parent.cwd, mode: "background", usage: emptyUsage() }));
  claim("u_unadopted");
  const lid = `scout-n5u${++seq}`, ldir = join(runsRoot(), lid); mkdirSync(ldir, { recursive: true });
  // A non-terminal leaf record reconcile did not register (skip-foreign, or H11 prepared-unpublished).
  writeFileSync(join(ldir, "record.json"), JSON.stringify({ id: lid, runtime: "herdr", status: "running", startTime: Date.now() - 500, depth: 2, delegateAllow: [], parentRunId: parent.id, delegateToolCallId: "u_unadopted",
    recordPath: join(ldir, "record.json"), transcriptPath: join(ldir, "transcript.jsonl"), finalPath: join(ldir, "final.md"), persona: "scout", task: "t", cwd: parent.cwd, mode: "background", usage: emptyUsage() }));
  claim("u_answered");
  publishJson(delegatePaths(dirname(parent.recordPath), "u_answered").response, { v: 1, toolCallId: "u_answered", parentRunId: parent.id, ok: true, envelope: "original" }, () => {});
  for (const id of ["u_none", "u_foreign", "u_unadopted", "u_answered"]) tee(start(id), update(id));
  const record = JSON.parse(readFileSync(parent.recordPath, "utf8")) as RunRecord;
  const next = await nextLead(record, h, []);
  await next.reconciled();
  for (const id of ["u_none", "u_foreign", "u_unadopted"]) {
    const r = answer(parent, id);
    assert.equal(r?.ok, false, id);
    assert.match(r.reason, new RegExp(LEAF_OUTCOME_UNCERTAIN), id);
  }
  assert.equal(answer(parent, "u_answered").envelope, "original", "an existing response is never replaced");
  assert.equal(next.owner.spawned.length, 0, "nothing claimed is replayed");
  assert.equal(next.parent.pendingDelegations, 0, "no credit is lost or left behind");
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 an unclaimed call in the replay is brokered normally after reconcile, once despite duplicate updates", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner, attach } = await herdrParent();
  // The old owner never saw this update: it was written after the reload detached it.
  await reload(owner);
  tee(start("fresh"), update("fresh"), update("fresh"));
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, []);
  attach(next.parent);
  assert.equal(next.owner.spawned.length, 0, "deferred until reconcile");
  await next.reconciled();
  assert.equal(next.owner.spawned.length, 1);
  assert.equal(next.owner.spawned[0]!.delegation!.delegateToolCallId, "fresh");
  assert.equal(next.parent.pendingDelegations, 1);
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 reload during the async roster resolve: a definite cancellation, no spawn now and none after replay", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner } = await herdrParent();
  tee(start("d5"), update("d5"));
  await reload(owner); // runs while resolve awaits the roster
  await tick();
  assert.equal(owner.spawned.length, 0);
  const r = answer(parent, "d5");
  assert.equal(r?.ok, false);
  assert.equal(r.reason, `cancelled: ${HERDR_RELOAD_CANCELLED}`);
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, []);
  await next.reconciled();
  assert.equal(next.owner.spawned.length, 0);
  assert.equal(answer(parent, "d5").reason, r.reason, "claim + response: skipped");
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 a foreign owner generation after the await: the old broker spawns and answers nothing; the next owner answers uncertain", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner, crash } = await herdrParent();
  tee(start("d6"), update("d6"));
  crash(); // the owner generation is fenced while resolve awaits the roster
  await tick();
  assert.equal(owner.spawned.length, 0, "fenced after the await: no leaf");
  assert.equal(answer(parent, "d6"), undefined, "and no answer from a fenced broker");
  assert.equal(parent.pendingDelegations, 0, "its local credit is released, not leaked");
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, []);
  await next.reconciled();
  assert.match(answer(parent, "d6")?.reason ?? "", new RegExp(LEAF_OUTCOME_UNCERTAIN));
  assert.equal(next.owner.spawned.length, 0);
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 rebound calls hold outstanding credit: with 8 rebound, a new ninth call is rejected; status shows 8 awaiting", { timeout: 20000 }, async () => {
  const { h, parent, tee, owner, attach } = await herdrParent(lead(16));
  const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
  for (const id of ids) tee(start(id), update(id));
  await until(() => owner.spawned.length === 8, "eight leaves");
  const leaves = owner.registry.list().filter(r => r.parentRunId === parent.id);
  await Promise.all(leaves.map(l => writeRecord(l)));
  await reload(owner);
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, leaves);
  attach(next.parent);
  await next.reconciled();
  assert.equal(next.parent.pendingDelegations, 8);
  tee(start("ninth"), update("ninth"));
  await tick();
  assert.match(answer(parent, "ninth")?.reason ?? "", /already has 8 delegate calls outstanding/);
  assert.equal(next.owner.spawned.length, 0);
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 an end in the replay cancels a rebound live leaf; a parent without its effort claim only observes", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner, attach } = await herdrParent();
  tee(start("e1"), update("e1"));
  await tick();
  const [leaf] = owner.registry.list().filter(r => r.parentRunId === parent.id);
  await writeRecord(leaf!);
  await reload(owner);
  tee(end("e1")); // the child stopped waiting while no lead owned it
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, [leaf!]);
  attach(next.parent);
  await next.reconciled();
  assert.match(answer(parent, "e1")?.reason ?? "", /^cancelled: the delegate call ended/);
  assert.equal(next.adopted[0]!.status, "killed", "the rebound leaf is cancelled, owned and bounded");
  // Run ownership is not effort ownership: without the effort claim the broker writes nothing.
  next.parent.effort = { owner: { pid: 1, sessionId: "x", epoch: "e" } as never, name: "f", gitRoot: "/nowhere", role: "writer" };
  next.parent.herdrEffortAuthorized = false;
  tee(start("e2"), update("e2"));
  await tick();
  assert.equal(existsSync(delegatePaths(dirname(parent.recordPath), "e2").claim), false);
  assert.equal(answer(parent, "e2"), undefined);
  assert.equal(next.owner.spawned.length, 0);
  next.parent.effort = undefined;
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 reconcile stops an attached herdr leaf of a terminal parent through its proven child; a live parent's leaf and a settled orphan are left alone", { timeout: 10000 }, async () => {
  const { reconcileOrphansAtStartup } = await import("../src/reconcile-startup.ts");
  const root = tmpDir("n5-orphans-"), registry = new RunRegistry(), now = Date.now();
  const write = (id: string, over: Partial<RunRecord>) => {
    const dir = join(root, id); mkdirSync(dir, { recursive: true });
    const rec = { id, runtime: "herdr", persona: "p", task: "t", cwd: root, mode: "background", status: "running", startTime: now - 1000, usage: emptyUsage(),
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), ...over };
    writeFileSync(rec.recordPath, JSON.stringify(rec));
  };
  write("lead-dead", { status: "killed", depth: 1, delegateAllow: ["scout"], startTime: now - 2000 });
  write("lead-live", { depth: 1, delegateAllow: ["scout"], startTime: now - 2000 });
  write("scout-orphan", { depth: 2, delegateAllow: [], parentRunId: "lead-dead", delegateToolCallId: "a" });
  write("scout-owned", { depth: 2, delegateAllow: [], parentRunId: "lead-live", delegateToolCallId: "b" });
  write("scout-settled", { depth: 2, delegateAllow: [], parentRunId: "lead-dead", delegateToolCallId: "c" });
  const stopped: string[] = [];
  await reconcileOrphansAtStartup({ runsRoot: root, registry, isAlive: () => false, now, selfSessionId: "s",
    herdrProbe: async r => r.id === "scout-settled" ? "settled" : "alive",
    attachHerdr: record => {
      const run = buildOrphanRun(record, "running");
      run.transport = { kind: "herdr", ready: Promise.resolve() } as unknown as HerdrTransport;
      registry.register(run);
    },
    stopOrphanLeaf: run => { stopped.push(`${run.id}: ${run.errorMessage}`); } });
  await tick();
  assert.deepEqual(stopped, ["scout-orphan: orphaned: parent lead-dead terminal; stopped through its proven pane child"]);
});

test("N5 N4 gate after readopt: the parent's finalize stops its unanswered rebound leaf first; an answered leaf being re-finalized is not its to stop", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner, attach } = await herdrParent();
  tee(start("g1"), update("g1"), start("g2"), update("g2"));
  await until(() => owner.spawned.length === 2, "two leaves");
  const leaves = owner.registry.list().filter(r => r.parentRunId === parent.id);
  const answered = leaves.find(l => l.delegateToolCallId === "g2")!;
  await complete(owner.registry, answered, "g2 answered before the reload");
  await until(() => !!answer(parent, "g2"), "g2 answered");
  await Promise.all(leaves.map(l => writeRecord(l)));
  await reload(owner);
  const next = await nextLead(JSON.parse(readFileSync(parent.recordPath, "utf8")), h, leaves);
  attach(next.parent);
  await next.reconciled();
  assert.equal(next.parent.pendingDelegations, 1, "only g1 is rebound; g2 has its answer");
  const [g1, g2] = ["g1", "g2"].map(id => next.adopted.find(l => l.delegateToolCallId === id)!);
  assert.equal(g2!.status, "running", "g2 is still being re-finalized after the restart");
  // The parent's own child exits; its finalize runs the N4 gate before anything is published.
  tee({ type: "agent_settled" }); h.exit();
  const settled = await next.settled();
  assert.equal(settled.status, "completed", settled.errorMessage);
  assert.equal(g1!.status, "killed", "the unanswered leaf was cancelled first");
  assert.deepEqual(settled.abandonedChildren?.map(c => [c.id, c.exit]), [[g1!.id, "confirmed"]]);
  assert.equal(g2!.status, "running", "an answered leaf is not the gate's to stop");
  assert.ok(answer(parent, "g1"), "g1's call still gets exactly one answer");
  await handleSessionShutdown({ reason: "reload" }, { runs: next.owner.registry.list(), resetSanitizer() {}, delegation: next.owner.broker });
});

test("N5 a herdr leaf holds its N3 slot until its pane child's exit is proven, not merely until it is terminal", { timeout: 10000 }, async () => {
  const { holdsSlot } = await import("../src/effort/admit.ts");
  const { forceTerminate } = await import("../src/runs.ts");
  for (const mode of ["stubborn", "running"]) {
    const h = herdrFixture(mode, { run: { depth: 2, delegateAllow: [], parentRunId: "lead-x", delegateToolCallId: "c" } });
    let notified = 0; h.registry.onChange(r => { if (r === h.run && r.processOpen === undefined) notified++; });
    void createRunPipeline(h.run, [], h.opts);
    if (h.run.transport?.kind !== "herdr") throw new Error("transport");
    await h.run.transport.ready;
    assert.equal(h.run.processOpen, true);
    forceTerminate(h.run, "killed", h.registry);
    assert.equal(h.run.status, "killed");
    await tick();
    if (mode === "stubborn") {
      assert.equal(h.run.processOpen, true, "an unproven exit keeps the reservation");
      assert.equal(holdsSlot(h.run), true);
    } else {
      assert.equal(h.run.processOpen, undefined, "a proven exit releases it");
      assert.equal(holdsSlot(h.run), false);
      assert.ok(notified >= 1, "the release is notified, so a broker waiting on it finishes");
    }
    clearTimeout(h.run.timeoutTimer);
  }
});

test("N5 a parent that settled before reconcile registered its leaf: the late rebind cancels that leaf instead of waiting for it", { timeout: 15000 }, async () => {
  const { h, parent, tee, owner, attach } = await herdrParent();
  tee(start("late"), update("late"));
  await until(() => owner.spawned.length === 1, "one leaf");
  const leaves = owner.registry.list().filter(r => r.parentRunId === parent.id);
  await Promise.all(leaves.map(l => writeRecord(l)));
  await reload(owner);
  // The parent's child finished while no lead owned it; the next owner readopts the parent first.
  tee({ type: "agent_settled" }); h.exit();
  const owner2 = lead(), done = deferred();
  owner2.broker.reconciling(done.promise);
  const { run: next, done: settled } = readoptHerdrRun(JSON.parse(readFileSync(parent.recordPath, "utf8")), { registry: owner2.registry, runtime: h.runtime, sessionId: "s2" });
  attach(next);
  assert.equal((await settled).status, "completed");
  // Only now does reconcile register the leaf, then finish.
  const old = leaves[0]!;
  const record = JSON.parse(readFileSync(old.recordPath, "utf8")) as RunRecord;
  const leaf = buildOrphanRun(record, "running");
  leaf.herdrOwnership = claimHerdrOwner(dirname(leaf.recordPath), { epoch: herdrModuleEpoch, sessionId: "s2", pid: process.pid, startTime: readProcessStartTime(process.pid),
    socketPath: leaf.herdr!.socketPath, runId: leaf.id, launchNonce: leaf.herdr!.launchNonce, at: Date.now() });
  leaf.transport = old.transport;
  owner2.registry.register(leaf);
  done.resolve(); await tick();
  assert.match(answer(parent, "late")?.reason ?? "", /^cancelled: parent .* ended \(completed\)/);
  assert.equal(leaf.status, "killed", "no live leaf is left working for a settled parent");
  assert.equal(owner2.spawned.length, 0);
  await handleSessionShutdown({ reason: "reload" }, { runs: owner2.registry.list(), resetSanitizer() {}, delegation: owner2.broker });
});

test("N5 reload: a herdr parent survives; leaves it cannot hand over (subprocess, queued) are cancelled by name while it is still owned", { timeout: 15000 }, async () => {
  const { parent, tee, owner } = await herdrParent(lead(2, "subprocess"));
  for (const id of ["s1", "s2", "s3"]) tee(start(id), update(id));
  await until(() => owner.spawned.length === 2 && owner.registry.list().some(r => r.parentRunId === parent.id && r.status === "queued"), "two running, one queued");
  const leaves = owner.registry.list().filter(r => r.parentRunId === parent.id);
  await reload(owner);
  for (const id of ["s1", "s2", "s3"]) assert.equal(answer(parent, id)?.reason, `cancelled: ${HERDR_RELOAD_CANCELLED}`, id);
  assert.deepEqual(leaves.map(l => l.status), ["killed", "killed", "killed"], "running leaves stopped, the queued one withdrawn");
  assert.equal(owner.queue.size(), 0);
  assert.equal(parent.status, "running", "the herdr parent itself survives the reload (R6 is subprocess-only)");
  assert.equal(owner.spawned.length, 2, "nothing launched while cancelling");
});
