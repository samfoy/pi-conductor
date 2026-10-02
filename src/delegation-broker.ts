/**
 * N2/N5 lead broker. Its only input is a delegator's own parsed event stream
 * (subprocess stdout or the herdr tee), fed by the pipeline that owns it. Start
 * saves arguments; only the first `tool_execution_update` (emitted from inside the
 * tool's execute) claims a call, because a start can still end as an unknown,
 * schema, permission or abort error without executing. Every async boundary is
 * fenced on the parent still being this instance's current, owned run.
 *
 * N5: a herdr parent's calls survive a lead reload or crash. Its replayed stream
 * reaches the next owner's broker, and a claimed call is never re-spawned: it is
 * skipped, rebound to its leaf, answered from the leaf's record, or answered uncertain.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { publishJson } from "./effort/store.ts";
import { appendFileEvidence } from "./file-evidence.ts";
import { ownsHerdrRun } from "./herdr/ownership.ts";
import { readControlRecord } from "./herdr/inbox.ts";
import { resolvePersonas } from "./personas.ts";
import { buildOrphanRun } from "./reconcile-startup.ts";
import { forceTerminate, resolveTimeoutMs, runsRoot, writeFinal, type RunRegistry } from "./runs.ts";
import type { SpawnQueue } from "./queue.ts";
import { isTerminal, type Run, type RunRecord } from "./types.ts";
import {
  RELOAD_INTERRUPTED, delegatePaths, formatDelegateEnvelope, isDelegateCallId, validateDelegateRequest,
  type DelegateResponse,
} from "./delegation.ts";

/** What a pipeline feeds and shutdown closes; `registry.delegation` holds one per module instance. */
export interface DelegationObserver {
  observe(parent: Run, event: unknown, cwd: string): void;
  close(): Promise<void>;
}

export const LEAF_OUTCOME_UNCERTAIN = "leaf outcome uncertain after lead restart; not replayed";
export const HERDR_RELOAD_CANCELLED = "lead /reload stopped a leaf it could not hand over (queued, launching or subprocess); delegate again";

interface Call {
  parent: Run;
  id: string;
  done: boolean;
  /** The parent's other outstanding calls when this one was claimed. */
  outstanding: number;
  /** False once this instance no longer owns the parent's stream: nothing may then answer or cancel. */
  owned: () => boolean;
  /** Its leaf settled and closed; the answer is being written. */
  finishing?: Promise<void>;
  leafId?: string;
  limit?: number;
  timer?: NodeJS.Timeout;
}

/** An update seen for a readopted parent before startup reconcile finished populating the registry. */
interface Deferred { parent: Run; id: string; args: unknown; cwd: string; ended: boolean }

type ToolEvent = { type?: unknown; toolName?: unknown; toolCallId?: unknown; parentToolCallId?: unknown; args?: unknown };

export class DelegationBroker implements DelegationObserver {
  private readonly starts = new Map<string, { args: unknown }>();
  private readonly calls = new Map<string, Call>();
  private readonly deferred = new Map<string, Deferred>();
  private closed = false;
  private reconciled: Promise<void> = Promise.resolve();
  private reconciledNow = true;

  constructor(private readonly deps: { registry: RunRegistry; queue: SpawnQueue; env: NodeJS.ProcessEnv }) {
    // Kept after close too: it drops a terminal parent's unfinished starts.
    deps.registry.onChange((run) => this.changed(run));
  }

  /** Startup reconcile is registering readopted runs; decisions for readopted parents wait for it. */
  reconciling(done: Promise<unknown>): void {
    this.reconciledNow = false;
    const settled: Promise<void> = done.then(() => {}, () => {}).then(() => { if (this.reconciled === settled) this.reconciledNow = true; });
    this.reconciled = settled;
  }

