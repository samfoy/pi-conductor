// M6b: `ask`/`off` policy and the human-only `/conductor effort resolve <run>`.
// First import: throws on an inherited herdr/child scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, until } from "./helpers/effort-integration.ts";
import { fakeMergers, land, mergerFixture, settle, trailerCount } from "./helpers/effort-merger.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { command, conflicted, preserving, type Fixture } from "./helpers/effort-resolve.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { registerTools } from "../src/tools.ts";
import { RunRegistry, runsRoot } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { acquireClaim, effortDir, readEffort, releaseClaim, writeEffort } from "../src/effort/store.ts";
import { effortOwner } from "../src/effort/open.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { readProcessStartTime, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { toRunRecord, type Run } from "../src/types.ts";
import type { EffortPolicy } from "../src/effort/policy.ts";

sandboxPi();
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const poll = async (cond: () => boolean, what = "condition", ms = 8000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`not reached: ${what}`); await delay(10); } };
const resolveBoth = (cand: string) => { writeFileSync(join(cand, "base"), "landed\nwriter\n"); git(cand, "add", "--", "base"); git(cand, "commit", "--no-edit"); return git(cand, "rev-parse", "HEAD"); };
/** Long enough for a wrongly started generation to reach the merger launch. */
const SETTLE_MS = 300;

/** Run and effort records follow HOME; a private one per test keeps a stray generation from leaking across tests. */
const freshHome = () => { process.env.HOME = tmpDir("m6b-home-"); };

function setup(t: test.TestContext, policy: Partial<EffortPolicy> = { merger: "ask" }, verify = "true", writer: Record<string, string> = { base: "writer\n" }, conflict = true) {
  freshHome();
  const f = mergerFixture(t, { policy, verify });
  const a = f.writer("builder-a", writer);
  const landed = conflict ? land(f.root, f.record.intRef, { base: "landed\n" }) : f.base;
  return { f, a, landed, cards: [] as string[] };
}

function registeredTools(f: Fixture) {
  const tools = new Map<string, { name: string; parameters: unknown; execute: (...a: unknown[]) => Promise<any> }>();
  const queue = new SpawnQueue(f.registry, 4, 1);
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, { getCwd: () => f.root, getRegistry: () => f.registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(f.registry),
    getParentMessages: () => [], openFocusedOverlay: () => {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }), pushCompletionNotification: () => {}, getSessionId: () => "owner" } as never, {});
  return tools;
}

/** Moves the private writer branch for a refusal case; the returned undo runs before the fixture's retention check. */
function moveSource(x: { a: Run; undo?: () => void }) {
  const head = git(x.a.worktreePath!, "rev-parse", "HEAD");
  writeFileSync(join(x.a.worktreePath!, "extra"), "x\n"); git(x.a.worktreePath!, "add", "extra"); git(x.a.worktreePath!, "commit", "-m", "more");
  x.undo = () => { git(x.a.worktreePath!, "reset", "-q", "--hard", head); };
}

/** Every durable or in-memory effect a refused resolve must not have. */
function effects(f: Fixture, a: Run): string {
  const listing = (dir: string) => existsSync(dir) ? readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    return [name, statSync(path).isDirectory() ? readdirSync(path).sort() : readFileSync(path, "utf8")];
  }) : [];
  return JSON.stringify({
    record: readFileSync(a.recordPath, "utf8"), memory: toRunRecord(a), effort: listing(effortDir(f.root, "probe")), driver: listing(effortDir(f.root, "integration-driver")),
    refs: git(f.root, "for-each-ref", "--format=%(refname) %(objectname)"), worktrees: git(f.root, "worktree", "list", "--porcelain"), runs: readdirSync(runsRoot()).sort(),
  });
}

