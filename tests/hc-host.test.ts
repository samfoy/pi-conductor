import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HcHost, hcIdentity, hcTab, HC_UNSET_HERDR_ENV } from "../src/hc/host.ts";
import { hcRunArgs, type HcCli } from "../src/hc/cli.ts";
import { tuiIdentity, type ChildEvidence, type LaunchFence, type TerminalHost } from "../src/herdr/host.ts";
import { provePaneOurs, sameHerdrBinding, terminalRef, type HcBinding, type HerdrBinding, type TuiBinding } from "../src/herdr/identity.ts";
import { fakeHc } from "./helpers/fake-hc.ts";

const coreId = "fakecore0000000000000000000000000";
const node = "/opt/node/bin/node", entry = "/opt/pi/dist/cli.js";
const fence: LaunchFence = { check() {}, current: () => undefined, backoff: async () => {} };
const invocation = { runId: "oracle-hc", launchNonce: "nonce-1", sessionId: "session-1", sessionFile: "/runs/oracle-hc/session/nonce-1.jsonl" };
const binding = (over: Partial<HcBinding> = {}): HcBinding => ({ ...invocation, host: "hc", socketPath: "/run/hc.sock", coreId, address: "t7",
  parentAddress: "t1", space: "sp-lead", tab: hcTab("oracle-hc"), createdTab: true, agentName: "oracle-hc-abcdef12", childPid: 4242, childStartTime: 77, ...over });
const tui = (over: Partial<TuiBinding> = {}): TuiBinding => ({ ...invocation, socketPath: "/run/herdr.sock", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2",
  terminalId: "term_2", createdTab: true, agentName: "oracle-hc-abcdef12", childPid: 4242, childStartTime: 77, ...over });
const hello = (over: Record<string, unknown> = {}) => ({ v: 1, bridgeProtocol: 1, ...invocation, pid: 4242, pidStartTime: 77, paneId: "t7", terminalId: "t7",
  piVersion: "0.87.1", conductorVersion: "test", at: 0, ...over });
const observed = (over: Record<string, unknown> = {}) => ({ address: "t7", name: "oracle-hc-abcdef12", pid: 4242, parent: "t1", state: "live",
  labels: { "conductor.run": "oracle-hc", "conductor.nonce": "nonce-1", "herdr.tab": hcTab("oracle-hc") }, ...over });
const evidence = (over: Partial<ChildEvidence> = {}): ChildEvidence => ({ binding: binding(), current: binding(), socketPath: "/run/hc.sock",
  observation: observed(), hello: hello(), platform: "linux", bridgeProtocol: 1, process: { pid: 4242, state: "alive", startTime: 77 }, ...over });
const identity = hcIdentity(coreId);

test("hc tab is tb plus the first 32 hex of sha256(run id)", () => {
  assert.match(hcTab("oracle-hc"), /^tb[0-9a-f]{32}$/);
  assert.notEqual(hcTab("oracle-hc"), hcTab("oracle-hd"));
  assert.equal(hcTab("r1"), `tb${createHash("sha256").update("r1").digest("hex").slice(0, 32)}`);
});

test("hc proof: the exact live terminal of this invocation is the proven child", () => {
  assert.deepEqual(identity.proveChild(evidence()), { ok: true, pid: 4242 });
});

