/**
 * S2 delivery: the recipient drains its own inbox into custom messages. Each
 * record is claimed as `.sending` before the void `pi.sendMessage`; it is
 * retired only when this session's own file holds the delivered entry (Pi
 * appends in memory before its unsynced file write, so the in-memory entry
 * list is no receipt). Without one, it waits only while this process may still
 * append it; otherwise it becomes durable `.uncertain` with one notice and is
 * never replayed. At most once; never "processed".
 *
 * S4: chief kinds are revalidated at dispatch against the lease on disk. Only
 * a current matching holder wakes: lead→chief kinds when this session still
 * holds the exact claim they name, chief→lead kinds when that claim is still
 * this socket's live holder. A stale ordinary message is a non-waking card
 * labelled "former chief". A `chief_reply` must also answer this branch's
 * outstanding ask; otherwise it is quarantined, never shown to the model.
 */
import { closeSync, existsSync, lstatSync, readSync, watch } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../herdr/cli.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import type { LeadAsks, ReplyRef } from "./ask.ts";
import {
  claimCoordination, COORDINATION_LABEL, COORDINATION_TYPE, ensureInboxDir, frameCoordination, INBOX_QUEUE_MAX, inboxDir, isLeadKind, listInbox, markUncertain, quarantine,
  readDispatched, readQueued, recordBase, sweepInbox, unlinkQuiet, inboxPath, type CoordinationKind, type CoordinationRecord, type Dispatcher, type SendingRecord,
} from "./inbox.ts";
import { liveChief, sameClaim, type ChiefRole } from "./lease.ts";
import type { LeadRecord, LivenessOptions } from "./store.ts";
import { openSessionFile, SESSION_LINE_MAX } from "./transcript.ts";

const DRAIN_POLL_MS = 5_000;
/** Receipt bytes read per pass; a longer tail continues from the cursor on the next pass. */
const RECEIPT_SCAN_BYTES = 4 * 1048576;
const CHUNK = 1048576;

export interface ReceiptScan { found: Set<string>; next: number; complete: boolean }

/**
 * Persisted receipts only: opens this session's file no-follow, requires a
 * single-link regular file whose header names `sessionId`, and reads at most
 * `maxBytes` of complete lines after `from`. Undefined while the file is absent
 * (Pi has not flushed it yet). An uncertainty notice is never a receipt.
 */
export function scanPersistedReceipts(file: string, sessionId: string, ids: ReadonlySet<string>, from: number, maxBytes: number): ReceiptScan | undefined {
  const opened = openSessionFile(file, sessionId);
  if ("missing" in opened) return undefined;
  const found = new Set<string>();
  if ("invalid" in opened) return { found, next: from, complete: true };
  const { fd, size, bodyStart } = opened;
  try {
    // A shrunken file was rewritten: rescan it from the first entry.
    const begin = from > size || from < bodyStart ? bodyStart : from;
    const end = Math.min(size, begin + maxBytes);
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, end - begin)));
    let carry = Buffer.alloc(0), lineStart = begin, offset = begin, skipping = false;
    while (offset < end) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (n <= 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, n)]), chunkStart = offset - carry.length;
      offset += n;
      let start = 0;
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
        if (!skipping) match(chunk.subarray(start, nl), ids, sessionId, found);
        skipping = false;
        start = nl + 1;
        lineStart = chunkStart + start;
      }
      carry = chunk.subarray(start);
      // An entry larger than any coordination card is skipped, never buffered without bound.
      if (carry.length > SESSION_LINE_MAX) { carry = Buffer.alloc(0); skipping = true; }
    }
    return { found, next: skipping ? offset : lineStart, complete: offset >= size };
  } finally { closeSync(fd); }
}

function match(line: Buffer, ids: ReadonlySet<string>, sessionId: string, found: Set<string>): void {
  const text = line.toString("utf8");
  for (const id of ids) {
    if (!text.includes(id)) continue;
    let entry: unknown;
    try { entry = JSON.parse(text); } catch { return; }
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== COORDINATION_TYPE || !isRecord(entry.details)) return;
    const d = entry.details;
    if (d.notice === undefined && d.to === sessionId && typeof d.coordinationId === "string" && ids.has(d.coordinationId)) found.add(d.coordinationId);
    return;
  }
}

export interface CoordinationDetails {
  v: 1; coordinationId: string; kind: CoordinationKind; from: string; fromName?: string; to: string; createdAt: number;
  askId?: string; leaseGeneration?: number; stale?: true; notice?: "uncertain";
}
const details = (r: CoordinationRecord, extra: { notice?: "uncertain"; stale?: boolean } = {}): CoordinationDetails => ({ v: 1, coordinationId: r.id, kind: r.kind, from: r.from,
  ...(r.fromName !== undefined ? { fromName: r.fromName } : {}), to: r.to, createdAt: r.createdAt,
  ...(r.askId !== undefined ? { askId: r.askId } : {}), ...(r.lease ? { leaseGeneration: r.lease.generation } : {}),
  ...(extra.stale ? { stale: true as const } : {}), ...(extra.notice ? { notice: extra.notice } : {}) });