test("M6b merger:ask settles a conflict as merge_conflict with zero mergers and one card; status hints only the human command; the registered effort tool refuses resolve", { timeout: 20000 }, async t => {
  const { f, a, cards } = setup(t);
  const m = fakeMergers(f.registry);
  const first = await Promise.race([conflicted(f, a, cards).then(() => "settled"), m.nth(0).then(() => "an automatic merger launched under ask")]);
  assert.equal(first, "settled", "ask launches no automatic merger");
  assert.equal(a.status, "merge_conflict"); assert.equal(a.integration!.reason, "conflict"); assert.equal(m.calls.length, 0);
  assert.deepEqual(cards, ["builder-a:merge_conflict"], "the original outcome card, once");
  assert.match(a.errorMessage!, /\/conductor effort resolve builder-a/, "the card names the human command");
  const tools = registeredTools(f);
  const status = await tools.get("ensemble_status")!.execute("s", {});
  const summary = status.details.finished.find((r: { id: string }) => r.id === "builder-a");
  assert.match(summary.human_resolution, /^\/conductor effort resolve builder-a \(interactive human confirmation only/);
  assert.ok(!summary.available_actions.includes("resolve"), "no executable resolve action token");
  assert.match(status.content[0].text, /human_resolution=\/conductor effort resolve builder-a/);
  const before = effects(f, a);
  const refused = await tools.get("ensemble_effort")!.execute("e", { action: "resolve", effort: "probe" });
  assert.match(refused.content[0].text, /Only effort open\/status/);
  for (const tool of tools.values()) assert.doesNotMatch(JSON.stringify(tool.parameters), /"const":"resolve"/, `${tool.name} exposes no resolve action`);
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, 0, "the model-callable route spawned nothing");
  assert.equal(effects(f, a), before); assert.deepEqual(cards, ["builder-a:merge_conflict"]);
});

test("M6b /conductor effort resolve: one confirmed merger generation, the command returns before the merger settles, and the hooked re-entry delivers a second card exactly once", { timeout: 20000 }, async t => {
  const { f, a, landed, cards } = setup(t);
  const m = fakeMergers(f.registry);
  await conflicted(f, a, cards);
  const marker = join(f.root, ".git", "hook-marker");
  f.hook(`echo "$(git rev-parse --show-toplevel)" >> "${marker}"`);
  const source = a.integration!.sourceHead!;
  const c = command(f, cards);
  let atPrompt = "";
  const before = effects(f, a);
  await c.resolve("builder-a", c.ctx(() => { atPrompt = effects(f, a); return true; }));
  assert.equal(atPrompt, before, "nothing is written before the human answers");
  assert.equal(c.prompts.length, 1);
  const body = c.prompts[0]!.body;
  for (const fact of [source, landed, f.record.baseOid.slice(0, 12), "main", a.worktreeBranch!, a.worktreePath!, "conflict", "ONE driver-owned merger", "No second attempt", "not resent"]) assert.ok(body.includes(fact), `plan shows ${fact}:\n${body}`);
  assert.match(c.notes.at(-1)!.message, /accepted/i, JSON.stringify(c.notes));
  assert.equal(a.status, "integrating", "the command returned with the generation queued, not after the model run");
  const disk = JSON.parse(readFileSync(a.recordPath, "utf8"));
  assert.equal(disk.status, "integrating");
  assert.deepEqual({ source: disk.integration.resolveRequested.sourceHead, tip: disk.integration.resolveRequested.tip }, { source, tip: landed });
  assert.equal(disk.integration.previous.reason, "conflict"); assert.equal(disk.integration.previous.delivery, "attempted");
  assert.equal(disk.integration.delivery, undefined, "a fresh delivery ledger for the new generation");
  const merger = await m.nth(0);
  assert.equal(m.claims[0]!.sourceHead, source, "the merger claim was durable before launch");
  assert.equal(a.integration!.state, "resolving");
  resolveBoth(merger.cwd); await settle(f.registry, merger, "Resolved.");
  await until(f.registry, a, r => r.status === "completed");
  await poll(() => cards.length === 2 && !a.integrationSettlement, "second card");
  assert.deepEqual(cards, ["builder-a:merge_conflict", "builder-a:completed"]);
  const tip = f.tip();
  assert.equal(git(f.root, "show", "-s", "--format=%P", tip), landed);
  for (const trailer of ["Conductor-Effort: probe", "Conductor-Run: builder-a", `Conductor-Merger: ${merger.id}`]) assert.equal(trailerCount(f.root, tip, trailer), 1, trailer);
  const hooked = readFileSync(marker, "utf8").trim().split("\n");
  assert.equal(hooked.length, 2); assert.equal(hooked[0], merger.cwd, "the merger's own commit ran the ordinary hook");
  assert.match(hooked[1]!, /\/conductor-cand\/probe\/builder-a-[0-9a-f-]{36}$/, "then the driver's re-entry commit ran it in a fresh candidate");
  assert.equal(a.integration!.previous!.reason, "conflict");
  await delay(SETTLE_MS);
  const after = effects(f, a);
  await c.resolve("builder-a", c.ctx(() => true));
  assert.equal(c.notes.at(-1)!.level, "error"); assert.equal(c.prompts.length, 1, "an ineligible repeat is refused before any prompt");
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, 1, "no second attempt"); assert.equal(effects(f, a), after); assert.equal(cards.length, 2);
});

