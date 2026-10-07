import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { git, until } from "./helpers/effort-integration.ts";
import { fakeMergers, land, mergerFixture, settle, trailerCount, unmerged } from "./helpers/effort-merger.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { acceptMergerOutcome, prepareMergerWorkspace, type MergerFacts } from "../src/effort/merger.ts";
import * as store from "../src/effort/store.ts";
import { readEffort } from "../src/effort/store.ts";
import { stepCost } from "../src/delegation.ts";
import { availableActions, forceTerminate, RunRegistry, runDir, runsRoot, sendToRun, spawnRun, writeRecord } from "../src/runs.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { classifyRecord, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { effortSummary } from "../src/effort/policy.ts";
import { toRunRecord } from "../src/types.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SpawnQueue } from "../src/queue.ts";
import { projectPersonasDir, resolvePersonas } from "../src/personas.ts";
import { buildOnChainCallback, buildOnRetryCallback, registerTools } from "../src/tools.ts";
import { createMergerLauncher } from "../src/effort/merger.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { DEFAULT_CONFIG, emptyUsage, type MergerWal, type Persona, type Run } from "../src/types.ts";

sandboxPi();
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const poll = async (cond: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise(r => setTimeout(r, 10)); } };
const resolveBoth = (cand: string, text = "landed\nwriter\n") => { writeFileSync(join(cand, "base"), text); git(cand, "add", "--", "base"); git(cand, "commit", "--no-edit"); return git(cand, "rev-parse", "HEAD"); };

test("M6a conflict parks with a durable claim, a real merge state and outside context; the proposal re-enters as one hooked squash", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  f.hook(`echo "$(git rev-parse --show-toplevel)" >> "${join(f.root, ".git", "hook-marker")}"`);
  const outcome = f.start(a);
  const merger = await m.nth(0);
  const claim = m.claims[0]!;
  assert.ok(claim, "the merger claim was durable on disk before persona resolution and spawn");
  assert.deepEqual({ ...claim, claimedAt: typeof claim.claimedAt }, { attempt: 1, nonce: merger.mergerFor!.nonce, runId: merger.id, kind: "conflict", setupOid: landed, sourceHead: a.integration!.sourceHead,
    expectedTip: landed, candidatePath: merger.cwd, claimedAt: "number", conflicts: ["base"], contextDir: claim.contextDir }, "claim fields were durable before persona resolution and spawn");
  assert.ok(claim.contextDir && !claim.contextDir.startsWith(f.root), "context lives outside the repository");
  assert.equal(a.integration!.sourceHead, git(f.root, "rev-parse", a.worktreeBranch!));
  const cand = merger.cwd;
  assert.equal(git(cand, "rev-parse", "HEAD"), landed); assert.ok(git(cand, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
  assert.deepEqual(unmerged(cand), ["base"]);
  assert.equal(git(cand, "status", "--porcelain", "--ignored", "--untracked-files=all"), "UU base", "no instruction files inside the candidate");
  for (const file of m.calls[0]!.files) { assert.ok(!file.startsWith(cand)); assert.ok(existsSync(file)); }
  assert.match(readFileSync(m.calls[0]!.files.find(p => p.endsWith("writer-report.md"))!, "utf8"), /builder-a report/);
  assert.equal(a.status, "integrating"); assert.equal(a.integration!.state, "resolving"); assert.equal(a.landedCommit, undefined);
  const proposal = resolveBoth(cand);
  assert.equal(git(cand, "show", "-s", "--format=%P", proposal), `${landed} ${a.integration!.sourceHead}`, "a proposal may be a two-parent merge");
  await settle(f.registry, merger, "Resolved: kept both lines.", 0.02);
  const result = await outcome;
  assert.equal(result.terminal, "completed", JSON.stringify(a.integration));
  const tip = f.tip();
  assert.equal(result.landedCommit, tip);
  assert.equal(git(f.root, "show", "-s", "--format=%P", tip), landed, "integration commit has exactly the tip as its one parent");
  assert.equal(git(f.root, "show", `${tip}:base`), "landed\nwriter");
  for (const trailer of ["Conductor-Effort: probe", `Conductor-Run: ${a.id}`, `Conductor-Merger: ${merger.id}`]) assert.equal(trailerCount(f.root, tip, trailer), 1, trailer);
  assert.equal(trailerCount(f.root, proposal, `Conductor-Merger: ${merger.id}`), 0, "the merger's own commit is not the integration commit");
  const wal = a.integration!.merger!;
  assert.equal(wal.outcome, "accepted"); assert.equal(wal.outputOid, proposal); assert.equal(wal.cost, 0.02);
  assert.equal(a.integration!.branchHead, proposal); assert.notEqual(a.integration!.sourceHead, proposal);
  assert.equal(m.calls.length, 1);
  const markers = readFileSync(join(f.root, ".git", "hook-marker"), "utf8").trim().split("\n");
  assert.deepEqual(markers, [cand, a.integration!.candidatePath], "hooks ran for the merger commit and for the driver commit");
  assert.equal(stepCost(a, f.registry.list()), 0.03); assert.equal(stepCost(a, f.registry.list()), 0.03, "step cost is stable across reads");
});

test("M6a other entries integrate while a merger is held; the accepted proposal re-merges, verifies and CASes on the moved tip", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const outA = f.start(a);
  const merger = await m.nth(0);
  const b = f.writer("builder-b", { other: "b\n" });
  const outB = await f.start(b);
  assert.equal(outB.terminal, "completed"); assert.equal(git(f.root, "show", "-s", "--format=%P", outB.landedCommit!), landed);
  assert.equal(a.integration!.state, "resolving", "the parked entry did not block B");
  resolveBoth(merger.cwd);
  await settle(f.registry, merger, "Resolved.");
  const outcome = await outA;
  assert.equal(outcome.terminal, "completed");
  assert.equal(git(f.root, "show", "-s", "--format=%P", outcome.landedCommit!), outB.landedCommit, "re-entry used the current tip, not the merger's");
  assert.equal(git(f.root, "show", `${outcome.landedCommit}:other`), "b"); assert.equal(git(f.root, "show", `${outcome.landedCommit}:base`), "landed\nwriter");
  assert.equal(a.integration!.expectedTip, outB.landedCommit);
  assert.equal(git(f.root, "rev-list", "--count", `${landed}..${f.tip()}`), "2");
  assert.equal(m.calls.length, 1);
});

