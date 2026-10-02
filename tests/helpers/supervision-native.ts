// Bundled only into a private harness whose Pi imports alias one explicit installed root.
// Each lead is a real AgentSessionRuntime loading the real conductor factory with an
// offline faux model, so session_start/session_shutdown come from Pi itself.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  VERSION, createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import conductor from "../../src/index.ts";

export { VERSION };

export interface ToolEnd { name: string; isError: boolean; text: string; details?: any }
export interface Lead {
  sessionId(): string;
  sessionFile(): string | undefined;
  active(): string[];
  registered(): string[];
  errors: string[];
  shutdowns: string[];
  command(text: string): Promise<void>;
  /** The faux model issues `peer {action:"list"}` once, then answers. */
  callPeer(): Promise<ToolEnd | undefined>;
  reload(): Promise<void>;
  newSession(): Promise<void>;
  resume(path: string): Promise<void>;
  fork(): Promise<void>;
  quit(): Promise<void>;
}

const textOf = (result: any) => (result?.content ?? []).map((p: any) => p.text ?? "").join("");

export async function openLead(root: string, label: string, opts: { session?: "memory" | string; tools?: string[] } = {}): Promise<Lead> {
  const cwd = join(root, label), agentDir = join(cwd, "agent"), sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const errors: string[] = [], shutdowns: string[] = [];
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => { pi.on("session_shutdown", (e: { reason: string }) => void shutdowns.push(e.reason)); }, conductor] });
    await resourceLoader.reload();
    for (const e of resourceLoader.getExtensions().errors) errors.push(e.error);
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager, sessionStartEvent, tools: opts.tools });
    return { session, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }, diagnostics: [] };
  };
  const sessionManager = opts.session === "memory" ? SessionManager.inMemory(cwd) : opts.session ? SessionManager.open(opts.session, sessionDir) : SessionManager.create(cwd, sessionDir);
  const runtime = await createAgentSessionRuntime(createRuntime as never, { cwd, agentDir, sessionManager });
  const bindings = { mode: "tui" as const, onError: (e: any) => void errors.push(String(e?.error ?? e)), shutdownHandler: () => {} };
  runtime.setRebindSession(async session => { await session.bindExtensions(bindings); });
  await runtime.session.bindExtensions(bindings);
  const s = () => runtime.session;
  return {
    sessionId: () => s().sessionManager.getSessionId(),
    sessionFile: () => s().sessionManager.getSessionFile(),
    active: () => s().getActiveToolNames(),
    registered: () => s().getAllTools().map(t => t.name),
    errors, shutdowns,
    command: async text => { await s().prompt(text); },
    callPeer: async () => {
      const ends: ToolEnd[] = [];
      const unsubscribe = s().subscribe((e: any) => {
        if (e.type === "tool_execution_end" && e.toolName === "peer") ends.push({ name: e.toolName, isError: e.isError, text: textOf(e.result), details: e.result?.details });
      });
      faux.setResponses([fauxAssistantMessage([fauxToolCall("peer", { action: "list" }, { id: `s1-peer-${Date.now()}` })], { stopReason: "toolUse" }), fauxAssistantMessage("S1 listed peers.")]);
      try { await s().prompt("S1 list the other leads"); } finally { unsubscribe(); }
      return ends[0];
    },
    reload: async () => { await s().reload(); },
    newSession: async () => { await runtime.newSession(); },
    resume: async path => { await runtime.switchSession(path); },
    fork: async () => {
      const first = s().sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.role === "user");
      if (!first) throw new Error("fork needs a user message");
      await runtime.fork(first.id);
    },
    quit: async () => { await runtime.dispose(); },
  };
}
