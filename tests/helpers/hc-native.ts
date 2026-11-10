// Native Pi event/acceptance witness over HcHost; the hc CLI and process exit are injected.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { registerTools } from "../../src/tools.ts";
import { HerdrRuntime } from "../../src/herdr/runtime.ts";
import { HcHost } from "../../src/hc/host.ts";
import { createRunPipeline } from "../../src/run-pipeline.ts";
import { RunRegistry } from "../../src/runs.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import type { HcCli, HcRunSpec, HcTerminal } from "../../src/hc/cli.ts";
import type { HcBinding } from "../../src/herdr/identity.ts";
import { readProcessStartTime } from "../../src/reconcile-startup.ts";

export async function nativeHcPipeline(root: string, t: TestContext) {
  assert.equal(VERSION, "0.87.1");
  const id = "oracle-native-hc", dir = join(root, id), agentDir = join(dir, "agent"); mkdirSync(dir);
  const run: Run = { id, runtime: "herdr", persona: "oracle", task: "Native hc probe", cwd: dir, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const registry = new RunRegistry(); registry.register(run);
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 8192, maxTokens: 1024 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
  const settingsManager = SettingsManager.inMemory(settings);
  let bridge: ReturnType<typeof installChildBridge> | undefined, session: any, gone = false, shutdowns = 0;
  const socketPath = join(dir, "hc.sock"), address = "t5", runs: HcRunSpec[] = [];
  let terminal: HcTerminal | undefined, hello: Record<string, unknown> | undefined;
  const cli: HcCli = {
    socketPath,
    async run(spec) {
      runs.push(spec);
      const b = run.herdr as HcBinding;
      const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_DIR: dir, CONDUCTOR_RUN_ID: id,
        HC_TERMINAL_ID: address, HC_TERMINAL_SOCKET: socketPath, HC_SCOPE: "native-scope", HC_SESSION: "native",
        HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "leaked-herdr.sock"), HERDR_PANE_ID: "leaked-pane", HERDR_TAB_ID: "leaked-tab", HERDR_WORKSPACE_ID: "leaked-ws" };
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => {
          pi.registerProvider(faux.provider); pi.registerFlag("conductor-launch", { type: "string" });
          bridge = installChildBridge(pi, { env }); registerTools(pi, { getRegistry: () => registry } as never, env);
        }] });
      await loader.reload(); loader.getExtensions().runtime.flagValues.set("conductor-launch", b.launchNonce);
      ({ session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(b.sessionFile), tools: [] }));
      terminal = { address, name: spec.name, pid: process.pid, parent: spec.parent ?? null, die_with_parent: false, notify: false, labels: { ...spec.labels },
        state: "live", exit_code: null, signal: null, cwd: spec.cwd, argv: [...spec.argv], status: null };
      await session.bindExtensions({ mode: "tui", onError: (e: unknown) => assert.fail(JSON.stringify(e)), shutdownHandler: () => {
        shutdowns++; gone = true; terminal = { ...terminal!, state: "finished", exit_code: 0 };
      } });
      hello = JSON.parse(readFileSync(join(dir, "launch", `${b.launchNonce}.json`), "utf8"));
      faux.setResponses([fauxAssistantMessage("Native hc final evidence with full verification.")]);
      assert.equal(session.isStreaming, false);
      return { address, name: spec.name, parent: spec.parent ?? null, state: "live" };
    },
    async get(target) {
      assert.equal(target, address, "observed by core address only");
      return { ...terminal!, labels: { ...terminal!.labels }, argv: [...terminal!.argv] };
    },
    async read() { return "native hc fixture"; },
    async rm() { return assert.fail("the native fixture never releases its terminal"); },
    async serverStatus() { return { coreId: "native-core", version: "0.1.19" }; },
  };
  const host = new HcHost({ cli, coreId: "native-core", lead: { address: "t1", space: "sp-native" }, piCommand: [process.execPath, "/opt/pi/dist/cli.js"] });
  const runtime = new HerdrRuntime({ host, env: {}, trustArgs: () => [], piVersion: VERSION,
    sleep: async () => { t.mock.timers.tick(250); await new Promise(resolve => setImmediate(resolve)); },
    probe: pid => ({ pid, state: gone ? "gone" : "alive", startTime: readProcessStartTime(pid) }), signal: () => assert.fail("native fixture must settle without signals") });
  const prior = process.env.CONDUCTOR_SUBAGENT; process.env.CONDUCTOR_SUBAGENT = "1";
  let completions = 0;
  try {
    await createRunPipeline(run, [], { registry, runtime, cwd: dir, timeoutMs: 10000, steerable: false, initialPrompt: "Native initial hc task",
      core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "Probe" }, onComplete: () => completions++ });
    const b = run.herdr as HcBinding;
    return { version: VERSION, status: run.status, error: run.errorMessage, shutdowns, completions, turns: run.usage.turns, final: readFileSync(run.finalPath, "utf8"),
      hello: { paneId: hello?.paneId, terminalId: hello?.terminalId, piVersion: hello?.piVersion }, binding: { host: b.host, address: b.address, coreId: b.coreId, tab: b.tab, space: b.space },
      runs: runs.map(spec => ({ name: spec.name, parent: spec.parent, labels: spec.labels, argv: spec.argv })) };
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    bridge?.dispose(); clearTimeout(run.timeoutTimer);
    if (prior === undefined) delete process.env.CONDUCTOR_SUBAGENT; else process.env.CONDUCTOR_SUBAGENT = prior;
  }
}
