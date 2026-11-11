import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import { fakeHc } from "./helpers/fake-hc.ts";
import { coreId, fakeChild, launchFixture, realProbe, until } from "./helpers/hc-launch.ts";
import { HcHost, hcTab } from "../src/hc/host.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import type { Run } from "../src/types.ts";
import type { HcBinding } from "../src/herdr/identity.ts";
import { HcCliError } from "../src/hc/cli.ts";

sandboxPi();
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
  await transport.stop();
});

test("hc record on another herdr-core or socket is other-socket, never reattached through this host", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const transport = h.launch();
  await transport.ready;
  const b = h.run.herdr as HcBinding;
  const recorded: Run = { ...h.run, herdr: { ...b }, transport: undefined };
  const elsewhere = await fakeHc();
  for (const host of [new HcHost({ cli: h.cli, coreId: "othercore", lead: { address: h.lead } }), new HcHost({ cli: elsewhere.cli, coreId, lead: { address: h.lead } })]) {
    const other = new HerdrRuntime({ host, env: {}, platform: "linux" });
    const before = h.calls().length;
    await assert.rejects(other.inspect(recorded), /^Error: herdr: other-socket$/);
    assert.equal(await other.probeRecord(recorded), "other-socket");
    assert.equal(h.calls().length, before, "no hc call reaches the core for a record bound elsewhere");
  }
  const same = new HerdrRuntime({ host: new HcHost({ cli: h.cli, coreId, lead: { address: h.lead } }), env: {}, platform: "linux" });
  assert.equal(await same.probeRecord(recorded), "alive", "positive control: the same socket and core reattach");
  await transport.stop();
});

test("hc resume: the previous terminal is removed, proven finished and ours, before the fresh terminal starts", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const first = h.launch();
  await first.ready;
  const previous = (h.run.herdr as HcBinding).address!;
  await first.stop(); await first.closed;
  const before = h.calls().length;
  const second = h.resume();
  await second.ready;
  const calls = h.calls().slice(before).map(c => c.args);
  const rm = calls.findIndex(a => a[0] === "rm"), run = calls.findIndex(a => a[0] === "run");
  assert.deepEqual(calls[rm], ["rm", previous, "--json"]);
  assert.ok(rm >= 0 && rm < run, `the previous terminal goes before the new hc run: ${JSON.stringify(calls)}`);
  assert.equal(h.terminals()[previous], undefined);
  const b = h.run.herdr as HcBinding;
  assert.notEqual(b.address, previous, "hc never reuses a finished terminal");
  assert.equal(h.terminals()[b.address!].state, "live");
  assert.doesNotMatch(second.stderr, /kept/);
  await second.stop();
});

test("hc resume: a previous terminal that is not proven ours is kept with a diagnostic, and the relaunch still starts", { timeout: 60000 }, async t => {
  const h = await launchFixture(t);
  const first = h.launch();
  await first.ready;
  const previous = (h.run.herdr as HcBinding).address!;
  await first.stop(); await first.closed;
  h.patch({ report: { [previous]: { labels: { "conductor.run": "someone-else" } } } });
  const before = h.calls().length;
  const second = h.resume();
  await second.ready;
  assert.ok(!h.calls().slice(before).some(c => c.args[0] === "rm"), "an unproven previous terminal is never removed");
  assert.ok(h.terminals()[previous], "the previous terminal is kept");
  assert.match(second.stderr, new RegExp(`previous terminal ${previous} kept: terminal labels mismatch`));
  assert.notEqual((h.run.herdr as HcBinding).address, previous);
  await second.stop();
});

test("hc rollback after an unconfirmed hc run: a started child is proven through its hello's terminal, stopped by pid and removed", { timeout: 60000 }, async t => {
  const hellos = (dir: string) => existsSync(join(dir, "launch")) ? readdirSync(join(dir, "launch")).filter(f => f.endsWith(".json")) : [];
  const h = await launchFixture(t, "hold", undefined, (cli, dir) => ({ ...cli, async run(spec, limits) {
    const abort = new AbortController();
    const pending = cli.run(spec, { ...limits, signal: abort.signal }).catch(() => undefined);
    await until(() => hellos(dir).length === 1, "the child's hello");
    abort.abort(); await pending;
    throw new HcCliError("timeout");
  } }));
  h.patch({ runFault: "timeout-after-start" });
  const transport = h.launch();
  await assert.rejects(transport.ready, /hc start outcome unconfirmed; no blind retry/);
  const hello = JSON.parse(readFileSync(join(h.dir, "launch", hellos(h.dir)[0]!), "utf8"));
  assert.deepEqual(h.signals, [[hello.pid, "SIGTERM"]], "the started child was stopped by its proven pid");
  const b = h.run.herdr as HcBinding;
  assert.equal(b.address, hello.paneId, "the address came from the child's own hello");
  assert.equal(h.terminals()[hello.paneId], undefined, "and its finished terminal removed");
  assert.equal(h.calls().filter(c => c.args[0] === "run" && c.args.includes(b.agentName!)).length, 1, "never retried");
});

test("hc launch without a proven host Pi entry is refused before any hc run, never retried as a bare pi", { timeout: 60000 }, async t => {
  const h = await launchFixture(t, "hold", undefined, undefined, null);
  const transport = h.launch();
  await assert.rejects(transport.ready, /hc launch refused: the host Pi entry is not Pi's declared bin, and hc never runs a bare pi from the core's PATH/);
  assert.equal(h.calls().filter(c => c.args[0] === "run").length, 1, "only the lead's own terminal was ever started");
});