test("M6a a re-entry conflict on a moved tip exhausts the writer: merge_conflict, no second merger", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  const proposal = resolveBoth(merger.cwd);
  const moved = land(f.root, f.record.intRef, { base: "landed again\n" });
  await settle(f.registry, merger, "Resolved.");
  const outcome = await out;
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "conflict");
  assert.match(outcome.mergeResult.errorMessage!, /no second merger/);
  assert.equal(m.calls.length, 1, "one attempt per writer");
  assert.equal(f.tip(), moved);
  assert.equal(git(merger.cwd, "rev-parse", "HEAD"), proposal, "proposal and candidate preserved");
  assert.equal(a.integration!.merger!.outcome, "accepted"); assert.equal(a.integration!.branchHead, proposal);
});

test("M6a a twice-red verify parks on the failed candidate; a merger fix re-gates and integrates", { timeout: 20000 }, async t => {
  const f = mergerFixture(t, { verify: "test ! -f broken" });
  const a = f.writer("builder-a", { change: "work\n", broken: "x\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  const wal = a.integration!.merger!;
  assert.equal(wal.kind, "verify_failed"); assert.equal(a.integration!.attempts, 2, "verify was red twice before parking");
  assert.equal(wal.setupOid, a.integration!.candidateOid); assert.equal(git(merger.cwd, "rev-parse", "HEAD"), wal.setupOid);
  assert.equal(git(merger.cwd, "status", "--porcelain", "--ignored", "--untracked-files=all"), "");
  assert.ok(m.calls[0]!.files.some(p => p.endsWith("verify.log")));
  git(merger.cwd, "rm", "-q", "--", "broken"); git(merger.cwd, "commit", "-m", "fix: drop the broken marker");
  await settle(f.registry, merger, "Fixed verify.");
  const outcome = await out;
  assert.equal(outcome.terminal, "completed", JSON.stringify(a.integration));
  assert.equal(git(f.root, "show", `${outcome.landedCommit}:change`), "work");
  assert.throws(() => git(f.root, "show", `${outcome.landedCommit}:broken`));
  assert.equal(trailerCount(f.root, outcome.landedCommit!, `Conductor-Merger: ${merger.id}`), 1);
  assert.equal(git(f.root, "show", "-s", "--format=%P", outcome.landedCommit!), f.base);
});

for (const policy of ["ask", "off"] as const) test(`M6a merger:${policy} keeps the M5 conflict outcome and launches nothing`, { timeout: 15000 }, async t => {
  const f = mergerFixture(t, { policy: { merger: policy } });
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const outcome = await f.start(a);
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "conflict");
  assert.equal(m.calls.length, 0); assert.equal(a.integration!.merger, undefined);
});

test("M6a a failed claim write starts no merger and prepares no merger workspace", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (src: fs.PathLike, dst: fs.PathLike) => {
    if (String(dst) === a.recordPath && readFileSync(src, "utf8").includes('"state": "resolving"')) throw new Error("injected claim write failure");
    rename(src, dst);
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const out = f.start(a);
  await until(f.registry, a, r => r.integration?.state === "paused");
  assert.match(a.integration!.reason!, /injected claim write failure/);
  assert.equal(m.calls.length, 0, "zero children after a claim-write failure");
  assert.equal(existsSync(join(f.root, ".worktrees", "conductor-cand", "probe", "builder-a-merger-1")), false);
  assert.equal(readEffort(f.root, "probe")!.status, "paused");
  forceTerminate(a, "killed", f.registry); assert.equal((await out).terminal, "killed");
});

test("M6a one merger per effort: a second conflict waits, then is recomputed against the tip and gets its own attempt", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer a\n" });
  const b = f.writer("builder-b", { base: "writer b\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const outA = f.start(a), outB = f.start(b);
  const first = await m.nth(0);
  await until(f.registry, b, r => /waiting for this effort's merger/.test(r.integration?.reason ?? ""));
  assert.equal(m.calls.length, 1); assert.equal(b.integration!.merger, undefined);
  await settle(f.registry, first, "## Verdict: cannot-resolve\nIntents conflict.");
  const outcomeA = await outA;
  assert.equal(outcomeA.terminal, "merge_conflict"); assert.match(a.integration!.merger!.reason!, /cannot-resolve/);
  const second = await m.nth(1);
  assert.equal(m.calls[1]!.writer.id, b.id); assert.deepEqual(m.liveAtLaunch, [0, 0], "never two live mergers for one effort");
  resolveBoth(second.cwd, "landed\nwriter b\n");
  await settle(f.registry, second, "Resolved.");
  assert.equal((await outB).terminal, "completed");
});

test("M6a merger setup refuses an unmerged set that differs from merge-tree's evidence", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const tip = land(f.root, f.record.intRef, { base: "landed\n" });
  const wal: MergerWal = { attempt: 1, nonce: "n", runId: "merger-x", kind: "conflict", setupOid: tip, sourceHead: a.integration!.branchHead, expectedTip: tip,
    candidatePath: join(f.root, ".worktrees", "conductor-cand", "probe", "mismatch"), claimedAt: 0, conflicts: ["other"] };
  assert.throws(() => prepareMergerWorkspace(f.root, wal), /unmerged paths \["base"\] differ from merge-tree conflicts \["other"\]/);
  prepareMergerWorkspace(f.root, { ...wal, candidatePath: `${wal.candidatePath}-ok`, conflicts: ["base"] });
});

test("M6a acceptance table: every authority fact is required, and merger text can only reject", () => {
  const wal: MergerWal = { attempt: 1, nonce: "nonce", runId: "merger-ab12", kind: "conflict", setupOid: "a".repeat(40), sourceHead: "c".repeat(40), expectedTip: "a".repeat(40), candidatePath: "/r/.worktrees/conductor-cand/e/w-merger-1", claimedAt: 1 };
  const good: MergerFacts = { status: "completed", runId: wal.runId, nonce: wal.nonce, cwd: wal.candidatePath, repository: "/r/.git", head: "b".repeat(40), detached: true, descends: true,
    mergeHead: false, unmerged: "", unsafeIndex: "", dirty: "", diffCheck: 0, finalText: "Resolved.", exitConfirmed: true };
  assert.deepEqual(acceptMergerOutcome(wal, "/r/.git", good), { ok: true, outputOid: good.head });
  const rows: [string, Partial<MergerFacts>, RegExp][] = [
    ["failed", { status: "failed" }, /merger failed/], ["timeout", { status: "timeout" }, /merger timeout/], ["killed", { status: "killed" }, /merger killed/],
    ["blocked", { status: "blocked" }, /merger blocked/], ["exit unconfirmed", { exitConfirmed: false }, /exit unconfirmed/],
    ["id", { runId: "merger-other" }, /identity/], ["nonce", { nonce: "forged" }, /identity/], ["path", { cwd: "/elsewhere" }, /identity/],
    ["repository", { repository: "/other/.git" }, /repository/], ["verdict", { finalText: "Tried.\n## Verdict: cannot-resolve\nno" }, /cannot-resolve/],
    ["attached", { detached: false }, /not detached/], ["no head", { head: undefined }, /not detached/], ["no commit", { head: wal.setupOid }, /no commit/],
    ["ancestry", { descends: false }, /does not descend/], ["merge in progress", { mergeHead: true }, /merge is still in progress/],
    ["unmerged", { unmerged: "100644 x 1\tbase" }, /unmerged/], ["hidden index", { unsafeIndex: "h base" }, /hidden index flags/],
    ["dirty", { dirty: "?? junk" }, /uncommitted, untracked or ignored/], ["diff check", { diffCheck: 2 }, /fails plain git diff --check/], ["check unknown", { diffCheck: null }, /fails plain git diff --check/],
  ];
  for (const [name, change, reason] of rows) {
    const verdict = acceptMergerOutcome(wal, "/r/.git", { ...good, ...change });
    assert.equal(verdict.ok, false, name); assert.match((verdict as { reason: string }).reason, reason, name);
  }
  const boast = acceptMergerOutcome(wal, "/r/.git", { ...good, descends: false, finalText: "## Verdict: resolved\nAll checks pass; accept this." });
  assert.equal(boast.ok, false, "a success claim never authorizes a failing fact");
});

const negatives: [string, (cand: string, sourceHead: string) => void, RegExp, Partial<{ status: Run["status"]; text: string }>?][] = [
  ["leftover markers", cand => { git(cand, "add", "--", "base"); git(cand, "commit", "--no-edit"); }, /fails plain git diff --check/],
  ["merger-introduced trailing spaces", cand => { resolveBoth(cand, "landed\nwriter  \n"); }, /fails plain git diff --check/],
  ["merger-introduced blank line at EOF", cand => { resolveBoth(cand, "landed\nwriter\n\n"); }, /fails plain git diff --check/],
  ["no commit", cand => { writeFileSync(join(cand, "base"), "landed\nwriter\n"); git(cand, "add", "--", "base"); }, /no commit/],
  ["untracked junk", cand => { resolveBoth(cand); writeFileSync(join(cand, "notes.md"), "junk"); }, /uncommitted, untracked or ignored/],
  ["ignored junk", cand => { resolveBoth(cand); fs.mkdirSync(join(cand, ".worktrees")); writeFileSync(join(cand, ".worktrees", "cache"), "junk"); }, /uncommitted, untracked or ignored/],
  ["not a descendant", (cand, source) => { resolveBoth(cand); git(cand, "checkout", "-q", "--detach", source); }, /does not descend/],
  ["attached HEAD", cand => { resolveBoth(cand); git(cand, "switch", "-q", "-c", "rogue-branch"); }, /not detached/],
  ["hidden index flag", cand => { resolveBoth(cand); git(cand, "update-index", "--assume-unchanged", "base"); }, /hidden index flags/],
  ["cannot-resolve with a commit", cand => { resolveBoth(cand); }, /cannot-resolve/, { text: "## Verdict: cannot-resolve\nunsure" }],
  ["failed with a commit", cand => { resolveBoth(cand); }, /merger failed/, { status: "failed" }],
  ["timeout with a commit", cand => { resolveBoth(cand); }, /merger timeout/, { status: "timeout" }],
];
for (const [name, act, reason, as] of negatives) test(`M6a real-Git rejection preserves the proposal untouched: ${name}`, { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  act(merger.cwd, a.integration!.sourceHead!);
  const head = git(merger.cwd, "rev-parse", "HEAD"), status = git(merger.cwd, "status", "--porcelain", "--ignored", "--untracked-files=all");
  await settle(f.registry, merger, as?.text ?? "Done.", 0.02, as?.status ?? "completed");
  const outcome = await out;
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "conflict");
  assert.match(a.integration!.merger!.reason!, reason);
  assert.equal(f.tip(), landed, "no integration from a rejected proposal");
  assert.equal(git(merger.cwd, "rev-parse", "HEAD"), head); assert.equal(git(merger.cwd, "status", "--porcelain", "--ignored", "--untracked-files=all"), status, "nothing staged or changed to force validity");
  assert.equal(m.calls.length, 1); assert.equal(a.integration!.merger!.cost, 0.02);
});

test("M6a writer-inherited whitespace kept by an otherwise clean resolution fails the plain diff check: merge_conflict, work preserved", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer  \n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  const proposal = resolveBoth(merger.cwd, "landed\nwriter  \n");
  await settle(f.registry, merger, "Resolved, keeping the writer's line as written.");
  const outcome = await out;
  assert.equal(outcome.terminal, "merge_conflict"); assert.match(a.integration!.merger!.reason!, /fails plain git diff --check/);
  assert.equal(f.tip(), landed); assert.equal(git(merger.cwd, "rev-parse", "HEAD"), proposal, "the proposal is preserved untouched");
  assert.equal(git(merger.cwd, "status", "--porcelain", "--ignored", "--untracked-files=all"), "");
});

