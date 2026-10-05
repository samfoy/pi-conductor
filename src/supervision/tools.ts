/**
 * `peer` tool: S1 `list`, S2 `message`. A message queues to one other live
 * lead by exact full session id and never wakes it. S3 `staff list` (chief
 * only). S4 `staff transcript/message/reply` (chief only) and `chief
 * message/ask` (every other lead on the socket); each queues through the S2
 * inbox and reports queued, never delivered or processed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isSoleToolCall } from "../ask-owner.ts";
import { appendFileEvidence } from "../file-evidence.ts";
import type { RunRegistry } from "../runs.ts";
import { ASK_QUESTION_MAX, CHIEF_TOOL, type LeadAsks } from "./ask.ts";
import { admitCoordination, buildCoordination, PEER_EVIDENCE_LIMIT, type CoordinationKind } from "./inbox.ts";
import { liveChief, sameClaim, STAFF_TOOL, type ChiefClaim, type ChiefRole } from "./lease.ts";
import type { LeadPresence } from "./presence.ts";
import { leadLiveness, leadPath, readLeadRecord, sameLeadIdentity, scanLeads, type LeadPendingAsk, type LeadRecord, type LeadScan } from "./store.ts";
import { readLeadTranscript, renderLeadTranscript } from "./transcript.ts";

export const PEER_TOOL = "peer";
export const PEER_LIST_MAX_BYTES = 16384;

export interface PeerEntry { lead: string; name: string; cwd: string; repo: string; branch: string; workspace_label: string; state: "live" | "unknown" }
export interface PeerListing { self: string; peers: PeerEntry[]; truncated?: true }
export interface PeerQueued { status: "queued"; id: string; lead: string; createdAt: number }

const byExactId = (a: { record: LeadRecord }, b: { record: LeadRecord }) => a.record.sessionId < b.record.sessionId ? -1 : a.record.sessionId > b.record.sessionId ? 1 : 0;

/** Pushes items in order while `listing` still serializes within `max` bytes; room for `,"truncated":true` is reserved. */
function fill<T>(listing: { truncated?: true }, into: T[], items: readonly T[], max: number): void {
  let bytes = Buffer.byteLength(JSON.stringify(listing)) + 18;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > max) { listing.truncated = true; return; }
    into.push(item);
    bytes += size;
  }
}

/** Self excluded; exact full ids; serialized output at most 16 KiB. Every field but `lead` is self-reported presentation. */
export function peerListing(self: Pick<LeadRecord, "sessionId">, scan: LeadScan): PeerListing {
  const peers = scan.leads.filter(l => l.record.sessionId !== self.sessionId).sort(byExactId)
    .map(({ record, state }): PeerEntry => ({ lead: record.sessionId, name: record.displayName, cwd: record.cwd, repo: record.repo ?? "",
      // No herdr CLI call, so no workspace label is known; the field keeps the reference shape.
      branch: record.branch ?? "", workspace_label: "", state }));
  const listing: PeerListing = { self: self.sessionId, peers: [] };
  fill(listing, listing.peers, peers, PEER_LIST_MAX_BYTES);
  return listing;
}

export const STAFF_LIST_MAX_BYTES = 16384;
export interface StaffEntry {
  lead: string; name: string; cwd: string; repo: string; branch: string; state: "live" | "unknown";
  runs: { active: number; blocked: number; total: number };
  /** S4: the lead's self-reported outstanding ask (presentation; its branch decides a reply). */
  pending_ask?: LeadPendingAsk;
  /** Advisory: what this chief can do with that lead today; each action revalidates. */
  available_actions: string[];
}
export interface StaffListing { self: string; generation: number; leads: StaffEntry[]; truncated?: true }