test("M6b a twice-red verify under ask is resolvable: the confirmed generation re-verifies, parks on the new red candidate, and the merger fix integrates", { timeout: 20000 }, async t => {
  const { f, a, cards } = setup(t, { merger: "ask" }, "test ! -f broken", { change: "work\n", broken: "x\n" }, false);
  const m = fakeMergers(f.registry);
  await conflicted(f, a, cards);
  assert.equal(a.integration!.reason, "verify_failed"); assert.equal(m.calls.length, 0);
  const c = command(f, cards);
  await c.resolve("builder-a", c.ctx(() => true));
  const merger = await m.nth(0);
  assert.equal(m.claims[0]!.kind, "verify_failed");
  git(merger.cwd, "rm", "-q", "--", "broken"); git(merger.cwd, "commit", "-q", "-m", "fix: drop broken");
  await settle(f.registry, merger, "Fixed.");
  await until(f.registry, a, r => r.status === "completed");
  await poll(() => cards.length === 2, "second card");
  assert.throws(() => git(f.root, "show", `${a.landedCommit}:broken`));
  assert.deepEqual(cards, ["builder-a:merge_conflict", "builder-a:completed"]);
});

for (const [name, arrange, expected, prompted] of [
  ["a declined confirmation", (_x: any) => ({ answer: () => false }), /declined; nothing changed/, 1],
  ["a missing UI", () => ({ hasUI: false }), /interactive human/, 0],
  ["a child scope", () => ({ child: true }), /interactive human/, 0],
  ["a foreign live session", (x: any) => { x.c.state.session = "intruder"; return {}; }, /live.*no takeover/, 0],
  ["an unknown run", () => ({ args: "builder-nope" }), /not found/, 0],
  ["extra arguments", () => ({ args: "builder-a --force" }), /usage: effort resolve <exact-run-id>/, 0],
  ["a changed source", (x: any) => { moveSource(x); return {}; }, /source branch head changed/, 0],
  ["a dirty source", (x: any) => { writeFileSync(join(x.a.worktreePath, "untracked"), "x\n"); return {}; }, /dirty/, 0],
  ["a legacy unreconstructable gate", (x: any) => { x.a.effort.gate = undefined; return {}; }, /hook is unknown.*requeue/, 0],
  ["a configured gate without its recorded pass", (x: any) => { x.a.effort.gate = { command: "true", source: "project", timeoutSeconds: 5 }; return {}; }, /hook pass is not recorded/, 0],
] as const) test(`M6b ${name} has zero effects and launches nothing`, { timeout: 20000 }, async t => {
  const x = setup(t) as ReturnType<typeof setup> & { c: ReturnType<typeof command>; undo?: () => void };
  const m = fakeMergers(x.f.registry);
  await conflicted(x.f, x.a, x.cards);
  x.c = command(x.f, x.cards);
  const opts = (arrange as (x: unknown) => { answer?: () => boolean; hasUI?: boolean; child?: boolean; args?: string })(x);
  const before = effects(x.f, x.a);
  if (opts.child) process.env.CONDUCTOR_SUBAGENT = "1";
  try { await x.c.resolve(opts.args ?? "builder-a", x.c.ctx(opts.answer ?? (() => true), opts.hasUI ?? true)); }
  finally { delete process.env.CONDUCTOR_SUBAGENT; }
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, 0, `no merger spawned after ${name}`);
  assert.match(x.c.notes.at(-1)!.message, expected, JSON.stringify(x.c.notes));
  assert.equal(x.c.prompts.length, prompted, "refused before any prompt unless the human declined");
  assert.equal(effects(x.f, x.a), before); assert.deepEqual(x.cards, ["builder-a:merge_conflict"]);
  x.undo?.();
});

