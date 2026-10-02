/**
 * N5: a readopted delegating herdr effort writer. It starts without effort authority
 * (H10 `herdrEffortAuthorized=false`) and M5 `recoverEffort` grants it only after
 * startup reconcile. Its replayed claimed call must be decided once, after that
 * barrier, whatever order the replay and the grant arrive in; with no grant it is only
 * observed. Each lead below runs index.ts's startup order on the production pieces:
 * broker barrier, then `reconcileOrphansAtStartup` attaching through `readoptHerdrRun`,
 * then `recoverEffort`, then the barrier resolves. Each test gets a private HOME, so a
 * reconcile scan sees only that test's own records.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { git } from "./helpers/effort-integration.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { RunRegistry, runsRoot, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { createRunPipeline, readoptHerdrRun } from "../src/run-pipeline.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { buildOrphanRun, readProcessStartTime, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { claimHerdrOwner, herdrModuleEpoch } from "../src/herdr/ownership.ts";
import { openEffort } from "../src/effort/open.ts";
import { addEffortMember, readEffort } from "../src/effort/store.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { createWorktree } from "../src/worktree.ts";
import { delegatePaths } from "../src/delegation.ts";
import type { Run } from "../src/types.ts";

sandboxPi();
const SESSION = "lead-session";
const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;
const tick = () => new Promise(r => setTimeout(r, 60));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 5)); }
}
const gate = () => { let open!: () => void; const promise = new Promise<void>(r => { open = r; }); return { promise, open }; };
type Fixture = ReturnType<typeof herdrFixture>;

/** Every lead instance a test made; afterEach quiesces them all, so a failed test never hangs the file. */
const leads: { registry: RunRegistry; broker: DelegationBroker }[] = [];
afterEach(async () => {
  for (const { registry, broker } of leads.splice(0)) {
    try { await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer() {}, delegation: broker }); } catch { /* already fenced or released */ }
  }
});

/** A lead instance whose queue launches each leaf as a herdr pipeline on its own fake CLI. */
function lead(fixtures: Map<string, Fixture>, leafPrefix: string) {
  const registry = new RunRegistry(), spawned: SpawnOptions[] = [];
  let n = 0;
  const queue = new SpawnQueue(registry, 4, 1, (o: SpawnOptions) => {
    spawned.push(o);
    const id = o.preAllocatedId ?? `${leafPrefix}-scout-${++n}`;
    const leaf = herdrFixture("running", { id, cwd: o.cwd, dir: join(runsRoot(), id), run: { persona: o.persona.name, depth: 2, delegateAllow: [],
      parentRunId: o.delegation!.parentRunId, delegateToolCallId: o.delegation!.delegateToolCallId, parentSessionId: SESSION } });
    fixtures.set(id, leaf);
    registry.register(leaf.run);
    return { run: leaf.run, done: createRunPipeline(leaf.run, [], { ...leaf.opts, registry, timeoutMs: 600000 }) };
  });
  const broker = new DelegationBroker({ registry, queue, env: {} });
  registry.delegation = broker;
  leads.push({ registry, broker });
  return { registry, queue, broker, spawned };
}

/**
 * The first lead: a running delegating herdr parent (an effort writer when asked) that
 * claims call e1, whose herdr leaf is launched and accepted; then that lead reloads,
 * handing the leaf over unanswered.
 */
