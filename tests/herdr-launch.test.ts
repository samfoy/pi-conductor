import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { readInbox, writeInboxAck } from "../src/herdr/inbox.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { HerdrCliError, type HerdrCli } from "../src/herdr/cli.ts";
import type { RunSink } from "../src/runtime.ts";

sandboxPi();
const runtimeModule = new URL("../src/herdr/runtime.ts", import.meta.url);
const sink: RunSink = { line() { assert.fail("H6 must not own pipeline streaming"); }, close() { assert.fail("CLI exit is not child close"); }, error() {}, initialDeliveryFailed() {} };
async function fixture(mode = "healthy") {
  assert.ok(existsSync(runtimeModule), "H6 launch runtime exists");
  const { HerdrRuntime } = await import("../src/herdr/runtime.ts");
  const root = tmpDir("h6-launch-"), dir = join(root, "oracle-test"); mkdirSync(dir);
  const run: Run = { id: "oracle-test", runtime: "herdr", persona: "oracle", task: "prepared", status: "running", mode: "background", cwd: root,
    startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const pane = { pane_id: "pane-owned", terminal_id: "terminal-owned", workspace_id: "workspace-owned", tab_id: "tab-owned", agent: null as string | null, agent_session: null as unknown };
  const calls: { args: readonly string[]; timeoutMs?: number }[] = [], signals: unknown[] = [];
  let time = 0, gone = false, starts = 0;
  let onSleep: (() => void) | undefined, onStart: (() => void) | undefined, react: (() => void) | undefined;
  const observed: { preparedText?: string; visibleAtStart?: number; aliases: string[] } = { aliases: [] };
  const cli: HerdrCli = { socketPath: join(root, "explicit-fake.socket"), async text(args, limits) { calls.push({ args, ...limits }); return "Authorization: Bearer secret-token\nhttps://user:proxy-secret@proxy.invalid\n"; }, async json(args, limits) {
    calls.push({ args, ...limits });
    if (args[0] === "tab") return { type: "tab_created", root_pane: { ...pane }, tab: { tab_id: pane.tab_id, workspace_id: pane.workspace_id, label: run.id, pane_count: 1 } };
    if (args[1] === "get") return { type: "pane_info", pane: { ...pane } };
    if (args[1] === "close") { assert.equal(gone, true, "never close before proven child death"); assert.equal(pane.agent, null); return { type: "ok" }; }
    assert.equal(args[1], "start"); starts++; onStart?.(); observed.aliases.push(args[2]);
    if (limits?.signal?.aborted) throw new HerdrCliError("cancelled");
    if (mode === "start-timeout") { time += 65000; throw new HerdrCliError("timeout"); }
    const record = JSON.parse(readFileSync(run.recordPath, "utf8")), binding = record.herdr;
    assert.equal(binding.launchNonce, run.herdr?.launchNonce);
    const inbox = join(dir, "inbox", binding.launchNonce);
    const prepared = existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith(".prepared.json")) : [];
    observed.preparedText = prepared.length === 1 ? JSON.parse(readFileSync(join(inbox, prepared[0]), "utf8")).text : undefined;
    observed.visibleAtStart = readInbox(dir, binding.launchNonce).length;
    // Real herdr: start succeeds only for an idle child. A task visible to the pump keeps it busy.
    if (observed.visibleAtStart) { time += 65000; throw new HerdrCliError("timeout"); }
    if (mode === "busy" && starts === 1 || mode === "always-busy") throw new HerdrCliError("remote", undefined, "agent_pane_busy");
    pane.agent = "pi"; pane.agent_session = { kind: "path", value: binding.sessionFile, agent: "pi", source: "integration" };
    const hello = { ...binding, v: 1, bridgeProtocol: mode === "protocol" ? 99 : 1, pid: 12345, pidStartTime: 77, at: 0, piVersion: "0.87.1", conductorVersion: "test" };
    if (mode === "foreign") hello.launchNonce = "foreign";
    if (mode === "pid") hello.pid = 1;
    if (mode === "pid-start") hello.pidStartTime = 78;
    if (mode === "version") hello.piVersion = "different-version";
    if (mode === "unknown-version") hello.piVersion = "unknown";
    if (mode === "session") pane.agent_session = { kind: "path", value: "/foreign/session", agent: "pi", source: "integration" };
    if (mode === "terminal") pane.terminal_id = "replaced";
    mkdirSync(join(dir, "launch"), { recursive: true });
    if (mode !== "no-hello") writeFileSync(join(dir, "launch", `${binding.launchNonce}.json`), JSON.stringify(hello));
    const emit = (e: unknown) => appendFileSync(run.transcriptPath, JSON.stringify(e) + "\n");
    emit({ type: "conductor_child", event: "launch", ...hello, _c: { n: mode === "stale-boundary" ? "foreign" : binding.launchNonce } });
    // The idle child reacts only once the parent publishes its task.
    react = () => {
      const request = readInbox(dir, binding.launchNonce)[0]?.request;
      if (!request) return;
      react = undefined;
      if (mode !== "no-ack" && mode !== "early-death") writeInboxAck(dir, request, mode === "busy-ack" ? "busy" : mode === "stale-ack" ? "stale-ask" : undefined);
      if (mode !== "no-start" && mode !== "late-start") emit({ type: "agent_start", _c: { n: binding.launchNonce }, initialRequestId: mode === "human" ? undefined : request.requestId });
      emit({ type: "agent_settled", _c: { n: binding.launchNonce } });
      if (mode === "fast-settle" || mode === "early-death") { gone = true; pane.agent = null; pane.agent_session = null; }
      return true;
    };
    const agent = { ...pane, name: mode === "other-name" ? "someone-else" : args[2] };
    if (mode === "prepublish-death") { gone = true; pane.agent = null; pane.agent_session = null; } // registered, then died unfed
    return { type: "agent_started", agent };
  } };
  const runtime = new HerdrRuntime({ cli, workspaceId: pane.workspace_id, env: { HTTPS_PROXY: "https://user:proxy-secret@proxy.invalid" },
    trustArgs: () => [], piVersion: "0.87.1", platform: "linux", now: () => time, sleep: async ms => { if (react?.()) return; time += ms; onSleep?.(); },
    probe: pid => ({ pid, state: gone ? "gone" : "alive", startTime: 77 }), signal: (pid, signal) => { signals.push([pid, signal]); if (mode === "stubborn" && signal === "SIGTERM") return; gone = true; pane.agent = null; pane.agent_session = null; } });
  const launch = () => runtime.launch(run, [], root, sink, "  Prepared evidence 漢🙂  ", { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "Private system prompt", model: "provider/model", thinking: "high", skillPaths: ["/private/skills"], tools: ["read"], excludeTools: ["write"] });
  return { run, dir, runtime, launch, calls, signals, pane, observed, now: () => time, onStart: (fn: () => void) => { onStart = fn; }, onSleep: (fn: () => void) => { onSleep = fn; } };
}

