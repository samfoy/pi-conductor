// N5 native pane child, one process per fake-herdr `agent start` manifest, bundled
// against one explicit installed Pi root. It runs a real interactive-mode Pi session
// with the real conductor child tools and H4 bridge, built from the exact pane env and
// argv the lead gave herdr, on an offline faux model. Its role comes from that env.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, parseArgs, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";

type Message = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };
const text = (m: Message | undefined): string => !m ? "" : typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.map(p => (p as { type?: string; text?: string }).type === "text" ? (p as { text: string }).text : "").join("") : "";

const manifestPath = process.argv[2]!;
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
if (VERSION !== process.env.N5_NATIVE_VERSION) throw new Error(`unapproved native Pi ${VERSION}`);
const b = JSON.parse(readFileSync(join(m.runDir, "record.json"), "utf8")).herdr;
// What herdr gives the pane: the conductor-set pane env plus herdr's own routing names.
const env: NodeJS.ProcessEnv = { ...m.paneEnv, HERDR_ENV: "1", HERDR_SOCKET_PATH: m.socketPath, HERDR_PANE_ID: m.paneId, HERDR_TAB_ID: b.tabId, HERDR_WORKSPACE_ID: b.workspaceId };
const depth = env.CONDUCTOR_DEPTH;
const argv = parseArgs(m.argv);
const agentDir = join(m.runDir, "native-agent");
const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 65536, maxTokens: 1024 }] });

function parent(messages: Message[]) {
  const results = messages.filter(r => r.role === "toolResult");
  if (results.length) return fauxAssistantMessage(`N5 native parent saw ${results.length} results:\n` + results.map(r => `${r.toolCallId}: ${r.isError ? "ERROR " : ""}${text(r)}`).join("\n---\n"));
  return fauxAssistantMessage([
    fauxToolCall("delegate", { persona: "scout", task: "N5-NATIVE-LEAF scout" }, { id: "n_scout" }),
    fauxToolCall("delegate", { persona: "auditor", task: "N5-NATIVE-LEAF auditor" }, { id: "n_auditor" }),
    fauxToolCall("delegate", { persona: "writer", task: "N5-NATIVE-LEAF writer must not run" }, { id: "n_denied" }),
    fauxToolCall("delegate", { persona: "scout" }, { id: "n_schema" }),
  ], { stopReason: "toolUse" });
}
function leaf(messages: Message[]) {
  const results = messages.filter(r => r.role === "toolResult");
  const task = text(messages.find(r => r.role === "user"));
  // A leaf has no delegate: Pi reports it unknown (start, then error end, no execution).
  if (!results.length) return fauxAssistantMessage([fauxToolCall("delegate", { persona: "scout", task: "grandchild" }, { id: "leaf_delegate" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(`N5 native leaf ${task.match(/N5-NATIVE-LEAF (\w+)/)?.[1]} done; saw=${results.map(r => text(r)).join("|")}`);
}
const next = async (context: { messages: Message[] }) => { faux.appendResponses([next]); return depth === "1" ? parent(context.messages) : leaf(context.messages); };
faux.setResponses([next]);

const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
const settingsManager = SettingsManager.inMemory(settings);
let bridge: ReturnType<typeof installChildBridge> | undefined;
const loader = new DefaultResourceLoader({ cwd: m.cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    pi.registerProvider(faux.provider as never); pi.registerFlag("conductor-launch", { type: "string" });
    bridge = installChildBridge(pi, { env });
    registerTools(pi, { getRegistry: () => new RunRegistry() } as never, env);
  }] });
await loader.reload();
loader.getExtensions().runtime.flagValues.set("conductor-launch", m.nonce);
const { session } = await createAgentSession({ cwd: m.cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader,
  sessionManager: SessionManager.open(b.sessionFile), tools: argv.tools, excludeTools: argv.excludeTools });
writeFileSync(`${manifestPath}.tools.json`, JSON.stringify({ version: VERSION, depth, active: session.getActiveToolNames(), registered: session.getAllTools().map(t => t.name) }));
let shutdown!: () => void;
const stopped = new Promise<void>(resolve => { shutdown = resolve; });
await session.bindExtensions({ mode: "tui", onError: (e: unknown) => process.stderr.write(`${JSON.stringify(e)}\n`), shutdownHandler: () => shutdown() });
const keepAlive = setInterval(() => {}, 1000);
writeFileSync(`${manifestPath}.ready`, String(process.pid));
await stopped; // the bridge requests shutdown once the accepted task settles
await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
bridge?.dispose(); session.dispose(); clearInterval(keepAlive);
process.exit(0);