for (const [policy, expected] of [["off", /"off": resolution refused/], ["auto", /attempt already spent/]] as const) test(`M6b merger:${policy} refuses resolution with zero effects`, { timeout: 20000 }, async t => {
  const { f, a, cards } = setup(t, { merger: policy });
  const m = fakeMergers(f.registry);
  const settling = conflicted(f, a, cards);
  if (policy === "auto") await settle(f.registry, await m.nth(0), "## Verdict: cannot-resolve");
  await settling;
  assert.equal(a.status, "merge_conflict");
  const c = command(f, cards), launched = m.calls.length, before = effects(f, a);
  await c.resolve("builder-a", c.ctx(() => true));
  assert.match(c.notes.at(-1)!.message, expected);
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, launched, "no merger spawned"); assert.equal(c.prompts.length, 0); assert.equal(effects(f, a), before);
});

test("M6b merger:auto without a spent attempt (no launcher when it conflicted) is resolvable once", { timeout: 20000 }, async t => {
  const { f, a, cards } = setup(t, { merger: "auto" });
  await conflicted(f, a, cards);
  assert.equal(a.integration!.merger, undefined);
  const m = fakeMergers(f.registry), c = command(f, cards);
  await c.resolve("builder-a", c.ctx(() => true));
  resolveBoth((await m.nth(0)).cwd); await settle(f.registry, m.launched[0]!, "Resolved.");
  await until(f.registry, a, r => r.status === "completed");
  await poll(() => cards.length === 2, "second card");
});

for (const [name, change, expected] of [
  ["the source moves", (x: ReturnType<typeof setup> & { undo?: () => void }) => { moveSource(x); }, /source branch head changed|changed while confirmation/],
  ["the integration tip moves", (x: ReturnType<typeof setup>) => { land(x.f.root, x.f.record.intRef, { other: "o\n" }); }, /changed while confirmation was pending/],
  ["a live foreign session takes the lease", (x: ReturnType<typeof setup>) => {
    const lock = join(effortDir(x.f.root, "probe"), "effort.lock"), record = readEffort(x.f.root, "probe")!;
    releaseClaim(lock, record.owner);
    const owner = acquireClaim(lock, effortOwner("intruder"));
    writeEffort({ ...record, owner, updatedAt: Date.now() });
  }, /owner|changed while confirmation/],
  ["the effort is paused", (x: ReturnType<typeof setup>) => { writeEffort({ ...readEffort(x.f.root, "probe")!, status: "paused", pausedReason: "operator pause", pausedRun: "other" }); }, /paused|changed while confirmation/],
] as const) test(`M6b ${name} while the confirmation is awaited: the confirmed resolve is rejected and the merge_conflict preserved`, { timeout: 20000 }, async t => {
  const x: ReturnType<typeof setup> & { undo?: () => void } = setup(t);
  const m = fakeMergers(x.f.registry);
  await conflicted(x.f, x.a, x.cards);
  const c = command(x.f, x.cards);
  const record = readFileSync(x.a.recordPath, "utf8");
  await c.resolve("builder-a", c.ctx(() => { change(x); return true; }));
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, 0, `no merger spawned after ${name} during confirmation`);
  assert.equal(c.prompts.length, 1);
  assert.equal(c.notes.at(-1)!.level, "error", JSON.stringify(c.notes)); assert.match(c.notes.at(-1)!.message, expected);
  assert.equal(readFileSync(x.a.recordPath, "utf8"), record, "prior failure, card ledger and record preserved");
  assert.equal(x.a.status, "merge_conflict"); assert.equal(x.a.integration!.resolveRequested, undefined); assert.deepEqual(x.cards, ["builder-a:merge_conflict"]);
  x.undo?.();
});