/** Leads on the claim's exact socket string (never a prefix), self excluded, exact full ids, at most 16 KiB. Presentation only. */
export function staffListing(claim: Pick<ChiefClaim, "sessionId" | "socketPath" | "generation">, scan: LeadScan): StaffListing {
  const leads = scan.leads.filter(l => l.record.socketPath === claim.socketPath && l.record.sessionId !== claim.sessionId).sort(byExactId)
    .map(({ record, state }): StaffEntry => ({ lead: record.sessionId, name: record.displayName, cwd: record.cwd, repo: record.repo ?? "", branch: record.branch ?? "",
      state, runs: { ...record.runs }, ...(record.pendingAsk ? { pending_ask: { ...record.pendingAsk } } : {}),
      available_actions: state !== "live" ? [] : ["staff transcript", "staff message", ...(record.pendingAsk ? ["staff reply"] : [])] }));
  const listing: StaffListing = { self: claim.sessionId, generation: claim.generation, leads: [] };
  fill(listing, listing.leads, leads, STAFF_LIST_MAX_BYTES);
  return listing;
}

/** Asserted before the scan and again before anything is returned: a lease lost meanwhile never yields a listing. */
export function staffList(presence: Pick<LeadPresence, "livenessOptions">, chief: Pick<ChiefRole, "assert">): StaffListing {
  const claim = chief.assert();
  const listing = staffListing(claim, scanLeads(presence.livenessOptions()));
  chief.assert(claim);
  return listing;
}

/**
 * Exact-id lookup of a live peer, then A5 evidence, then a create-only queued
 * record whose fence rechecks this lead's own presence and the target's
 * liveness. Queued is not delivered: the recipient adds it at its next turn
 * boundary without waking, at most once.
 */
export function queuePeerMessage(presence: Pick<LeadPresence, "assertOwned" | "livenessOptions">, params: { lead?: unknown; message?: unknown; files?: readonly string[] },
  deps: { registry: RunRegistry; cwd: string; now?: () => number }): PeerQueued {
  const self = presence.assertOwned();
  const lead = params.lead;
  if (typeof lead !== "string" || !lead) throw new Error("peer message needs `lead`: an exact full session id from peer list");
  if (lead === self.sessionId) throw new Error("peer message: a lead cannot message itself (self)");
  if (typeof params.message !== "string") throw new Error("peer message needs `message` text");
  const live = () => {
    const target = readLeadRecord(leadPath(lead));
    return target?.sessionId === lead && leadLiveness(target, presence.livenessOptions()) === "live";
  };
  // Labels, names and prefixes never match: only the exact id's own record, from the bounded scan.
  if (!scanLeads(presence.livenessOptions()).leads.some(l => l.record.sessionId === lead && l.state === "live") || !live()) {
    throw new Error(`peer message: no live lead has the exact session id ${JSON.stringify(lead)}; use a full id from peer list`);
  }
  const text = appendFileEvidence(params.message, params.files, { cwd: deps.cwd, registry: deps.registry, limit: PEER_EVIDENCE_LIMIT });
  const record = buildCoordination({ from: self.sessionId, fromName: self.displayName, to: lead, text, createdAt: (deps.now ?? Date.now)() });
  admitCoordination(record, () => {
    if (presence.assertOwned().generation !== self.generation) throw new Error("peer unavailable: this lead's presence changed");
    if (!live()) throw new Error(`peer message: lead ${lead} is no longer live; not queued`);
  });
  return { status: "queued", id: record.id, lead, createdAt: record.createdAt };
}

