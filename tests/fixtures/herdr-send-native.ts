// Private native SDK child behind fake-herdr; no terminal server or provider network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";

const manifest = process.argv[2];
while (!existsSync(manifest)) await delay(10);
const { runDir, mode } = JSON.parse(readFileSync(manifest, "utf8"));
const binding = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8")).herdr;
const agentDir = join(process.env.HOME!, "agent"); mkdirSync(agentDir, { recursive: true });
const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 8192, maxTokens: 1024 }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
const settingsManager = SettingsManager.inMemory(settings);
const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: binding.runId, CONDUCTOR_RUN_DIR: runDir,
  HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath, HERDR_PANE_ID: binding.paneId, HERDR_TAB_ID: binding.tabId, HERDR_WORKSPACE_ID: binding.workspaceId };
process.env.CONDUCTOR_SUBAGENT = "1";
let bridge: ReturnType<typeof installChildBridge> | undefined;
const inputs: string[] = [], modelInputs: string[][] = [];
const resourceLoader = new DefaultResourceLoader({ cwd: runDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    pi.registerProvider(faux.provider); pi.registerFlag("conductor-launch", { type: "string" });
    if (mode === "retired") pi.on("session_start", (_e, ctx) => { pi.appendEntry("conductor-context-retired", { sessionId: ctx.sessionManager.getSessionId() }); });
    bridge = installChildBridge(pi, { env }); registerTools(pi, { getRegistry: () => new RunRegistry() } as never, env);
  }, pi => {
    pi.on("input", e => {
      inputs.push(e.text); writeFileSync(`${manifest}.inputs`, JSON.stringify(inputs));
      if (mode === "intercept") return { action: "handled" };
    });
  }] });
await resourceLoader.reload(); resourceLoader.getExtensions().runtime.flagValues.set("conductor-launch", binding.launchNonce);
const { session } = await createAgentSession({ cwd: runDir, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader,
  sessionManager: SessionManager.open(binding.sessionFile), tools: ["ask_owner"] });
let shutdown!: () => void;
const finished = new Promise<void>(resolve => { shutdown = resolve; });
await session.bindExtensions({ mode: "tui", onError: e => writeFileSync(`${manifest}.error`, JSON.stringify(e)), shutdownHandler: shutdown });
const response = (text: string) => (context: any) => {
  modelInputs.push(context.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")));
  writeFileSync(`${manifest}.model-inputs`, JSON.stringify(modelInputs));
  return fauxAssistantMessage(text);
};
faux.setResponses(mode === "ask" ? [fauxAssistantMessage([fauxToolCall("ask_owner", { question: "Choose the native route?" }, { id: "native-question" })], { stopReason: "toolUse" })]
  : mode === "failure" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline later failure" })]
  : mode === "live" ? [async () => { writeFileSync(`${manifest}.streaming`, "streaming"); while (!existsSync(`${manifest}.release`)) await delay(10); return fauxAssistantMessage("Held native response complete."); }, response("Native follow-up final evidence 漢🙂 with exact input acceptance.")]
  : [response("Native resumed final evidence 漢🙂 with exact input acceptance.")]);
writeFileSync(`${manifest}.ready`, JSON.stringify({ version: VERSION, nonce: binding.launchNonce }));
// The bridge timer is unref'd; this fixture alone owns the child lifetime.
const keepAlive = setInterval(() => {}, 1000);
await finished;
clearInterval(keepAlive);
await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
bridge?.dispose(); session.dispose();
process.exit(0);