test("M6b two concurrent confirmations launch one generation and one attempt", { timeout: 20000 }, async t => {
  const { f, a, cards } = setup(t);
  const m = fakeMergers(f.registry);
  await conflicted(f, a, cards);
  const c = command(f, cards);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const both = [c.resolve("builder-a", c.ctx(async () => { await gate; return true; })), c.resolve("builder-a", c.ctx(async () => { await gate; return true; }))];
  await poll(() => c.prompts.length === 2, "both prompts open");
  release(); await Promise.all(both);
  assert.equal(c.notes.filter(n => /accepted/i.test(n.message)).length, 1, JSON.stringify(c.notes));
  assert.equal(c.notes.filter(n => n.level === "error").length, 1);
  const merger = await m.nth(0);
  await delay(SETTLE_MS);
  assert.equal(m.calls.length, 1, "one attempt");
  resolveBoth(merger.cwd); await settle(f.registry, merger, "Resolved.");
  await until(f.registry, a, r => r.status === "completed");
  await poll(() => cards.length === 2, "second card");
  await delay(SETTLE_MS);
  assert.deepEqual(cards, ["builder-a:merge_conflict", "builder-a:completed"]); assert.equal(m.calls.length, 1);
});

// ── Real-process crash boundaries ───────────────────────────────────────────

const CHILD = fileURLToPath(new URL("./helpers/resolve-crash-child.ts", import.meta.url));

function crashRepo() {
  freshHome();
  const root = tmpDir("m6b-crash-repo-"), evidence = tmpDir("m6b-crash-evidence-");
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "T"); git(root, "config", "user.email", "t@t");
  writeFileSync(join(root, "base"), "original\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", "base", ".gitignore"); git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD"), index = readFileSync(join(root, ".git", "index"));
  const worktree = join(root, ".worktrees", "builder-a");
  git(root, "worktree", "add", "-b", "conductor-wt/builder-a", worktree, base);
  writeFileSync(join(worktree, "base"), "writer\n"); git(worktree, "add", "base"); git(worktree, "commit", "-m", "test: builder-a");
  const head = git(worktree, "rev-parse", "HEAD");
  const unchanged = () => {
    assert.equal(git(root, "rev-parse", "HEAD"), base); assert.equal(git(root, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.deepEqual(readFileSync(join(root, ".git", "index")), index); assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-parse", "conductor-wt/builder-a"), head, "writer branch retained");
  };
  return { root, evidence, head, unchanged, tip: () => git(root, "rev-parse", "refs/heads/conductor-int/probe") };
}

/** A test-owned child: its own SIGKILL is the evidence; the safety net only reaps and is never evidence. */
async function child(t: test.TestContext, repo: ReturnType<typeof crashRepo>, mode: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD, repo.root, mode, repo.evidence], { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe"] });
  const identity = { pid: proc.pid!, startTime: readProcessStartTime(proc.pid!) };
  let stderr = ""; proc.stderr!.on("data", d => { stderr += d; });
  const exited = once(proc, "exit");
  let safetyNet = false;
  const timer = setTimeout(() => {
    safetyNet = true;
    if (readProcessStartTime(identity.pid) === identity.startTime && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }, 30000);
  await exited; clearTimeout(timer);
  t.diagnostic(`child ${mode} pid ${identity.pid} exit=${proc.exitCode} signal=${proc.signalCode}${stderr ? ` stderr=${stderr.slice(-400)}` : ""}`);
  assert.equal(safetyNet, false, `child ${mode} ended on its own`);
  return { code: proc.exitCode, signal: proc.signalCode, cards: () => existsSync(join(repo.evidence, `cards-${mode}`)) ? readFileSync(join(repo.evidence, `cards-${mode}`), "utf8").trim().split("\n") : [] };
}

async function adopt(repo: ReturnType<typeof crashRepo>, session: string, cards: string[]) {
  const registry = new RunRegistry(), m = fakeMergers(registry);
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: () => false, selfSessionId: session, now: Date.now() });
  const recover = () => recoverEffort(readEffort(repo.root, "probe")!, { registry, sessionId: session, onComplete: r => cards.push(`${r.id}:${r.status}`) });
  return { registry, m, recover };
}