export function registerPeerTool(pi: ExtensionAPI, presence: LeadPresence, deps: { getRegistry: () => RunRegistry; getCwd: () => string }): void {
  pi.registerTool({
    name: PEER_TOOL,
    label: "Peer leads",
    description:
      "List the other conductor leads on this host (any herdr socket), or queue one non-waking message to one of them. " +
      "Each peer's `lead` is its exact full pi session id; name, cwd, repo, branch, workspace_label and state are self-reported presentation and grant nothing. " +
      "`message` needs that exact id (never a name or prefix). It reports queued, not delivered: the recipient sees it as untrusted context at its next turn boundary, " +
      "without waking, at most once, and you get no confirmation. It cannot inspect or control another lead or its runs.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("message")], { description: "list: the other live (or unproven) leads; message: queue text for one live lead" }),
      lead: Type.Optional(Type.String({ description: "message: the exact full session id from peer list" })),
      message: Type.Optional(Type.String({ description: "message: the text; with files at most 8 KiB serialized and after escaping, never truncated" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "message: evidence paths or exact run:<agent_id> results, embedded up to 1 KiB each (4 KiB total), larger ones as references; no capability grants" })),
    }),
    async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: PeerListing | PeerQueued }> {
      if (params.action === "message") {
        const queued = queuePeerMessage(presence, params, { registry: deps.getRegistry(), cwd: deps.getCwd() });
        return { content: [{ type: "text" as const, text: `Queued peer message ${queued.id} for ${queued.lead}. Queued is not delivered: the recipient adds it to its context at its next turn boundary without waking, at most once, and sends no confirmation.` }], details: queued };
      }
      const self = presence.assertOwned();
      const listing = peerListing(self, scanLeads(presence.livenessOptions()));
      return { content: [{ type: "text" as const, text: JSON.stringify(listing) }], details: listing };
    },
  });
  presence.ownTool(PEER_TOOL);
}

// ── S4: staff transcript/message/reply (chief) ─────────────────────────────

type Presence = Pick<LeadPresence, "assertOwned" | "livenessOptions">;
export interface StaffQueued { status: "queued"; action: "message" | "reply"; id: string; lead: string; generation: number; askId?: string; createdAt: number }
export interface StaffTranscript { lead: string; generation: number; transcript: string; bytesRead: number; omittedBefore: boolean }

/** The exact full id's own record: a live lead on the claim's exact socket that is not the chief itself. */
function staffTarget(presence: Presence, claim: ChiefClaim, lead: unknown): LeadRecord {
  if (typeof lead !== "string" || !lead) throw new Error("staff needs `lead`: an exact full session id from staff list");
  if (lead === claim.sessionId) throw new Error("staff: the chief cannot target itself (self)");
  let record: LeadRecord | undefined;
  try { record = readLeadRecord(leadPath(lead)); } catch (e) { throw new Error(`staff: lead ${JSON.stringify(lead)}: ${(e as Error).message}`); }
  if (!record || record.sessionId !== lead || record.socketPath !== claim.socketPath || leadLiveness(record, presence.livenessOptions()) !== "live") {
    throw new Error(`staff: no live lead on this herdr socket has the exact session id ${JSON.stringify(lead)}; use a full id from staff list`);
  }
  return record;
}

/** Lease and own presence (assert), then the same target identity and liveness: run before returning or publishing anything. */
function staffFence(presence: Presence, chief: Pick<ChiefRole, "assert">, claim: ChiefClaim, target: LeadRecord): void {
  chief.assert(claim);
  const again = staffTarget(presence, claim, target.sessionId);
  if (!sameLeadIdentity(again, target)) throw new Error(`staff: lead ${target.sessionId} changed (a new presence generation) meanwhile; nothing done`);
}

/** One bounded persisted tail of the target's own session file (header id checked first), escaped and untrusted. */
export function staffTranscript(presence: Presence, chief: Pick<ChiefRole, "assert">, params: { lead?: unknown }): StaffTranscript {
  const claim = chief.assert();
  const target = staffTarget(presence, claim, params.lead);
  const tail = readLeadTranscript(target.sessionFile, target.sessionId);
  staffFence(presence, chief, claim, target);
  return { lead: target.sessionId, generation: claim.generation, transcript: renderLeadTranscript(target.sessionId, claim.generation, tail), bytesRead: tail.bytesRead, omittedBefore: tail.omittedBefore };
}

