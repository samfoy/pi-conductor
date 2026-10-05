/**
 * `peer` tool: S1 `list`, S2 `message`. A message queues to one other live
 * lead by exact full session id and never wakes it; `chief` and `staff` land
 * with their behaviour in S3/S4, never as inactive stubs (R3).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileEvidence } from "../file-evidence.ts";
import type { RunRegistry } from "../runs.ts";
import { admitCoordination, buildCoordination, PEER_EVIDENCE_LIMIT } from "./inbox.ts";
import type { LeadPresence } from "./presence.ts";
import { leadLiveness, leadPath, readLeadRecord, scanLeads, type LeadRecord, type LeadScan } from "./store.ts";

export const PEER_TOOL = "peer";
export const PEER_LIST_MAX_BYTES = 16384;

export interface PeerEntry { lead: string; name: string; cwd: string; repo: string; branch: string; workspace_label: string; state: "live" | "unknown" }
export interface PeerListing { self: string; peers: PeerEntry[]; truncated?: true }
export interface PeerQueued { status: "queued"; id: string; lead: string; createdAt: number }

/** Self excluded; exact full ids; serialized output at most 16 KiB. Every field but `lead` is self-reported presentation. */
export function peerListing(self: Pick<LeadRecord, "sessionId">, scan: LeadScan): PeerListing {
  const peers = scan.leads.filter(l => l.record.sessionId !== self.sessionId)
    .sort((a, b) => a.record.sessionId < b.record.sessionId ? -1 : a.record.sessionId > b.record.sessionId ? 1 : 0)
    .map(({ record, state }): PeerEntry => ({ lead: record.sessionId, name: record.displayName, cwd: record.cwd, repo: record.repo ?? "",
      // No herdr CLI call, so no workspace label is known; the field keeps the reference shape.
      branch: record.branch ?? "", workspace_label: "", state }));
  const listing: PeerListing = { self: self.sessionId, peers: [] };
  // Room for `,"truncated":true` is reserved so the bound holds either way.
  let bytes = Buffer.byteLength(JSON.stringify(listing)) + 18;
  for (const peer of peers) {
    const size = Buffer.byteLength(JSON.stringify(peer)) + 1;
    if (bytes + size > PEER_LIST_MAX_BYTES) { listing.truncated = true; break; }
    listing.peers.push(peer);
    bytes += size;
  }
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