const refusals: [string, Partial<ChildEvidence>][] = [
  ["label run mismatch", { observation: observed({ labels: { "conductor.run": "someone-else", "conductor.nonce": "nonce-1" } }) }],
  ["label nonce mismatch", { observation: observed({ labels: { "conductor.run": "oracle-hc", "conductor.nonce": "nonce-0" } }) }],
  ["labels missing", { observation: observed({ labels: {} }) }],
  ["name mismatch", { observation: observed({ name: "oracle-hc-00000000" }) }],
  ["address mismatch", { observation: observed({ address: "t8" }) }],
  ["reused name on another terminal", { observation: observed({ address: "t9", pid: 5151 }) }],
  ["binding address unknown", { binding: binding({ address: undefined }), current: binding({ address: undefined }) }],
  ["hello names another terminal", { hello: hello({ paneId: "t8" }) }],
  ["observed pid mismatch", { observation: observed({ pid: 5151 }) }],
  ["observed pid missing", { observation: observed({ pid: null }) }],
  ["hello pid differs from the recorded child", { hello: hello({ pid: 5151 }), process: { pid: 5151, state: "alive", startTime: 77 } }],
  ["probed pid mismatch", { process: { pid: 5151, state: "alive", startTime: 77 } }],
  ["other core", { binding: binding({ coreId: "othercore" }), current: binding({ coreId: "othercore" }) }],
  ["other socket", { socketPath: "/run/other.sock" }],
  ["invocation replaced", { current: binding({ launchNonce: "nonce-2" }) }],
  ["hello for another invocation", { hello: hello({ launchNonce: "nonce-2" }) }],
  ["malformed hello", { hello: hello({ v: 2 }) }],
  ["bridge protocol mismatch", { hello: hello({ bridgeProtocol: 2 }) }],
  ["finished terminal while its pid is alive", { observation: observed({ state: "finished" }) }],
  ["start time mismatch", { process: { pid: 4242, state: "alive", startTime: 78 } }],
  ["missing linux start identity", { hello: hello({ pidStartTime: undefined }), binding: binding({ childStartTime: undefined }), current: binding({ childStartTime: undefined }) }],
  ["liveness unknown", { process: { pid: 4242, state: "unknown" } }],
  ["a herdr TUI binding", { binding: tui(), current: tui(), socketPath: "/run/herdr.sock" }],
  ["missing observation", { observation: undefined }],
];
for (const [name, over] of refusals) test(`hc proof refuses: ${name}`, () => {
  const result = identity.proveChild(evidence(over));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.state, "unknown", JSON.stringify(result));
});

test("hc proof: a proven terminal whose child is gone proves exit, finished or not", () => {
  for (const state of ["live", "finished"]) {
    const result = identity.proveChild(evidence({ observation: observed({ state }), process: { pid: 4242, state: "gone" } }));
    assert.deepEqual(result, { ok: false, state: "gone", reason: "child absent" });
  }
  const foreign = identity.proveChild(evidence({ observation: observed({ labels: {} }), process: { pid: 4242, state: "gone" } }));
  assert.equal(!foreign.ok && foreign.state, "unknown", "a gone pid never proves exit through a foreign terminal");
});

test("hc recorded observation proves a gone child without a server, and the TUI identity refuses hc bindings", () => {
  const recorded = identity.recorded(binding());
  assert.deepEqual(identity.proveChild(evidence({ observation: recorded, process: { pid: 4242, state: "gone" } })), { ok: false, state: "gone", reason: "child absent" });
  assert.deepEqual(identity.proveChild(evidence({ observation: recorded })), { ok: true, pid: 4242 });
  const viaTui = tuiIdentity.proveChild(evidence({ observation: tuiIdentity.recorded(binding()) }));
  assert.equal(!viaTui.ok && viaTui.state, "unknown");
  const pane = { pane_id: "w1:p2", terminal_id: "term_2", workspace_id: "w1", tab_id: "w1:t1" };
  const hcAsPane = { ...binding(), paneId: "w1:p2", terminalId: "term_2", workspaceId: "w1", tabId: "w1:t1" };
  assert.equal(provePaneOurs({ binding: hcAsPane, current: hcAsPane, socketPath: "/run/hc.sock", pane, requireNoAgent: false }).ok, false);
  assert.equal(provePaneOurs({ binding: tui(), current: tui(), socketPath: "/run/herdr.sock", pane, requireNoAgent: false }).ok, true);
});

test("hc hello fills only a missing address; TUI hellos fill nothing", () => {
  assert.deepEqual(identity.helloFields(binding({ address: undefined }), hello()), { address: "t7" });
  assert.deepEqual(identity.helloFields(binding(), hello({ paneId: "t8" })), {});
  assert.deepEqual(identity.helloFields(binding({ address: undefined }), hello({ paneId: "../t7" })), {});
  assert.deepEqual(tuiIdentity.helloFields(tui(), hello()), {});
});