async function claimedThenReloaded(opts: { effort: boolean; leafPrefix?: string }) {
  process.env.HOME = tmpDir("n5-effort-home-");
  const cwd = tmpDir("n5-effort-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(cwd), "scout.md"), doc("scout", "read_only: true\n"));
  const id = "lead-n5e", fixtures = new Map<string, Fixture>();
  let effortRun: Partial<Run> = {}, effort: ReturnType<typeof openEffort> | undefined;
  if (opts.effort) {
    const repo = tmpDir("n5-effort-repo-");
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
    writeFileSync(join(repo, "base"), "base"); writeFileSync(join(repo, ".gitignore"), ".worktrees/\n"); git(repo, "add", "base", ".gitignore"); git(repo, "commit", "-m", "base");
    effort = openEffort(repo, "n5-writer", SESSION, { verify: "test -f base" });
    const path = join(repo, ".worktrees", "conductor-wt", id);
    createWorktree({ gitRoot: repo, worktreePath: path, branch: "writer" }, { from: effort.baseOid });
    effortRun = { worktreePath: path, worktreeBranch: "writer", worktreeBaseBranch: "main",
      effort: { owner: effort.owner, name: effort.name, gitRoot: repo, role: "writer", spawnBase: effort.baseOid } };
    addEffortMember(effort, id);
  }
  const h = herdrFixture("running", { id, cwd, dir: join(runsRoot(), id), run: { persona: "lead", depth: 1, delegateAllow: ["scout"], parentSessionId: SESSION, ...effortRun } });
  fixtures.set(id, h);
  const first = lead(fixtures, opts.leafPrefix ?? "zz");
  first.registry.register(h.run);
  void createRunPipeline(h.run, [], { ...h.opts, registry: first.registry, timeoutMs: 600000, onEvent: (r, e) => first.broker.observe(r, e, cwd) });
  if (h.run.transport?.kind !== "herdr") throw new Error("transport");
  await h.run.transport.ready;
  h.emit({ type: "tool_execution_start", toolCallId: "e1", toolName: "delegate", args: { persona: "scout", task: "inspect e1" } });
  h.emit({ type: "tool_execution_update", toolCallId: "e1", toolName: "delegate" });
  h.run.transport.drain();
  await until(() => first.spawned.length === 1, "the first lead's leaf");
  const leafRun = first.registry.list().find(r => r.parentRunId === id)!;
  if (leafRun.transport?.kind !== "herdr") throw new Error("leaf transport");
  await leafRun.transport.ready;
  assert.equal(leafRun.transport.initialAccepted, true);
  await handleSessionShutdown({ reason: "reload" }, { runs: first.registry.list(), resetSanitizer() {}, delegation: first.broker });
  const paths = delegatePaths(dirname(h.run.recordPath), "e1");
  assert.equal(existsSync(paths.claim), true); assert.equal(existsSync(paths.response), false, "handed over unanswered");
  return { h, id, effort, fixtures, leaf: fixtures.get(leafRun.id)!, leafId: leafRun.id, paths, claim: readFileSync(paths.claim, "utf8") };
}

/**
 * The next lead, in index.ts's order. `hold` keeps the parent's reattach inspection
 * (its first `pane get` after attach) waiting, so the test can order the replay
 * against the grant: the replay reaches the broker only once it is opened.
 */
async function nextLead(s: Awaited<ReturnType<typeof claimedThenReloaded>>) {
  const owner = lead(s.fixtures, "never"), barrier = gate(), inspection = gate();
  owner.broker.reconciling(barrier.promise);
  const json = s.h.cli.json;
  let armed = false;
  s.h.cli.json = async (...args) => {
    if (armed && args[0][1] === "get") { armed = false; await inspection.promise; }
    return json(...args);
  };
  const adopted = new Map<string, Run>();
  const result = await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry: owner.registry, isAlive: () => false, now: Date.now(), selfSessionId: SESSION,
    herdrProbe: record => s.fixtures.get(record.id)?.runtime.probeRecord(buildOrphanRun(record, record.status)) ?? Promise.resolve("other-socket"),
    attachHerdr: record => {
      if (record.id === s.id) armed = true;
      adopted.set(record.id, readoptHerdrRun(record, { registry: owner.registry, runtime: s.fixtures.get(record.id)!.runtime, sessionId: SESSION }).run);
    } });
  assert.deepEqual(result.readopted.sort(), [s.id, s.leafId].sort(), JSON.stringify(result.errors));
  const parent = adopted.get(s.id)!, leaf = adopted.get(s.leafId)!;
  /** Open the inspection and wait until the replay from the launch boundary has reached the broker. */
  const replay = async () => {
    inspection.open();
    if (parent.transport?.kind !== "herdr") throw new Error("transport");
    await parent.transport.ready; parent.transport.drain();
    assert.equal(parent.transport.observable, true, "the replay is attached");
  };
  const grant = async () => { const r = await recoverEffort(readEffort(s.effort!.gitRoot, s.effort!.name)!, { registry: owner.registry, sessionId: SESSION }); await r.done; };
  const reconciled = async () => { barrier.open(); await tick(); };
  return { owner, parent, leaf, replay, grant, reconciled };
}

const response = (s: { paths: { response: string } }) => existsSync(s.paths.response) ? JSON.parse(readFileSync(s.paths.response, "utf8")) : undefined;
/** The leaf's own pane child settles and exits; its readopted pipeline finalizes it. */
const finishLeaf = (s: { leaf: Fixture }) => { s.leaf.emit({ type: "agent_settled" }); s.leaf.exit(); };

async function rebound(s: Awaited<ReturnType<typeof claimedThenReloaded>>, next: Awaited<ReturnType<typeof nextLead>>) {
  assert.equal(next.owner.spawned.length, 0, "a claimed call is never re-spawned");
  assert.equal(next.parent.pendingDelegations, 1, "the claimed call is rebound as one awaiting call");
  assert.equal(response(s), undefined, "nothing is answered before the leaf finishes");
  finishLeaf(s);
  await until(() => !!response(s), "the rebound leaf's answer");
  const r = response(s);
  assert.deepEqual([r.ok, r.agentId, r.status, r.parentRunId], [true, s.leafId, "completed", s.id]);
  assert.match(r.envelope, /Final verified evidence/);
  assert.equal(next.parent.pendingDelegations, 0);
  assert.deepEqual(readdirSync(dirname(s.paths.claim)).sort(), ["e1.claim.json", "e1.json"], "one claim, one answer");
}

