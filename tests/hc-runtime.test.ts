import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { fakeHc, fakeHcBin } from "./helpers/fake-hc.ts";
import { coreId, launchFixture } from "./helpers/hc-launch.ts";
import { cachedHcContext, hcContextStatus, resolveHcContext } from "../src/hc/context.ts";
import { recoveryRuntimes, runtimeFor, type HerdrTransport, type RunSink } from "../src/runtime.ts";
import { herdrChildAbsent, releaseRecordedPane } from "../src/herdr/runtime.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { executeReclaim } from "../src/gc/executor.ts";
import { buildDoctorReport } from "../src/doctor.ts";
import { registerTools } from "../src/tools.ts";
import { herdrLeadEnv } from "../src/supervision/presence.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DEFAULT_CONFIG, SUPERVISION_TOOL_NAMES, emptyUsage, toRunRecord, type Run } from "../src/types.ts";
import type { HcBinding, TuiBinding } from "../src/herdr/identity.ts";

sandboxPi();
const node = "/opt/node/bin/node", entry = "/opt/pi/dist/cli.js";
const sink: RunSink = { line() {}, close() {}, error() {}, initialDeliveryFailed() {} };
const hcEnv = (f: { socketPath: string; statePath: string }, address: string) =>
  ({ HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: f.socketPath, CONDUCTOR_HC_BIN: fakeHcBin, FAKE_HC_STATE: f.statePath, PATH: process.env.PATH });
function freshRun(id: string): Run {
  const root = tmpDir("hc-runtime-"), dir = join(root, id); mkdirSync(dir);
  return { id, runtime: "herdr", persona: "oracle", task: "t", status: "running", mode: "background", cwd: root, startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
}
const launchFresh = (run: Run, env: Record<string, string | undefined>) =>
  runtimeFor(run, env).launch(run, [], run.cwd, sink, "task", { kind: "fresh", sessionDir: join(run.cwd, run.id, "session"), systemPrompt: "probe" }) as HerdrTransport;

test("hc context: the core id, the lead and its herdr.space label resolve once per socket and terminal", async () => {
  const f = await fakeHc({ coreId: "corectx0000000000000000000000000" });
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp1" }, argv: ["pi"] });
  const bare = await f.cli.run({ name: "bare", cwd: "/tmp", labels: {}, argv: ["pi"] });
  const env = hcEnv(f, lead.address);
  const context = await resolveHcContext(env, [node, entry]);
  assert.deepEqual(context, { socketPath: f.socketPath, coreId: "corectx0000000000000000000000000", lead: { address: lead.address, space: "sp1" }, piCommand: [node, entry] });
  const calls = f.calls().length;
  assert.equal(await resolveHcContext(env, [node, entry]), context, "cached");
  assert.equal(f.calls().length, calls, "no second hc call");
  assert.deepEqual(hcContextStatus(env), { context });
  assert.deepEqual((await resolveHcContext(hcEnv(f, bare.address), [node, entry])).lead, { address: bare.address }, "a lead without herdr.space has no space");
  assert.deepEqual(f.calls().slice(calls).map(c => c.args), [["server", "status", "--json"], ["get", bare.address, "--json"]]);
});

test("hc context failures are named, and an hc launch is refused with the reason until a later spawn resolves it lazily", async () => {
  const f = await fakeHc();
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: {}, argv: ["pi"] });
  const env = hcEnv(f, lead.address);
  f.patch({ fault: "envelope", envelope: { error: { kind: "unavailable", message: "core down", hint: "start it" } }, exit: 5 });
  const refused = launchFresh(freshRun("oracle-unresolved"), env);
  await assert.rejects(refused.ready, /hc launch refused: herdr-core id unresolved \(unavailable\)/);
  assert.deepEqual(hcContextStatus(env), { reason: "herdr: herdr-core id unresolved (unavailable)" });
  assert.equal(cachedHcContext(env), undefined);
  f.patch({ fault: undefined, terminals: { ...f.terminals(), [lead.address]: { ...f.terminals()[lead.address]!, state: "finished" } } });
  await assert.rejects(launchFresh(freshRun("oracle-dead-lead"), env).ready, new RegExp(`hc launch refused: lead terminal ${lead.address} is not live`));
  f.patch({ terminals: { ...f.terminals(), [lead.address]: { ...f.terminals()[lead.address]!, state: "live" } } });
  await assert.rejects(launchFresh(freshRun("oracle-lazy"), env).ready, /the host Pi entry is not Pi's declared bin, and hc never runs a bare pi/,
    "resolved lazily; this test process is not a declared pi bin, so the launch is still refused by name");
  assert.equal(cachedHcContext(env)?.coreId, coreId);
  assert.ok(!f.calls().some(c => c.args[0] === "run" && !c.args.includes("lead")), "no child terminal was ever started");
});