test("sameHerdrBinding compares each host's own fields and never matches across hosts", () => {
  assert.equal(sameHerdrBinding(binding(), binding()), true);
  for (const key of ["address", "coreId", "tab", "space", "parentAddress", "agentName", "childPid", "socketPath", "launchNonce"] as const) {
    assert.equal(sameHerdrBinding(binding(), binding({ [key]: key === "childPid" ? 1 : "changed" })), false, key);
  }
  assert.equal(sameHerdrBinding(tui(), tui()), true);
  assert.equal(sameHerdrBinding(tui(), tui({ paneId: "w1:p3" })), false);
  assert.equal(sameHerdrBinding(binding() as HerdrBinding, tui()), false);
  assert.equal(sameHerdrBinding(tui(), { ...tui(), host: "hc" } as unknown as HerdrBinding), false);
});

test("terminalRef names a pane for TUI bindings and a terminal for hc bindings", () => {
  assert.deepEqual(terminalRef(tui()), ["pane", "w1:p2"]);
  assert.deepEqual(terminalRef(binding()), ["terminal", "t7"]);
  assert.deepEqual(terminalRef(binding({ address: undefined })), ["terminal", "unknown"]);
  assert.deepEqual(terminalRef(undefined), ["pane", "unknown"]);
});

async function hostFixture(lead: { space?: string } = { space: "sp-lead" }, extra: Record<string, unknown> = {}) {
  const f = await fakeHc({ pids: { lead: 1111, "parent-run-0000aaaa": 2222, "oracle-hc-abcdef12": 4242 } });
  const leadTerminal = await f.cli.run({ name: "lead", cwd: "/tmp", labels: lead.space ? { "herdr.space": lead.space } : {}, argv: ["pi"] });
  f.patch(extra);
  const host = new HcHost({ cli: f.cli, coreId, lead: { address: leadTerminal.address, ...lead }, piCommand: [node, entry] });
  const before = f.calls().length;
  const place = async (env: Record<string, string> = {}) => ({ ...await host.placeRun({ cwd: "/tmp", invocation, env }) as HcBinding, agentName: launch.alias });
  return { ...f, host, place, lead: leadTerminal.address, newCalls: () => f.calls().slice(before) };
}

test("HcHost refuses an unusable configuration before any hc call", async () => {
  const f = await fakeHc();
  const ok = { cli: f.cli, coreId, lead: { address: "t1" }, piCommand: [node, entry] as const };
  for (const bad of [{ coreId: "" }, { lead: { address: "a b" } }, { piCommand: ["node", entry] as const }, { piCommand: [node, "relative.js"] as const },
    { piCommand: ["/opt/x=y/node", entry] as const }, { lead: { address: "t1", space: "" } }]) {
    assert.throws(() => new HcHost({ ...ok, ...bad }), /configuration/, JSON.stringify(bad));
  }
  assert.equal(f.calls().length, 0);
});

test("placeRun puts a run in its own tab of the lead's space, under the lead terminal, without an hc call", async () => {
  const h = await hostFixture();
  const placed = await h.host.placeRun({ cwd: "/tmp", invocation, env: {} });
  assert.deepEqual(placed, { ...invocation, host: "hc", socketPath: h.socketPath, coreId, parentAddress: h.lead, space: "sp-lead", tab: hcTab("oracle-hc"), createdTab: true });
  assert.deepEqual(h.newCalls(), []);
  const bare = await hostFixture({});
  assert.equal("space" in await bare.host.placeRun({ cwd: "/tmp", invocation, env: {} }), false);
});

async function parentFixture(extra: Record<string, unknown> = {}) {
  const h = await hostFixture({ space: "sp-lead" }, extra);
  const parentRun = await h.cli.run({ name: "parent-run-0000aaaa", cwd: "/tmp", parent: h.lead, labels: { "conductor.run": "parent-run", "conductor.nonce": "parent-nonce", "herdr.tab": "tb-parent", "herdr.space": "sp-lead" }, argv: ["pi"] });
  const parent: HcBinding = { runId: "parent-run", launchNonce: "parent-nonce", sessionId: "ps", sessionFile: "/runs/parent-run/session/p.jsonl", host: "hc", socketPath: h.socketPath,
    coreId, address: parentRun.address, parentAddress: h.lead, space: "sp-lead", tab: "tb-parent", createdTab: true, agentName: "parent-run-0000aaaa", childPid: 2222 };
  const before = h.calls().length;
  const leaf = (over: Record<string, unknown> = {}) => h.host.placeLeaf({ parentId: "parent-run", parentRuntime: "herdr", parent, current: () => true, cwd: "/tmp",
    invocation, env: {}, known: [], ...over }, fence);
  return { ...h, parent, leaf, leafCalls: () => h.calls().slice(before) };
}

