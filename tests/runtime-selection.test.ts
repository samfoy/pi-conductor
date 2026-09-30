import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as runtime from "../src/runtime.ts";
import { spawnRun, sendToRun, failBeforeSpawn, RunRegistry, runsRoot, availableActions, writeRecord, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { buildOrphanRun, classifyRecord, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { loadConfigWithErrors, userConfigPath } from "../src/config.ts";
import { resolvePersonas, projectPersonasDir, userPersonasDir } from "../src/personas.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { requeueEffortRun, recoverEffort } from "../src/effort/reconcile.ts";
import { formatRunRowForTest } from "../src/commands.ts";
import { buildDoctorReport } from "../src/doctor.ts";
import { registerTools, buildOnRetryCallback, buildOnChainCallback } from "../src/tools.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, toRunRecord, DEFAULT_CONFIG, type Run, type Persona } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const herdr = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/fake/socket", HERDR_PANE_ID: "fake-pane" };
const persona: Persona = { name: "inspector", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" };
function run(over: Partial<Run> = {}): Run {
  const cwd = tmpDir("h2-record-");
  return { id: "inspector-saved", persona: "inspector", task: "probe", cwd, mode: "background", status: "completed", startTime: 1, lastEventAt: 1, messages: [], usage: emptyUsage(), recordPath: join(cwd, "record.json"), transcriptPath: join(cwd, "transcript.jsonl"), finalPath: join(cwd, "final.md"), ...over };
}
function fakeChild(t: test.TestContext) {
  let launches = 0;
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true, unref() {} });
  t.mock.method(cp, "spawn", () => { launches++; return proc; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { proc, launches: () => launches };
}
function options(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return { registry: new RunRegistry(), persona, task: "probe", cwd: tmpDir("h2-cwd-"), mode: "background", timeoutMs: 4000, runtimeEnv: {}, ...over };
}

test("H2 pure cascade: per-call > effective persona > project > user > auto", () => {
  for (const [input, kind, source] of [
    [{ perCall: "subprocess", persona: "herdr", project: "herdr", user: "herdr" }, "subprocess", "per-call"],
    [{ persona: "subprocess", project: "herdr", user: "herdr" }, "subprocess", "persona"],
    [{ project: "subprocess", user: "herdr" }, "subprocess", "project"],
    [{ user: "subprocess" }, "subprocess", "user"],
    [{}, "herdr", "auto"],
    [{ perCall: "auto", persona: "subprocess" }, "herdr", "per-call"],
  ] as const) assert.deepEqual(runtime.resolveRuntime({ ...input, env: herdr }), { ok: true, kind, source });
  for (const bad of ["", "rpc", "HERDR", null, 3]) {
    const result = runtime.resolveRuntime({ perCall: bad as never, env: herdr });
    assert.equal(result.ok, false, `invalid runtime ${JSON.stringify(bad)} must fail closed`);
  }
});

test("H2 auto requires the complete exact herdr environment", () => {
  for (let mask = 0; mask < 8; mask++) {
    const env = Object.fromEntries(Object.entries(herdr).filter((_, i) => mask & (1 << i)));
    assert.deepEqual(runtime.resolveRuntime({ env }), { ok: true, kind: mask === 7 ? "herdr" : "subprocess", source: "auto" }, `environment mask ${mask}`);
    assert.equal(runtime.resolveRuntime({ perCall: "herdr", env }).ok, mask === 7);
  }
  for (const key of Object.keys(herdr)) {
    assert.deepEqual(runtime.resolveRuntime({ env: { ...herdr, [key]: "" } }), { ok: true, kind: "subprocess", source: "auto" });
  }
  for (const HERDR_ENV of ["true", "0", "yes"]) assert.deepEqual(runtime.resolveRuntime({ env: { ...herdr, HERDR_ENV } }), { ok: true, kind: "subprocess", source: "auto" });
});

test("H2 config and frontmatter use existing field-level persona precedence; invalid runtime is diagnosed", async () => {
  const cwd = tmpDir("h2-config-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(cwd), "inspector.md"), "---\nname: inspector\ndescription: probe\nruntime: herdr\n---\nProbe");
  mkdirSync(join(userConfigPath(), ".."), { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify({ runtime: "herdr", personaOverrides: { inspector: { runtime: "subprocess" } } }));
  try {
    writeFileSync(join(cwd, ".pi/conductor.json"), JSON.stringify({ runtime: "auto", personaOverrides: { inspector: { thinking: "high" } } }));
    const layers = loadConfigWithErrors(cwd);
    assert.equal(layers.user.runtime, "herdr"); assert.equal(layers.project.runtime, "auto");
    const resolved = await resolvePersonas({ cwd, personaOverrides: layers.config.personaOverrides });
    assert.equal(resolved.personas.get("inspector")?.runtime, "subprocess");
    const invalid = await resolvePersonas({ cwd, personaOverrides: { inspector: { runtime: "rpc" as never } } });
    assert.equal(invalid.personas.has("inspector"), false); assert.match(invalid.errors[0]!.reason, /runtime/);
    writeFileSync(join(cwd, ".pi/conductor.json"), '{"runtime":"rpc"}');
    assert.match(loadConfigWithErrors(cwd).errors.map(e => e.reason).join(" "), /runtime/);
    assert.throws(() => spawnRun(options({ cwd, persona: { ...persona, name: "oracle", runtime: undefined } })), /runtime/);
    writeFileSync(join(projectPersonasDir(cwd), "bad.md"), "---\nname: bad\ndescription: probe\nruntime: rpc\n---\nProbe");
    assert.match((await resolvePersonas({ cwd })).errors.map(e => e.reason).join(" "), /runtime/);
  } finally { rmSync(userConfigPath()); }
});

for (const queued of [false, true]) test(`H7 herdr passes runtime selection but invalid effort rejects before ${queued ? "queue" : "direct spawn"} effects`, t => {
  const child = fakeChild(t);
  for (const selection of ["herdr", "auto"] as const) {
    const opts = options({ runtime: selection, runtimeEnv: herdr, worktree: true, effort: "must-not-open", persona: { ...persona, readOnly: false } });
    const queue = new SpawnQueue(opts.registry, 1);
    if (queued) opts.registry.register(run({ status: "running" }));
    const before = existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [];
    assert.throws(() => queued ? queue.enqueueOrSpawn(opts) : spawnRun(opts), /efforts require a non-bare git repository/);
    assert.equal(child.launches(), 0); assert.equal(queue.size(), 0);
    assert.equal(opts.registry.list().length, queued ? 1 : 0);
    assert.deepEqual(readdirSync(opts.cwd), [], "no effort or worktree created");
    assert.deepEqual(existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [], before, "no run directory");
  }
});

for (const [choice, env, task] of [[undefined, {}, "short"], ["subprocess", herdr, "short"], ["subprocess", herdr, "x".repeat(100_000)]] as const) {
  test(`H2 native fake-child positive control ${choice ?? "default"}/${task.length}: runtime is not transport`, async t => {
    const child = fakeChild(t);
    const opts = options({ runtime: choice, runtimeEnv: env, task });
    const result = spawnRun(opts); t.after(() => clearTimeout(result.run.timeoutTimer));
    assert.equal(result.run.runtime, "subprocess");
    assert.equal(result.run.streamingMode, task.length > 96 * 1024 ? "rpc" : "print");
    assert.equal(result.run.steerable, false);
    assert.equal(availableActions(result.run).includes("steer"), false);
    child.proc.stdout.write('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Completed with verification and final evidence."}],"stopReason":"stop"}}\n{"type":"agent_settled"}\n');
    await result.done; child.proc.emit("close", 0);
    assert.equal(result.run.status, "completed");
    assert.equal(JSON.parse(readFileSync(result.run.recordPath, "utf8")).runtime, "subprocess");
  });
}

test("H2 queued concrete runtime survives environment/config changes and drain", async t => {
  const child = fakeChild(t); const registry = new RunRegistry();
  const busy = run({ status: "running" }); registry.register(busy);
  const env: NodeJS.ProcessEnv = {};
  const queue = new SpawnQueue(registry, 1);
  const result = queue.enqueueOrSpawn(options({ registry, runtimeEnv: env }));
  assert.equal(result.kind, "queued"); if (result.kind !== "queued") return;
  assert.equal(result.placeholderRun.runtime, "subprocess");
  assert.equal(result.pending.spawn.runtime, "subprocess");
  assert.equal(toRunRecord(result.placeholderRun).runtime, "subprocess");
  Object.assign(env, herdr); busy.status = "completed"; registry.notify(busy);
  const promoted = registry.get(result.placeholderRun.id)!;
  t.after(() => clearTimeout(promoted.timeoutTimer));
  assert.equal(promoted.runtime, "subprocess"); assert.equal(child.launches(), 1);
  child.proc.emit("close", 1); await promoted.recordWrite;
});

test("H2 restore preserves saved runtime and legacy means subprocess; herdr send cannot write stdin or restore worktrees", async t => {
  fakeChild(t);
  for (const selected of [undefined, "subprocess", "herdr"] as const) {
    const original = run({ runtime: selected, worktreePath: "/must-not-restore", streamingMode: "rpc", steerable: true });
    writeFileSync(join(original.cwd, "session.jsonl"), '{"type":"session","id":"saved"}\n');
    original.sessionPath = join(original.cwd, "session.jsonl");
    const restored = buildOrphanRun(toRunRecord(original), "completed");
    assert.equal(restored.runtime, selected ?? "subprocess", "saved runtime must survive restore");
    assert.equal(toRunRecord(restored).runtime, selected ?? "subprocess");
    if (selected === "herdr") {
      const before = JSON.stringify(toRunRecord(restored));
      const response = sendToRun(restored, "continue", { registry: new RunRegistry(), timeoutMs: 4000 });
      assert.equal(response.kind, "rejected"); if (response.kind === "rejected") assert.match(response.reason, /herdr.*unavailable/i);
      assert.deepEqual(availableActions(restored), []); assert.equal(JSON.stringify(toRunRecord(restored)), before);
    }
  }
});

test("H2 reconcile preserves herdr records without probing or signalling guessed PIDs", async () => {
  const root = tmpDir("h2-reconcile-"); const registry = new RunRegistry();
  for (const status of ["running", "queued", "blocked", "integrating", "completed"] as const) {
    const r = run({ id: `inspector-${status}`, runtime: "herdr", status, pid: 123, parentPid: 456, streamingMode: "rpc" });
    const dir = join(root, r.id); mkdirSync(dir); const path = join(dir, "record.json");
    const saved = JSON.stringify(toRunRecord(r)); writeFileSync(path, saved);
    const forbidden = () => { assert.fail("unsupported runtime must not probe or signal"); return false; };
    assert.equal(classifyRecord(toRunRecord(r), forbidden, 1, 1, forbidden), "skip-foreign");
    const result = await reconcileOrphansAtStartup({ runsRoot: root, registry, now: 1, isAlive: forbidden, isParentAlive: forbidden, signal: forbidden });
    assert.ok(result.skippedForeign.includes(r.id));
    assert.equal(readFileSync(path, "utf8"), saved); assert.deepEqual(registry.list(), []);
  }
});

// Tool registration is the real production entry; only child launching is substituted.
function tools(cwd: string, env: NodeJS.ProcessEnv, queue: SpawnQueue, registry: RunRegistry) {
  const registered = new Map<string, any>(); // Pi's generic execute schema is intentionally erased by the harness.
  registerTools({ registerTool: (t: any) => registered.set(t.name, t) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [],
    openFocusedOverlay() {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }), pushCompletionNotification() {},
  }, env);
  return registered;
}

test("H2 tool spawn and every auto step preflight runtime before the queue or effort opens", async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  const registered = tools(opts.cwd, herdr, queue, opts.registry);
  assert.ok(registered.get("ensemble_spawn").parameters.properties.runtime);
  assert.ok(registered.get("ensemble_auto").parameters.properties.steps.items.properties.runtime);
  const spawn = await registered.get("ensemble_spawn").execute("s", { persona: "builder", task: "probe", effort: "no-open", foreground: false });
  assert.match(spawn.content[0].text, /efforts require a non-bare git repository/);
  const auto = await registered.get("ensemble_auto").execute("a", { goal: "probe", max_steps: 2, steps: [{ persona: "inspector", task: "first", runtime: "subprocess" }, { persona: "inspector", task: "second", runtime: "future" }] });
  assert.equal(auto.details.status, "halted"); assert.match(auto.details.haltReason, /runtime/);
  assert.equal(child.launches(), 0); assert.equal(queue.size(), 0); assert.deepEqual(opts.registry.list(), []); assert.deepEqual(readdirSync(opts.cwd), []);
});

test("H2 doctor reports configured/effective/source and legacy runtime without process effects", async t => {
  let effects = 0;
  t.mock.method(cp, "execSync", () => { effects++; return Buffer.from(""); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const opts = options(); opts.registry.register(run());
  mkdirSync(join(opts.cwd, ".pi")); writeFileSync(join(opts.cwd, ".pi/conductor.json"), JSON.stringify({ personaOverrides: { inspector: { onCompleteHook: "echo checked" } } }));
  const report = await buildDoctorReport({ cwd: opts.cwd, registry: opts.registry, queue: new SpawnQueue(opts.registry, 1), conductorMode: false, env: herdr });
  assert.equal(effects, 0, "doctor checks must not launch processes");
  assert.match(report, /configured.*auto/); assert.match(report, /inspector.*herdr.*auto/i); assert.doesNotMatch(report, /inspector.*herdr.*unavailable/i); assert.match(report, /legacy.*subprocess/i);
});


test("H2 tagged records survive subsequent GC, even stale or over budget", async () => {
  const root = tmpDir("h2-gc-"); const r = run({ runtime: "herdr", status: "running" });
  mkdirSync(join(root, r.id)); writeFileSync(join(root, r.id, "record.json"), JSON.stringify(toRunRecord(r)));
  const plan = planReclaim(await walkInventory(root, new RunRegistry()), { ...DEFAULT_CONFIG.gc, totalSizeBudgetBytes: 0 }, Date.now());
  assert.equal(plan.actions[0]!.kind, "keep", "unavailable backend evidence cannot be orphan-reclassified by GC");
});

test("H2 legacy resume through real tool inside herdr stays subprocess", async t => {
  const child = fakeChild(t); const r = buildOrphanRun(toRunRecord(run()), "completed");
  writeFileSync(join(r.cwd, "session.jsonl"), '{"type":"session","id":"saved","cwd":"/tmp"}\n'); r.sessionPath = join(r.cwd, "session.jsonl");
  mkdirSync(join(r.cwd, ".pi")); writeFileSync(join(r.cwd, ".pi/conductor.json"), '{"runtime":"herdr"}');
  const registry = new RunRegistry(); registry.register(r);
  const registered = tools(r.cwd, herdr, new SpawnQueue(registry, 1), registry);
  const sending = registered.get("ensemble_send").execute("s", { agent_id: r.id, message: "continue", foreground: false });
  // A real send uses the saved concrete backend, not current config or the tool's environment.
  const response = await sending;
  assert.equal(child.launches(), 1, JSON.stringify(response)); assert.equal(r.runtime, "subprocess");
  t.after(() => clearTimeout(r.timeoutTimer)); child.proc.emit("close", 1); await sending;
  await r.recordWrite; assert.equal(JSON.parse(readFileSync(r.recordPath, "utf8")).runtime, "subprocess");
  const status = await registered.get("ensemble_status").execute("status", { agent_id: r.id });
  assert.equal(status.details.finished[0].runtime, "subprocess");
  assert.match(status.content[0].text, /runtime=subprocess/);
});

test("H2 retry preserves concrete selection; fresh chains resolve current successor config", async () => {
  const registry = new RunRegistry(); const calls: SpawnOptions[] = [];
  const queue = { enqueueOrSpawn(opts: SpawnOptions) { calls.push(opts); } } as unknown as SpawnQueue;
  const cwd = tmpDir("h2-lineage-"); mkdirSync(join(cwd, ".pi"));
  const cfg = { ...DEFAULT_CONFIG, runtime: "herdr" as const, chains: { inspector: { then: "oracle" } } };
  const retry = buildOnRetryCallback({ originalTask: "probe", persona, cfg, queue, cwd, pushNotification() {}, getParentMessages: () => [] });
  retry(run({ runtime: "subprocess", status: "failed" }));
  assert.equal(calls.pop()!.runtime, "subprocess", "retry cannot migrate through current auto/env");
  retry(run({ runtime: undefined, status: "failed" })); assert.equal(calls.pop()!.runtime, "subprocess", "legacy retry is subprocess");
  const chain = buildOnChainCallback({ chainEnabled: true, personaName: "inspector", cfg, queue, registry, cwd, runtimeEnv: herdr, pushNotification() {}, getParentMessages: () => [] })!;
  writeFileSync(join(cwd, ".pi/conductor.json"), '{"runtime":"subprocess"}');
  await chain(run({ cwd, runtime: "herdr" })); assert.equal(calls.pop()!.runtime, "subprocess", "fresh successor resolves current config, not parent backend");
  writeFileSync(join(cwd, ".pi/conductor.json"), '{"runtime":"herdr"}');
  await chain(run({ cwd, runtime: "subprocess" })); assert.equal(calls.pop()!.runtime, "herdr", "H7 fresh successor can select the herdr backend");
  assert.deepEqual(registry.list(), []);
});

test("H2 auto retries carry each accepted concrete step runtime", async () => {
  const env: NodeJS.ProcessEnv = {};
  const registry = new RunRegistry(); const calls: SpawnOptions[] = [];
  const queue = { enqueueOrSpawn(opts: SpawnOptions) {
    calls.push(opts); Object.assign(env, herdr);
    const r = run({ id: `inspector-${calls.length}`, status: calls.length === 1 ? "failed" : "completed", failureClass: "environment", runtime: opts.runtime as Run["runtime"] });
    registry.register(r); return { kind: "spawned", run: r, done: Promise.resolve(r) };
  } } as unknown as SpawnQueue;
  const cwd = tmpDir("h2-auto-");
  const registered = tools(cwd, env, queue, registry);
  const result = await registered.get("ensemble_auto").execute("a", { goal: "probe", max_steps: 4, steps: [{ persona: "inspector", task: "first" }, { persona: "inspector", task: "second", runtime: "subprocess" }] });
  assert.equal(result.details.status, "done"); assert.deepEqual(calls.map(c => c.runtime), ["subprocess", "subprocess", "subprocess"]);
  assert.deepEqual(calls.map(c => c.retryAttempt), [0, 1, 0]);
});

test("H2 herdr live-send and recovery refuse before stdin/ownership/integration effects", async t => {
  const child = fakeChild(t); const r = run({ runtime: "herdr", status: "running", streamingMode: "rpc", steerable: true });
  r.proc = child.proc as unknown as Run["proc"];
  r.rpcStdinQueue = { writable: true, enqueue: () => assert.fail("no stdin writes") } as unknown as Run["rpcStdinQueue"];
  const registry = new RunRegistry(); registry.register(r);
  const sent = sendToRun(r, "steer", { registry, streamingBehavior: "steer", timeoutMs: 4000 });
  assert.equal(sent.kind, "rejected"); if (sent.kind === "rejected") assert.match(sent.reason, /herdr.*unavailable/);
  assert.deepEqual(availableActions(r), []);
  await assert.rejects(requeueEffortRun(r, { registry, sessionId: "test" }), /stopped preserved writer/);
  const effort = { gitRoot: r.cwd, name: "probe" };
  const saved = { ...toRunRecord(r), effort };
  mkdirSync(join(runsRoot(), r.id), { recursive: true }); writeFileSync(join(runsRoot(), r.id, "record.json"), JSON.stringify({ ...saved, recordPath: join(runsRoot(), r.id, "record.json"), finalPath: join(runsRoot(), r.id, "final.md"), transcriptPath: join(runsRoot(), r.id, "transcript.jsonl") }));
  await assert.rejects(recoverEffort(effort as never, { registry: new RunRegistry(), sessionId: "test" }), /effort record missing/);
  assert.equal(child.launches(), 0); assert.deepEqual(readdirSync(r.cwd), []);
});


test("H2 refused chain successors retain runtime metadata and cannot create unavailable runs", () => {
  const opts = options();
  const failed = failBeforeSpawn({ ...opts, runtime: "subprocess" }, "kept parent branch");
  assert.equal(failed.runtime, "subprocess"); assert.equal(toRunRecord(failed).runtime, "subprocess");
  const before = opts.registry.list().length;
  assert.throws(() => failBeforeSpawn({ ...opts, runtime: "herdr", runtimeEnv: {} }, "kept parent branch"), /HERDR_ENV/);
  assert.equal(opts.registry.list().length, before);
});


test("H2 slash status names saved runtime without probing a herdr-tagged PID", () => {
  const r = run({ runtime: "herdr", status: "running", pid: 123 });
  assert.match(formatRunRowForTest(r, () => assert.fail("herdr PID must not be probed")), /runtime=herdr/);
  assert.match(formatRunRowForTest(run()), /runtime=subprocess/);
});

test("H2 explicit native RPC retains subprocess runtime and live actions", async t => {
  const child = fakeChild(t);
  const spawned = spawnRun(options({ runtime: "subprocess", runtimeEnv: herdr, steerable: true }));
  t.after(() => clearTimeout(spawned.run.timeoutTimer));
  assert.equal(spawned.run.runtime, "subprocess"); assert.equal(spawned.run.streamingMode, "rpc");
  assert.ok(availableActions(spawned.run).includes("steer")); assert.ok(availableActions(spawned.run).includes("follow_up"));
  child.proc.emit("close", 1); await spawned.done;
  assert.equal(toRunRecord(spawned.run).runtime, "subprocess");
});


for (const selector of ["rpc", ""] as const) test(`H2 B1 invalid project runtime ${JSON.stringify(selector)} cannot launch fallback persona`, async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  t.after(() => { child.proc.emit("close", 1); for (const r of opts.registry.list()) clearTimeout(r.timeoutTimer); });
  mkdirSync(projectPersonasDir(opts.cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(opts.cwd), "inspector.md"), `---\nname: inspector\ndescription: project\nruntime: "${selector}"\n---\nProject only.`);
  const before = existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [];
  const registered = tools(opts.cwd, {}, queue, opts.registry);
  const response = await registered.get("ensemble_spawn").execute("invalid", { persona: "inspector", task: "must not fall back", foreground: false });
  assert.equal(child.launches(), 0, "invalid shadowing persona must not launch a lower-priority fallback");
  assert.match(response.content[0].text, /not found|runtime/);
  assert.deepEqual(opts.registry.list(), []); assert.equal(queue.size(), 0);
  assert.deepEqual(existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [], before);
  const resolved = await resolvePersonas({ cwd: opts.cwd });
  assert.equal(resolved.personas.has("inspector"), false);
  assert.equal(resolved.personas.has("oracle"), true, "unrelated personas still resolve");
  assert.ok(resolved.errors.some(e => e.path.endsWith("inspector.md") && /runtime/.test(e.reason)));
});

test("H2 B1 invalid candidate masks its filename, never an unrelated malformed metadata name", async () => {
  const cwd = tmpDir("h2-shadow-name-"); mkdirSync(projectPersonasDir(cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(cwd), "inspector.md"), "---\nname: oracle\ndescription: invalid inspector candidate\nruntime: rpc\n---\nProbe");
  const resolved = await resolvePersonas({ cwd });
  assert.equal(resolved.personas.has("inspector"), false, "candidate filename identifies the unavailable override");
  assert.equal(resolved.personas.has("oracle"), true, "invalid metadata cannot mask an unrelated persona");
});

test("H2 B1 valid higher-priority project override still launches explicit subprocess under herdr", async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  t.after(() => { child.proc.emit("close", 1); for (const r of opts.registry.list()) clearTimeout(r.timeoutTimer); });
  mkdirSync(projectPersonasDir(opts.cwd), { recursive: true });
  mkdirSync(userPersonasDir(), { recursive: true });
  const invalidUserPath = join(userPersonasDir(), "inspector.md");
  writeFileSync(invalidUserPath, "---\nname: inspector\ndescription: invalid user\nruntime: rpc\n---\nUser");
  t.after(() => rmSync(invalidUserPath));
  writeFileSync(join(projectPersonasDir(opts.cwd), "inspector.md"), "---\nname: inspector\ndescription: valid project\nruntime: subprocess\n---\nOnly the project persona.");
  const registered = tools(opts.cwd, herdr, queue, opts.registry);
  await registered.get("ensemble_spawn").execute("valid", { persona: "inspector", task: "probe", foreground: false });
  assert.equal(child.launches(), 1); assert.equal(opts.registry.list()[0]!.runtime, "subprocess");
  assert.match(opts.registry.list()[0]!.systemPrompt!, /Only the project persona/);
  assert.equal((await resolvePersonas({ cwd: opts.cwd })).personas.get("inspector")?.source, "project");
});

for (const selector of [null, "", "future-runtime"] as const) test(`H2 B2 direct spawn rejects present invalid override ${JSON.stringify(selector)} before all effects`, async t => {
  const child = fakeChild(t); let workspaceCalls = 0;
  t.mock.method(cp, "execSync", () => { workspaceCalls++; throw new Error("not a git repository"); }); syncBuiltinESMExports();
  const opts = options({ worktree: true });
  mkdirSync(join(opts.cwd, ".pi")); const configPath = join(opts.cwd, ".pi/conductor.json");
  const config = JSON.stringify({ personaOverrides: { inspector: { runtime: selector } } }); writeFileSync(configPath, config);
  const before = existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [];
  let launched: ReturnType<typeof spawnRun> | undefined; let error: unknown;
  t.after(async () => { if (launched) { clearTimeout(launched.run.timeoutTimer); child.proc.emit("close", 1); await launched.done; } });
  try { launched = spawnRun(opts); } catch (e) { error = e; }
  assert.equal(child.launches(), 0, "present invalid persona runtime must not launch a subprocess");
  assert.ok(error instanceof Error); assert.match(error.message, /runtime/);
  assert.equal(workspaceCalls, 0); assert.deepEqual(opts.registry.list(), []);
  assert.deepEqual(existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [], before);
  assert.deepEqual(readdirSync(opts.cwd), [".pi"]); assert.equal(readFileSync(configPath, "utf8"), config);
});

for (const selector of [null, "", "future-runtime"] as const) test(`H2 B2 raw record ${JSON.stringify(selector)} cannot gain send authority after roundtrip`, async t => {
  const child = fakeChild(t); const original = run({ status: "blocked", pendingAsk: { askId: "ask-1", question: "Proceed?", evidence: "Keep evidence" } });
  const workspace = join(original.cwd, "kept-worktree"); mkdirSync(workspace);
  writeFileSync(join(workspace, "evidence.txt"), "unchanged workspace");
  original.worktreePath = workspace; original.worktreeBranch = "kept-branch";
  original.sessionPath = join(original.cwd, "session.jsonl");
  const session = JSON.stringify({ type: "session", id: "saved", cwd: workspace }) + "\n"; writeFileSync(original.sessionPath, session);
  // Parse raw disk data: do not let a test fixture normalize the invalid value first.
  const raw = JSON.parse(JSON.stringify({ ...toRunRecord(original), runtime: selector }));
  assert.equal(classifyRecord(raw, () => assert.fail("no PID probes"), 1), "skip-unsupported-runtime");
  const restored = buildOrphanRun(raw, "blocked");
  const roundtrip = JSON.parse(JSON.stringify(toRunRecord(restored)));
  const target = buildOrphanRun(roundtrip, "blocked"); const before = structuredClone(target);
  const registry = new RunRegistry(); registry.register(target);
  const sent = sendToRun(target, "yes", { registry, timeoutMs: 4000 });
  t.after(async () => { if (sent.kind === "started") { clearTimeout(target.timeoutTimer); child.proc.emit("close", 1); await sent.done; } });
  assert.equal(child.launches(), 0, "present invalid saved runtime must not launch after restore/serialization");
  assert.equal(sent.kind, "rejected"); if (sent.kind === "rejected") assert.match(sent.reason, /runtime.*unavailable/);
  assert.equal(restored.runtime, selector); assert.equal(roundtrip.runtime, selector);
  assert.deepEqual(target, before, "state, ask and worktree metadata remain unchanged");
  assert.equal(readFileSync(original.sessionPath, "utf8"), session);
  assert.equal(readFileSync(join(workspace, "evidence.txt"), "utf8"), "unchanged workspace");
  assert.equal(existsSync(target.recordPath), false, "refusal writes no record");
});

test("H2 B2 truly absent record tag is still legacy subprocess", () => {
  const raw = toRunRecord(run()); delete (raw as { runtime?: unknown }).runtime;
  const restored = buildOrphanRun(JSON.parse(JSON.stringify(raw)), "completed");
  assert.equal(restored.runtime, "subprocess"); assert.equal(toRunRecord(restored).runtime, "subprocess");
});


test("H2 B2 retry cannot normalize a present null runtime into subprocess", async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  t.after(() => { child.proc.emit("close", 1); for (const r of opts.registry.list()) clearTimeout(r.timeoutTimer); });
  const retry = buildOnRetryCallback({ originalTask: "probe", persona, cfg: DEFAULT_CONFIG, queue, cwd: opts.cwd, pushNotification() {}, getParentMessages: () => [] });
  let error: unknown;
  try { retry(run({ runtime: null as never, status: "failed" })); } catch (e) { error = e; }
  assert.equal(child.launches(), 0, "invalid retry runtime must not launch a subprocess");
  assert.ok(error instanceof Error); assert.match(error.message, /runtime/);
  assert.deepEqual(opts.registry.list(), []);
});

test("H2 B2 status and doctor never present null as a supported or automatic backend", async () => {
  const opts = options(); const r = run({ runtime: null as never, status: "running", pid: 123 }); opts.registry.register(r);
  const queue = new SpawnQueue(opts.registry, 1); const registered = tools(opts.cwd, {}, queue, opts.registry);
  const status = await registered.get("ensemble_status").execute("status", {});
  assert.equal(status.details.running[0].runtime, null); assert.match(status.content[0].text, /runtime=null/);
  assert.match(formatRunRowForTest(r, () => assert.fail("null backend cannot probe subprocess PID")), /runtime=null/);
  mkdirSync(join(opts.cwd, ".pi")); writeFileSync(join(opts.cwd, ".pi/conductor.json"), '{"runtime":null}');
  const report = await buildDoctorReport({ cwd: opts.cwd, registry: opts.registry, queue, conductorMode: false, env: {} });
  assert.match(report, /configured: null/); assert.match(report, /saved=null/);
});


for (const malformedName of ["team-reader", "oracle"]) test(`H2 source identity: invalid custom-reader file cannot launch its validated lower persona (${malformedName})`, async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  t.after(() => { child.proc.emit("close", 1); for (const r of opts.registry.list()) clearTimeout(r.timeoutTimer); });
  mkdirSync(userPersonasDir(), { recursive: true }); mkdirSync(projectPersonasDir(opts.cwd), { recursive: true });
  const userPath = join(userPersonasDir(), "custom-reader.md");
  writeFileSync(userPath, "---\nname: team-reader\ndescription: valid user\nruntime: subprocess\n---\nUser reader.");
  t.after(() => rmSync(userPath));
  writeFileSync(join(projectPersonasDir(opts.cwd), "custom-reader.md"), `---\nname: ${malformedName}\ndescription: invalid project\nruntime: rpc\n---\nMust not substitute a user reader.`);
  const before = existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [];
  const registered = tools(opts.cwd, {}, queue, opts.registry);
  const response = await registered.get("ensemble_spawn").execute("invalid-custom", { persona: "team-reader", task: "must not fall back", foreground: false });
  assert.equal(child.launches(), 0, "invalid source filename must not launch its validated lower-priority persona");
  assert.match(response.content[0].text, /not found|runtime/);
  assert.deepEqual(opts.registry.list(), []); assert.equal(queue.size(), 0);
  assert.deepEqual(existsSync(runsRoot()) ? readdirSync(runsRoot()).sort() : [], before);
  const resolved = await resolvePersonas({ cwd: opts.cwd });
  assert.equal(resolved.personas.has("team-reader"), false);
  assert.equal(resolved.personas.has("oracle"), true, "malformed metadata never masks an unrelated persona");
  assert.ok(resolved.errors.some(e => e.path.endsWith("custom-reader.md") && /runtime/.test(e.reason)));
});