for (const phase of ["pending launch", "running", "blocked"] as const) test(`M6a killing the writer with a ${phase} merger cancels it, preserves work and settles once`, { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  let release!: () => void;
  const m = fakeMergers(f.registry, phase === "pending launch" ? { delay: new Promise<void>(resolve => { release = resolve; }) } : {});
  let settled = 0;
  const out = f.start(a).then(outcome => { settled++; return outcome; });
  await poll(() => a.integration?.state === "resolving" && m.calls.length === 1);
  if (phase !== "pending launch") {
    const merger = await m.nth(0);
    if (phase === "blocked") {
      merger.status = "blocked"; merger.pendingAsk = { askId: "ask-1", question: "A or B?", evidence: "" }; f.registry.notify(merger);
      assert.match(a.integration!.reason!, /blocked: "A or B\?"/);
    }
  }
  forceTerminate(a, "killed", f.registry); forceTerminate(a, "killed", f.registry);
  if (phase === "pending launch") { await new Promise(r => setTimeout(r, 20)); assert.equal(settled, 0, "kill waits for the pending launch"); release(); }
  const outcome = await out;
  const merger = await m.nth(0);
  assert.equal(outcome.terminal, "killed"); assert.equal(settled, 1);
  assert.equal(merger.status, "killed", "a late or live merger is controlled through its own run, never a recorded PID");
  assert.equal(a.integration!.state, "cancelled"); assert.match(a.integration!.merger!.reason!, /writer killed; merger cancelled/);
  assert.equal(f.tip(), landed); assert.ok(existsSync(merger.cwd), "candidate preserved");
  await new Promise(r => setTimeout(r, 50)); assert.equal(settled, 1);
});