test("placeLeaf puts a leaf in its proven delegator's tab, under the delegator's terminal", async () => {
  const p = await parentFixture();
  const placed = await p.leaf();
  assert.deepEqual(placed, { binding: { ...invocation, host: "hc", socketPath: p.socketPath, coreId, parentAddress: p.parent.address, space: "sp-lead", tab: "tb-parent", createdTab: false } });
  assert.deepEqual(p.leafCalls().map(c => c.args), [["get", p.parent.address!, "--json"]]);
});

test("placeLeaf gives the leaf its own tab whenever the delegator's terminal is not proven", async () => {
  const p = await parentFixture();
  const cases: [string, Record<string, unknown>, (() => void)?][] = [
    ["subprocess parent", { parentRuntime: "subprocess", parent: undefined }],
    ["TUI parent", { parent: tui() }],
    ["parent on another socket", { parent: { ...p.parent, socketPath: "/run/other.sock" } }],
    ["parent on another core", { parent: { ...p.parent, coreId: "othercore" } }],
    ["parent address unknown", { parent: { ...p.parent, address: undefined } }],
    ["parent pid differs", { parent: { ...p.parent, childPid: 9999 } }],
    ["parent nonce differs", { parent: { ...p.parent, launchNonce: "older" } }],
    ["parent name differs", { parent: { ...p.parent, agentName: "parent-run-1111bbbb" } }],
    ["parent fenced", { current: () => false }],
  ];
  for (const [name, over] of cases) {
    const placed = await p.leaf(over);
    assert.ok("warning" in placed && /own tab/.test(placed.warning), `${name}: ${JSON.stringify(placed)}`);
  }
  p.patch({ report: { [p.parent.address!]: { labels: { "conductor.run": "parent-run", "conductor.nonce": "foreign" } } } });
  assert.ok("warning" in await p.leaf(), "foreign labels");
  p.patch({ report: { [p.parent.address!]: { state: "finished" } } });
  assert.ok("warning" in await p.leaf(), "finished parent");
  p.patch({ report: {}, getFault: "not_found" });
  assert.ok("warning" in await p.leaf(), "parent terminal unobservable");
});

const launch = { alias: "oracle-hc-abcdef12", args: ["--session", "/runs/oracle-hc/session/nonce-1.jsonl", "--conductor-launch", "nonce-1"], cwd: "/tmp",
  env: { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUN_ID: "oracle-hc", AWS_PROFILE: "inference only" } };

test("start runs exactly one terminal: env drops herdr TUI routing, then node and the pi entry, named, labelled and parented", async () => {
  const h = await hostFixture();
  const placed = await h.place(launch.env);
  const started = await h.host.start(placed, launch, { timeoutMs: 5000 }, fence);
  assert.deepEqual(HC_UNSET_HERDR_ENV, ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION", "HERDR_BIN_PATH"]);
  const argv = ["env", "-u", "HERDR_ENV", "-u", "HERDR_SOCKET_PATH", "-u", "HERDR_PANE_ID", "-u", "HERDR_TAB_ID", "-u", "HERDR_WORKSPACE_ID", "-u", "HERDR_SESSION", "-u", "HERDR_BIN_PATH",
    "CONDUCTOR_SUBAGENT=1", "CONDUCTOR_RUN_ID=oracle-hc", "AWS_PROFILE=inference only", node, entry, ...launch.args];
  const runs = h.newCalls().filter(c => c.args[0] === "run");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, hcRunArgs({ name: launch.alias, cwd: "/tmp", parent: h.lead,
    labels: { "conductor.run": "oracle-hc", "conductor.nonce": "nonce-1", "herdr.tab": hcTab("oracle-hc"), "herdr.space": "sp-lead" }, argv }));
  assert.ok(!runs[0].args.some(a => a.startsWith("HC_")), "the core sets HC_* itself");
  const address = placed.address!;
  assert.match(address, /^t\d+$/);
  assert.deepEqual(h.newCalls().map(c => c.args[0]), ["run", "get"]);
  assert.equal(h.newCalls()[1].args[1], address, "the start observation reads the core address, never the name");
  assert.deepEqual(identity.proveChild({ binding: { ...placed, childPid: 4242, childStartTime: 77 }, current: placed, socketPath: h.socketPath, observation: started, platform: "linux", bridgeProtocol: 1,
    hello: hello({ paneId: address }), process: { pid: 4242, state: "gone" } }), { ok: false, state: "gone", reason: "child absent" }, "the start observation can prove a fast exit");
  const t = h.terminals()[address];
  assert.equal(t.die_with_parent, false); assert.equal(t.notify, false); assert.equal(t.parent, h.lead);
});