  observe(parent: Run, event: unknown, cwd: string): void {
    const e = event as ToolEvent;
    if (!e || typeof e !== "object" || e.toolName !== "delegate" || e.parentToolCallId !== undefined || !isDelegateCallId(e.toolCallId)) return;
    const key = `${parent.id}\0${e.toolCallId}`;
    if (e.type === "tool_execution_start") {
      if (!this.starts.has(key) && !this.calls.has(key) && !this.deferred.has(key)) this.starts.set(key, { args: e.args });
    } else if (e.type === "tool_execution_update") {
      const start = this.starts.get(key);
      if (!start || this.calls.has(key)) return;
      this.starts.delete(key);
      // Run ownership is not effort ownership: without the effort claim, only observe.
      if (!brokerable(parent)) return;
      if (parent.reconciledAtStartup && !this.reconciledNow) {
        this.deferred.set(key, { parent, id: e.toolCallId, args: start.args, cwd, ended: false });
        void this.reconciled.then(() => this.undefer(key));
        return;
      }
      this.claim(parent, e.toolCallId, key, start.args, cwd);
    } else if (e.type === "tool_execution_end") {
      this.starts.delete(key);
      const deferred = this.deferred.get(key);
      if (deferred) deferred.ended = true;
      const call = this.calls.get(key);
      if (call) this.cancel(call, "the delegate call ended before its leaf finished");
    }
  }

  private undefer(key: string): void {
    const d = this.deferred.get(key);
    if (!d) return;
    this.deferred.delete(key);
    if (!this.current(d.parent) || !brokerable(d.parent)) return;
    // Nothing was claimed and nobody waits any more.
    if (d.ended && !existsSync(delegatePaths(dirname(d.parent.recordPath), d.id).claim)) return;
    this.claim(d.parent, d.id, key, d.args, d.cwd, d.ended);
  }