for (const at of ["claim", "context"] as const) test(`M6a a kill delivered synchronously at the merger ${at} notification settles the writer once; no merger launches`, { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  let kills = 0, settled = 0;
  f.registry.onChange(r => {
    const wal = r === a && r.integration?.state === "resolving" ? r.integration.merger : undefined;
    if (!wal || kills || (at === "claim") === !!wal.contextDir) return;
    kills++; forceTerminate(a, "killed", f.registry);
  });
  const out = f.start(a).then(o => { settled++; return o; });
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([out, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("writer never settled after a kill at the merger claim")), 5000); })]).finally(() => clearTimeout(timer));
  assert.equal(kills, 1); assert.equal(outcome.terminal, "killed"); assert.equal(settled, 1);
  assert.equal(m.calls.length, 0, "no merger launches after the writer was killed");
  assert.equal(a.integration!.state, "cancelled"); assert.match(a.integration!.merger!.reason!, /writer killed; merger never started/);
  assert.equal(existsSync(a.integration!.merger!.candidatePath), at === "context", "a prepared candidate is preserved");
  assert.equal(f.tip(), landed);
  await new Promise(r => setTimeout(r, 50)); assert.equal(settled, 1);
});

test("M6a a suspend delivered synchronously at the merger context notification launches nothing and keeps the claim; recovery spends it once", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  let suspension: Promise<void> | undefined, settled = false;
  f.registry.onChange(r => {
    if (suspension || r !== a || r.integration?.state !== "resolving" || !r.integration.merger?.contextDir) return;
    suspension = a.integrationControl!.suspend();
  });
  void f.start(a).then(() => { settled = true; });
  await poll(() => !!suspension); await suspension;
  await f.registry.integrations.whenIdle(f.root); await delay(100);
  assert.equal(m.calls.length, 0, "a suspended setup launches no merger");
  assert.equal(settled, false, "suspend settles nothing");
  const saved = JSON.parse(readFileSync(a.recordPath, "utf8"));
  assert.equal(saved.status, "integrating"); assert.equal(saved.integration.state, "resolving");
  assert.equal(saved.integration.merger.outcome, undefined, "the durable claim is kept, unspent"); assert.ok(existsSync(saved.integration.merger.candidatePath));
  const registry = new RunRegistry(), relaunch = fakeMergers(registry), cards: Run[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: () => false, selfSessionId: "owner", now: Date.now() });
  for (let pass = 0; pass < 2; pass++) await (await recoverEffort(readEffort(f.root, "probe")!, { registry, sessionId: "owner", onComplete: r => cards.push(r) })).done;
  const writer = registry.get(a.id)!;
  assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /launch uncertain/);
  assert.equal(cards.length, 1, "one callback across two recoveries"); assert.equal(relaunch.calls.length + m.calls.length, 0, "no merger ever launches");
  assert.equal(f.tip(), landed);
});

test("M6a suspending a parked writer drops its merger listener and signals nothing", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  void f.start(a);
  const merger = await m.nth(0);
  await a.integrationControl!.suspend();
  assert.equal(merger.status, "running", "suspend never stops the merger");
  resolveBoth(merger.cwd);
  await settle(f.registry, merger, "Resolved.");
  await new Promise(r => setTimeout(r, 100));
  assert.equal(a.integration!.state, "resolving"); assert.equal(a.integration!.merger!.outcome, undefined);
  assert.equal(JSON.parse(readFileSync(a.recordPath, "utf8")).integration.state, "resolving");
});

