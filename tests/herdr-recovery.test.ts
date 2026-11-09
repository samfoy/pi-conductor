import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, sandboxPi } from "./helpers/tmp.ts";
import { claimHerdrOwner, readHerdrOwner } from "../src/herdr/ownership.ts";
import type { RunRecord } from "../src/types.ts";
sandboxPi();

const identity = (epoch = "module-a") => ({ epoch, sessionId: "session", pid: 1234, startTime: 42, socketPath: "/private/fake.socket", runId: "oracle-h10", launchNonce: "launch", at: 100 });
const dead = { platform: "linux", now: () => 100000, probe: () => ({ state: "gone" as const }) };

test("H10 owner: one generation winner; live and unknown refuse takeover including same PID reload", () => {
  const dir = tmpDir("h10-owner-");
  const first = claimHerdrOwner(dir, identity(), dead);
  for (const state of ["alive", "unknown"] as const) {
    assert.throws(() => claimHerdrOwner(dir, identity("module-b"), { ...dead, probe: () => ({ state, startTime: 42 }) }), /takeover refused/);
  }
  first.assert(); first.release();
  const second = claimHerdrOwner(dir, identity("module-b"), dead);
  assert.equal(second.identity.generation, 1);
  assert.throws(() => first.assert(), /fenced/);
  assert.throws(() => first.release(), /fenced/);
  second.assert();
});
test("H10 owner: same socket dead adoption, off-Linux 90 second floor, no invented procfs proof", () => {
  const dir = tmpDir("h10-owner-"); claimHerdrOwner(dir, identity(), dead);
  assert.throws(() => claimHerdrOwner(dir, { ...identity("foreign"), socketPath: "/other.socket" }, dead), /socket/);
  assert.throws(() => claimHerdrOwner(dir, identity("young"), { ...dead, platform: "darwin", now: () => 90099 }), /takeover refused/);
  assert.throws(() => claimHerdrOwner(dir, identity("unknown"), { ...dead, probe: () => ({ state: "alive" }) }), /takeover refused/);
  const next = claimHerdrOwner(dir, identity("older"), { ...dead, platform: "darwin", now: () => 90100 });
  assert.equal(next.identity.generation, 1);
});
test("H10 owner: incomplete newest claim and generation gaps fail closed, released files never reuse numbers", () => {
  const dir = tmpDir("h10-owner-"); const first = claimHerdrOwner(dir, identity(), dead); first.release();
  const second = claimHerdrOwner(dir, identity("b"), dead); second.release();
  assert.equal(readHerdrOwner(dir)?.generation, 1);
  writeFileSync(join(dir, "owner", "000002.json"), "{");
  assert.throws(() => claimHerdrOwner(dir, identity("c"), dead), /claim/);
  const gap = tmpDir("h10-owner-gap-"); mkdirSync(join(gap, "owner"));
  writeFileSync(join(gap, "owner", "000001.json"), JSON.stringify({ ...identity(), generation: 1 }));
  assert.throws(() => claimHerdrOwner(gap, identity(), dead), /claim/);
});

test("H10 startup classifies herdr before legacy pid/effort branches; unknown never becomes lost writer", async () => {
  const { classifyRecord } = await import("../src/reconcile-startup.ts");
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { toRunRecord } = await import("../src/types.ts");
  const h = herdrFixture(); const record = toRunRecord(h.run);
  const never = () => { assert.fail("must not consult legacy PID probe for herdr"); };
  for (const state of ["other-socket", "unknown"] as const) assert.equal(classifyRecord(record, never, 0, 1, never, "session", state), "skip-foreign");
  assert.equal(classifyRecord(record, never, 0, 1, never, "session", "alive"), "readopt-herdr");
  assert.equal(classifyRecord(record, never, 0, 1, never, "session", "settled"), "readopt-herdr");
  assert.equal(classifyRecord(record, never, 0, 1, never, "session", "gone"), "readopt-herdr");
});

