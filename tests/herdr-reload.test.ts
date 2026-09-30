import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { buildOrphanRun } from "../src/reconcile-startup.ts";
import { RunRegistry, writeRecord, writeFinal } from "../src/runs.ts";
sandboxPi();

test("H10 reload: old timer/stream/writes fenced; child continues; new owner drains same invocation once", { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = herdrFixture("running"); let oldCalls = 0, newCalls = 0;
  void createRunPipeline(h.run, [], { ...h.opts, onComplete: () => oldCalls++ });
  assert.equal(h.run.transport?.kind, "herdr");
  if (h.run.transport?.kind !== "herdr") throw new Error("transport");
  await h.run.transport.ready;
  await Promise.all([1, 2, 3].map(() => handleSessionShutdown({ reason: "reload" }, { runs: [h.run], resetSanitizer() {} })));
  assert.deepEqual(h.signals, []); assert.equal(h.gone(), false); assert.equal(h.run.transport.observable, false);
  const saved = readFileSync(h.run.recordPath, "utf8");
  h.emit({ type: "agent_settled" }); h.exit();
  t.mock.timers.tick(10000);
  await writeRecord(h.run); await writeFinal(h.run);
  assert.equal(readFileSync(h.run.recordPath, "utf8"), saved); assert.equal(existsSync(h.run.finalPath), false); assert.equal(oldCalls, 0);
  const run = buildOrphanRun(JSON.parse(saved), "running"), registry = new RunRegistry(); registry.register(run);
  await createRunPipeline(run, [], { ...h.opts, registry, reattach: true, onComplete: () => newCalls++, onChain: () => assert.fail("no adoption chain"), onRetry: () => assert.fail("no adoption retry") });
  assert.equal(newCalls, 1); assert.equal(run.status, "completed"); assert.equal(run.usage.input, 12); assert.equal(run.usage.turns, 1);
  assert.equal(h.calls.filter(c => c === "agent start").length, 1, "reattach never sends another prompt");
  assert.equal(run.herdr?.settlement?.delivery, "attempted");
  assert.match(readFileSync(run.finalPath, "utf8"), /漢🙂/);
});

for (const mode of ["healthy", "ask"]) test(`H10 ${mode}: twice restarted settlement never repeats callback and repairs final artifact`, { timeout: 10000 }, async () => {
  const h = herdrFixture(mode); h.onSleep(() => h.exit()); let notifications = 0;
  await createRunPipeline(h.run, [], { ...h.opts, onComplete: () => notifications++ });
  assert.equal(notifications, 1);
  let run = h.run;
  for (let i = 0; i < 2; i++) {
    await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
    const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
    run = buildOrphanRun(record, "running");
    const registry = new RunRegistry(); registry.register(run);
    await createRunPipeline(run, [], { ...h.opts, registry, reattach: true, onComplete: () => notifications++ });
    assert.equal(notifications, 1, "no duplicate automatic dispatch");
    assert.equal(run.usage.input, 12); assert.equal(run.status, mode === "ask" ? "blocked" : "completed");
    if (mode === "ask") assert.equal(run.pendingAsk?.evidence, "original evidence");
  }
  await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
});

test("H10 interrupted dispatch intent is visibly uncertain across two restarts, without callback replay", { timeout: 10000 }, async () => {
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const h = herdrFixture(); await createRunPipeline(h.run, [], h.opts);
  await handleSessionShutdown({ reason: "reload" }, { runs: [h.run], resetSanitizer() {} });
  const saved = JSON.parse(readFileSync(h.run.recordPath, "utf8"));
  saved.herdr.settlement.delivery = "intent";
  writeFileSync(h.run.recordPath, JSON.stringify(saved)); unlinkSync(h.run.finalPath);
  let run = h.run;
  for (let i = 0; i < 2; i++) {
    const record = JSON.parse(readFileSync(run.recordPath, "utf8")); run = buildOrphanRun(record, "running");
    const registry = new RunRegistry(); registry.register(run);
    await createRunPipeline(run, [], { ...h.opts, registry, reattach: true, onComplete: () => assert.fail("ambiguous delivery cannot replay") });
    assert.equal(run.herdr?.settlement?.delivery, "uncertain"); assert.match(run.errorMessage!, /notification.*missing/);
    assert.match(readFileSync(run.finalPath, "utf8"), /漢🙂/);
    await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
  }
  assert.equal(h.calls.filter(c => c === "agent start").length, 1);
});

test("H10 late readiness: reload waits for held CLI, then fences old launch failure/callback without stopping child", { timeout: 10000 }, async () => {
  const h = herdrFixture("running"); let ready!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { ready = r; }), held = new Promise<void>(r => { release = r; });
  const json = h.cli.json; let gets = 0, callbacks = 0, shutdownReturned = false;
  h.cli.json = async (...args) => {
    const result = await json(...args);
    if (args[0][1] === "get" && ++gets === 2) { ready(); await held; }
    return result;
  };
  void createRunPipeline(h.run, [], { ...h.opts, onComplete: () => callbacks++ });
  await reached;
  const stopping = handleSessionShutdown({ reason: "reload" }, { runs: [h.run], resetSanitizer() {} }).then(() => { shutdownReturned = true; });
  await Promise.resolve(); assert.equal(shutdownReturned, false);
  release(); await stopping;
  assert.equal(callbacks, 0); assert.deepEqual(h.signals, []); assert.equal(h.run.status, "running");
  const saved = readFileSync(h.run.recordPath, "utf8");
  h.emit({ type: "agent_settled" }); h.exit();
  const run = buildOrphanRun(JSON.parse(saved), "running"), registry = new RunRegistry(); registry.register(run);
  await createRunPipeline(run, [], { ...h.opts, registry, reattach: true, onComplete: () => callbacks++ });
  assert.equal(callbacks, 1); assert.equal(run.status, "completed");
  await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
});

test("H10 live-control invocation markers do not double usage when reattaching the launch", { timeout: 10000 }, async () => {
  const { snapshotInvocationMarkers } = await import("../src/runs.ts");
  const h = herdrFixture("running"); void createRunPipeline(h.run, [], h.opts);
  if (h.run.transport?.kind !== "herdr") throw new Error("transport"); await h.run.transport.ready;
  assert.equal(h.run.usage.input, 12); snapshotInvocationMarkers(h.run, "steerCount"); await writeRecord(h.run);
  await handleSessionShutdown({ reason: "reload" }, { runs: [h.run], resetSanitizer() {} });
  h.emit({ type: "agent_settled" }); h.exit();
  const run = buildOrphanRun(JSON.parse(readFileSync(h.run.recordPath, "utf8")), "running"), registry = new RunRegistry(); registry.register(run);
  await createRunPipeline(run, [], { ...h.opts, registry, reattach: true });
  assert.equal(run.usage.input, 12); assert.equal(run.usage.turns, 1);
  await handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} });
});