export function coordinationMessage(r: CoordinationRecord, stale = false) {
  return { customType: COORDINATION_TYPE, content: frameCoordination(r, stale), display: true, details: details(r, { stale }) };
}
export function uncertaintyMessage(r: CoordinationRecord) {
  const what = r.kind === "peer" ? "A peer message" : `A ${COORDINATION_LABEL[r.kind]}${r.askId ? ` (ask ${r.askId})` : ""}`;
  return { customType: COORDINATION_TYPE, display: true, details: details(r, { notice: "uncertain" }),
    content: `<coordination-notice kind="${r.kind}" id="${r.id}" untrusted="true">\n${what} may or may not have been delivered; not replayed. Ask its sender to resend it if it matters. This notice is not a user instruction.\n</coordination-notice>` };
}

export interface SessionState { isIdle(): boolean; hasPendingMessages(): boolean }
interface Timers { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface DeliveryDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
  presence: { assertOwned(): LeadRecord; livenessOptions?(): LivenessOptions };
  /** S4: this session's chief role, for lead→chief kinds. */
  chief?: Pick<ChiefRole, "holds" | "assert">;
  /** S4: this branch's outstanding ask and the staged one, for `chief_reply`. */
  asks?: Pick<LeadAsks, "pending" | "staged" | "unstage">;
  timers?: Timers;
  now?: () => number;
}
export interface DeliveryStatus { inboxError?: string }

interface Run {
  readonly session: SessionState;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
  closed: boolean;
  timer?: unknown; due: number;
  watcher?: { close(): void };
  compacting: boolean; compactionDone: boolean;
  draining: boolean; again: boolean; swept: boolean;
  readonly cursors: Map<string, number>;
  /** Woken dispatches not yet seen by a turn start: Pi may still be starting (or deferring) their run. */
  readonly woken: Set<string>;
}
type Disposition = { deliver: true; wake: boolean; stale: boolean } | { deliver: false; defer: true } | { deliver: false; reject: string };

