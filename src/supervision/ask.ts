/**
 * S4 `chief ask` correlation. The asking lead's current session branch is the
 * only authority: the outstanding ask is the newest successful `chief ask`
 * tool result on the branch (a newer one supersedes it), until a `chief_reply`
 * card for that ask id follows it there AND that card is persisted in this
 * session's own file (Pi keeps a card in memory when its write fails). Inbox
 * record states are never receipts. No record, message or presence file can
 * create an ask.
 */
import { lstatSync } from "node:fs";
import { isRecord } from "../herdr/cli.ts";
import { scanPersistedReceipts } from "./delivery.ts";
import { COORDINATION_TYPE } from "./inbox.ts";
import { ASK_QUESTION_MAX } from "./store.ts";

export { ASK_QUESTION_MAX };
export const CHIEF_TOOL = "chief";

export interface PendingAsk { askId: string; question: string; askedAt: number; chief: string; leaseGeneration: number }
/** A reply card's identity on the branch: its coordination id and its own addressee (a fork's copied card names the parent). */
export interface ReplyRef { coordinationId: string; createdAt: number; to: string }

const boundedQuestion = (q: unknown): q is string => typeof q === "string" && q.length > 0 && Array.from(q).length <= ASK_QUESTION_MAX && Buffer.byteLength(q) <= ASK_QUESTION_MAX;

/** A successful `chief ask` tool result whose details name its own tool call. */
function askOf(entry: unknown): PendingAsk | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const m = entry.message, d = m.details;
  if (m.role !== "toolResult" || m.toolName !== CHIEF_TOOL || m.isError === true || !isRecord(d) || d.action !== "ask") return undefined;
  if (typeof d.askId !== "string" || d.askId !== m.toolCallId || !boundedQuestion(d.question) || !Number.isSafeInteger(d.askedAt) ||
      typeof d.chief !== "string" || !Number.isSafeInteger(d.leaseGeneration)) return undefined;
  return { askId: d.askId, question: d.question, askedAt: d.askedAt as number, chief: d.chief, leaseGeneration: d.leaseGeneration as number };
}

function replyOf(entry: unknown): (ReplyRef & { askId: string }) | undefined {
  if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== COORDINATION_TYPE || !isRecord(entry.details)) return undefined;
  const d = entry.details;
  if (d.kind !== "chief_reply" || d.notice !== undefined || typeof d.askId !== "string" || typeof d.coordinationId !== "string" ||
      !Number.isSafeInteger(d.createdAt) || typeof d.to !== "string") return undefined;
  return { askId: d.askId, coordinationId: d.coordinationId, createdAt: d.createdAt as number, to: d.to };
}

/** The newest successful ask on the branch, unless a confirmed reply card for it follows it. Only cards for that ask are checked. */
export function branchAsk(branch: readonly unknown[], unconfirmed: (reply: ReplyRef) => boolean = () => false): PendingAsk | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const ask = askOf(branch[i]);
    if (!ask) continue;
    for (let j = i + 1; j < branch.length; j++) {
      const reply = replyOf(branch[j]);
      if (reply?.askId === ask.askId && !unconfirmed(reply)) return undefined;
    }
    return ask;
  }
  return undefined;
}

export interface AskSession { getBranch: () => readonly unknown[]; sessionId?: string; sessionFile?: string }
/** Per card: the file it was judged in (device and inode), and either the proof or how far a negative scan got. */
interface Proof { dev: number; ino: number; proven: boolean; next: number }

/**
 * Per module instance: reads the live branch, and holds the one ask a `chief
 * ask` call has queued but Pi has not yet recorded on the branch. While that is
 * staged and the session busy, replies wait (the drain defers them); once idle,
 * the branch alone decides.
 */
export class LeadAsks {
  private session?: Readonly<AskSession>;
  private getBranch?: () => readonly unknown[];
  private stagedId?: string;
  private readonly proofs = new Map<string, Proof>();

  /** session_start: the identity read once there; a fork or resume starts again with its own. */
  start(session: AskSession): void { this.stop(); this.session = Object.freeze({ ...session }); this.getBranch = session.getBranch; }
  stop(): void { this.session = undefined; this.getBranch = undefined; this.stagedId = undefined; this.proofs.clear(); }

  pending(): PendingAsk | undefined {
    try { return this.getBranch ? branchAsk(this.getBranch(), reply => !this.persisted(reply)) : undefined; } catch { return undefined; }
  }

  /**
   * True only when S2's bounded no-follow scan finds this card, addressed to its
   * own `to`, in this session's own file (header naming this session). An
   * absent or invalid file proves nothing and is never cached. A proof, or a
   * negative scan's cursor, is kept per card for that exact file (device and
   * inode), so a replaced file is scanned afresh and an append-only one only
   * from where the last scan stopped.
   */
  private persisted(reply: ReplyRef): boolean {
    const { sessionId, sessionFile } = this.session ?? {};
    if (!sessionId || !sessionFile) return false;
    const key = JSON.stringify([sessionId, sessionFile, reply.coordinationId, reply.to]);
    let path;
    try { path = lstatSync(sessionFile); } catch { return false; }
    const known = this.proofs.get(key);
    const same = known !== undefined && known.dev === path.dev && known.ino === path.ino;
    if (same && known.proven) return true;
    let scan;
    try { scan = scanPersistedReceipts(sessionFile, sessionId, new Set([reply.coordinationId]), same ? known.next : 0, Number.POSITIVE_INFINITY, reply.to); }
    catch { return false; } // a read error proves nothing
    if (!scan?.file) return false;
    const proven = scan.found.has(reply.coordinationId);
    this.proofs.set(key, { ...scan.file, proven, next: scan.next });
    return proven;
  }

  stage(askId: string): void { this.stagedId = askId; }
  unstage(askId: string): void { if (this.stagedId === askId) this.stagedId = undefined; }
  /** The staged ask until Pi records any result for its call on the branch. */
  staged(): string | undefined {
    const id = this.stagedId;
    if (id === undefined) return undefined;
    try {
      const branch = this.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const m = (branch[i] as { type?: unknown; message?: { role?: unknown; toolCallId?: unknown } }).message;
        if ((branch[i] as { type?: unknown }).type === "message" && m?.role === "toolResult" && m.toolCallId === id) { this.stagedId = undefined; return undefined; }
      }
    } catch { /* the branch decides once idle */ }
    return id;
  }
}