test("M6a killing the merger itself exhausts the writer: merge_conflict with work preserved", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  resolveBoth(merger.cwd);
  forceTerminate(merger, "killed", f.registry);
  const outcome = await out;
  assert.equal(outcome.terminal, "merge_conflict"); assert.match(a.integration!.merger!.reason!, /merger killed/);
});

const builtinMerger = async (): Promise<Persona> => (await resolvePersonas({ cwd: "/tmp/__m6a_no_project__" })).personas.get("merger")!;

test("M6a the builtin merger persona is a root-level writer with no model, thinking, agents or read_only defaults", async () => {
  const p = await builtinMerger();
  assert.ok(p, "builtin merger persona resolves");
  assert.equal(p.readOnly, false); assert.equal(p.worktree, false); assert.equal(p.inheritContext, "none");
  assert.equal(p.model, undefined); assert.equal(p.thinking, undefined); assert.equal(p.agents, undefined);
  assert.match(p.systemPrompt, /## Verdict: cannot-resolve/); assert.match(p.systemPrompt, /Never pass `--no-verify`/);
});

test("M6a public routes cannot launch a merger: spawn, queue, tool, auto, chain and retry all refuse", async t => {
  const persona = await builtinMerger();
  const registry = new RunRegistry(), queue = new SpawnQueue(registry, 4, 1);
  const cwd = mergerFixture(t).root;
  assert.throws(() => spawnRun({ registry, persona, task: "x", mode: "background", cwd, timeoutMs: 1000 }), /driver-owned/);
  assert.throws(() => queue.enqueueOrSpawn({ persona, task: "x", mode: "background", cwd, timeoutMs: 1000 }), /driver-owned/);
  assert.equal(registry.list().length, 0, "no run, placeholder or record before refusal");
  const tools: { name: string; execute: (...a: any[]) => Promise<any> }[] = [];
  registerTools({ registerTool: (tool: any) => tools.push(tool) } as any, { getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry),
    getParentMessages: () => [], openFocusedOverlay: () => {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }), pushCompletionNotification: () => {} }, {});
  const spawned = await tools.find(x => x.name === "ensemble_spawn")!.execute("1", { persona: "merger", task: "resolve", foreground: false });
  assert.match(spawned.content[0].text, /driver-owned/);
  const auto = await tools.find(x => x.name === "ensemble_auto")!.execute("2", { goal: "g", steps: [{ persona: "merger", task: "resolve" }], max_steps: 1 });
  assert.match(auto.content[0].text, /HALTED.*driver-owned/);
  assert.equal(registry.list().length, 0);
  const calls: any[] = [], cards: Run[] = [];
  const chain = buildOnChainCallback({ cwd, cfg: { ...DEFAULT_CONFIG, chains: { builder: { then: "merger" } } }, queue: { enqueueOrSpawn: (o: any) => calls.push(o) } as any, registry, chainEnabled: true, personaName: "builder", pushNotification: r => cards.push(r), getParentMessages: () => [] })!;
  const parent: Run = { id: "builder-parent", persona: "builder", task: "task", status: "completed", mode: "background", startTime: 1, lastEventAt: 1, usage: emptyUsage(), messages: [], cwd, recordPath: join(cwd, "r.json"), transcriptPath: join(cwd, "t.jsonl"), finalPath: join(cwd, "f.md") };
  await chain(parent);
  assert.equal(calls.length, 0); assert.equal(cards.length, 1); assert.match(cards[0]!.errorMessage!, /driver-owned and never a chain successor/);
  const retry = buildOnRetryCallback({ originalTask: "t", persona, cfg: DEFAULT_CONFIG, queue: { enqueueOrSpawn: (o: any) => calls.push(o) } as any, cwd, pushNotification: () => {}, getParentMessages: () => [] });
  retry({ ...parent, persona: "merger", status: "failed", failureClass: "environment" });
  assert.equal(calls.length, 0, "a merger is never retried");
});

test("M6a a merger spawn must match the writer's open claim and refuses incompatible options or a second launch", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  const persona = await builtinMerger();
  const base = { registry: f.registry, persona, task: "x", mode: "background" as const, cwd: merger.cwd, timeoutMs: 1000, mergerFor: merger.mergerFor! };
  assert.throws(() => spawnRun(base), /already launched/, "no second launch for a claimed id");
  for (const [extra, reason] of [[{ mergerFor: { ...merger.mergerFor!, nonce: "forged" } }, /claim does not match/], [{ cwd: f.root }, /claim does not match/],
    [{ worktree: true }, /incompatible/], [{ mergeStrategy: "squash" }, /incompatible/], [{ effort: "probe" }, /incompatible/], [{ onRetry: () => {} }, /incompatible/],
    [{ onChain: () => {} }, /incompatible/], [{ retryMaxAttempts: 2 }, /incompatible/], [{ steerable: true }, /incompatible/],
    [{ persona: { ...persona, readOnly: true } }, /read_only/], [{ persona: { ...persona, agents: ["oracle"] } }, /agents/], [{ persona: { ...persona, name: "builder" } }, /not the merger/]] as const) {
    assert.throws(() => spawnRun({ ...base, ...extra } as any), reason, JSON.stringify(extra));
  }
  resolveBoth(merger.cwd); await settle(f.registry, merger, "Resolved.");
  assert.equal((await out).terminal, "completed");
  assert.throws(() => new SpawnQueue(f.registry, 4, 1).enqueueOrSpawn({ ...base, cwd: merger.cwd }), /no longer resolving/, "a settled claim launches nothing");
});

