import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { tmpDir } from "./tmp.ts";
import { fakeHc } from "./fake-hc.ts";
import { HcHost } from "../../src/hc/host.ts";
import { HerdrRuntime } from "../../src/herdr/runtime.ts";
import { readProcessStartTime } from "../../src/reconcile-startup.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import type { HerdrTransport, RunSink } from "../../src/runtime.ts";
import type { HcCli } from "../../src/hc/cli.ts";

export const fakeChild = fileURLToPath(new URL("../fixtures/fake-hc-child.mjs", import.meta.url));
export const coreId = "fakecore0000000000000000000000000";
const leaked = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/leaked-herdr.sock", HERDR_PANE_ID: "leaked-pane", HERDR_TAB_ID: "leaked-tab", HERDR_WORKSPACE_ID: "leaked-ws" };
export type Probe = (pid: number) => { pid: number; state: "alive" | "gone" | "unknown"; startTime?: number };
export const realProbe: Probe = pid => {
  try { process.kill(pid, 0); return { pid, state: "alive", startTime: readProcessStartTime(pid) }; }
  catch (e) { return { pid, state: (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" }; }
};

export async function until(cond: () => boolean, what: string, ms = 30000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
}

export async function launchFixture(t: TestContext, mode = "hold", probe: (h: { transport: () => HerdrTransport | undefined }) => Probe = () => realProbe,
  wrap: (cli: HcCli, dir: string) => HcCli = cli => cli, piCommand: readonly [string, string] | null = [process.execPath, fakeChild]) {
  const f = await fakeHc({}, { FAKE_CHILD_MODE: mode });
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp-lead" }, argv: ["pi"] });
  f.patch({ spawn: true, coreEnv: leaked });
  const root = tmpDir("hc-launch-"), dir = join(root, "oracle-hc"); mkdirSync(dir);
  const run: Run = { id: "oracle-hc", runtime: "herdr", persona: "oracle", task: "hc task", status: "running", mode: "background", cwd: root,
    startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const host = new HcHost({ cli: wrap(f.cli, dir), coreId, lead: { address: lead.address, space: "sp-lead" }, ...(piCommand ? { piCommand } : {}) });
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
  const resume = () => {
    transport = runtime.launch(run, [], root, sink, "hc resume", { kind: "resume", sessionPath: run.sessionPath!, systemPrompt: "probe" });
    run.transport = transport;
    return transport;
  };
  return { ...f, lead: lead.address, run, dir, signals, launch, resume };
}