async function untouched(s: Awaited<ReturnType<typeof claimedThenReloaded>>, next: Awaited<ReturnType<typeof nextLead>>) {
  assert.equal(next.owner.spawned.length, 0);
  assert.equal(next.parent.pendingDelegations ?? 0, 0, "no awaiting credit");
  assert.equal(next.leaf.status, "running", "the leaf is not cancelled");
  // Even the leaf finishing produces nothing: the call is only observed.
  finishLeaf(s);
  await until(() => next.leaf.status === "completed", "the leaf settles on its own");
  await tick();
  assert.equal(response(s), undefined, "no answer");
  assert.deepEqual(readdirSync(dirname(s.paths.claim)), ["e1.claim.json"], "no new claim or response");
  assert.equal(readFileSync(s.paths.claim, "utf8"), s.claim, "the claim is untouched");
}

for (const scan of ["parent-first", "child-first"] as const) {
  test(`N5 effort writer (${scan} scan): replay, then the M5 grant, then the barrier: the claimed call is rebound and answered once`, { timeout: 20000 }, async () => {
    const s = await claimedThenReloaded({ effort: true, leafPrefix: scan === "child-first" ? "aa" : "zz" });
    const next = await nextLead(s);
    assert.equal(next.parent.herdrEffortAuthorized, false, "a readopted writer starts without effort authority");
    await next.replay();
    await next.grant();
    assert.equal(next.parent.herdrEffortAuthorized, true, "M5 recovery granted it");
    await next.reconciled();
    await rebound(s, next);
  });
  test(`N5 effort writer (${scan} scan): the M5 grant before the replay, then the barrier: rebound and answered once`, { timeout: 20000 }, async () => {
    const s = await claimedThenReloaded({ effort: true, leafPrefix: scan === "child-first" ? "aa" : "zz" });
    const next = await nextLead(s);
    await next.grant();
    assert.equal(next.parent.herdrEffortAuthorized, true);
    await next.replay();
    await next.reconciled();
    await rebound(s, next);
  });
}

test("N5 a plain (non-effort) herdr delegator: replay then the barrier rebinds its claimed call", { timeout: 20000 }, async () => {
  const s = await claimedThenReloaded({ effort: false });
  const next = await nextLead(s);
  await next.replay();
  await next.reconciled();
  await rebound(s, next);
});

test("N5 effort writer with no effort grant: the replayed claimed call is only observed (no claim, answer, credit or cancel)", { timeout: 20000 }, async () => {
  const s = await claimedThenReloaded({ effort: true });
  const next = await nextLead(s);
  await next.replay();
  await next.reconciled();
  assert.equal(next.parent.herdrEffortAuthorized, false);
  await untouched(s, next);
});

test("N5 effort writer granted only after the barrier: still only observed; a late grant revives nothing", { timeout: 20000 }, async () => {
  const s = await claimedThenReloaded({ effort: true });
  const next = await nextLead(s);
  await next.replay();
  await next.reconciled();
  await next.grant();
  await tick();
  await untouched(s, next);
});

test("N5 the parent's owner generation changes while its call is deferred: nothing is decided for it", { timeout: 20000 }, async () => {
  const s = await claimedThenReloaded({ effort: false });
  const next = await nextLead(s);
  await next.replay();
  // Another lead takes the stream over while the barrier is still pending.
  const p = next.parent, dir = dirname(p.recordPath);
  p.herdrOwnership!.release();
  claimHerdrOwner(dir, { epoch: "another-lead", sessionId: "other", pid: process.pid, startTime: readProcessStartTime(process.pid), socketPath: p.herdr!.socketPath, runId: p.id, launchNonce: p.herdr!.launchNonce, at: Date.now() });
  await next.reconciled();
  await untouched(s, next);
});

test("N5 a deferred call of an older invocation is never decided under the parent's newer launch", { timeout: 20000 }, async () => {
  const s = await claimedThenReloaded({ effort: false });
  const next = await nextLead(s);
  await next.replay();
  // The same run object starts a newer invocation (as a resume would): new owner generation and launch nonce.
  const p = next.parent, dir = dirname(p.recordPath);
  p.herdrOwnership!.release();
  p.herdrOwnership = claimHerdrOwner(dir, { epoch: herdrModuleEpoch, sessionId: SESSION, pid: process.pid, startTime: readProcessStartTime(process.pid), socketPath: p.herdr!.socketPath, runId: p.id, launchNonce: "newer-launch", at: Date.now() });
  p.herdr = { ...p.herdr!, launchNonce: "newer-launch", ownerGeneration: p.herdrOwnership.identity.generation };
  await next.reconciled();
  await untouched(s, next);
});