/**
 * `chief_message` or `chief_reply` to one live lead on this socket, carrying
 * this chief's exact claim. A reply first needs the target's presentation to
 * show `ask_id` pending; the target's branch still decides whether it is accepted.
 */
export function queueStaffMessage(presence: Presence, chief: Pick<ChiefRole, "assert">, params: { lead?: unknown; message?: unknown; ask_id?: unknown; files?: readonly string[] },
  kind: "chief_message" | "chief_reply", deps: { registry: RunRegistry; cwd: string; now?: () => number }): StaffQueued {
  const claim = chief.assert();
  const target = staffTarget(presence, claim, params.lead);
  if (typeof params.message !== "string" || !params.message.trim()) throw new Error(`staff ${kind === "chief_reply" ? "reply" : "message"} needs \`message\` text`);
  let askId: string | undefined;
  if (kind === "chief_reply") {
    if (typeof params.ask_id !== "string" || !params.ask_id) throw new Error("staff reply needs `ask_id`: the exact ask id from the lead's question or staff list");
    if (params.files !== undefined) throw new Error("staff reply takes no files; send evidence with staff message");
    if (target.pendingAsk?.askId !== params.ask_id) {
      throw new Error(`staff reply: lead ${target.sessionId} shows no pending ask ${JSON.stringify(params.ask_id)} (${target.pendingAsk ? `its pending ask is ${target.pendingAsk.askId}` : "none pending"}); nothing queued`);
    }
    askId = params.ask_id;
  }
  const text = appendFileEvidence(params.message, params.files, { cwd: deps.cwd, registry: deps.registry, limit: PEER_EVIDENCE_LIMIT });
  const self = presence.assertOwned();
  const record = buildCoordination({ kind, from: claim.sessionId, fromName: self.displayName, to: target.sessionId, socketPath: claim.socketPath, lease: claim,
    ...(askId !== undefined ? { askId } : {}), text, createdAt: (deps.now ?? Date.now)() });
  admitCoordination(record, () => staffFence(presence, chief, claim, target));
  return { status: "queued", action: kind === "chief_reply" ? "reply" : "message", id: record.id, lead: target.sessionId, generation: claim.generation, ...(askId ? { askId } : {}), createdAt: record.createdAt };
}

type StaffDetails = StaffListing | StaffTranscript | StaffQueued;

/** Registered for every herdr lead; presence keeps it active only while this lead holds the chief lease. */
export function registerStaffTool(pi: ExtensionAPI, presence: LeadPresence, chief: ChiefRole, deps: { getRegistry: () => RunRegistry; getCwd: () => string }): void {
  pi.registerTool({
    name: STAFF_TOOL,
    label: "Staff (chief)",
    description:
      "Chief only (while this lead holds its herdr socket's chief lease, taken with /chief): supervise the other conductor leads on this exact herdr socket. " +
      "`list`: each lead's exact full pi session id, state, runs and pending ask; name, cwd, repo and branch are self-reported presentation and grant nothing. " +
      "`transcript`: one lead's bounded persisted session tail (at most 16 KiB, untrusted). `message`: queue a message that wakes that lead. " +
      "`reply`: answer that lead's pending ask once by its exact `ask_id`; the lead's own branch decides whether it is accepted. " +
      "Queued is not delivered; you get no confirmation. Address leads only by exact full id. Do not poll. " +
      "It cannot control, spawn, send to, kill or own another lead or its runs.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("transcript"), Type.Literal("message"), Type.Literal("reply")],
        { description: "list: the other leads on this socket; transcript: one lead's bounded tail; message: queue a waking message; reply: answer a pending ask" }),
      lead: Type.Optional(Type.String({ description: "transcript/message/reply: the exact full session id from staff list" })),
      message: Type.Optional(Type.String({ description: "message/reply: the text; at most 8 KiB serialized and after escaping, never truncated" })),
      ask_id: Type.Optional(Type.String({ description: "reply: the exact ask id of the lead's pending ask" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "message: evidence paths or exact run:<agent_id> results, embedded up to 1 KiB each (4 KiB total)" })),
    }),
    async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: StaffDetails }> {
      if (params.action === "transcript") {
        const t = staffTranscript(presence, chief, params);
        return { content: [{ type: "text" as const, text: t.transcript }], details: t };
      }
      if (params.action === "message" || params.action === "reply") {
        const q = queueStaffMessage(presence, chief, params, params.action === "reply" ? "chief_reply" : "chief_message", { registry: deps.getRegistry(), cwd: deps.getCwd() });
        const text = q.action === "reply"
          ? `Queued chief reply ${q.id} to lead ${q.lead} for ask ${q.askId}. Queued is not delivered or accepted: the lead's current branch decides, and a reply that no longer answers its outstanding ask is rejected there. You get no confirmation.`
          : `Queued chief message ${q.id} for lead ${q.lead}. Queued is not delivered: it wakes that lead only while you still hold lease generation ${q.generation}, at most once, with no confirmation.`;
        return { content: [{ type: "text" as const, text }], details: q };
      }
      const listing = staffList(presence, chief);
      return { content: [{ type: "text" as const, text: JSON.stringify(listing) }], details: listing };
    },
  });
  presence.ownTool(STAFF_TOOL, () => chief.holds());
}

