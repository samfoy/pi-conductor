// In-process S4 lead without a native Pi: real presence, chief role, asks,
// delivery and tools over a fake Pi whose sendMessage appends to an in-memory
// branch (and, while `persist`, to the session file, as Pi's own append would).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunRegistry } from "../../src/runs.ts";
import { LeadAsks } from "../../src/supervision/ask.ts";
import { CoordinationDelivery } from "../../src/supervision/delivery.ts";
import { ChiefRole } from "../../src/supervision/lease.ts";
import { LeadPresence } from "../../src/supervision/presence.ts";
import { registerChiefTool, registerPeerTool, registerStaffTool } from "../../src/supervision/tools.ts";
import type { makeFakeClock } from "./fake-clock.ts";

export const sessionHeader = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/" }) + "\n";
export interface Sent { message: any; options: any }

export function s4Lead(opts: { dir: string; socket: string; clock: ReturnType<typeof makeFakeClock>; label: string; liveness?: object; flushed?: boolean; registered?: string[] }) {
  const sessionId = `${opts.label}-${randomUUID()}`, sessionFile = join(opts.dir, `${sessionId}.jsonl`);
  if (opts.flushed !== false) writeFileSync(sessionFile, sessionHeader(sessionId));
  const registered = opts.registered ?? ["read", "peer", "staff", "chief"];
  const branch: any[] = [], sent: Sent[] = [], notes: string[] = [];
  const state = { idle: true, pending: false, persist: true, on: true };
  const tools = new Map<string, any>();
  let active = [...registered];
  const persist = (entry: unknown) => { if (state.persist && existsSync(sessionFile)) appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); };
  const api = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names.filter(n => registered.includes(n)); },
    getAllTools: () => registered.map(name => ({ name })),
    getSessionName: () => `${opts.label} lead`,
    appendEntry: (customType: string, data: unknown) => { const e = { type: "custom", customType, data }; branch.push(e); persist(e); },
    registerTool: (t: { name: string }) => void tools.set(t.name, t),
    sendMessage: (message: any, options: any) => {
      sent.push({ message, options });
      const e = { type: "custom_message", customType: message.customType, content: message.content, display: true, details: message.details };
      branch.push(e); persist(e);
    },
  };
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: opts.socket, HERDR_PANE_ID: `pane-${opts.label}` };
  const asks = new LeadAsks();
  const presence = new LeadPresence({ pi: api as never, env, registry: new RunRegistry(), getMode: () => state.on, now: opts.clock.deps.now, timers: opts.clock.deps as never,
    liveness: opts.liveness as never, describeRepo: () => ({ repo: opts.label, branch: "main" }), pendingAsk: () => asks.pending() });
  const chief = new ChiefRole({ pi: api as never, presence, timers: opts.clock.deps as never });
  const delivery = new CoordinationDelivery({ pi: api as never, presence, chief, asks, timers: opts.clock.deps as never, now: opts.clock.deps.now });
  const deps = { getRegistry: () => new RunRegistry(), getCwd: () => opts.dir };
  registerPeerTool(api as never, presence, deps);
  registerStaffTool(api as never, presence, chief, deps);
  registerChiefTool(api as never, presence, chief, { ...deps, asks });
  const notify = (m: string) => void notes.push(m);
  const ctx = { sessionManager: { getBranch: () => branch }, hasPendingMessages: () => state.pending };
  return {
    sessionId, sessionFile, branch, sent, notes, state, tools, presence, chief, asks, delivery, api,
    active: () => active,
    start() { asks.start({ getBranch: () => branch, sessionId, sessionFile }); presence.start({ sessionId, sessionFile, cwd: opts.dir }, notify); chief.start({ getBranch: () => branch }, notify); delivery.start({ isIdle: () => state.idle, hasPendingMessages: () => state.pending }, notify); },
    stop() { delivery.stop(); chief.stop(); presence.stop(); asks.stop(); },
    mode(on: boolean) { state.on = on; presence.refresh(); chief.refresh(); delivery.drain(); },
    record(entry: unknown) { branch.push(entry); persist(entry); },
    staff: (args: object, id = `staff-${randomUUID()}`) => tools.get("staff").execute(id, args),
    peer: (args: object) => tools.get("peer").execute(`peer-${randomUUID()}`, args),
    /** The model's assistant message (its tool calls), then the chief tool call; `land` records Pi's tool result on the branch. */
    async chiefCall(args: Record<string, unknown>, o: { id?: string; siblings?: unknown[]; land?: boolean } = {}) {
      const id = o.id ?? `call-${randomUUID()}`;
      this.record({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "chief", arguments: args }, ...(o.siblings ?? [])] } });
      const land = (result: any, isError: boolean) => this.record({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "chief", content: result?.content ?? [], details: result?.details ?? {}, isError } });
      try {
        const result = await tools.get("chief").execute(id, args, undefined, undefined, ctx);
        if (o.land !== false) land(result, false);
        return { id, result, land: () => land(result, false) };
      } catch (e) { if (o.land !== false) land(undefined, true); throw e; }
    },
  };
}
export type S4Lead = ReturnType<typeof s4Lead>;