test("H6 bounded launch proves ack and subsequent native start without a CLI proc", async () => {
  const h = await fixture(); const transport = h.launch();
  assert.equal(transport.kind, "herdr"); assert.equal("proc" in transport, false);
  const ready = await transport.ready;
  assert.equal(ready.binding.childPid, 12345); assert.equal(h.run.proc, undefined); assert.equal(h.run.pid, undefined);
  const args = h.calls.find(c => c.args[1] === "start")!;
  assert.equal(args.timeoutMs, 65000); assert.equal(args.args[args.args.indexOf("--timeout") + 1], "60000");
  for (const flag of ["-p", "--mode", "--no-extensions", "--approve", "  Prepared evidence 漢🙂  "]) assert.ok(!args.args.includes(flag));
  assert.ok(args.args.includes("provider/model")); assert.ok(args.args.includes("/private/skills"));
  const path = args.args[args.args.indexOf("--append-system-prompt") + 1];
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(readFileSync(path, "utf8"), "Private system prompt");
  await transport.stop(); await transport.closed;
  assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0, "process-only stop keeps scrollback");
});

for (const mode of ["no-hello", "no-ack", "no-start", "human", "foreign", "protocol", "always-busy"]) {
  test(`H6 ${mode} never reports readiness`, async () => {
    const h = await fixture(mode); const transport = h.launch();
    await assert.rejects(transport.ready, /herdr:/);
    if (["no-hello", "foreign", "protocol", "always-busy"].includes(mode)) {
      assert.deepEqual(h.signals, [], "unknown child identity cannot authorize signals");
      assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0, "ambiguous launch retains pane");
    } else {
      assert.deepEqual(h.signals, [[12345, "SIGTERM"]]);
      assert.equal(h.calls.filter(c => c.args[1] === "close").length, 1, "fresh pane closes only after proven death");
    }
    assert.ok(h.now() <= 75000); assert.ok(!transport.stderr.includes("secret-token")); assert.ok(!transport.stderr.includes("proxy-secret"));
  });
}
test("H6 busy retries once after two seconds and a new empty-pane proof", async () => {
  const h = await fixture("busy"); const transport = h.launch(); await transport.ready;
  assert.equal(h.now(), 2000);
  const starts = h.calls.map((c, i) => c.args[1] === "start" ? i : -1).filter(i => i >= 0);
  assert.equal(starts.length, 2); assert.equal(h.calls[starts[1] - 1].args[1], "get");
  await transport.stop();
});