test("M6b a resolve adopting a dead owner's effort starts one generation through the shared M5 adoption", { timeout: 60000 }, t => preserving(t, async () => {
  const repo = crashRepo();
  const first = await child(t, repo, "conflict");
  assert.equal(first.code, 0); assert.deepEqual(first.cards(), ["builder-a:merge_conflict"]);
  const registry = new RunRegistry(), m = fakeMergers(registry), cards: string[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: () => false, selfSessionId: "lead", now: Date.now() });
  const a = registry.get("builder-a")!;
  assert.equal(a.status, "merge_conflict");
  const f = { root: repo.root, registry } as unknown as Fixture;
  const c = command(f, cards); c.state.session = "lead";
  await c.resolve("builder-a", c.ctx(() => true));
  assert.match(c.prompts[0]!.body, /adopt the effort from dead owner owner-conflict/);
  assert.match(c.notes.at(-1)!.message, /accepted/i, JSON.stringify(c.notes));
  assert.equal(readEffort(repo.root, "probe")!.owner.sessionId, "lead");
  resolveBoth((await m.nth(0)).cwd); await settle(registry, m.launched[0]!, "Resolved.");
  await until(registry, a, r => r.status === "completed");
  await poll(() => cards.length === 1, "resolved card");
  assert.deepEqual(cards, ["builder-a:completed"]); assert.equal(m.calls.length, 1);
  repo.unchanged();
}));

test("M6b a crash between the acknowledged generation WAL and enqueue recovers once: one attempt, one more card, repeated recovery is inert", { timeout: 60000 }, t => preserving(t, async () => {
  const repo = crashRepo();
  const crashed = await child(t, repo, "resolve-crash");
  assert.equal(crashed.signal, "SIGKILL"); assert.deepEqual(crashed.cards(), ["builder-a:merge_conflict"]);
  const wal = JSON.parse(readFileSync(join(repo.evidence, "generation-acknowledged"), "utf8"));
  assert.equal(wal.status, "integrating"); assert.equal(wal.integration.state, "queued");
  assert.equal(wal.integration.resolveRequested.sourceHead, repo.head); assert.equal(wal.integration.previous.delivery, "attempted");
  assert.equal(existsSync(join(repo.evidence, "unreachable-after-enqueue")), false);
  const landed = repo.tip(), cards: string[] = [];
  const r = await adopt(repo, "lead", cards);
  const { done } = await r.recover();
  const merger = await r.m.nth(0);
  assert.equal(r.m.claims[0]!.sourceHead, repo.head);
  resolveBoth(merger.cwd); await settle(r.registry, merger, "Resolved after the crash.");
  await done;
  assert.equal(r.registry.get("builder-a")!.status, "completed");
  assert.deepEqual(cards, ["builder-a:completed"], "the new generation's card once; the original is never resent");
  assert.equal(git(repo.root, "rev-list", "--count", `${landed}..${repo.tip()}`), "1");
  const again = await r.recover(); await again.done;
  await delay(SETTLE_MS);
  assert.equal(r.m.calls.length, 1, "repeated recovery never relaunches"); assert.deepEqual(cards, ["builder-a:completed"]);
  assert.equal(git(repo.root, "rev-list", "--count", `${landed}..${repo.tip()}`), "1");
  repo.unchanged();
}));

test("M6b a second crash inside the recovered merger launch spends the one attempt: no relaunch, no false acceptance, one final card", { timeout: 60000 }, t => preserving(t, async () => {
  const repo = crashRepo();
  assert.equal((await child(t, repo, "resolve-crash")).signal, "SIGKILL");
  const landed = repo.tip();
  const second = await child(t, repo, "recover-crash");
  assert.equal(second.signal, "SIGKILL", "the recovery itself crashed inside the launch");
  const claim = JSON.parse(readFileSync(join(repo.evidence, "merger-claim-durable"), "utf8"));
  assert.equal(claim.attempt, 1); assert.equal(claim.sourceHead, repo.head); assert.equal(second.cards().length, 0);
  const cards: string[] = [], r = await adopt(repo, "lead", cards);
  const { done } = await r.recover(); await done;
  const a = r.registry.get("builder-a")!;
  assert.equal(a.status, "merge_conflict"); assert.match(a.integration!.merger!.reason!, /launch uncertain/);
  assert.equal(r.m.calls.length, 0, "no relaunch"); assert.equal(repo.tip(), landed, "no false acceptance"); assert.equal(a.landedCommit, undefined);
  assert.deepEqual(cards, ["builder-a:merge_conflict"], "one final card after the original one");
  const c = command({ root: repo.root, registry: r.registry } as unknown as Fixture, cards); c.state.session = "lead";
  await c.resolve("builder-a", c.ctx(() => true));
  assert.match(c.notes.at(-1)!.message, /attempt already spent/); assert.equal(c.prompts.length, 0);
  repo.unchanged();
}));