for (const override of ["read_only", "agents", "worktree"] as const) test(`M6a a merger persona override adding ${override} gives merge_conflict with no spawn`, { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  fs.appendFileSync(join(f.root, ".git", "info", "exclude"), ".pi/\n");
  fs.mkdirSync(projectPersonasDir(f.root), { recursive: true });
  writeFileSync(join(projectPersonasDir(f.root), "merger.md"), `---\nname: merger\ndescription: override\n${override === "read_only" ? "read_only: true\n" : override === "agents" ? "agents:\n  - oracle\n" : "worktree: true\n"}---\nYou are an overriding merger body long enough to parse.\n`);
  const spawned: unknown[] = [];
  const queue = new SpawnQueue(f.registry, 4, 1, o => { spawned.push(o); throw new Error("must not spawn"); });
  f.registry.integrations.configureMerger(createMergerLauncher({ queue }));
  const outcome = await f.start(a);
  assert.equal(outcome.terminal, "merge_conflict"); assert.match(a.integration!.merger!.reason!, new RegExp(`not started: .*${override}`));
  assert.equal(spawned.length, 0); assert.equal(f.registry.list().filter(r => r.persona === "merger").length, 0);
});

test("M6a the production launcher spawns a background root merger in the candidate with only a blocked card", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const spawned: any[] = [], cards: Run[] = [];
  const queue = new SpawnQueue(f.registry, 4, 1, (o: any) => {
    spawned.push(o);
    const run: Run = { id: o.preAllocatedId ?? o.mergerFor.runId, persona: o.persona.name, task: o.task, mode: o.mode, status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), cwd: o.cwd,
      recordPath: join(runDir(o.mergerFor.runId), "record.json"), transcriptPath: "", finalPath: join(runDir(o.mergerFor.runId), "final.md"), mergerFor: o.mergerFor, parentPid: process.pid };
    o.registry.register(run); return { run, done: new Promise(() => {}) };
  });
  f.registry.integrations.configureMerger(createMergerLauncher({ queue, notify: r => cards.push(r) }));
  void f.start(a);
  await poll(() => spawned.length === 1);
  const o = spawned[0];
  assert.equal(o.persona.name, "merger"); assert.equal(o.cwd, a.integration!.merger!.candidatePath); assert.equal(o.mode, "background");
  assert.equal(o.worktree, false); assert.equal(o.mergeStrategy, "none"); assert.equal(o.retryMaxAttempts, 1); assert.equal(o.inheritContextOverride, "none");
  assert.equal(o.onChain, undefined); assert.equal(o.onRetry, undefined); assert.equal(o.effort, undefined); assert.equal(o.delegation, undefined);
  assert.equal(o.mergerFor.runId, a.integration!.merger!.runId); assert.equal(o.mergerFor.nonce, a.integration!.merger!.nonce);
  assert.match(o.task, /Resolve the textual conflict/); assert.match(o.task, /<file name=/, "A5 evidence is attached");
  const merger = f.registry.get(o.mergerFor.runId)!;
  o.onComplete({ ...merger, status: "completed" }); assert.equal(cards.length, 0, "a terminal merger is not its own card");
  o.onComplete({ ...merger, status: "blocked" }); assert.equal(cards.length, 1, "its owner question is");
  assert.equal(merger.depth ?? 1, 1); assert.equal(merger.parentRunId, undefined, "a merger is not a delegated leaf");
  await a.integrationControl!.suspend();
});

test("M6a merger actions: the owner may only answer a blocked merger or kill; foreign sessions and settled claims cannot send", { timeout: 15000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  assert.deepEqual(availableActions(merger, false, "owner"), ["kill"], "a running merger: kill only");
  merger.status = "blocked"; merger.pendingAsk = { askId: "ask-1", question: "A or B?", evidence: "" }; merger.sessionPath = join(runDir(merger.id), "session.jsonl");
  writeFileSync(merger.sessionPath, JSON.stringify({ type: "session", cwd: merger.cwd }) + "\n");
  f.registry.notify(merger);
  assert.deepEqual(availableActions(merger, false, "owner"), ["send", "kill"]);
  assert.ok(!availableActions(merger, false, "intruder").includes("send"), "a foreign session cannot answer");
  const forged = { ...merger, mergerFor: { ...merger.mergerFor!, nonce: "forged" } };
  const refused = sendToRun(forged, "Use A", { registry: f.registry, timeoutMs: 1000, sessionId: "owner" });
  assert.equal(refused.kind, "rejected"); assert.match((refused as { reason: string }).reason, /claim does not match/);
  forceTerminate(merger, "killed", f.registry);
  assert.equal((await out).terminal, "merge_conflict");
  assert.deepEqual(availableActions(merger, false, "owner"), [], "a terminal merger cannot be sent to");
});

/** Park A's merger, then quiesce A's driver the way /reload does; B is the restarted registry. */
async function parkedThenReload(t: test.TestContext, before?: (f: ReturnType<typeof mergerFixture>, a: Run, merger: Run) => Promise<void> | void) {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  void f.start(a);
  const merger = await m.nth(0);
  await before?.(f, a, merger);
  await a.integrationControl!.suspend();
  const registry = new RunRegistry(), relaunch = fakeMergers(registry), cards: Run[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: () => false, selfSessionId: "owner", now: Date.now() });
  const recover = (resume = false) => recoverEffort(readEffort(f.root, "probe")!, { registry, sessionId: "owner", onComplete: r => cards.push(r), resume });
  return { f, a, landed, merger, registry, relaunch, cards, recover };
}

