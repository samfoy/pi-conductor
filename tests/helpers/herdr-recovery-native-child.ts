import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";

const manifest = process.argv[2];
const wait = async (path: string) => {
  const end = Date.now() + 25000;
  while (!existsSync(path)) { if (Date.now() > end) throw new Error(`fixture barrier expired: ${path}`); await delay(10); }
};
await wait(manifest);
const { runDir, mode } = JSON.parse(readFileSync(manifest, "utf8"));
const run = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8")), b = run.herdr;
if (VERSION !== "0.87.1") throw new Error(`unapproved native Pi ${VERSION}`);
const agentDir = join(runDir, "native-agent");
const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 8192, maxTokens: 1024 }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
const settingsManager = SettingsManager.inMemory(settings);
let bridge: ReturnType<typeof installChildBridge> | undefined;
const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: run.id, CONDUCTOR_RUN_DIR: runDir,
  HERDR_ENV: "1", HERDR_SOCKET_PATH: b.socketPath, HERDR_PANE_ID: b.paneId, HERDR_TAB_ID: b.tabId, HERDR_WORKSPACE_ID: b.workspaceId };
const loader = new DefaultResourceLoader({ cwd: run.cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => { pi.registerProvider(faux.provider); pi.registerFlag("conductor-launch", { type: "string" }); bridge = installChildBridge(pi, { env }); }] });
await loader.reload(); loader.getExtensions().runtime.flagValues.set("conductor-launch", b.launchNonce);
const { session } = await createAgentSession({ cwd: run.cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(b.sessionFile), tools: [] });
await session.bindExtensions({ mode: "tui", onError: error => process.stderr.write(JSON.stringify(error) + "\n"), shutdownHandler: () => {} });
if (mode === "partial") {
  const write = fs.writeSync;
  fs.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
    if (buffer.includes('"type":"agent_settled"')) { write(fd, buffer, offset, Math.min(length, 17)); throw new Error("fixture partial native settle"); }
    return write(fd, buffer, offset, length);
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
}
faux.setResponses([async () => { writeFileSync(`${manifest}.entered`, "native response held"); await wait(`${manifest}.release`); return fauxAssistantMessage("Native H10 assignment complete, with durable verification evidence 漢🙂."); }]);
const settled = new Promise<void>(resolve => { const off = session.subscribe(event => { if (event.type === "agent_settled") { off(); resolve(); } }); });
const keepAlive = setInterval(() => {}, 1000);
writeFileSync(`${manifest}.ready`, VERSION);
await settled;
writeFileSync(`${manifest}.settled`, "native agent_settled");
await wait(`${manifest}.exit`);
await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
bridge?.dispose(); session.dispose(); clearInterval(keepAlive);