// ── S4: chief message/ask (every other lead on the socket) ───────────────

export interface ChiefQueued { status: "queued"; action: "message" | "ask"; id: string; chief: string; leaseGeneration: number; askId?: string; question?: string; askedAt?: number }
export interface ChiefCall { id: string; branch: readonly unknown[]; hasPendingMessages: boolean; aborted?: boolean }

/**
 * Queues `lead_message` or `lead_ask` for the live chief of this lead's exact
 * socket, never itself. Everything is checked before any write; the fence
 * re-proves this lead's presence and the exact captured claim at publication.
 * An ask must be the sole call with nothing queued; it is staged until Pi
 * records its result on the branch, which alone makes it outstanding.
 */
export function queueToChief(presence: Presence, chief: Pick<ChiefRole, "holds">, params: { action?: unknown; message?: unknown; question?: unknown; files?: readonly string[] },
  deps: { registry: RunRegistry; cwd: string; now?: () => number; asks?: Pick<LeadAsks, "stage" | "unstage">; call?: ChiefCall }): ChiefQueued {
  const self = presence.assertOwned();
  if (chief.holds()) throw new Error("chief unavailable: this lead is the chief of its herdr socket (use staff); nothing queued");
  const holder = liveChief(self.socketPath, presence.livenessOptions());
  if (!holder) throw new Error("chief unavailable: no live chief holds this herdr socket's lease; nothing queued");
  if (holder.sessionId === self.sessionId) throw new Error("chief unavailable: the lease names this lead itself (self); nothing queued");
  const ask = params.action === "ask";
  let body: string, question: string | undefined;
  if (ask) {
    const call = deps.call;
    if (!call || call.aborted) throw new Error("chief ask requires an active model turn");
    if (typeof params.question !== "string" || !params.question.trim()) throw new Error("chief ask needs `question` text");
    question = params.question.trim();
    if (Array.from(question).length > ASK_QUESTION_MAX || Buffer.byteLength(question) > ASK_QUESTION_MAX) throw new Error(`chief ask: the question exceeds ${ASK_QUESTION_MAX} characters or UTF-8 bytes; nothing queued`);
    if (call.hasPendingMessages) throw new Error("Cannot ask with queued messages; process them first");
    if (!isSoleToolCall(call.branch, CHIEF_TOOL, call.id)) throw new Error("Call chief ask alone as the only tool call in the assistant turn");
    body = question;
  } else {
    if (typeof params.message !== "string" || !params.message.trim()) throw new Error("chief message needs `message` text");
    body = params.message;
  }
  const text = appendFileEvidence(body, params.files, { cwd: deps.cwd, registry: deps.registry, limit: PEER_EVIDENCE_LIMIT });
  const kind: CoordinationKind = ask ? "lead_ask" : "lead_message";
  const record = buildCoordination({ kind, from: self.sessionId, fromName: self.displayName, to: holder.sessionId, socketPath: self.socketPath, lease: holder,
    ...(ask ? { askId: deps.call!.id } : {}), text, createdAt: (deps.now ?? Date.now)() });
  const fence = () => {
    if (presence.assertOwned().generation !== self.generation) throw new Error("chief unavailable: this lead's presence changed; nothing queued");
    if (chief.holds()) throw new Error("chief unavailable: this lead became the chief; nothing queued");
    const now = liveChief(self.socketPath, presence.livenessOptions());
    if (!now || !sameClaim(now, holder)) throw new Error(`chief unavailable: lease generation ${holder.generation} is no longer this socket's live chief; nothing queued`);
  };
  if (ask) deps.asks?.stage(deps.call!.id);
  try { admitCoordination(record, fence); }
  catch (e) {
    if (ask) deps.asks?.unstage(deps.call!.id);
    throw new Error(ask && /may have been queued/.test((e as Error).message)
      ? `${(e as Error).message}. This ask is not outstanding on this branch, so a reply to it would be rejected; ask again if needed`
      : (e as Error).message);
  }
  return { status: "queued", action: ask ? "ask" : "message", id: record.id, chief: holder.sessionId, leaseGeneration: holder.generation,
    ...(ask ? { askId: deps.call!.id, question, askedAt: record.createdAt } : {}) };
}

