// S5 multiprocess lead: one real Pi lead per OS process. The real conductor
// factory loads in a real AgentSessionRuntime with an offline faux model
// (openLead); the test drives it over IPC. Hooks here only observe or hold on
// named gates the test releases: every coordination effect goes through the
// conductor's own tools, commands and Pi's own events. Bundled per Pi root.
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { fauxAssistantMessage, fauxToolCall, openLead, VERSION, type Lead } from "./supervision-native.ts";

type Call = { name: string; args?: Record<string, unknown>; id?: string };
type Spec = { text: string } | { calls: Call[] } | { gate: string; text: string };
interface Arms { settleBefore?: string; settleAfter?: { reload: true }; toolResult?: { tool: string; gate: string } }

const [root, label, config = "{}"] = process.argv.slice(2) as [string, string, string?];
const cfg = JSON.parse(config) as { session?: string; tools?: string[] };
const send = (m: unknown) => process.send!(m);
const NOTE_MAX = 8192;
const inputs: string[] = [], commands: string[] = [], notes: string[] = [];
const sends: { kind?: unknown; notice?: unknown; coordinationId?: unknown; deliverAs?: unknown; triggerTurn?: unknown; streaming: boolean }[] = [];
const arms: Arms = {};
let seq = 0;

// Observation only: every coordination card the conductor hands to Pi, with Pi's delivery options.
const proto = AgentSession.prototype as unknown as { sendCustomMessage: (this: { isStreaming: boolean }, m: any, o: any) => Promise<void> };
const original = proto.sendCustomMessage;
proto.sendCustomMessage = function (message, options) {
  if (message?.customType === "conductor-coordination") {
    const d = message.details ?? {};
    sends.push({ kind: d.kind, notice: d.notice, coordinationId: d.coordinationId, deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn, streaming: !!this.isStreaming });
  }
  return original.call(this, message, options);
};

const released = new Map<string, () => void>(), gates = new Map<string, Promise<void>>();
const gate = (name: string) => {
  if (!gates.has(name)) gates.set(name, new Promise<void>(resolve => released.set(name, resolve)));
  return gates.get(name)!;
};
const hold = async (name: string) => { send({ event: `hold:${name}` }); await gate(name); };

let uiPatched = false;
const before = (api: any) => {
  api.on("session_start", (_e: unknown, ctx: any) => {
    // Pi's headless UI context is one shared object: capture what the conductor notifies.
    if (uiPatched) return;
    uiPatched = true;
    ctx.ui.notify = (message: string, level: string) => void notes.push(`${level}: ${String(message).slice(0, NOTE_MAX)}`);
  });
  api.on("input", (e: { text?: unknown }) => void inputs.push(String(e.text)));
  api.registerCommand("s5probe", { description: "S5 probe", handler: async () => void commands.push("ran") });
  api.registerTool({ name: "mp_probe", label: "mp probe", description: "a foreign extension's tool", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }) });
  api.on("agent_settled", async () => { const g = arms.settleBefore; arms.settleBefore = undefined; if (g) await hold(g); });
  api.on("tool_result", async (e: { toolName?: unknown }) => {
    const a = arms.toolResult;
    if (!a || e.toolName !== a.tool) return;
    arms.toolResult = undefined;
    await hold(a.gate);
  });
};
const extra = (api: any) => {
  // After the conductor's own agent_settled drain, still inside agent_settled.
  api.on("agent_settled", async () => {
    const a = arms.settleAfter;
    arms.settleAfter = undefined;
    if (a?.reload) { await lead.session().reload(); send({ event: "reloaded" }); }
  });
};

const toFaux = (s: Spec): unknown => "calls" in s
  ? fauxAssistantMessage(s.calls.map((c, i) => fauxToolCall(c.name, c.args ?? {}, { id: c.id ?? `mp-${label}-${++seq}-${i}` })), { stopReason: "toolUse" })
  : "gate" in s ? async (_c: unknown, o?: { signal?: AbortSignal }) => {
      send({ event: `hold:${s.gate}` });
      await Promise.race([gate(s.gate), new Promise(r => o?.signal?.addEventListener("abort", r, { once: true }))]);
      return fauxAssistantMessage(s.text);
    }
  : fauxAssistantMessage(s.text);

const lead: Lead = await openLead(root, label, { ...(cfg.session ? { session: cfg.session } : {}), ...(cfg.tools ? { tools: cfg.tools } : {}), before, extra });

function info() {
  const s = lead.session();
  const staff = s.getAllTools().find((t: { name: string }) => t.name === "staff");
  return { pid: process.pid, version: VERSION, sessionId: lead.sessionId(), sessionFile: lead.sessionFile(), active: lead.active(), registered: lead.registered(),
    calls: lead.calls(), idle: !!s.isIdle, inputs, commands, notes: notes.slice(-50), sends, errors: lead.errors, shutdowns: lead.shutdowns,
    staffActions: staff?.parameters?.properties?.action?.anyOf?.map((x: { const?: unknown }) => x.const) };
}

const prompts = new Map<number, Promise<{ ok: boolean; error?: string }>>();
async function handle(m: any): Promise<unknown> {
  switch (m.op) {
    case "info": return info();
    case "prompt": await lead.prompt(m.text, m.responses?.map(toFaux)); return info();
    case "promptStart": {
      const h = ++seq;
      prompts.set(h, lead.prompt(m.text, m.responses?.map(toFaux)).then(() => ({ ok: true }), (e: Error) => ({ ok: false, error: String(e?.message ?? e) })));
      return h;
    }
    case "promptWait": return prompts.get(m.handle);
    // A user prompt typed during agent_settled: Pi defers it.
    case "userPrompt": await lead.session().prompt(m.text); return null;
    case "respond": lead.respond(m.responses.map(toFaux)); return null;
    case "command": { const from = notes.length; await lead.command(m.text); return notes.slice(from); }
    case "callTools": return lead.callTools(m.calls);
    case "arm": Object.assign(arms, m.arms); return null;
    case "release": gate(m.gate); released.get(m.gate)!(); return null;
    case "failWake": {
      // Injected: the deferred run for the next card of this kind fails before it starts (Pi then drops the later deferred prompts too).
      const session = lead.session(), run = session._runAgentPrompt;
      session._runAgentPrompt = function (message: any) {
        if (message?.details?.kind === m.kind) { session._runAgentPrompt = run; return Promise.reject(new Error("injected wake failure")); }
        return run.call(this, message);
      };
      return null;
    }
    // The SDK/RPC abort: no clearQueue(), so a card Pi queued behind the run stays queued.
    case "abort": await lead.session().abort(); return info();
    case "reload": await lead.reload(); return info();
    case "newSession": await lead.newSession(); return info();
    case "resume": await lead.resume(m.path); return info();
    case "quit": await lead.quit(); return null;
    default: throw new Error(`unknown op ${m.op}`);
  }
}

process.on("message", (m: any) => {
  handle(m).then(value => {
    send({ id: m.id, ok: true, value });
    if (m.op === "quit") setImmediate(() => process.exit(0));
  }, (e: Error) => send({ id: m.id, ok: false, error: String(e?.stack ?? e).slice(0, 4000) }));
});
send({ event: "ready", info: info() });