test("start without a space label leaves herdr.space out", async () => {
  const h = await hostFixture({});
  const placed = await h.place();
  await h.host.start(placed, { ...launch, env: {} }, { timeoutMs: 5000 }, fence);
  const run = h.newCalls().find(c => c.args[0] === "run")!;
  assert.deepEqual(run.args.filter((a, i) => run.args[i - 1] === "--label"), ["conductor.run=oracle-hc", "conductor.nonce=nonce-1", `herdr.tab=${hcTab("oracle-hc")}`]);
});

for (const runFault of ["timeout", "timeout-after-start", "name_taken", "spawn_failed"]) test(`start never retries an unconfirmed outcome: ${runFault}`, async () => {
  const h = await hostFixture({ space: "sp-lead" }, { runFault });
  const placed = await h.place();
  await assert.rejects(h.host.start(placed, launch, { timeoutMs: 1500 }, fence), /start outcome unconfirmed; no blind retry/);
  assert.equal(h.newCalls().filter(c => c.args[0] === "run").length, 1);
  assert.equal(placed.address, undefined, "an unconfirmed start records no address");
});

test("start refuses a run result naming another terminal, and a fence that trips after the run", async () => {
  const h = await hostFixture();
  for (const result of [{ name: "someone-else", parent: h.lead, state: "live" }, { name: launch.alias, parent: "t99", state: "live" }, { name: launch.alias, parent: h.lead, state: "finished" }]) {
    const cli: HcCli = { ...h.cli, run: async () => ({ address: "t9", ...result } as Awaited<ReturnType<HcCli["run"]>>) };
    const host = new HcHost({ cli, coreId, lead: { address: h.lead }, piCommand: [node, entry] });
    const placed = { ...await host.placeRun({ cwd: "/tmp", invocation, env: {} }) as HcBinding, agentName: launch.alias };
    await assert.rejects(host.start(placed, launch, { timeoutMs: 5000 }, fence), /different terminal/, JSON.stringify(result));
    assert.equal(placed.address, undefined);
  }
  let checks = 0;
  const tripping: LaunchFence = { ...fence, check() { if (++checks === 1) throw new Error("herdr: launch cancelled"); } };
  const placed = await h.place();
  await assert.rejects(h.host.start(placed, launch, { timeoutMs: 5000 }, tripping), /launch cancelled/);
  assert.equal(h.newCalls().filter(c => c.args[0] === "run").length, 1);
});

test("start refuses a launch alias that is not the binding's agent name, before any hc call", async () => {
  const h = await hostFixture();
  const placed = await h.place();
  await assert.rejects(h.host.start({ ...placed, agentName: "oracle-hc-00000000" }, launch, { timeoutMs: 5000 }, fence), /agent name/);
  await assert.rejects(h.host.start(placed, { ...launch, env: { HC_TERMINAL_ID: "t1" } }, { timeoutMs: 5000 }, fence), /invalid terminal environment/);
  await assert.rejects(h.host.start(placed, { ...launch, env: { "BAD-NAME": "x" } }, { timeoutMs: 5000 }, fence), /invalid terminal environment/);
  assert.deepEqual(h.newCalls(), []);
});

