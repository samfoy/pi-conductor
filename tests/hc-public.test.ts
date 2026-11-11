import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { fakeHc, fakeHcBin } from "./helpers/fake-hc.ts";
import { fakeChild, until } from "./helpers/hc-launch.ts";
import { registerTools } from "../src/tools.ts";
import { RunRegistry, runsRoot } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { resolveHcContext } from "../src/hc/context.ts";
import { recoveryRuntimes } from "../src/runtime.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { buildOrphanRun, defaultLivenessProbe, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { readoptHerdrRun } from "../src/run-pipeline.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { executeReclaim } from "../src/gc/executor.ts";
import { DEFAULT_CONFIG, isTerminal, type Run } from "../src/types.ts";
import type { HcBinding } from "../src/herdr/identity.ts";

sandboxPi();

test("hc end to end through the public tools: auto spawn, card, send resume, kill by proven pid, /reload readopt, GC removes the finished terminals", { timeout: 240000 }, async t => {
  const f = await fakeHc({}, { FAKE_CHILD_MODE: "task" });
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp-lead" }, argv: ["pi"] });
  f.patch({ spawn: true });
  const root = tmpDir("hc-public-");
  const env = { ...gitTestEnv(), HC_TERMINAL_ID: lead.address, HC_TERMINAL_SOCKET: f.socketPath, CONDUCTOR_HC_BIN: fakeHcBin, FAKE_HC_STATE: f.statePath, FAKE_CHILD_MODE: "task" };
  await resolveHcContext(env, [process.execPath, fakeChild]);
  t.after(() => {
    for (const terminal of Object.values(f.terminals())) if (terminal.name !== "lead") try { process.kill(terminal.pid, "SIGKILL"); } catch { /* already gone */ }
  });

  let registry = new RunRegistry(), cards: Run[] = [];
  const queue = new SpawnQueue(registry, 4), tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    getCwd: () => root, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [],
    openFocusedOverlay() {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }), pushCompletionNotification(run: Run) { cards.push(run); },
  } as any, env);
  const spawn = async (task: string) => {
    await tools.get("ensemble_spawn").execute(task, { persona: "inspector", task, foreground: false });
    return registry.list().find(r => r.task.includes(task))!;
  };
  const hcCalls = (verb: string) => f.calls().filter(c => c.args[0] === verb).map(c => c.args);
  const cardsFor = (run: Run) => cards.filter(card => card.id === run.id).length;
  const binding = (run: Run) => run.herdr as HcBinding;
  const nonceFile = (run: Run, suffix: string) => join(dirname(run.recordPath), `fake-child-${binding(run).launchNonce}.${suffix}`);
  const finished = (run: Run, n: number) => until(() => cardsFor(run) === n && isTerminal(run.status), `${run.id} card ${n}`, 60000);

  const a = await spawn("A completes");
  assert.equal(a.runtime, "herdr");
  await finished(a, 1);
  assert.equal(a.status, "completed", a.errorMessage);
  const first = binding(a);
  assert.deepEqual([first.host, first.parentAddress, first.space, first.coreId], ["hc", lead.address, "sp-lead", "fakecore0000000000000000000000000"]);
  const firstTerminal = f.terminals()[first.address!];
  assert.equal(firstTerminal.parent, lead.address);
  assert.equal(firstTerminal.labels["herdr.space"], "sp-lead");
  assert.equal(firstTerminal.argv[firstTerminal.argv.indexOf(fakeChild) - 1], process.execPath, "node plus the proven pi entry, never a bare pi");
  assert.match(readFileSync(a.finalPath, "utf8"), /Final verified hc evidence/);

  const runsBefore = hcCalls("run").length;
  await tools.get("ensemble_send").execute("send-a", { agent_id: a.id, message: "resume A please", foreground: false });
  await finished(a, 2);
  assert.equal(a.status, "completed", a.errorMessage);
  const second = binding(a);
  assert.notEqual(second.address, first.address, "a resume gets a fresh terminal");
  assert.equal(f.terminals()[first.address!], undefined, "the previous terminal was removed");
  const order = f.calls().map(c => c.args).filter(args => args[0] === "rm" || args[0] === "run");
  assert.ok(order.findIndex(args => args[0] === "rm" && args[1] === first.address) < order.findIndex((args, i) => args[0] === "run" && order.slice(0, i).filter(x => x[0] === "run").length === runsBefore),
    "removed before the resumed launch's hc run");

  const b = await spawn("B HOLD then kill");
  await until(() => b.transport?.kind === "herdr" && !!b.transport.observable, "B attached and ready");
  const helloB = JSON.parse(readFileSync(join(dirname(b.recordPath), "launch", `${binding(b).launchNonce}.json`), "utf8"));
  await tools.get("ensemble_kill").execute("kill-b", { agent_id: b.id });
  await until(() => existsSync(nonceFile(b, "sigterm")), "B received SIGTERM");
  assert.equal(readFileSync(nonceFile(b, "sigterm"), "utf8"), String(helloB.pid), "the signal reached the proven hello pid");
  assert.equal(f.terminals()[binding(b).address!].pid, helloB.pid);
  assert.deepEqual(hcCalls("kill"), [], "conductor never kills through hc");
  await until(() => isTerminal(b.status), "B terminal");
  assert.equal(b.status, "killed");

  const c = await spawn("C HOLD across reload");
  await until(() => c.transport?.kind === "herdr" && !!c.transport.observable, "C attached and ready");
  await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer() {} });
  assert.equal(f.terminals()[binding(c).address!].state, "live", "reload never stops the child");

  registry = new RunRegistry();
  const runtimeOf = await recoveryRuntimes(env);
  const reconciled = await reconcileOrphansAtStartup({
    runsRoot: runsRoot(), registry, isAlive: defaultLivenessProbe, now: Date.now(),
    herdrProbe: record => runtimeOf(record.herdr)?.probeRecord(buildOrphanRun(record, record.status)) ?? Promise.resolve("other-socket"),
    attachHerdr: record => { readoptHerdrRun(record, { registry, runtime: runtimeOf(record.herdr)!, onComplete: run => cards.push(run) }); },
  });
  assert.deepEqual(registry.list().map(r => r.id), [c.id], JSON.stringify(reconciled));
  const readopted = registry.get(c.id)!;
  await until(() => readopted.transport?.kind === "herdr" && !!readopted.transport.observable, "C readopted");
  writeFileSync(nonceFile(readopted, "finish"), "go");
  await finished(readopted, 1);
  assert.equal(readopted.status, "completed", readopted.errorMessage);
  assert.equal(hcCalls("run").filter(args => args.includes(binding(readopted).agentName!)).length, 1, "readopt never relaunches");

  const live = Object.values(f.terminals()).filter(t => t.name !== "lead");
  assert.deepEqual(live.map(t => t.address).sort(), [second.address, binding(b).address, binding(readopted).address].sort());
  const inventory = await walkInventory(runsRoot(), registry);
  const plan = planReclaim(inventory, { ...DEFAULT_CONFIG.gc, transcriptSizeCapBytes: 1 }, Date.now());
  assert.deepEqual(plan.actions.filter(x => x.kind === "cold-archive").map(x => x.id).sort(), [a.id, b.id, c.id].sort(), JSON.stringify(plan.actions));
  const result = await executeReclaim(plan.actions, runsRoot(), new Set(), Date.now(), { currentRun: id => registry.get(id), env });
  assert.equal(result.archived.length, 3, JSON.stringify(result.failed));
  assert.deepEqual(Object.values(f.terminals()).map(t => t.name), ["lead"], "GC removed every finished terminal and nothing else");
  assert.deepEqual(hcCalls("rm").map(args => args[1]).sort(), [first.address, second.address, binding(b).address, binding(readopted).address].sort());
});