for (const projectFile of ["custom-reader.md", "replacement-reader.md"]) test(`H2 source identity: valid project ${projectFile} keeps differing declared name selectable`, async t => {
  const child = fakeChild(t); const opts = options(); const queue = new SpawnQueue(opts.registry, 1);
  t.after(() => { child.proc.emit("close", 1); for (const r of opts.registry.list()) clearTimeout(r.timeoutTimer); });
  mkdirSync(userPersonasDir(), { recursive: true }); mkdirSync(projectPersonasDir(opts.cwd), { recursive: true });
  const userPath = join(userPersonasDir(), "custom-reader.md");
  writeFileSync(userPath, "---\nname: team-reader\ndescription: valid user\nruntime: subprocess\n---\nUser reader.");
  t.after(() => rmSync(userPath));
  writeFileSync(join(projectPersonasDir(opts.cwd), "custom-reader.md"), "---\nname: oracle\ndescription: invalid project\nruntime: rpc\n---\nInvalid.");
  writeFileSync(join(projectPersonasDir(opts.cwd), projectFile), "---\nname: team-reader\ndescription: valid project\nruntime: subprocess\n---\nValidated project reader.");
  const registered = tools(opts.cwd, herdr, queue, opts.registry);
  await registered.get("ensemble_spawn").execute("valid-custom", { persona: "team-reader", task: "probe", foreground: false });
  assert.equal(child.launches(), 1); assert.equal(opts.registry.list()[0]!.runtime, "subprocess");
  assert.match(opts.registry.list()[0]!.systemPrompt!, /Validated project reader/);
  const resolved = await resolvePersonas({ cwd: opts.cwd });
  assert.equal(resolved.personas.get("team-reader")?.sourcePath, join(projectPersonasDir(opts.cwd), projectFile));
  assert.equal(resolved.personas.has("oracle"), true);
});