for (const mode of ["pid", "session", "terminal", "stale-boundary", "early-death"]) test(`H6 ${mode} cannot satisfy launch identity/readiness`, async () => {
  const h = await fixture(mode); await assert.rejects(h.launch().ready, /herdr:/);
  if (["pid", "session", "terminal"].includes(mode)) {
    assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
  }
});
test("H6 fast settled and exited child retains readiness evidence from the launch boundary", async () => {
  const h = await fixture("fast-settle"), transport = h.launch(); await transport.ready; await transport.closed;
  assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
});
for (const mode of ["no-hello", "no-ack", "no-start", "busy"]) test(`H6 cancel during ${mode} is bounded and cannot become ready`, async () => {
  const h = await fixture(mode), transport = h.launch();
  h.onSleep(() => { void transport.cancel(); });
  await assert.rejects(transport.ready, /cancelled/); await transport.cancel();
  assert.equal(transport.cancelled, true);
  assert.equal(h.calls.filter(c => c.args[1] === "start").length, 1);
});
test("H6 pre-cancel never creates a pane or starts a CLI", async () => {
  const h = await fixture(), transport = h.launch(); const cancelled = transport.cancel();
  await assert.rejects(transport.ready, /cancelled/); await cancelled; assert.deepEqual(h.calls, []);
});
for (const mode of ["healthy", "no-start"]) test(`H6 exact empty reuse ${mode} never rollback-closes the reused pane`, async () => {
  const h = await fixture(mode);
  h.run.herdr = { runId: h.run.id, launchNonce: "previous", sessionId: "prior-session", sessionFile: join(dirname(h.run.recordPath), "session", "prior.jsonl"),
    socketPath: join(h.run.cwd, "explicit-fake.socket"), paneId: h.pane.pane_id, terminalId: h.pane.terminal_id, tabId: h.pane.tab_id, workspaceId: h.pane.workspace_id, createdTab: true };
  const transport = h.launch();
  if (mode === "healthy") { await transport.ready; await transport.stop(); } else await assert.rejects(transport.ready);
  assert.equal(h.calls.filter(c => c.args[0] === "tab").length, 0);
  assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
});


test("H6 persisted binding roundtrips without process/transport adoption", async () => {
  const { toRunRecord } = await import("../src/types.ts"); const { buildOrphanRun } = await import("../src/reconcile-startup.ts");
  const { unsupportedRuntimeReason } = await import("../src/runtime.ts");
  const h = await fixture(), transport = h.launch(); await transport.ready; h.run.transport = transport;
  const record = JSON.parse(JSON.stringify(toRunRecord(h.run)));
  assert.deepEqual(record.herdr, h.run.herdr); assert.equal(record.transport, undefined); assert.equal(record.pid, undefined);
  const restored = buildOrphanRun(record, "running"); assert.deepEqual(restored.herdr, h.run.herdr);
  assert.equal(restored.proc, undefined); assert.equal(restored.transport, undefined);
  assert.equal(unsupportedRuntimeReason(restored.runtime), undefined);
  assert.equal(restored.herdrOwnership, undefined, "record alone does not confer stream ownership");
  await transport.stop();
});