test("a lead whose herdr.space label is unusable refuses hc launches by name instead of throwing at runtime selection", async () => {
  const f = await fakeHc();
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp" }, argv: ["pi"] });
  const env = hcEnv(f, lead.address);
  for (const space of ["two\nlines", "x".repeat(513), ""]) {
    f.patch({ report: { [lead.address]: { labels: { "herdr.space": space } } } });
    await assert.rejects(resolveHcContext(env, [node, entry]), new RegExp(`lead terminal ${lead.address} has a malformed herdr.space label`), JSON.stringify(space));
  }
  const run = freshRun("oracle-bad-space");
  const transport = launchFresh(run, env);
  await assert.rejects(transport.ready, /hc launch refused: lead terminal t1 has a malformed herdr.space label/);
});

test("recovery picks each record's host from its own binding, and an hc record reattaches only through the same socket and core", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const transport = h.launch();
  await transport.ready;
  const b = h.run.herdr as HcBinding;
  const env = hcEnv(h, h.lead);
  const runtimeOf = await recoveryRuntimes(env);
  const record = (herdr: Run["herdr"]): Run => ({ ...h.run, herdr: herdr && { ...herdr }, transport: undefined });
  assert.equal(await runtimeOf(b)!.probeRecord(record(b)), "alive");
  assert.equal(await runtimeOf(b)!.probeRecord(record({ ...b, coreId: "othercore" })), "other-socket");
  assert.equal(await runtimeOf(b)!.probeRecord(record({ ...b, socketPath: "/run/other.sock" })), "other-socket");
  const tui: TuiBinding = { runId: b.runId, launchNonce: b.launchNonce, sessionId: b.sessionId, sessionFile: b.sessionFile, socketPath: "/run/herdr.sock",
    workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "term1", createdTab: true };
  assert.equal(runtimeOf(tui), undefined, "no herdr TUI here: a TUI record has no runtime and stays other-socket");
  const both = await recoveryRuntimes({ ...env, HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "p1" });
  assert.equal(await both(tui)!.probeRecord(record(tui)), "unknown", "a TUI record goes to the TUI host, never the hc one");
  assert.equal(await both(b)!.probeRecord(record(b)), "alive", "and an hc record to the hc host");
  const elsewhere = await recoveryRuntimes({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/run/nothing-listens.sock" });
  assert.equal(elsewhere(b), undefined, "an unresolvable core gives no hc runtime: other-socket");
  await transport.stop();
});

async function finishedRecord(t: test.TestContext) {
  const h = await launchFixture(t);
  const transport = h.launch();
  await transport.ready;
  await transport.stop(); await transport.closed;
  h.run.status = "completed"; h.run.transport = undefined;
  writeFileSync(h.run.recordPath, JSON.stringify(toRunRecord(h.run)));
  return { ...h, b: h.run.herdr as HcBinding, env: hcEnv(h, h.lead) };
}

test("explicit release of a recorded hc run goes through the binding's own host: removed on its core, kept elsewhere", { timeout: 60000 }, async t => {
  const h = await finishedRecord(t);
  assert.equal(herdrChildAbsent(h.run), true);
  assert.equal(herdrChildAbsent({ ...h.run, herdr: { ...h.b, childPid: process.pid } }), false, "a live pid is never absent");
  const other = { ...h.b, coreId: "othercore" };
  assert.equal(await releaseRecordedPane({ ...h.run, herdr: other }, () => other, h.env), false, "another core never removes");
  assert.equal(h.terminals()[h.b.address!]?.state, "finished");
  const { address: _address, ...unaddressed } = h.b;
  assert.equal(await releaseRecordedPane({ ...h.run, herdr: unaddressed }, () => unaddressed, h.env), true, "the address comes from the hello");
  assert.equal(h.terminals()[h.b.address!], undefined);
  assert.deepEqual(h.calls().filter(c => c.args[0] === "rm").map(c => c.args), [["rm", h.b.address, "--json"]]);
});

test("GC on hc records: a finished, proven terminal is removed; a live child keeps everything; another core keeps its terminal", { timeout: 90000 }, async t => {
  const gc = { ...DEFAULT_CONFIG.gc, transcriptSizeCapBytes: 1 };
  const done = await finishedRecord(t);
  const plan = planReclaim(await walkInventory(done.run.cwd, new RunRegistry()), gc, Date.now());
  assert.deepEqual(plan.actions.map(a => a.kind), ["cold-archive"]);
  const result = await executeReclaim(plan.actions, done.run.cwd, new Set(), Date.now(), { env: done.env });
  assert.equal(result.archived.length, 1, JSON.stringify(result.failed));
  assert.equal(done.terminals()[done.b.address!], undefined, "removed");

  const live = await launchFixture(t);
  const transport = live.launch();
  await transport.ready;
  live.run.status = "completed"; writeFileSync(live.run.recordPath, JSON.stringify(toRunRecord({ ...live.run, transport: undefined })));
  const keep = planReclaim(await walkInventory(live.run.cwd, new RunRegistry()), gc, Date.now());
  assert.deepEqual(keep.actions.map(a => [a.kind, "reason" in a ? a.reason : ""]), [["keep", "herdr child live or unknown; evidence preserved"]]);
  await executeReclaim(keep.actions, live.run.cwd, new Set(), Date.now(), { env: hcEnv(live, live.lead) });
  assert.equal(live.terminals()[(live.run.herdr as HcBinding).address!].state, "live");
  assert.ok(!live.calls().some(c => c.args[0] === "rm"));
  await transport.stop();

  const foreign = await finishedRecord(t);
  foreign.run.herdr = { ...foreign.b, coreId: "othercore" };
  writeFileSync(foreign.run.recordPath, JSON.stringify(toRunRecord(foreign.run)));
  foreign.run.worktreePath = join(foreign.run.cwd, "kept"); foreign.run.worktreeBranch = "unmerged";
  mkdirSync(foreign.run.worktreePath); writeFileSync(foreign.run.recordPath, JSON.stringify(toRunRecord(foreign.run)));
  const action = { kind: "delete" as const, id: foreign.run.id, reason: "TTL", bytesReclaimed: 1, losesResume: true, herdr: { ...foreign.run.herdr } };
  const refused = await executeReclaim([action], foreign.run.cwd, new Set(), Date.now(), { env: foreign.env });
  assert.equal(refused.deleted.length, 0);
  assert.match(refused.failed[0]?.error ?? "", /pane release unconfirmed; worktree and ownership evidence preserved/);
  assert.equal(foreign.terminals()[foreign.b.address!]?.state, "finished", "a terminal named under another core is never removed");
});

test("doctor ## Runtime names the host, why, the hc core, lead and space, any conflict, and unprovable hc records", { timeout: 60000 }, async t => {
  const f = await fakeHc({ coreId: "coredoc0000000000000000000000000" });
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp-doc" }, argv: ["pi"] });
  const env = hcEnv(f, lead.address);
  const registry = new RunRegistry(), queue = new SpawnQueue(registry, 1), cwd = tmpDir("hc-doctor-");
  const report = (over: Record<string, string | undefined>, runsRoot = join(cwd, "none")) =>
    buildDoctorReport({ cwd, registry, queue, conductorMode: false, env: over, runsRoot }).then(text => text.slice(text.indexOf("## Runtime"), text.indexOf("## Turn limits")));
  const unresolved = await report(env);
  assert.match(unresolved, /selected: herdr on hc \[auto\]/);
  assert.match(unresolved, /environment: Herdr 2 terminal \(hc\)/);
  assert.match(unresolved, new RegExp(`hc: socket=${f.socketPath} core unresolved \\(not resolved yet\\); hc launches refused until it resolves`));
  assert.ok(!f.calls().some(c => c.args[0] === "server"), "doctor never probes the core");
  await resolveHcContext(env, [node, entry]);
  assert.match(await report(env), new RegExp(`hc: socket=${f.socketPath} core=coredoc0000000000000000000000000 lead=${lead.address} space=sp-doc`));
  const conflict = await report({ ...env, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "p1" });
  assert.match(conflict, /selected: subprocess \[auto\]/);
  assert.match(conflict, /⚠ environment conflict: both Herdr 2 \(HC_TERMINAL_ID, HC_TERMINAL_SOCKET\) and herdr TUI \(HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID\)/);
  assert.match(await report({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "p1" }), /selected: herdr on tui \[auto\][\s\S]*tui: socket=\/run\/herdr.sock pane=p1/);
  assert.match(await report({}), /selected: subprocess \[auto\][\s\S]*environment: no herdr host/);

  const done = await finishedRecord(t);
  await resolveHcContext(done.env, [node, entry]);
  assert.match(await report(done.env, done.run.cwd), /hc records with an unprovable terminal: 0 \(/, "a finished record on this core is provable");
  writeFileSync(done.run.recordPath, JSON.stringify(toRunRecord({ ...done.run, herdr: { ...done.b, coreId: "othercore" } })));
  assert.match(await report(done.env, done.run.cwd), /hc records with an unprovable terminal: 1 \(/, "a terminal on another core is not");
  const live = await launchFixture(t);
  const transport = live.launch();
  await transport.ready;
  const liveEnv = hcEnv(live, live.lead);
  await resolveHcContext(liveEnv, [node, entry]);
  writeFileSync(live.run.recordPath, JSON.stringify(toRunRecord({ ...live.run, transport: undefined })));
  assert.match(await report(liveEnv, live.run.cwd), /hc records with an unprovable terminal: 1 \(/, "nor a live child this session has not attached");
  await transport.stop();
});

test("supervision stays herdr TUI only: an hc lead, even with leaked HERDR_* routing, registers no chief, peer or staff tool", () => {
  const hc = { HC_TERMINAL_ID: "t17", HC_TERMINAL_SOCKET: "/run/user/1000/herdr-core/default.sock" };
  const tui = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "p1" };
  assert.deepEqual([herdrLeadEnv(hc), herdrLeadEnv({ ...hc, ...tui }), herdrLeadEnv(tui)], [false, false, true]);
  for (const [env, expected] of [[hc, []], [{ ...hc, ...tui }, []], [tui, ["chief", "peer", "staff"]]] as const) {
    const names: string[] = [];
    const registry = new RunRegistry();
    registerTools({ registerTool: (tool: { name: string }) => names.push(tool.name), getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [] } as never, {
      getCwd: () => "/tmp", getRegistry: () => registry, getQueue: () => new SpawnQueue(registry, 1), getParentMessages: () => [],
      supervision: { ownTool() {} } as never, chief: {} as never,
    } as never, env);
    assert.deepEqual(names.filter(n => SUPERVISION_TOOL_NAMES.includes(n)).sort(), expected, JSON.stringify(env));
  }
});
