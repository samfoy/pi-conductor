/**
 * S4 `chief ask` correlation. The asking lead's current session branch is the
 * only authority: the outstanding ask is the newest successful `chief ask`
 * tool result on the branch (a newer one supersedes it), until a delivered
 * `chief_reply` card for that ask id follows it there. A reply card whose
 * dispatch is still unconfirmed (`.sending`) or uncertain is no answer, so a
 * queued, in-flight or unpersisted reply never clears the ask. No record,
 * message or presence file can create an ask.
 */
import { isRecord } from "../herdr/cli.ts";
import { COORDINATION_TYPE } from "./inbox.ts";
import { ASK_QUESTION_MAX } from "./store.ts";

export { ASK_QUESTION_MAX };
export const CHIEF_TOOL = "chief";

export interface PendingAsk { askId: string; question: string; askedAt: number; chief: string; leaseGeneration: number }
/** A delivered reply card's identity, enough to find its inbox record. */
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

/** The newest successful ask on the branch, unless a confirmed reply card for it follows it. */
export function branchAsk(branch: readonly unknown[], unconfirmed: (reply: ReplyRef) => boolean = () => false): PendingAsk | undefined {
  const answered = new Set<string>();
  for (let i = branch.length - 1; i >= 0; i--) {
    const reply = replyOf(branch[i]);
    if (reply) { if (!unconfirmed(reply)) answered.add(reply.askId); continue; }
    const ask = askOf(branch[i]);
    if (ask) return answered.has(ask.askId) ? undefined : ask;
  }
  return undefined;
}

/**
 * Per module instance: reads the live branch, and holds the one ask a `chief
 * ask` call has queued but Pi has not yet recorded on the branch. While that is
 * staged and the session busy, replies wait (the drain defers them); once idle,
 * the branch alone decides.
 */
export class LeadAsks {
  private getBranch?: () => readonly unknown[];
  private stagedId?: string;

  constructor(private readonly unconfirmed: (reply: ReplyRef) => boolean = () => false) {}

  start(getBranch: () => readonly unknown[]): void { this.getBranch = getBranch; this.stagedId = undefined; }
  stop(): void { this.getBranch = undefined; this.stagedId = undefined; }

  pending(): PendingAsk | undefined {
    try { return this.getBranch ? branchAsk(this.getBranch(), this.unconfirmed) : undefined; } catch { return undefined; }
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