test("H6 revalidates pane identity after ack/start waits before becoming ready", async () => {
  const h = await fixture("late-start"), transport = h.launch();
  h.onSleep(() => {
    h.pane.terminal_id = "foreign-terminal";
    const request = readInbox(dirname(h.run.recordPath), h.run.herdr!.launchNonce)[0].request;
    appendFileSync(h.run.transcriptPath, JSON.stringify({ type: "agent_start", initialRequestId: request.requestId, _c: { n: request.launchNonce } }) + "\n");
  });
  await assert.rejects(transport.ready, /identity/);
  assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
});
test("H6 busy revalidation rejects a replaced terminal without a second start", async () => {
  const h = await fixture("busy"), transport = h.launch(); h.onSleep(() => { h.pane.terminal_id = "foreign-terminal"; });
  await assert.rejects(transport.ready, /busy retry refused/);
  assert.equal(h.calls.filter(c => c.args[1] === "start").length, 1); assert.deepEqual(h.signals, []);
});
test("H6 failed empty-pane proof creates a new subtree and never closes the old pane", async () => {
  const h = await fixture();
  h.run.herdr = { runId: h.run.id, launchNonce: "previous", sessionId: "prior-session", sessionFile: join(dirname(h.run.recordPath), "session", "prior.jsonl"),
    socketPath: join(h.run.cwd, "explicit-fake.socket"), paneId: "old-pane", terminalId: "old-terminal", tabId: "old-tab", workspaceId: h.pane.workspace_id, createdTab: true };
  const transport = h.launch(); await transport.ready; await transport.stop();
  assert.equal(h.calls.filter(c => c.args[0] === "tab").length, 1);
  assert.ok(!h.calls.some(c => c.args[1] === "close" && c.args[2] === "old-pane"));
});


for (const mode of ["pid-start", "busy-ack", "stale-ack", "start-timeout"]) test(`H6 ${mode} fails bounded without a blind start retry`, async () => {
  const h = await fixture(mode), transport = h.launch(); await assert.rejects(transport.ready, /herdr:/);
  assert.equal(h.calls.filter(c => c.args[1] === "start").length, 1);
  if (mode === "pid-start" || mode === "start-timeout") { assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0); }
  if (mode === "start-timeout") assert.equal(h.now(), 65000);
});
test("H6 cancel in agent start never retries the ambiguous CLI outcome", async () => {
  const h = await fixture(), transport = h.launch(); h.onStart(() => { void transport.cancel(); });
  await assert.rejects(transport.ready, /cancelled/); assert.equal(h.calls.filter(c => c.args[1] === "start").length, 1);
  assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
});
test("H6 Pi version mismatch is diagnostic, unlike bridge protocol mismatch", async () => {
  const h = await fixture("version"), transport = h.launch(); await transport.ready;
  assert.match(transport.stderr, /Pi version mismatch: lead 0\.87\.1, child different-version/);
  assert.equal(h.run.herdr?.versionWarning, "Pi version mismatch: lead 0.87.1, child different-version", "persisted for the completion card");
  assert.equal(JSON.parse(readFileSync(h.run.recordPath, "utf8")).herdr.versionWarning, h.run.herdr?.versionWarning);
  await transport.stop();
});
test("H11 an unprovable child host version is reported unverified, never as a match", async () => {
  const h = await fixture("unknown-version"), transport = h.launch(); await transport.ready;
  assert.equal(h.run.herdr?.versionWarning, "Pi version unverified: lead 0.87.1, child unknown");
  await transport.stop();
});
test("H11 matching host versions persist no warning", async () => {
  const h = await fixture(), transport = h.launch(); await transport.ready;
  assert.equal(h.run.herdr?.versionWarning, undefined); assert.equal(transport.stderr, ""); await transport.stop();
});