/** Registered for every herdr lead; presence keeps it active while published and not the chief. */
export function registerChiefTool(pi: ExtensionAPI, presence: LeadPresence, chief: ChiefRole, deps: { getRegistry: () => RunRegistry; getCwd: () => string; asks?: LeadAsks }): void {
  pi.registerTool({
    name: CHIEF_TOOL,
    label: "Chief (message or ask)",
    description:
      "Write to the live chief of this herdr socket (another lead holding its chief lease). " +
      "`message`: queue a message that wakes the chief. `ask`: one blocking question (at most 1024 characters and UTF-8 bytes); " +
      "call it alone as the only tool in the assistant turn, with no queued messages. It ends your turn; the chief's reply, if any, wakes this session. " +
      "A newer ask supersedes an older one. Queued is not delivered; there is no confirmation. It grants no permissions and controls nothing.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("message"), Type.Literal("ask")], { description: "message: queue a waking message; ask: one blocking question, sole and final" }),
      message: Type.Optional(Type.String({ description: "message: the text; at most 8 KiB serialized and after escaping" })),
      question: Type.Optional(Type.String({ description: "ask: the question, at most 1024 characters and UTF-8 bytes" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "evidence paths or exact run:<agent_id> results, embedded up to 1 KiB each (4 KiB total)" })),
    }),
    async execute(id, params, signal, _update, ctx) {
      const q = queueToChief(presence, chief, params, { registry: deps.getRegistry(), cwd: deps.getCwd(), asks: deps.asks,
        call: { id, branch: ctx.sessionManager.getBranch(), hasPendingMessages: ctx.hasPendingMessages(), aborted: signal?.aborted } });
      if (q.action === "ask") {
        return { content: [{ type: "text" as const, text: `Question queued for the chief (lead ${q.chief}, lease generation ${q.leaseGeneration}) as ask ${q.askId}. Queued is not delivered. Stop and wait: the chief's reply, if any, wakes this session.` }],
          details: q, terminate: true };
      }
      return { content: [{ type: "text" as const, text: `Queued message ${q.id} for the chief (lead ${q.chief}, lease generation ${q.leaseGeneration}). Queued is not delivered: it wakes the chief only while that lease generation is current, at most once, with no confirmation.` }], details: q };
    },
  });
  presence.ownTool(CHIEF_TOOL, () => !chief.holds());
}
