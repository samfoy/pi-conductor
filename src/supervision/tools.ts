/**
 * S1 `peer` tool: `list` only. S2 adds `message`; `chief` and `staff` land
 * with their behaviour in S3/S4, never as inactive stubs (R3).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { LeadPresence } from "./presence.ts";
import { scanLeads, type LeadRecord, type LeadScan } from "./store.ts";

export const PEER_TOOL = "peer";
export const PEER_LIST_MAX_BYTES = 16384;

export interface PeerEntry { lead: string; name: string; cwd: string; repo: string; branch: string; workspace_label: string; state: "live" | "unknown" }
export interface PeerListing { self: string; peers: PeerEntry[]; truncated?: true }

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

export function registerPeerTool(pi: ExtensionAPI, presence: LeadPresence): void {
  pi.registerTool({
    name: PEER_TOOL,
    label: "Peer leads",
    description:
      "List the other conductor leads on this host (any herdr socket). Read-only: it cannot message, inspect or control another lead or its runs. " +
      "Each peer's `lead` is its exact full pi session id; name, cwd, repo, branch, workspace_label and state are self-reported presentation and grant nothing.",
    parameters: Type.Object({ action: Type.Literal("list", { description: "list: the other live (or unproven) leads" }) }),
    async execute() {
      const self = presence.assertOwned();
      const listing = peerListing(self, scanLeads(presence.livenessOptions()));
      return { content: [{ type: "text" as const, text: JSON.stringify(listing) }], details: listing };
    },
  });
  presence.ownTool(PEER_TOOL);
}