test("a start whose observation read fails still records the address and returns the run result", async () => {
  const h = await hostFixture();
  const placed = await h.place();
  h.patch({ getFault: "not_found" });
  const started = await h.host.start(placed, launch, { timeoutMs: 5000 }, fence) as { address: string; pid: null; labels: Record<string, string> };
  assert.equal(started.address, placed.address);
  assert.equal(started.pid, null);
  assert.equal(started.labels["conductor.nonce"], "nonce-1");
});

test("an hc host refuses TUI bindings, and observe/readScreen use only the core address", async () => {
  const h = await hostFixture();
  await assert.rejects(h.host.start(tui(), launch, { timeoutMs: 5000 }, fence), /not a Herdr 2 binding/);
  await assert.rejects(h.host.observe(tui()), /not a Herdr 2 binding/);
  await assert.rejects(h.host.observe(binding({ address: undefined, socketPath: h.socketPath })), /address unknown/);
  assert.equal((await h.host.release(tui(), () => tui())).ok, false);
  assert.equal(await (h.host as TerminalHost).reuse(binding(), invocation), undefined);
  const placed = await h.place();
  await h.host.start(placed, launch, { timeoutMs: 5000 }, fence);
  h.patch({ screens: { [placed.address!]: "screen line\n" } });
  assert.equal(await h.host.readScreen(placed, 40), "screen line\n");
  const observedNow = await h.host.observe(placed) as { address: string };
  assert.equal(observedNow.address, placed.address);
  assert.deepEqual(h.newCalls().slice(-2).map(c => c.args), [["read", placed.address, "--lines", "40"], ["get", placed.address, "--json"]]);
  assert.ok(!h.calls().some(c => c.args[0] === "kill"), "an hc host never kills through hc");
});

async function releaseFixture() {
  const h = await hostFixture();
  const placed = await h.place();
  await h.host.start(placed, launch, { timeoutMs: 5000 }, fence);
  const current = () => placed;
  return { ...h, placed, current };
}

test("release removes only its own finished terminal by address", async () => {
  const r = await releaseFixture();
  assert.deepEqual(await r.host.release(r.placed, r.current), { ok: false, state: "unknown", reason: "terminal still live" });
  assert.ok(!r.calls().some(c => c.args[0] === "rm"), "a live terminal is never removed");
  await r.cli.get(r.placed.address!);
  r.patch({ terminals: { ...r.terminals(), [r.placed.address!]: { ...r.terminals()[r.placed.address!], state: "finished" } } });
  const successor = await r.cli.run({ name: launch.alias, cwd: "/tmp", labels: { "conductor.run": "intruder" }, argv: ["pi"] });
  assert.deepEqual(await r.host.release(r.placed, r.current), { ok: true });
  assert.deepEqual(r.calls().filter(c => c.args[0] === "rm").map(c => c.args), [["rm", r.placed.address, "--json"]]);
  assert.equal(r.terminals()[r.placed.address!], undefined);
  assert.equal(r.terminals()[successor.address].state, "live", "a later terminal reusing the name is untouched");
});

test("release refuses a foreign, replaced or unaddressed terminal", async () => {
  const r = await releaseFixture();
  r.patch({ terminals: { ...r.terminals(), [r.placed.address!]: { ...r.terminals()[r.placed.address!], state: "finished" } } });
  r.patch({ report: { [r.placed.address!]: { labels: { "conductor.run": "oracle-hc", "conductor.nonce": "nonce-0" } } } });
  assert.equal((await r.host.release(r.placed, r.current)).ok, false, "foreign labels");
  r.patch({ report: { [r.placed.address!]: { name: "someone-else" } } });
  assert.equal((await r.host.release(r.placed, r.current)).ok, false, "foreign name");
  r.patch({ report: {} });
  assert.equal((await r.host.release(r.placed, () => undefined)).ok, false, "invocation replaced");
  assert.equal((await r.host.release({ ...r.placed, launchNonce: "nonce-2" }, r.current)).ok, false, "stale binding");
  assert.equal((await r.host.release({ ...r.placed, address: undefined }, r.current)).ok, false, "no address");
  r.patch({ getFault: "timeout" });
  assert.equal((await r.host.release(r.placed, r.current, { timeoutMs: 1000 })).ok, false, "observation unavailable");
  assert.ok(!r.calls().some(c => c.args[0] === "rm"));
});