test("H6 binding durability failure prevents agent start", async t => {
  const h = await fixture();
  t.mock.method(fs, "fsyncSync", () => { throw new Error("fixture fsync failure"); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(h.launch().ready, /launch failed/);
  assert.equal(h.calls.filter(c => c.args[1] === "start").length, 0);
});
test("H6 a pending answer cannot replace the original session with a fresh launch", async () => {
  const h = await fixture(); h.run.pendingAsk = { askId: "original", question: "Choose?", evidence: "" };
  h.run.sessionPath = join(dirname(h.run.recordPath), "session", "original.jsonl");
  const original = h.run.sessionPath;
  await assert.rejects(h.launch().ready, /answer requires the original session/);
  assert.equal(h.run.sessionPath, original); assert.deepEqual(h.calls, []);
});


for (const replaced of [false, true]) test(`H6 TERM/KILL chase re-proves child identity (replaced=${replaced})`, async () => {
  const h = await fixture("stubborn"), transport = h.launch(); await transport.ready;
  if (replaced) h.onSleep(() => { h.pane.terminal_id = "foreign-terminal"; });
  await transport.stop();
  assert.deepEqual(h.signals, replaced ? [[12345, "SIGTERM"]] : [[12345, "SIGTERM"], [12345, "SIGKILL"]]);
  if (replaced) assert.match(transport.stderr, /exit unconfirmed/); else await transport.closed;
  assert.equal(h.calls.filter(c => c.args[1] === "close").length, 0);
});
test("H6 effective child cwd and spawning config cwd remain distinct", async () => {
  const h = await fixture(), effectiveCwd = h.run.cwd, configCwd = join(h.run.cwd, "requested-project"); h.run.cwd = configCwd;
  const transport = h.launch(); await transport.ready;
  const args = h.calls.find(c => c.args[0] === "tab")!.args;
  assert.equal(args[args.indexOf("--cwd") + 1], effectiveCwd);
  assert.ok(args.includes(`CONDUCTOR_CONFIG_CWD=${configCwd}`));
  assert.equal(JSON.parse(readFileSync(h.run.sessionPath!, "utf8").split("\n")[0]).cwd, effectiveCwd);
  await transport.stop();
});

test("H11 the prepared task is durable before agent start but published only to the registered idle child", async () => {
  const h = await fixture(), transport = h.launch(); await transport.ready;
  assert.equal(h.observed.preparedText, "  Prepared evidence 漢🙂  ", "exact prepared intent is durable before start");
  assert.equal(h.observed.visibleAtStart, 0, "the pump could not see the task while herdr waited for idle");
  const entries = readInbox(h.dir, h.run.herdr!.launchNonce);
  assert.equal(entries.length, 1); assert.equal(entries[0].request.text, "  Prepared evidence 漢🙂  ");
  assert.deepEqual(readdirSync(join(h.dir, "inbox", h.run.herdr!.launchNonce)).filter(f => f.endsWith(".prepared.json")), []);
  await transport.stop();
});
for (const mode of ["no-hello", "foreign", "protocol", "pid-start", "other-name", "prepublish-death", "always-busy", "start-timeout"]) test(`H11 ${mode} before publication preserves the prepared task unpublished`, async () => {
  const h = await fixture(mode); await assert.rejects(h.launch().ready, /herdr:/);
  const nonce = h.run.herdr!.launchNonce;
  assert.equal(readInbox(h.dir, nonce).length, 0, "no task reached the pump");
  assert.equal(readdirSync(join(h.dir, "inbox", nonce)).filter(f => f.endsWith(".prepared.json")).length, 1, "durable intent kept for diagnosis");
  assert.equal(h.calls.filter(c => c.args[1] === "start").length, mode === "always-busy" ? 2 : 1, "no blind relaunch");
  if (mode === "prepublish-death") assert.equal(h.calls.filter(c => c.args[1] === "close").length, 1, "proven-dead fresh pane is still rolled back");
});
test("H11 a pending owner question survives failure between registration and publication", async () => {
  const h = await fixture("no-hello");
  h.run.pendingAsk = { askId: "original", question: "Choose?", evidence: "" };
  h.run.sessionPath = join(h.dir, "session", "original.jsonl");
  const { seedSessionFile } = await import("../src/session-seed.ts"); seedSessionFile(h.run.sessionPath, [], h.run.cwd);
  const transport = h.runtime.launch(h.run, [], h.run.cwd, sink, "answer text", { kind: "resume", sessionPath: h.run.sessionPath, systemPrompt: "p" });
  await assert.rejects(transport.ready, /herdr:/);
  assert.equal(h.run.pendingAsk?.askId, "original");
  const nonce = h.run.herdr!.launchNonce, file = readdirSync(join(h.dir, "inbox", nonce)).find(f => f.endsWith(".prepared.json"))!;
  const prepared = JSON.parse(readFileSync(join(h.dir, "inbox", nonce, file), "utf8"));
  assert.equal(prepared.kind, "reply"); assert.equal(prepared.askId, "original");
});
test("H11 each launch gets a fresh bounded physical alias persisted in its binding; old aliases never authorize", async () => {
  const { herdrAgentName } = await import("../src/herdr/runtime.ts");
  const h = await fixture();
  h.run.herdr = { runId: h.run.id, launchNonce: "previous", sessionId: "prior-session", sessionFile: join(h.dir, "session", "prior.jsonl"), agentName: herdrAgentName(h.run.id, "previous"),
    socketPath: join(h.run.cwd, "explicit-fake.socket"), paneId: h.pane.pane_id, terminalId: h.pane.terminal_id, tabId: h.pane.tab_id, workspaceId: h.pane.workspace_id, createdTab: true };
  const transport = h.launch(); await transport.ready;
  const [alias] = h.observed.aliases;
  assert.match(alias, /^[a-z][a-z0-9_-]{0,31}$/); assert.equal(alias, herdrAgentName(h.run.id, h.run.herdr!.launchNonce));
  assert.notEqual(alias, herdrAgentName(h.run.id, "previous"), "same-pane relaunch never reuses a retained name");
  assert.equal(h.run.herdr!.agentName, alias); assert.equal(JSON.parse(readFileSync(h.run.recordPath, "utf8")).herdr.agentName, alias);
  assert.equal(h.run.herdr!.paneId, h.pane.pane_id, "logical run and pane stay; only the physical alias changes");
  await transport.readStallEvidence!();
  assert.deepEqual(h.calls.filter(c => c.args[1] === "read").map(c => c.args[2]), [alias]);
  const ids = new Set(Array.from({ length: 200 }, (_, i) => herdrAgentName("x".repeat(40), `nonce-${i}`)));
  assert.equal(ids.size, 200); for (const id of ids) assert.match(id, /^[a-z][a-z0-9_-]{0,31}$/);
  await transport.stop();
});
test("H11 crash between registration and publication is diagnosable on reattach, never replayed", async () => {
  const h = await fixture("no-hello"); await assert.rejects(h.launch().ready, /herdr:/);
  const hello = { v: 1, bridgeProtocol: 1, ...h.run.herdr!, pid: process.pid, pidStartTime: readProcessStartTime(process.pid), at: 0, piVersion: "0.87.1", conductorVersion: "test" };
  writeFileSync(join(h.dir, "launch", `${h.run.herdr!.launchNonce}.json`), JSON.stringify(hello));
  h.run.herdr!.childPid = hello.pid; h.run.herdr!.childStartTime = hello.pidStartTime;
  h.pane.agent = "pi"; h.pane.agent_session = { kind: "path", value: h.run.herdr!.sessionFile, agent: "pi", source: "integration" };
  const { HerdrRuntime } = await import("../src/herdr/runtime.ts");
  const runtime = new HerdrRuntime({ cli: h.runtime["options"]!.cli, env: {}, platform: "linux" });
  await assert.rejects(runtime.inspect(h.run), /prepared but never published; the child never received its task; preserved, not replayed/);
  assert.equal(readInbox(h.dir, h.run.herdr!.launchNonce).length, 0);
});