test("H11 a requested herdr termination is never readopted as running on startup", async () => {
  // Live H11: a killed herdr run became "failed: pi exited before settling" after the next lead /reload.
  const { classifyRecord, reconcileOrphansAtStartup } = await import("../src/reconcile-startup.ts");
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { toRunRecord } = await import("../src/types.ts");
  const { RunRegistry } = await import("../src/runs.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const never = () => { assert.fail("must not consult legacy PID probe for herdr"); };
  for (const status of ["killed", "timeout", "aborted"] as const) {
    const h = herdrFixture(); const record = { ...toRunRecord(h.run), status };
    for (const probe of ["alive", "settled", "gone"] as const) assert.equal(classifyRecord(record, never, 0, 1, never, "session", probe), "skip-terminal", `${status}/${probe}`);
    const root = join(h.run.cwd, "runs"), dir = join(root, h.run.id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "record.json"), JSON.stringify({ ...record, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") }));
    let probes = 0, attaches = 0;
    const result = await reconcileOrphansAtStartup({ runsRoot: root, registry: new RunRegistry(), isAlive: never, now: 0, selfSessionId: "session",
      herdrProbe: async () => { probes++; return "gone"; }, attachHerdr: () => { attaches++; } });
    assert.deepEqual([probes, attaches, result.readopted], [0, 0, []], `${status}: no CLI probe, no attachment`);
  }
  const h = herdrFixture(); const running = toRunRecord(h.run);
  assert.equal(classifyRecord(running, never, 0, 1, never, "session", "gone"), "readopt-herdr", "an unfinished running record still recovers");
});

test("a terminal herdr record with a decided settlement is neither probed nor re-finalized on startup", async () => {
  const { classifyRecord, reconcileOrphansAtStartup } = await import("../src/reconcile-startup.ts");
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { toRunRecord } = await import("../src/types.ts");
  const { RunRegistry } = await import("../src/runs.ts");
  const never = () => { assert.fail("must not consult legacy PID probe for herdr"); };
  const startup = async (over: Partial<RunRecord>) => {
    const h = herdrFixture(); const base = toRunRecord(h.run);
    const root = join(h.run.cwd, "runs"), dir = join(root, h.run.id); mkdirSync(dir, { recursive: true });
    const record = { ...base, herdr: { launchNonce: "launch-1" } as RunRecord["herdr"], ...over,
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") } as RunRecord;
    writeFileSync(record.recordPath, JSON.stringify(record));
    let probes = 0, attaches = 0;
    const result = await reconcileOrphansAtStartup({ runsRoot: root, registry: new RunRegistry(), isAlive: never, now: 0, selfSessionId: "session",
      herdrProbe: async () => { probes++; return "gone"; }, attachHerdr: () => { attaches++; } });
    return { verdict: classifyRecord(record, never, 0, 1, never, "session", "gone"), probes, attaches, readopted: result.readopted.length };
  };
  const settled = (delivery: "intent" | "attempted" | "uncertain", launchNonce = "launch-1") => ({ herdr: { launchNonce: "launch-1", settlement: { launchNonce, delivery } } as RunRecord["herdr"] });
  for (const status of ["completed", "failed", "hook_failed", "merge_conflict"] as const) for (const delivery of ["attempted", "uncertain"] as const) {
    assert.deepEqual(await startup({ status, ...settled(delivery) }), { verdict: "skip-terminal", probes: 0, attaches: 0, readopted: 0 }, `${status}/${delivery}`);
  }
  const recovers = { verdict: "readopt-herdr", probes: 1, attaches: 1, readopted: 1 };
  assert.deepEqual(await startup({ status: "completed" }), recovers, "terminal record written before the settlement intent");
  assert.deepEqual(await startup({ status: "completed", ...settled("intent") }), recovers, "an interrupted dispatch is still marked uncertain once");
  assert.deepEqual(await startup({ status: "completed", ...settled("attempted", "older-launch") }), recovers, "another launch's settlement");
  assert.deepEqual(await startup({ status: "completed", ...settled("attempted"), worktreePath: "/kept" }), recovers, "a kept worktree");
  assert.deepEqual(await startup({ status: "failed", ...settled("attempted"), worktreeBranch: "kept" }), recovers, "a kept branch");
  assert.deepEqual(await startup({ status: "failed", ...settled("attempted"), herdrExitUnconfirmed: true }), recovers, "an unconfirmed child exit");
  assert.deepEqual(await startup({ status: "running", ...settled("attempted") }), recovers, "a running record");
  const effort = { name: "e", gitRoot: "/repo", role: "reader", spawnBase: "base", touches: [] } as unknown as RunRecord["effort"];
  assert.deepEqual(await startup({ status: "completed", ...settled("attempted"), effort }), recovers, "an effort member");
  const integration = { state: "queued", branchHead: "head", enqueuedAt: 1, attempts: 0, verifyIdentity: { command: "true", timeoutSeconds: 1, retries: 0 } } as RunRecord["integration"];
  assert.deepEqual(await startup({ status: "completed", ...settled("attempted"), integration }), recovers, "an integration entry");
  const mergerFor = { writer: "w" } as unknown as RunRecord["mergerFor"];
  assert.deepEqual(await startup({ status: "completed", ...settled("attempted"), mergerFor }), { verdict: "preserve-merger", probes: 1, attaches: 0, readopted: 0 }, "a merger");
});

test("H10 missing accepted native start after proven child death is an orphan failure, not successful recovery", { timeout: 10000 }, async () => {
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { createRunPipeline } = await import("../src/run-pipeline.ts");
  const { handleSessionShutdown } = await import("../src/shutdown.ts");
  const { buildOrphanRun } = await import("../src/reconcile-startup.ts");
  const { RunRegistry } = await import("../src/runs.ts");
  const { readFileSync } = await import("node:fs");
  const h = herdrFixture("running"); void createRunPipeline(h.run, [], h.opts);
  if (h.run.transport?.kind !== "herdr") throw new Error("transport"); await h.run.transport.ready;
  await handleSessionShutdown({ reason: "reload" }, { runs: [h.run], resetSanitizer() {} });
  writeFileSync(h.run.transcriptPath, readFileSync(h.run.transcriptPath, "utf8").split("\n").filter(line => !line.includes('"type":"agent_start"')).join("\n"));
  h.exit();
  const run = buildOrphanRun(JSON.parse(readFileSync(h.run.recordPath, "utf8")), "running"), registry = new RunRegistry(); registry.register(run);
  assert.equal(await h.runtime.probeRecord(run), "gone");
  await createRunPipeline(run, [], { ...h.opts, registry, reattach: true });
  assert.equal(run.status, "failed"); assert.match(run.errorMessage!, /exited before.*native/);
  assert.equal(run.herdrResultUnavailable, true);
  await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
});

test("H10 startup unknown and foreign socket preserve bytes and registry, even for proc-less effort writers", async () => {
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { reconcileOrphansAtStartup, classifyRecord } = await import("../src/reconcile-startup.ts");
  const { toRunRecord } = await import("../src/types.ts");
  const { RunRegistry } = await import("../src/runs.ts");
  const { readFileSync } = await import("node:fs");
  const h = herdrFixture(); const record = toRunRecord(h.run);
  record.effort = { name: "unknown", gitRoot: h.run.cwd, role: "writer", spawnBase: "base", touches: [] };
  const saved = JSON.stringify(record); writeFileSync(h.run.recordPath, saved);
  for (const state of ["unknown", "other-socket"] as const) {
    const registry = new RunRegistry();
    const result = await reconcileOrphansAtStartup({ runsRoot: h.run.cwd, registry, now: 0, isAlive: () => assert.fail("legacy PID probe"), herdrProbe: async () => state, attachHerdr: () => assert.fail("unknown must not attach") });
    assert.deepEqual(result.skippedForeign, [record.id]); assert.equal(registry.list().length, 0); assert.equal(readFileSync(h.run.recordPath, "utf8"), saved);
  }
  record.integration = { state: "accepted", branchHead: "head", enqueuedAt: 1, attempts: 1, verifyIdentity: { command: "true", timeoutSeconds: 1, retries: 0 } };
  record.status = "completed";
  assert.equal(classifyRecord(record, () => assert.fail("legacy probe"), 0, 1, () => false, "session", "settled"), "restore-integrating", "durable accepted WAL is exclusively M5 recovery");
});

test("H10 manual worktree cleanup snapshot refuses a newer owner before destructive effects", { timeout: 10000 }, async () => {
  const { herdrFixture } = await import("./helpers/herdr-pipeline.ts");
  const { createRunPipeline } = await import("../src/run-pipeline.ts");
  const { writeRecord, worktreeCleanupGuard, releaseWorktree } = await import("../src/runs.ts");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const h = herdrFixture(); await createRunPipeline(h.run, [], h.opts);
  h.run.worktreePath = tmpDir("h10-kept-worktree-"); h.run.worktreeBranch = "kept"; await writeRecord(h.run);
  const current = worktreeCleanupGuard(h.run, () => h.run); assert.equal(current(), true, "positive ownership control");
  const old = h.run.herdrOwnership!; old.release();
  const newer = claimHerdrOwner(dirname(h.run.recordPath), { ...old.identity, epoch: "next-module" });
  assert.equal(current(), false); assert.equal(await releaseWorktree(h.run, { keepBranch: true, isCurrent: current }), false);
  assert.equal(existsSync(h.run.worktreePath!), true); assert.equal(h.calls.includes("pane close"), false);
  newer.release();
});
