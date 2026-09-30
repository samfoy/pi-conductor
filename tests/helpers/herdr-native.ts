// Native Pi event/acceptance witness; CLI and process-exit observations are injected.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { registerTools } from "../../src/tools.ts";
import { HerdrRuntime } from "../../src/herdr/runtime.ts";
import { createRunPipeline } from "../../src/run-pipeline.ts";
import { RunRegistry } from "../../src/runs.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import type { HerdrCli } from "../../src/herdr/cli.ts";
import { readProcessStartTime } from "../../src/reconcile-startup.ts";

export async function nativePipeline(root: string, ask: boolean, t: TestContext) {
  assert.equal(VERSION, "0.87.1");
  const id = `oracle-native-${ask}`, dir = join(root, id), agentDir = join(dir, "agent"); mkdirSync(dir);
  const run: Run = { id, runtime: "herdr", persona: "oracle", task: "Native probe", cwd: dir, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(),
    recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const registry = new RunRegistry(); registry.register(run);
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 8192, maxTokens: 1024 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
  const settingsManager = SettingsManager.inMemory(settings);
  let bridge: ReturnType<typeof installChildBridge> | undefined, session: any, gone = false, shutdowns = 0;
  const pane = { pane_id: "pane", terminal_id: "terminal", workspace_id: "workspace", tab_id: "tab", agent: null as string | null, agent_session: null as unknown };
  const socketPath = join(dir, "fake.socket");
  const cli: HerdrCli = { socketPath, async text() { return "native fixture"; }, async json(args) {
    if (args[0] === "tab") return { type: "tab_created", root_pane: { ...pane }, tab: { tab_id: "tab", workspace_id: "workspace", label: id, pane_count: 1 } };
    if (args[1] === "get") return { type: "pane_info", pane: { ...pane } };
    assert.equal(args[1], "start");
    const b = run.herdr!;
    const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_DIR: dir, CONDUCTOR_RUN_ID: id, HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: pane.pane_id, HERDR_TAB_ID: pane.tab_id, HERDR_WORKSPACE_ID: pane.workspace_id };
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(faux.provider); pi.registerFlag("conductor-launch", { type: "string" });
        bridge = installChildBridge(pi, { env }); registerTools(pi, { getRegistry: () => registry } as never, env);
      }] });
    await loader.reload(); loader.getExtensions().runtime.flagValues.set("conductor-launch", b.launchNonce);
    ({ session } = await createAgentSession({ cwd: dir, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(b.sessionFile), tools: ["ask_owner"] }));
    await session.bindExtensions({ mode: "tui", onError: (e: unknown) => assert.fail(JSON.stringify(e)), shutdownHandler: () => { shutdowns++; gone = true; pane.agent = null; pane.agent_session = null; } });
    assert.equal(JSON.parse(readFileSync(join(dir, "launch", `${b.launchNonce}.json`), "utf8")).piVersion, "0.87.1");
    pane.agent = "pi"; pane.agent_session = { kind: "path", value: b.sessionFile, agent: "pi", source: "integration" };
    const agent = { ...pane };
    faux.setResponses([ask ? fauxAssistantMessage([fauxToolCall("ask_owner", { question: "Native choice?", evidence: "Native evidence" }, { id: "native-ask" })], { stopReason: "toolUse" }) : fauxAssistantMessage("Native final evidence 漢🙂\u2028\u2029 with full verification.")]);
    const settled = new Promise<void>(resolve => { const off = session.subscribe((e: any) => { if (e.type === "agent_settled") { off(); resolve(); } }); });
    t.mock.timers.tick(250); await settled;
    return { type: "agent_started", agent };
  } };
  const runtime = new HerdrRuntime({ cli, workspaceId: "workspace", env: {}, trustArgs: () => [], piVersion: VERSION,
    probe: pid => ({ pid, state: gone ? "gone" : "alive", startTime: readProcessStartTime(pid) }), signal: () => assert.fail("native fixture must settle without signals") });
  const prior = process.env.CONDUCTOR_SUBAGENT; process.env.CONDUCTOR_SUBAGENT = "1";
  let completions = 0;
  try {
    await createRunPipeline(run, [], { registry, runtime, cwd: dir, timeoutMs: 10000, steerable: false, initialPrompt: "Native initial task", core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "Probe" }, onComplete: () => completions++ });
    assert.equal(shutdowns, 1); assert.equal(completions, 1); assert.equal(run.usage.turns, 1);
    assert.equal(run.status, ask ? "blocked" : "completed", run.errorMessage);
    if (ask) assert.equal(run.pendingAsk?.question, "Native choice?");
    else assert.match(readFileSync(run.finalPath, "utf8"), /漢🙂\u2028\u2029/);
    return { version: VERSION, status: run.status, shutdowns, completions, turns: run.usage.turns };
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    bridge?.dispose(); clearTimeout(run.timeoutTimer);
    if (prior === undefined) delete process.env.CONDUCTOR_SUBAGENT; else process.env.CONDUCTOR_SUBAGENT = prior;
  }
}
