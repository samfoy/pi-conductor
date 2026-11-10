import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { readInbox, writeInboxAck } from "../src/herdr/inbox.ts";
import { isRecord } from "../src/herdr/cli.ts";
import type { HerdrBinding } from "../src/herdr/identity.ts";
import type { TerminalHost, TerminalIdentity } from "../src/herdr/host.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import type { RunSink } from "../src/runtime.ts";

sandboxPi();
const sink: RunSink = { line() {}, close() {}, error() {}, initialDeliveryFailed() {} };

const identity: TerminalIdentity = {
  proveChild: ({ binding, observation, process }) => {
    if (isRecord(process) && process.state === "gone") return { ok: false, state: "gone", reason: "stub child gone" };
    return isRecord(observation) && isRecord(binding) && observation.owner === binding.runId && isRecord(process) && process.state === "alive"
      ? { ok: true, pid: process.pid as number } : { ok: false, state: "unknown", reason: "stub refusal" };
  },
  recorded: binding => ({ owner: binding.runId }),
};

function fixture(mode: "healthy" | "no-ack" | "cancel-in-place" = "healthy") {
  const root = tmpDir("host-seam-"), dir = join(root, "oracle-seam"); mkdirSync(dir);
  const run: Run = { id: "oracle-seam", runtime: "herdr", persona: "oracle", task: "seam", status: "running", mode: "background", cwd: root,
    startTime: 0, lastEventAt: 0, messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const calls: string[] = [], signals: [number, string][] = [], seen: Record<string, unknown> = {};
  let time = 0, gone = false, cancel: (() => void) | undefined;
  let react: (() => boolean) | undefined;
  const host: TerminalHost = {
    socketPath: join(root, "stub.socket"), identity,
    async reuse() { calls.push("reuse"); return undefined; },
    async placeLeaf() { calls.push("placeLeaf"); return { warning: "stub" }; },
    async placeRun(spec, fence) {
      calls.push("placeRun"); seen.placeEnv = spec.env;
      if (mode === "cancel-in-place") cancel?.();
      fence.check();
      return { ...spec.invocation, socketPath: join(root, "stub.socket"), workspaceId: "ws", tabId: "tab", paneId: "pane", terminalId: "term", createdTab: true };
    },
    async start(binding, launch, limits, fence) {
      calls.push("start"); fence.check();
      seen.launch = launch; seen.startLimits = limits;
      const nonce = binding.launchNonce;
      seen.publishedAtStart = readInbox(dir, nonce).length;
      const record = JSON.parse(readFileSync(run.recordPath, "utf8")).herdr as HerdrBinding;
      const hello = { ...record, v: 1, bridgeProtocol: 1, pid: 4242, pidStartTime: 77, at: 0, piVersion: "0.87.1", conductorVersion: "test" };
      mkdirSync(join(dir, "launch"), { recursive: true });
      writeFileSync(join(dir, "launch", `${nonce}.json`), JSON.stringify(hello));
      const emit = (e: unknown) => appendFileSync(run.transcriptPath, JSON.stringify(e) + "\n");
      emit({ type: "conductor_child", event: "launch", ...hello, _c: { n: nonce } });
      react = () => {
        const request = readInbox(dir, nonce)[0]?.request;
        if (!request || mode === "no-ack") return false;
        seen.callsAtPublish = [...calls];
        react = undefined;
        writeInboxAck(dir, request);
        emit({ type: "agent_start", _c: { n: nonce }, initialRequestId: request.requestId });
        return true;
      };
      return { owner: binding.runId };
    },
    async observe(binding, limits) { calls.push("observe"); seen.observeLimits = limits; return { owner: binding.runId }; },
    async readScreen(binding, lines, limits) { calls.push("readScreen"); seen.screen = { binding, lines, limits }; return "Authorization: Bearer secret-token\nscreen"; },
    async release(binding, current) { calls.push("release"); seen.release = { binding, current: current() }; return { ok: true }; },
  };
  const runtime = new HerdrRuntime({ host, env: { HTTPS_PROXY: "https://user:proxy-secret@proxy.invalid" }, trustArgs: () => [], piVersion: "0.87.1", platform: "linux",
    now: () => time, sleep: async ms => { if (react?.()) return; time += ms; },
    probe: pid => ({ pid, state: gone ? "gone" : "alive", startTime: 77 }), signal: (pid, signal) => { signals.push([pid, signal]); gone = true; } });
  const launch = () => {
    const transport = runtime.launch(run, [], root, sink, "seam task", { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "probe" });
    cancel = () => { void transport.cancel(); };
    return transport;
  };
  return { run, runtime, launch, calls, signals, seen };
}

test("TerminalHost seam: launch places, starts and observes through the host, then publishes only to the observed child", async () => {
  const h = fixture(); const transport = h.launch();
  const ready = await transport.ready;
  assert.equal(h.seen.publishedAtStart, 0, "the task is not published before the host starts the child");
  assert.deepEqual(h.seen.callsAtPublish, ["placeRun", "start", "observe"]);
  assert.deepEqual(h.calls, ["placeRun", "start", "observe", "observe"]);
  assert.equal(ready.binding.childPid, 4242);
  assert.equal(ready.binding.socketPath, h.runtime["options"]!.host.socketPath);
  const launch = h.seen.launch as { alias: string; args: string[]; cwd: string; env: Record<string, string> };
  assert.equal(launch.alias, ready.binding.agentName);
  assert.ok(launch.args.includes("--conductor-launch"));
  assert.deepEqual(launch.env, h.seen.placeEnv, "the host sees one pane environment for placement and start");
  assert.equal(launch.env.CONDUCTOR_RUN_ID, "oracle-seam");
  assert.equal((h.seen.startLimits as { timeoutMs: number }).timeoutMs, 65000);
  assert.equal((h.seen.observeLimits as { timeoutMs: number }).timeoutMs, 2000);
  const evidence = await transport.readStallEvidence!();
  assert.ok(!evidence.includes("secret-token"), "screen text is redacted by the runtime, whatever the host returns");
  assert.deepEqual((h.seen.screen as { lines: number }).lines, 40);
  assert.deepEqual((h.seen.screen as { limits: unknown }).limits, { timeoutMs: 2000, maxBuffer: 4096, signal: undefined });
  await transport.stop();
  assert.deepEqual(h.signals, [[4242, "SIGTERM"]]);
  assert.ok(!h.calls.includes("release"), "a process stop keeps the terminal");
  assert.equal(await transport.releasePane(), true);
  assert.equal(h.calls.at(-1), "release");
  const released = h.seen.release as { binding: HerdrBinding; current: unknown };
  assert.equal(released.binding, h.run.herdr);
  assert.equal(released.current, h.run.herdr);
});

test("TerminalHost seam: a failed fresh launch rolls back through host.release after the child is proven gone", async () => {
  const h = fixture("no-ack"); const transport = h.launch();
  await assert.rejects(transport.ready, /herdr:.*initial ack timeout/);
  assert.deepEqual(h.signals, [[4242, "SIGTERM"]]);
  assert.deepEqual(h.calls.slice(-2), ["release", "readScreen"], "rollback releases through the host before reading stall evidence");
  assert.equal(h.calls.filter(c => c === "release").length, 1);
});

test("TerminalHost seam: the fence a host receives is the runtime's own check, so a cancel during placement never starts", async () => {
  const h = fixture("cancel-in-place"); const transport = h.launch();
  await assert.rejects(transport.ready, /herdr:.*launch cancelled/);
  assert.deepEqual(h.calls, ["placeRun"]);
  assert.deepEqual(h.signals, []);
});

test("TerminalHost seam: inspect and probeRecord prove identity through the host, never a TUI pane", async () => {
  const h = fixture(); const transport = h.launch(); await transport.ready;
  h.calls.length = 0;
  assert.equal(await h.runtime.probeRecord(h.run), "alive");
  assert.deepEqual(h.calls, ["observe"]);
  const other = { ...h.run, herdr: { ...h.run.herdr!, socketPath: "/elsewhere.socket" } };
  assert.equal(await h.runtime.probeRecord(other), "other-socket");
  assert.deepEqual(h.calls, ["observe"], "a foreign socket never reaches the host");
  await transport.stop();
});
