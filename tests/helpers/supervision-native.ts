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

export { VERSION, fauxAssistantMessage, fauxToolCall };

export interface ToolEnd { name: string; isError: boolean; text: string; details?: any }
export interface Lead {
  sessionId(): string;
  sessionFile(): string | undefined;
  active(): string[];
  registered(): string[];
  errors: string[];
  shutdowns: string[];
  command(text: string): Promise<void>;
  /** The faux model issues one `peer` call (default `{action:"list"}`), then answers. */
  callPeer(args?: Record<string, unknown>): Promise<ToolEnd | undefined>;
  /** The faux model issues these calls in one assistant message (one turn), then answers; every tool end, in order. */
  callTools(calls: { name: string; args?: Record<string, unknown> }[]): Promise<ToolEnd[]>;
  /** One user prompt answered by the given faux steps (default: one text reply). */
  prompt(text: string, responses?: unknown[]): Promise<void>;
  /** Queues faux steps for a model call this lead makes without a prompt (compaction). */
  respond(responses: unknown[]): void;
  /** The faux model's call count: a wake would raise it. */
  calls(): number;
  /** The live AgentSession, for native tree navigation, compaction and in-memory entries. */
  session(): any;
  reload(): Promise<void>;
  newSession(): Promise<void>;
  resume(path: string): Promise<void>;
  /** Forks before a user message (default: the first), as /fork does; `at` keeps `entryId` itself as the fork's leaf. */
  fork(entryId?: string, position?: "before" | "at"): Promise<void>;
  quit(): Promise<void>;
}

const textOf = (result: any) => (result?.content ?? []).map((p: any) => p.text ?? "").join("");

export async function openLead(root: string, label: string, opts: { session?: "memory" | string; tools?: string[]; extra?: (pi: any) => void; before?: (pi: any) => void; keepRecentTokens?: number } = {}): Promise<Lead> {
  const cwd = join(root, label), agentDir = join(cwd, "agent"), sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const errors: string[] = [], shutdowns: string[] = [];
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, ...(opts.keepRecentTokens ? { keepRecentTokens: opts.keepRecentTokens } : {}) }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => { pi.on("session_shutdown", (e: { reason: string }) => void shutdowns.push(e.reason)); }, ...(opts.before ? [opts.before] : []), conductor, ...(opts.extra ? [opts.extra] : [])] });
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
    callPeer: async (args = { action: "list" }) => {
      const ends: ToolEnd[] = [];
      const unsubscribe = s().subscribe((e: any) => {
        if (e.type === "tool_execution_end" && e.toolName === "peer") ends.push({ name: e.toolName, isError: e.isError, text: textOf(e.result), details: e.result?.details });
      });
      faux.setResponses([fauxAssistantMessage([fauxToolCall("peer", args, { id: `s1-peer-${Date.now()}` })], { stopReason: "toolUse" }), fauxAssistantMessage("S1 listed peers.")]);
      try { await s().prompt("S1 list the other leads"); } finally { unsubscribe(); }
      return ends[0];
    },
    callTools: async calls => {
      const ends: ToolEnd[] = [];
      const unsubscribe = s().subscribe((e: any) => {
        if (e.type === "tool_execution_end") ends.push({ name: e.toolName, isError: e.isError, text: textOf(e.result), details: e.result?.details });
      });
      faux.setResponses([fauxAssistantMessage(calls.map((c, i) => fauxToolCall(c.name, c.args ?? {}, { id: `s3-${i}-${c.name}-${Date.now()}` })), { stopReason: "toolUse" }), fauxAssistantMessage("S3 done.")]);
      try { await s().prompt("S3 call the tools"); } finally { unsubscribe(); }
      return ends;
    },
    prompt: async (text, responses) => { faux.setResponses((responses ?? [fauxAssistantMessage("ok")]) as never); await s().prompt(text); },
    respond: responses => faux.setResponses(responses as never),
    calls: () => faux.state.callCount,
    session: () => s(),
    reload: async () => { await s().reload(); },
    newSession: async () => { await runtime.newSession(); },
    resume: async path => { await runtime.switchSession(path); },
    fork: async (entryId, position) => {
      const first = entryId ?? s().sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.role === "user")?.id;
      if (!first) throw new Error("fork needs a user message");
      await runtime.fork(first, position ? { position } : undefined);
    },
    quit: async () => { await runtime.dispose(); },
  };
}