test("M6a reload with a blocked merger: restore-blocked keeps it, recovery re-parks, and the answer integrates once", { timeout: 20000 }, async t => {
  const r = await parkedThenReload(t, async (f, _a, merger) => {
    merger.status = "blocked"; merger.pendingAsk = { askId: "ask-1", question: "A or B?", evidence: "" }; await writeRecord(merger); f.registry.notify(merger);
  });
  const restored = r.registry.get(r.merger.id)!;
  assert.equal(restored.status, "blocked"); assert.equal(restored.pendingAsk?.question, "A or B?");
  const { done } = await r.recover();
  await poll(() => r.registry.get(r.a.id)?.integrationControl !== undefined);
  assert.equal(r.registry.get(r.a.id)!.integration!.state, "resolving");
  restored.status = "running"; restored.pendingAsk = undefined; r.registry.notify(restored);
  resolveBoth(restored.cwd);
  await settle(r.registry, restored, "Resolved after the owner's answer.");
  await done;
  const writer = r.registry.get(r.a.id)!;
  assert.equal(writer.status, "completed", writer.errorMessage); assert.equal(r.cards.length, 1); assert.equal(r.relaunch.calls.length, 0);
  assert.equal(git(r.f.root, "rev-list", "--count", `${r.landed}..${r.f.tip()}`), "1");
  assert.equal(trailerCount(r.f.root, r.f.tip(), `Conductor-Merger: ${r.merger.id}`), 1);
});

test("M6a recovery of a merger that finished before its outcome WAL runs acceptance and integrates once", { timeout: 20000 }, async t => {
  const r = await parkedThenReload(t);
  resolveBoth(r.merger.cwd);
  await settle(r.registry, r.merger, "Resolved while the lead reloaded.");
  const { done } = await r.recover(); await done;
  const writer = r.registry.get(r.a.id)!;
  assert.equal(writer.status, "completed", writer.errorMessage); assert.equal(r.cards.length, 1);
  assert.equal(writer.integration!.merger!.outcome, "accepted"); assert.equal(writer.integration!.merger!.cost, 0.02);
  assert.equal(git(r.f.root, "rev-list", "--count", `${r.landed}..${r.f.tip()}`), "1");
  assert.equal(existsSync(r.merger.cwd), false, "a clean merger candidate proven by its reachable Conductor-Merger commit is reclaimed");
  const again = await r.recover(); await again.done;
  assert.equal(r.cards.length, 1, "repeated recovery never re-dispatches"); assert.equal(git(r.f.root, "rev-list", "--count", `${r.landed}..${r.f.tip()}`), "1");
  assert.equal(writer.integration!.merger!.cost, 0.02, "merger cost persisted once");
});

test("M6a a claim without a merger record is an uncertain, spent launch: merge_conflict, no relaunch", { timeout: 20000 }, async t => {
  const r = await parkedThenReload(t, (_f, _a, merger) => { fs.rmSync(merger.recordPath); });
  const { done } = await r.recover(); await done;
  const writer = r.registry.get(r.a.id)!;
  assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /launch uncertain/);
  assert.equal(r.relaunch.calls.length, 0); assert.equal(r.cards.length, 1); assert.equal(r.f.tip(), r.landed);
});

