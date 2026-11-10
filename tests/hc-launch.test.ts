import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { fakeHc } from "./helpers/fake-hc.ts";
import { HcHost, hcTab } from "../src/hc/host.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import type { HerdrTransport, RunSink } from "../src/runtime.ts";
import type { HcBinding } from "../src/herdr/identity.ts";

sandboxPi();
const fakeChild = fileURLToPath(new URL("./fixtures/fake-hc-child.mjs", import.meta.url));
const coreId = "fakecore0000000000000000000000000";
const leaked = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/leaked-herdr.sock", HERDR_PANE_ID: "leaked-pane", HERDR_TAB_ID: "leaked-tab", HERDR_WORKSPACE_ID: "leaked-ws" };
type Probe = (pid: number) => { pid: number; state: "alive" | "gone" | "unknown"; startTime?: number };
const realProbe: Probe = pid => {
  try { process.kill(pid, 0); return { pid, state: "alive", startTime: readProcessStartTime(pid) }; }
  catch (e) { return { pid, state: (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" }; }
};

async function launchFixture(t: TestContext, mode = "hold", probe: (h: { transport: () => HerdrTransport | undefined }) => Probe = () => realProbe) {
  const f = await fakeHc({}, { FAKE_CHILD_MODE: mode });
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp-lead" }, argv: ["pi"] });
  f.patch({ spawn: true, coreEnv: leaked });
  const root = tmpDir("hc-launch-"), dir = join(root, "oracle-hc"); mkdirSync(dir);
  const run: Run = { id: "oracle-hc", runtime: "herdr", persona: "oracle", task: "hc task", status: "running", mode: "background", cwd: root,
    startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const host = new HcHost({ cli: f.cli, coreId, lead: { address: lead.address, space: "sp-lead" }, piCommand: [process.execPath, fakeChild] });
  const signals: [number, string][] = [];
  let transport: HerdrTransport | undefined;
  const runtime = new HerdrRuntime({ host, env: { AWS_PROFILE: "inference-only" }, trustArgs: () => [], piVersion: "fake-child", platform: "linux",
    probe: probe({ transport: () => transport }), signal: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); } });
  const sink: RunSink = { line() {}, close() {}, error() {}, initialDeliveryFailed() {} };
  t.after(() => {
    for (const terminal of Object.values(f.terminals())) if (terminal.name !== "lead") try { process.kill(terminal.pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const launch = () => {
    transport = runtime.launch(run, [], root, sink, "hc task", { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "probe" });
    run.transport = transport;
    return transport;
  };
  return { ...f, lead: lead.address, run, dir, signals, launch };
}
const addressed = (h: Awaited<ReturnType<typeof launchFixture>>) =>
  h.calls().filter(c => ["get", "read", "rm"].includes(c.args[0])).every(c => /^t\d+$/.test(c.args[1]));

test("hc launch: a real child becomes ready in its terminal, takes steer and follow-up, stops by its proven pid and is removed by address", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const transport = h.launch();
  const ready = await transport.ready;
  const b = h.run.herdr as HcBinding;
  assert.equal(ready.binding, b);
  assert.equal(b.host, "hc");
  assert.match(b.address!, /^t\d+$/);
  const terminal = h.terminals()[b.address!];
  assert.equal(terminal.name, b.agentName);
  assert.equal(terminal.parent, h.lead);
  assert.equal(terminal.die_with_parent, false);
  assert.equal(terminal.notify, false);
  assert.deepEqual(terminal.labels, { "conductor.run": "oracle-hc", "conductor.nonce": b.launchNonce, "herdr.tab": hcTab("oracle-hc"), "herdr.space": "sp-lead" });
  assert.equal(b.childPid, terminal.pid);
  const persisted = JSON.parse(readFileSync(h.run.recordPath, "utf8")).herdr;
  assert.deepEqual([persisted.host, persisted.address, persisted.childPid, persisted.coreId], ["hc", b.address, terminal.pid, coreId]);
  assert.equal(JSON.parse(readFileSync(join(h.dir, "launch", `${b.launchNonce}.json`), "utf8")).paneId, b.address);
  const seen = JSON.parse(readFileSync(join(h.dir, `fake-child-${b.launchNonce}.json`), "utf8"));
  assert.deepEqual(Object.keys(seen.env).filter(key => key.startsWith("HERDR_")), [], "env -u drops herdr TUI routing leaked by the core");
  assert.deepEqual([seen.env.HC_TERMINAL_ID, seen.env.HC_TERMINAL_SOCKET], [b.address, h.socketPath]);
  assert.deepEqual([seen.env.AWS_PROFILE, seen.env.CONDUCTOR_RUN_ID, seen.env.CONDUCTOR_RUNTIME], ["inference-only", "oracle-hc", "herdr"]);
  assert.equal(seen.argv[seen.argv.indexOf("--conductor-launch") + 1], b.launchNonce);

  transport.observe();
  for (const kind of ["steer", "follow_up"] as const) {
    const delivery = transport.deliver!(kind, `hc ${kind}`);
    assert.equal(delivery.kind, "queued");
    if (delivery.kind === "queued") { const ack = await delivery.ack; assert.equal(ack.delivered, true, JSON.stringify(ack)); }
  }
  const inputs = JSON.parse(readFileSync(join(h.dir, `fake-child-${b.launchNonce}.inputs.json`), "utf8"));
  assert.deepEqual(inputs.map((i: { kind: string }) => i.kind), ["initial", "steer", "follow_up"]);

  await transport.stop();
  await transport.closed;
  assert.deepEqual(h.signals, [[terminal.pid, "SIGTERM"]]);
  assert.equal(await transport.releasePane(), true);
  assert.equal(h.terminals()[b.address!], undefined);
  assert.deepEqual(h.calls().filter(c => c.args[0] === "rm").map(c => c.args), [["rm", b.address, "--json"]]);
  assert.ok(!h.calls().some(c => c.args[0] === "kill"), "conductor signals the proven pid; it never kills through hc");
  assert.ok(addressed(h), "every get, read and rm names the core address, never the name");
  for (const call of h.calls()) assert.equal(call.socket, h.socketPath);
});

test("hc stop escalates to SIGKILL on the same proven pid when the child ignores SIGTERM", { timeout: 60000 }, async t => {
  const h = await launchFixture(t, "ignore-term");
  const transport = h.launch();
  await transport.ready;
  const pid = (h.run.herdr as HcBinding).childPid!;
  await transport.stop();
  await transport.closed;
  assert.deepEqual(h.signals, [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
});

test("hc failed fresh launch: a child gone before acknowledging its task is proven gone and its terminal is removed", { timeout: 60000 }, async t => {
  const h = await launchFixture(t, "exit-on-task");
  const transport = h.launch();
  await assert.rejects(transport.ready, /herdr:.*child gone/);
  const b = h.run.herdr as HcBinding;
  assert.deepEqual(h.signals, [], "a gone child is never signalled");
  assert.equal(h.terminals()[b.address!], undefined, "rollback removed the finished terminal");
  assert.deepEqual(h.calls().filter(c => c.args[0] === "rm").map(c => c.args), [["rm", b.address, "--json"]]);
  assert.ok(addressed(h));
});

test("hc reattach after a crash between run and the record write: the address comes from the child's own hello", { timeout: 60000 }, async t => {
  let crashed = false;
  const h = await launchFixture(t, "hold", ({ transport }) => pid => {
    if (!crashed) { crashed = true; void transport()!.detach!(); }
    return realProbe(pid);
  });
  const transport = h.launch();
  await assert.rejects(transport.ready, /herdr:/);
  const address = (h.run.herdr as HcBinding).address!;
  assert.match(address, /^t\d+$/);
  const persisted = JSON.parse(readFileSync(h.run.recordPath, "utf8")).herdr;
  assert.deepEqual([persisted.host, persisted.address, persisted.childPid], ["hc", undefined, undefined], "the crash window: the record names no terminal yet");
  assert.equal(h.terminals()[address].state, "live");

  const restarted = new HerdrRuntime({ host: new HcHost({ cli: h.cli, coreId, lead: { address: h.lead }, piCommand: [process.execPath, fakeChild] }), env: {}, platform: "linux" });
  const recovered: Run = { ...h.run, herdr: persisted, transport: undefined, herdrOwnership: undefined };
  const before = h.calls().length;
  await assert.rejects(restarted.inspect(recovered), /prepared but never published/);
  assert.deepEqual(h.calls().slice(before).map(c => c.args), [["get", address, "--json"]], "the restarted lead observed the hello's terminal by address");
  assert.equal(await restarted.probeRecord(recovered), "unknown");
  assert.equal(persisted.address, undefined, "inspect never writes the recovered address back into the caller's record");
});

test("hc reattach of a ready run whose record lost its address recovers it and proves the live child", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const transport = h.launch();
  await transport.ready;
  const b = h.run.herdr as HcBinding;
  const restarted = new HerdrRuntime({ host: new HcHost({ cli: h.cli, coreId, lead: { address: h.lead }, piCommand: [process.execPath, fakeChild] }), env: {}, platform: "linux" });
  const { address: _address, ...withoutAddress } = b;
  const evidence = await restarted.inspect({ ...h.run, herdr: withoutAddress, transport: undefined });
  assert.equal(evidence.state, "alive");
  assert.equal((evidence.binding as HcBinding).address, b.address);
  const other = new HerdrRuntime({ host: new HcHost({ cli: h.cli, coreId: "othercore", lead: { address: h.lead }, piCommand: [process.execPath, fakeChild] }), env: {}, platform: "linux" });
  await assert.rejects(other.inspect({ ...h.run, herdr: { ...b }, transport: undefined }), /reattach identity unknown: core mismatch/);
  await transport.stop();
});