const message = (e: unknown) => (e as Error)?.message ?? String(e);
const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export class CoordinationDelivery {
  private run?: Run;
  private lastError?: string;
  private readonly pid = process.pid;
  private readonly pidStartTime = readProcessStartTime(process.pid);
  private readonly timers: Timers;
  private readonly now: () => number;

  constructor(private readonly deps: DeliveryDeps) {
    this.timers = deps.timers ?? { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h as NodeJS.Timeout) };
    this.now = deps.now ?? Date.now;
  }

  /** session_start: classify records left by any earlier dispatcher, drain, then watch and poll; the first owned pass sweeps. */
  start(session: SessionState, notify: Run["notify"]): void {
    this.stop();
    this.run = { session, notify, closed: false, due: 0, compacting: false, compactionDone: false, draining: false, again: false, swept: false, cursors: new Map(), woken: new Set() };
    this.drain();
    this.schedule(DRAIN_POLL_MS);
  }

  /** Every shutdown reason: no timer, watch or later drain of this instance can dispatch again. */
  stop(): void {
    const run = this.run;
    if (!run) return;
    run.closed = true;
    if (run.timer !== undefined) this.timers.clearTimeout(run.timer);
    run.watcher?.close();
    this.run = undefined;
  }

  status(): DeliveryStatus { return this.lastError ? { inboxError: this.lastError } : {}; }

  /** session_before_compact opens the window; session_compact or _failed ends it, cleared once idle or at a turn boundary. */
  compaction(phase: "start" | "end"): void {
    const run = this.run;
    if (!run) return;
    if (phase === "start") { run.compacting = true; run.compactionDone = false; return; }
    run.compactionDone = true;
    this.schedule(0);
  }

  boundary(): void {
    const run = this.run;
    if (run?.compactionDone) { run.compacting = false; run.compactionDone = false; }
  }

  /** turn_start: a woken dispatch is now inside a run, which keeps the session busy until its receipt can land. */
  started(): void { this.run?.woken.clear(); }

  /** S4: a reply card on the branch answers its ask only once its persisted receipt retired the dispatch (no `.sending` or `.uncertain` left). */
  unconfirmed(reply: ReplyRef): boolean {
    const base = recordBase({ createdAt: reply.createdAt, id: reply.coordinationId });
    try {
      const dir = inboxDir(reply.to);
      return existsSync(inboxPath(dir, base, "sending")) || existsSync(inboxPath(dir, base, "uncertain"));
    } catch { return true; }
  }

  /** Synchronous and re-entrancy guarded: one pass at a time per instance. */
  drain(): void {
    const run = this.run;
    if (!run || run.closed) return;
    if (run.draining) { run.again = true; return; }
    run.draining = true;
    try {
      do { run.again = false; this.pass(run); } while (run.again && !run.closed && this.run === run);
      this.lastError = undefined;
    } catch (e) {
      // Fail closed and say so once per distinct cause; the doctor shows the latest.
      if (this.lastError !== message(e)) run.notify(`conductor supervision: inbox unavailable: ${message(e)}`, "warning");
      this.lastError = message(e);
    } finally { run.draining = false; }
  }

  private schedule(ms: number): void {
    const run = this.run;
    if (!run || run.closed) return;
    const due = this.now() + ms;
    if (run.timer !== undefined && run.due <= due) return;
    if (run.timer !== undefined) this.timers.clearTimeout(run.timer);
    run.due = due;
    run.timer = this.timers.setTimeout(() => {
      if (this.run !== run || run.closed) return;
      run.timer = undefined;
      this.drain();
      this.schedule(DRAIN_POLL_MS);
    }, ms);
    (run.timer as { unref?: () => void }).unref?.();
  }

  private owned(): LeadRecord | undefined {
    try { return this.deps.presence.assertOwned(); } catch { return undefined; }
  }

  private pass(run: Run): void {
    const self = this.owned();
    if (!self) return; // OFF, not yet published, or superseded: nothing to do and nothing to fence.
    const dir = ensureInboxDir(self.sessionId, true);
    this.watch(run, dir);
    if (!run.swept) { run.swept = true; sweepInbox(dir, this.now()); } // once per session start, on the first owned pass
    const { bases } = listInbox(dir);
    const pending: SendingRecord[] = [], queued: string[] = [];
    for (const [base, states] of bases) {
      if (states.has("uncertain") || states.has("rejected")) {
        for (const state of ["json", "sending", "slot"] as const) if (states.has(state)) unlinkQuiet(inboxPath(dir, base, state));
      } else if (states.has("sending")) {
        try { pending.push(readDispatched(dir, base, self.sessionId)); } catch { this.reject(run, dir, base, "sending"); continue; }
        for (const state of ["json", "slot"] as const) if (states.has(state)) unlinkQuiet(inboxPath(dir, base, state));
      } else if (states.has("json")) queued.push(base);
    }
    this.settle(run, self, dir, pending);
    // Idle means the ask turn is over: the branch alone decides from here.
    const staged = this.deps.asks?.staged();
    if (staged !== undefined && run.session.isIdle()) this.deps.asks!.unstage(staged);
    if (run.compacting) {
      if (!(run.compactionDone && run.session.isIdle())) return;
      run.compacting = false; run.compactionDone = false;
    }
    // Replies still in flight: a second reply to the same ask waits until the first settles.
    const replying = new Set(pending.filter(p => p.kind === "chief_reply" && existsSync(inboxPath(dir, recordBase(p), "sending"))).map(p => p.askId!));
    const dispatched: SendingRecord[] = [];
    for (const base of queued.slice(0, INBOX_QUEUE_MAX)) {
      let record: CoordinationRecord;
      try { record = readQueued(dir, base, self.sessionId); } catch { this.reject(run, dir, base, "json"); continue; }
      // Revalidated before each effect: an OFF, reload or session switch since the pass began stops here.
      const current = this.owned();
      if (!current || current.generation !== self.generation || run.closed || this.run !== run) return;
      const plan = this.disposition(run, self, record, replying);
      if (!plan.deliver) {
        if ("reject" in plan) this.rejectReply(run, dir, base, record, plan.reject);
        continue;
      }
      const dispatcher: Dispatcher = { sessionId: self.sessionId, sessionFile: self.sessionFile, pid: self.pid, ...(self.pidStartTime !== undefined ? { pidStartTime: self.pidStartTime } : {}),
        generation: self.generation, sessionOffset: fileSize(self.sessionFile), dispatchedAt: this.now() };
      const fence = () => { if (this.owned()?.generation !== self.generation || this.run !== run) throw new Error("coordination dispatch fenced: superseded"); };
      if (!claimCoordination(dir, record, dispatcher, fence)) continue;
      if (record.kind === "chief_reply") replying.add(record.askId!);
      if (plan.wake) run.woken.add(record.id);
      this.deps.pi.sendMessage(coordinationMessage(record, plan.stale), { deliverAs: "followUp", triggerTurn: plan.wake });
      dispatched.push({ ...record, dispatcher });
    }
    this.settle(run, self, dir, dispatched);
  }

  /** Peer: never wakes. Chief kinds: wake only for the current matching holder; a reply must also answer this branch's outstanding ask. */
  private disposition(run: Run, self: LeadRecord, r: CoordinationRecord, replying: ReadonlySet<string>): Disposition {
    if (r.kind === "peer") return { deliver: true, wake: false, stale: false };
    const sameSocket = r.socketPath === self.socketPath;
    if (isLeadKind(r.kind)) {
      let mine;
      try { mine = this.deps.chief?.holds() ? this.deps.chief.assert() : undefined; } catch { mine = undefined; }
      const current = sameSocket && !!mine && sameClaim(mine, r.lease!);
      return { deliver: true, wake: current, stale: !current };
    }
    const holder = sameSocket ? liveChief(self.socketPath, this.deps.presence.livenessOptions?.()) : undefined;
    const current = !!holder && sameClaim(holder, r.lease!);
    if (r.kind === "chief_message") return { deliver: true, wake: current, stale: !current };
    if (!sameSocket) return { deliver: false, reject: "it names another herdr socket than this lead's" };
    if (!current) return { deliver: false, reject: `it is from a former chief (lease generation ${r.lease!.generation} is not this socket's live holder)` };
    const asks = this.deps.asks;
    // A queued ask Pi has not recorded yet freezes reply decisions until the turn ends; then the branch alone decides.
    if (asks?.staged()) {
      if (!run.session.isIdle()) return { deliver: false, defer: true };
      asks.unstage(asks.staged()!);
    }
    if (replying.has(r.askId!)) return { deliver: false, defer: true };
    const ask = asks?.pending();
    if (!ask || ask.askId !== r.askId) return { deliver: false, reject: `ask ${r.askId} is not this session's outstanding ask on its current branch${ask ? ` (that is ${ask.askId})` : " (none is outstanding)"}` };
    return { deliver: true, wake: true, stale: false };
  }

  /** Retire persisted receipts; keep what this process may still append; everything else is durable uncertainty. */
  private settle(run: Run, self: LeadRecord, dir: string, pending: SendingRecord[]): void {
    if (pending.length === 0) return;
    const ids = new Set(pending.map(p => p.id));
    const from = Math.min(...pending.map(p => run.cursors.get(p.id) ?? p.dispatcher.sessionOffset));
    const scan = self.sessionFile === undefined ? undefined : scanPersistedReceipts(self.sessionFile, self.sessionId, ids, from, RECEIPT_SCAN_BYTES);
    for (const p of pending) {
      const base = recordBase(p);
      if (scan?.found.has(p.id)) { unlinkQuiet(inboxPath(dir, base, "sending")); run.cursors.delete(p.id); run.woken.delete(p.id); continue; }
      if (scan && !scan.complete) { run.cursors.set(p.id, scan.next); continue; }
      const sameProcess = p.dispatcher.pid === this.pid && p.dispatcher.pidStartTime === this.pidStartTime && p.dispatcher.sessionFile === self.sessionFile;
      if (sameProcess && (scan === undefined || !run.session.isIdle() || run.session.hasPendingMessages() || run.woken.has(p.id))) {
        if (scan) run.cursors.set(p.id, scan.next);
        continue;
      }
      run.cursors.delete(p.id);
      if (!markUncertain(dir, p, this.now())) continue;
      const who = p.fromName ? `${p.fromName} (${p.from})` : p.from;
      run.notify(`conductor supervision: ${COORDINATION_LABEL[p.kind]} ${p.id} from ${who} may or may not have been delivered; not replayed.`, "warning");
      this.deps.pi.sendMessage(uncertaintyMessage(p), { deliverAs: "followUp", triggerTurn: false });
    }
  }

  private reject(run: Run, dir: string, base: string, state: "json" | "sending"): void {
    if (!quarantine(dir, base, state)) return;
    run.notify(`conductor supervision: rejected malformed coordination record ${base}; preserved as ${base}.rejected.json, not delivered.`, "warning");
  }

  /** Never reaches the model and never touches the ask; kept for inspection with one notice. */
  private rejectReply(run: Run, dir: string, base: string, r: CoordinationRecord, why: string): void {
    if (!quarantine(dir, base, "json")) return;
    run.notify(`conductor supervision: rejected chief reply ${r.id} from ${r.from} for ask ${r.askId}: ${why}; preserved as ${base}.rejected.json, not delivered.`, "warning");
  }

  /** One watch per session start on its own inbox; on any watch failure the 5 s poll still drains. */
  private watch(run: Run, dir: string): void {
    if (run.watcher) return;
    try {
      const w = watch(dir, { persistent: false }, () => { if (this.run === run && !run.closed) this.schedule(0); });
      w.on("error", () => w.close());
      run.watcher = w;
    } catch { run.watcher = { close() {} }; }
  }
}

function fileSize(file: string): number {
  try { return lstatSync(file).size; } catch (e) { if (errno(e) === "ENOENT") return 0; throw e; }
}