  /** Synchronous, before any await: exclusive claim, then count and notify, so a duplicate never spawns twice. */
  private claim(parent: Run, id: string, key: string, args: unknown, cwd: string, ended = false): void {
    const paths = delegatePaths(dirname(parent.recordPath), id);
    try {
      publishJson(paths.claim, { v: 1, toolCallId: id, parentRunId: parent.id, claimedAt: Date.now(),
        ...(parent.runtime === "herdr" ? { launchNonce: parent.herdr?.launchNonce } : {}) }, () => {});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && parent.runtime === "herdr") { this.rebind(parent, id, key, ended); return; }
      const reason = (e as NodeJS.ErrnoException).code === "EEXIST"
        ? `call ${id} was already claimed; leaf outcome uncertain; not replayed`
        : `claim failed: ${(e as Error).message}`;
      this.respond(parent, id, { ok: false, reason });
      return;
    }
    const call = this.track(parent, id, key);
    if (this.closed) { this.reject(call, "lead /reload closed this run's delegation broker; resume this run with ensemble_send to delegate again"); return; }
    void this.resolve(call, args, cwd).catch((e) => this.reject(call, `delegation failed: ${(e as Error).message}`));
  }

  private track(parent: Run, id: string, key: string, leafId?: string): Call {
    // A subprocess parent has one stream owner for life; a replaced registry entry is rejected by validation.
    const ownership = parent.herdrOwnership, nonce = parent.herdr?.launchNonce;
    const call: Call = { parent, id, done: false, outstanding: parent.pendingDelegations ?? 0, leafId,
      owned: () => parent.runtime !== "herdr" || (this.current(parent) && parent.herdrOwnership === ownership && parent.herdr?.launchNonce === nonce) };
    this.calls.set(key, call);
    parent.pendingDelegations = (parent.pendingDelegations ?? 0) + 1;
    this.deps.registry.notify(parent);
    return call;
  }

  private current(parent: Run): boolean {
    return this.deps.registry.get(parent.id) === parent && ownsHerdrRun(parent);
  }

  /**
   * N5 readopt table for a claimed call of this herdr parent: response -> skip;
   * registered leaf -> rebind as awaiting; terminal leaf record -> answer from it;
   * anything else (foreign, unknown, prepared-unpublished) -> explicit uncertainty.
   */
  private rebind(parent: Run, id: string, key: string, ended: boolean): void {
    const paths = delegatePaths(dirname(parent.recordPath), id);
    if (existsSync(paths.response)) return;
    let claim: Record<string, unknown> | undefined;
    try { claim = readControlRecord(paths.claim) as Record<string, unknown>; } catch { claim = undefined; }
    const valid = !!claim && claim.v === 1 && claim.toolCallId === id && claim.parentRunId === parent.id && typeof claim.claimedAt === "number" &&
      claim.launchNonce === parent.herdr?.launchNonce;
    const since = valid ? claim!.claimedAt as number : Infinity;
    const lineage = (r: { depth?: unknown; parentRunId?: string; delegateToolCallId?: string; startTime: number }) =>
      r.depth === 2 && r.parentRunId === parent.id && r.delegateToolCallId === id && r.startTime >= since;
    const registered = valid ? this.deps.registry.list().filter(lineage) : [];
    const leaf = registered.length === 1 && !(registered[0]!.reconciledAtStartup && isTerminal(registered[0]!.status) && !registered[0]!.transport) ? registered[0] : undefined;
    // Rebind only a leaf this instance observes; a readopted subprocess leaf has no event source here.
    const observed = leaf && (isTerminal(leaf.status) || (leaf.runtime === "herdr" ? leaf.transport?.kind === "herdr" && ownsHerdrRun(leaf) : leaf.transport?.kind === "subprocess"));
    const records = valid && !leaf && registered.length <= 1 ? durableLeaves(lineage) : [];
    const record = records.length === 1 && isTerminal(records[0]!.status) ? records[0] : undefined;
    // Counted, with its leaf known, before the notify: a parent that already ended cancels it right here.
    const call = this.track(parent, id, key, observed ? leaf!.id : record?.id);
    if (call.done) return;
    call.limit = loadConfig(parent.cwd).inlineAttachmentLimitBytes;
    if (observed) {
      if (ended) this.cancel(call, "the delegate call ended before its leaf finished");
      else if (isTerminal(leaf!.status) && !leaf!.processOpen) call.finishing = this.finish(call, leaf!);
      return;
    }
    if (!record) { this.reject(call, `call ${id} was already claimed; ${LEAF_OUTCOME_UNCERTAIN}`); return; }
    // The record's existence and terminal status are the proof; the answer is still create-only.
    this.settle(call);
    this.respond(parent, id, { ok: true, agentId: record.id, status: record.status, envelope: formatDelegateEnvelope(recordedLeaf(record), call.limit) });
  }

  private async resolve(call: Call, args: unknown, cwd: string): Promise<void> {
    const { parent } = call;
    const cfg = loadConfig(parent.cwd);
    const roster = await resolvePersonas({ cwd: parent.cwd, personaOverrides: cfg.personaOverrides });
    if (call.done) return; // an end, terminal parent or reload cancelled it during resolution
    if (!call.owned()) { this.release(call); return; }
    const name = (args as { persona?: unknown } | undefined)?.persona;
    const target = typeof name === "string" ? roster.personas.get(name) : undefined;
    const verdict = validateDelegateRequest({ args, parent, current: this.deps.registry.get(parent.id) === parent, target,
      personaTimeoutMs: target ? resolveTimeoutMs(target, cfg.personaOverrides[target.name], cfg) : 0,
      outstanding: call.outstanding, now: Date.now() });
    if (!verdict.ok) { this.reject(call, verdict.reason); return; }
    const request = args as { task: string; files?: string[] };
    const foreign = (request.files ?? []).find((f) => f.startsWith("run:") && this.deps.registry.get(f.slice(4))?.parentRunId !== parent.id);
    if (foreign) { this.reject(call, `files: ${foreign} is not a delegate child of this run`); return; }
    let task: string;
    try { task = appendFileEvidence(request.task, request.files, { cwd, registry: this.deps.registry, limit: cfg.inlineAttachmentLimitBytes }); }
    catch (e) { this.reject(call, (e as Error).message); return; }
    call.limit = cfg.inlineAttachmentLimitBytes;
    // No per-call runtime: the leaf resolves through the persona/project/user/auto cascade, and an
    // unsatisfiable selection (herdr outside herdr) is a named rejection, never a silent downgrade.
    const result = this.deps.queue.enqueueOrSpawn({
      persona: target!, task, cwd, mode: "background", timeoutMs: verdict.timeoutMs, runtimeEnv: this.deps.env,
      // resolvePersonas already applied personaOverrides; unset keeps pi's inherit semantics.
      model: target!.model, thinking: target!.thinking,
      parentSessionId: parent.parentSessionId, delegation: { parentRunId: parent.id, delegateToolCallId: call.id },
      inheritContextOverride: "none", worktree: false, mergeStrategy: "none", onCompleteHook: "", retryMaxAttempts: 1, steerable: false,
    });
    const leaf = result.kind === "spawned" ? result.run : result.placeholderRun;
    call.leafId = leaf.id;
    if (call.done) return;
    // Bounds a queued leaf too; a running one is also bounded by its own hard timer.
    call.timer = setTimeout(() => this.expire(call), Math.max(0, verdict.deadlineAt - Date.now()));
    call.timer.unref();
  }

  private expire(call: Call): void {
    if (call.done) return;
    if (!call.owned()) { this.release(call); return; }
    const leaf = call.leafId ? this.deps.registry.get(call.leafId) : undefined;
    if (!leaf || isTerminal(leaf.status)) return;
    if (leaf.status === "queued") {
      this.reject(call, `timeout: ${leaf.id} did not start before its deadline`);
      this.deps.queue.removeQueued(leaf.id);
    } else forceTerminate(leaf, "timeout", this.deps.registry);
  }

  private changed(run: Run): void {
    if (isTerminal(run.status)) for (const key of this.starts.keys()) if (key.startsWith(`${run.id}\0`)) this.starts.delete(key);
    if (run.parentRunId !== undefined && run.delegateToolCallId !== undefined && isTerminal(run.status) && !run.processOpen) {
      // The parent stays blocked, and its slot stays lent, until the leaf's process has closed (N3).
      const call = this.calls.get(`${run.parentRunId}\0${run.delegateToolCallId}`);
      if (call && !call.done && !call.finishing) call.finishing = this.finish(call, run);
    }
    if (isTerminal(run.status) && (run.pendingDelegations ?? 0) > 0) {
      this.cancelAll([...this.calls.values()].filter((call) => call.parent === run), () => `parent ${run.id} ended (${run.status})`);
    }
  }

  /** Queued leaves first, so a cancelled sibling's freed slot never launches a leaf about to be cancelled. */
  private cancelAll(calls: Call[], reason: (call: Call) => string): void {
    const queued = calls.filter((c) => this.deps.registry.get(c.leafId ?? "")?.status === "queued");
    for (const call of [...queued, ...calls.filter((c) => !queued.includes(c))]) this.cancel(call, reason(call));
  }

  private async finish(call: Call, leaf: Run): Promise<void> {
    await leaf.recordWrite;
    await writeFinal(leaf); // resultRef needs the persisted final; same bytes as the pipeline's write
    if (call.done) return; // cancelled meanwhile; that answer stands
    if (!call.owned()) { this.release(call); return; } // the next owner answers from the leaf's record
    this.settle(call);
    this.respond(call.parent, call.id, { ok: true, agentId: leaf.id, status: leaf.status, envelope: formatDelegateEnvelope(leaf, call.limit ?? 131072) });
  }

  /**
   * Answer first, so the leaf's own terminal notification cannot answer the call as a result;
   * notify last, so no listener sees an answered call whose leaf is still queued.
   */
  private cancel(call: Call, reason: string): void {
    if (call.done) return;
    this.reject(call, `cancelled: ${reason}`, false);
    const leaf = call.leafId ? this.deps.registry.get(call.leafId) : undefined;
    if (leaf?.status === "queued") this.deps.queue.removeQueued(leaf.id);
    if (leaf && !isTerminal(leaf.status)) forceTerminate(leaf, "killed", this.deps.registry);
    this.deps.registry.notify(call.parent);
  }

  private reject(call: Call, reason: string, notify = true): void {
    if (call.done) return;
    this.settle(call, notify);
    this.respond(call.parent, call.id, { ok: false, reason });
  }

  private settle(call: Call, notify = true): void {
    this.release(call);
    const { parent } = call;
    // Resume grace: the watchdog measures silence from the last handoff, not from before the wait.
    if (parent.pendingDelegations === 0 && parent.status === "running") parent.lastEventAt = Date.now();
    if (notify) this.deps.registry.notify(parent);
  }

  /** Also the fenced path: this instance lost the parent's stream, so its credit goes and the next owner decides. */
  private release(call: Call): void {
    call.done = true;
    clearTimeout(call.timer);
    this.calls.delete(`${call.parent.id}\0${call.id}`);
    call.parent.pendingDelegations = Math.max(0, (call.parent.pendingDelegations ?? 1) - 1);
  }

  /** Create-only: an existing response (EEXIST) is never replaced. */
  private respond(parent: Run, id: string, body: Omit<DelegateResponse, "v" | "toolCallId" | "parentRunId">): void {
    const response: DelegateResponse = { v: 1, toolCallId: id, parentRunId: parent.id, ...body };
    try { publishJson(delegatePaths(dirname(parent.recordPath), id).response, response, () => {}); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") process.stderr.write(`[conductor] delegate response ${parent.id}/${id} not written: ${(e as Error).message}\n`);
    }
  }

  /**
   * Reload. Subprocess parents keep the approved R6 fallback: the new module instance
   * has no event source for them, so every one with an outstanding call is stopped,
   * leaves first, with a named diagnostic; parents with nothing outstanding keep running
   * and a later update is claimed and rejected, never dropped. A herdr parent survives:
   * a launched herdr leaf is handed over unanswered for the next owner to rebind, and
   * only what cannot be handed over (no leaf yet, queued, launching or a subprocess leaf)
   * is cancelled now, while this instance still owns the parent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.deferred.clear();
    const pending = [...this.calls.values()];
    const leafOf = (c: Call) => (c.leafId ? this.deps.registry.get(c.leafId) : undefined);
    // An answer already being written for a herdr parent completes under this instance's ownership.
    const answering = pending.filter((c) => c.parent.runtime === "herdr" && c.finishing);
    const handover = pending.filter((c) => {
      const leaf = leafOf(c);
      return c.parent.runtime === "herdr" && !c.finishing && leaf?.runtime === "herdr" && !isTerminal(leaf.status) &&
        leaf.transport?.kind === "herdr" && leaf.transport.initialAccepted === true;
    });
    for (const call of handover) this.release(call);
    const stopped = pending.filter((c) => !answering.includes(c) && !handover.includes(c));
    const parents = [...new Set(stopped.filter((c) => c.parent.runtime !== "herdr").map((c) => c.parent))];
    const leaves = stopped.map(leafOf).filter((r): r is Run => !!r);
    this.cancelAll(stopped, (c) => (c.parent.runtime === "herdr" ? HERDR_RELOAD_CANCELLED : RELOAD_INTERRUPTED));
    for (const parent of parents) {
      if (isTerminal(parent.status)) continue;
      parent.errorMessage = RELOAD_INTERRUPTED;
      forceTerminate(parent, "killed", this.deps.registry, parent.onComplete);
    }
    // A cancelled herdr leaf's stop must finish before shutdown detaches and fences it.
    await Promise.allSettled([...answering.map((c) => c.finishing), ...leaves.map((r) => (r.transport?.kind === "herdr" ? r.transport.stop() : undefined)),
      ...[...leaves, ...parents].map((r) => r.recordWrite)]);
  }
}

function brokerable(parent: Run): boolean {
  return !(parent.effort && parent.herdrEffortAuthorized === false);
}

/** Durable leaf records naming this exact call; GC'd or never-written leaves are absent. */
function durableLeaves(lineage: (r: RunRecord) => boolean): RunRecord[] {
  const root = runsRoot();
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.flatMap((name) => {
    try {
      const record = JSON.parse(readFileSync(join(root, name, "record.json"), "utf8")) as RunRecord;
      return record.id === name && lineage(record) ? [record] : [];
    } catch { return []; }
  });
}

/** A terminal leaf as its record and published final describe it; an unpublished final stays unavailable. */
function recordedLeaf(record: RunRecord): Run {
  const leaf = buildOrphanRun(record, record.status);
  let text = "";
  try { if (!record.herdrExitUnconfirmed && !record.herdrResultUnavailable) text = readFileSync(record.finalPath, "utf8"); } catch { /* no published final */ }
  if (text) leaf.messages = [{ role: "assistant", content: [{ type: "text", text }] } as never];
  return leaf;
}