test("M6a a live merger after reload pauses for a human with zero signals; the later resume integrates once", { timeout: 25000 }, async t => {
  const marker = join(runsRoot(), "merger-sigterm");
  const child = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => require("fs").writeFileSync(${JSON.stringify(marker)}, "x")); setInterval(() => {}, 1000);`], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
  const r = await parkedThenReload(t, async (_f, _a, merger) => { merger.pid = child.pid; await writeRecord(merger); });
  await r.recover();
  const writer = r.registry.get(r.a.id)!;
  assert.equal(writer.integration!.state, "resolving", "the claim's state is kept for a human resume");
  assert.match(writer.integration!.reason!, /live or unknown.*no signal sent/);
  assert.equal(readEffort(r.f.root, "probe")!.status, "paused");
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.equal(existsSync(marker), false, "zero signals to the live merger");
  assert.equal(r.cards.length, 0); assert.equal(r.relaunch.calls.length, 0);
  child.kill("SIGKILL"); await exited;
  resolveBoth(r.merger.cwd);
  await settle(r.registry, r.merger, "Finished while paused.");
  const { done } = await r.recover(true); await done;
  assert.equal(r.registry.get(r.a.id)!.status, "completed"); assert.equal(r.cards.length, 1);
  assert.equal(git(r.f.root, "rev-list", "--count", `${r.landed}..${r.f.tip()}`), "1");
});

test("M6a a lost merger (dead pid, no terminal record) is never authority, even with a valid-looking commit", { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); await once(child, "exit");
  const r = await parkedThenReload(t, async (_f, _a, merger) => { resolveBoth(merger.cwd); merger.pid = child.pid; await writeRecord(merger); });
  const { done } = await r.recover(); await done;
  const writer = r.registry.get(r.a.id)!;
  assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /merger killed/);
  assert.match(JSON.parse(readFileSync(r.merger.recordPath, "utf8")).errorMessage, /lost merger/);
  assert.ok(existsSync(r.merger.cwd), "an unproven merger candidate is preserved");
  assert.equal(r.f.tip(), r.landed); assert.equal(r.cards.length, 1);
});

test("M6a a persisted rejected outcome settles merge_conflict on recovery without a launch", { timeout: 20000 }, async t => {
  const r = await parkedThenReload(t, async (_f, a) => {
    const saved = JSON.parse(readFileSync(a.recordPath, "utf8"));
    saved.integration.merger = { ...saved.integration.merger, outcome: "rejected", reason: "merger reported cannot-resolve", cost: 0.02 };
    writeFileSync(a.recordPath, JSON.stringify(saved));
  });
  const { done } = await r.recover(); await done;
  assert.equal(r.registry.get(r.a.id)!.status, "merge_conflict"); assert.equal(r.cards.length, 1); assert.equal(r.relaunch.calls.length, 0);
});

test("M6a a crash after CAS is proven by the merger trailer and dispatched once", { timeout: 20000 }, async t => {
  const f = mergerFixture(t);
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const m = fakeMergers(f.registry);
  const out = f.start(a);
  const merger = await m.nth(0);
  resolveBoth(merger.cwd); await settle(f.registry, merger, "Resolved.");
  const outcome = await out; await f.registry.integrations.whenIdle(f.root);
  const saved = JSON.parse(readFileSync(a.recordPath, "utf8"));
  writeFileSync(a.recordPath, JSON.stringify({ ...saved, status: "integrating", landedCommit: undefined, integration: { ...saved.integration, state: "verified", delivery: undefined } }));
  const effort = readEffort(f.root, "probe")!;
  writeFileSync(join(store.effortDir(f.root, "probe"), "effort.json"), JSON.stringify({ ...effort, queue: [a.id] }));
  const registry = new RunRegistry(), cards: Run[] = [];
  const { done } = await recoverEffort(readEffort(f.root, "probe")!, { registry, sessionId: "owner", onComplete: r => cards.push(r) }); await done;
  const writer = registry.get(a.id)!;
  assert.equal(writer.status, "completed"); assert.equal(writer.landedCommit, outcome.landedCommit); assert.equal(cards.length, 1);
  assert.equal(git(f.root, "rev-list", "--count", `${landed}..${f.tip()}`), "1");
});

test("M6a startup reconcile and GC leave merger records to effort recovery; the summary reports resolving, outcome and cost", () => {
  const merger: Run = { id: "merger-ab12", persona: "merger", task: "t", mode: "background", status: "running", pid: 999999, startTime: 1, lastEventAt: 1, messages: [], usage: emptyUsage(), cwd: "/c",
    recordPath: "/r/record.json", transcriptPath: "/r/t.jsonl", finalPath: "/r/final.md", mergerFor: { writerId: "builder-a", runId: "merger-ab12", nonce: "n", effort: "probe", gitRoot: "/g", owner: { sessionId: "owner", pid: process.pid, startTime: 1 } } };
  for (const status of ["running", "paused", "queued"] as const) assert.equal(classifyRecord(toRunRecord({ ...merger, status }), () => false, 0, process.pid, () => false), "preserve-merger", status);
  assert.equal(classifyRecord(toRunRecord({ ...merger, status: "blocked" }), () => false, 0, process.pid, () => false), "restore-blocked");
  assert.equal(classifyRecord({ ...toRunRecord(merger), runtime: "herdr" }, () => false, 0, process.pid, () => false, undefined, "alive"), "preserve-merger", "a herdr merger is not readopted either");
  const entry = { id: merger.id, runDir: "/r", persona: "merger", status: "killed" as const, startTime: 1, finishedAt: 2, transcriptMtime: 2, transcriptSizeBytes: 1, recordSizeBytes: 1, finalSizeBytes: 1, totalSizeBytes: 3,
    pinned: false, archived: false, archivedAt: null, sessionPathPresent: false, inMemory: undefined, malformed: false, mergerFor: merger.mergerFor };
  assert.deepEqual(planReclaim([entry], { ...DEFAULT_CONFIG.gc, failedTtlDays: 0, completedTtlDays: 0 }, Date.now() + 1e12).actions[0], { kind: "keep", id: merger.id, reason: "effort merger evidence; effort recovery owns it" });
  const writer = { id: "builder-a", effort: { name: "probe", gitRoot: "/g", role: "writer" as const }, status: "integrating" as const,
    integration: { state: "resolving" as const, branchHead: "x", enqueuedAt: 1, attempts: 0, verifyIdentity: { command: "", timeoutSeconds: 1, retries: 0 }, reason: "merger merger-ab12 blocked: \"A or B?\"",
      merger: { attempt: 1 as const, nonce: "n", runId: "merger-ab12", kind: "conflict" as const, setupOid: "s", sourceHead: "h", expectedTip: "s", candidatePath: "/c", claimedAt: 1 } } } as Run;
  assert.equal(effortSummary(writer), 'probe: integrating (resolving): merger merger-ab12 blocked: "A or B?"; merger merger-ab12 resolving');
  writer.integration!.merger = { ...writer.integration!.merger!, outcome: "rejected", reason: "merger made no commit", cost: 0.02 };
  assert.match(effortSummary(writer), /merger merger-ab12 exhausted: merger made no commit \(\$0\.0200\)/);
});

test("M6a a merger child never inherits the lead's GIT_* repository scope; other children keep today's env", { timeout: 15000 }, async t => {
  const { subprocessRuntime } = await import("../src/subprocess-runtime.ts");
  const dir = tmpDir("m6a-env-");
  const bin = join(dir, "dump-env.mjs");
  writeFileSync(bin, `process.stdout.write(JSON.stringify({ git: Object.keys(process.env).filter(k => k.startsWith("GIT_")).sort() }) + "\\n");\n`);
  const saved = { bin: process.env.PI_BIN, dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
  process.env.PI_BIN = bin; process.env.GIT_DIR = join(dir, "lead.git"); process.env.GIT_INDEX_FILE = join(dir, "lead.index");
  t.after(() => { for (const [k, v] of [["PI_BIN", saved.bin], ["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.index]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const seen = async (mergerFor?: Run["mergerFor"]) => {
    const run = { id: "merger-env", persona: "merger", recordPath: join(dir, "record.json"), cwd: dir, depth: 1, delegateAllow: [], mergerFor } as unknown as Run;
    let line = "";
    const transport = subprocessRuntime.launch(run, ["--mode", "json", "-p", "x"], dir, { line: (l: string) => { line ||= l; }, close: () => {}, error: () => {}, gone: () => {}, initialDeliveryFailed: () => {} } as never);
    await transport.closed;
    return JSON.parse(line).git as string[];
  };
  assert.deepEqual(await seen({ writerId: "w", runId: "merger-env", nonce: "n", effort: "probe", gitRoot: dir, owner: { sessionId: "s", pid: 1, startTime: 1 } }), [], "a merger's git sees only its candidate");
  assert.deepEqual((await seen()).filter(k => k === "GIT_DIR" || k === "GIT_INDEX_FILE"), ["GIT_DIR", "GIT_INDEX_FILE"], "ordinary children are unchanged");
});
