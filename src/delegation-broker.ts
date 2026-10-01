/**
 * N2 lead broker for subprocess delegators. Its only input is the parent's
 * own parsed event stream, fed by the pipeline that owns that stream. Start
 * saves arguments; only the first `tool_execution_update` (emitted from inside
 * the tool's execute) claims a call, because a start can still end as an
 * unknown, schema, permission or abort error without executing.
 */
import { dirname } from "node:path";
import { loadConfig } from "./config.ts";
import { publishJson } from "./effort/store.ts";
import { appendFileEvidence } from "./file-evidence.ts";
import { resolvePersonas } from "./personas.ts";
import { forceTerminate, prepareSpawnRuntime, resolveTimeoutMs, writeFinal, type RunRegistry } from "./runs.ts";
import type { SpawnQueue } from "./queue.ts";
import { isTerminal, type Run } from "./types.ts";
import {
  RELOAD_INTERRUPTED, delegatePaths, formatDelegateEnvelope, isDelegateCallId, validateDelegateRequest,
  type DelegateResponse,
} from "./delegation.ts";

/** What a pipeline feeds and shutdown closes; `registry.delegation` holds one per module instance. */
export interface DelegationObserver {
  observe(parent: Run, event: unknown, cwd: string): void;
  close(): Promise<void>;
}

interface Call {
  parent: Run;
  id: string;
  done: boolean;
  /** The parent's other outstanding calls when this one was claimed. */
  outstanding: number;
  leafId?: string;
  limit?: number;
  timer?: NodeJS.Timeout;
}

type ToolEvent = { type?: unknown; toolName?: unknown; toolCallId?: unknown; parentToolCallId?: unknown; args?: unknown };

export class DelegationBroker implements DelegationObserver {
  private readonly starts = new Map<string, { args: unknown }>();
  private readonly calls = new Map<string, Call>();
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: { registry: RunRegistry; queue: SpawnQueue; env: NodeJS.ProcessEnv }) {
    this.unsubscribe = deps.registry.onChange((run) => this.changed(run));
  }

  observe(parent: Run, event: unknown, cwd: string): void {
    const e = event as ToolEvent;
    if (!e || typeof e !== "object" || e.toolName !== "delegate" || e.parentToolCallId !== undefined || !isDelegateCallId(e.toolCallId)) return;
    const key = `${parent.id}\0${e.toolCallId}`;
    if (e.type === "tool_execution_start") {
      if (!this.starts.has(key) && !this.calls.has(key)) this.starts.set(key, { args: e.args });
    } else if (e.type === "tool_execution_update") {
      const start = this.starts.get(key);
      if (!start || this.calls.has(key)) return;
      this.starts.delete(key);
      this.claim(parent, e.toolCallId, key, start.args, cwd);
    } else if (e.type === "tool_execution_end") {
      this.starts.delete(key);
      const call = this.calls.get(key);
      if (call) this.cancel(call, "the delegate call ended before its leaf finished");
    }
  }

  /** Synchronous, before any await: exclusive claim, then count and notify, so a duplicate never spawns twice. */
  private claim(parent: Run, id: string, key: string, args: unknown, cwd: string): void {
    const paths = delegatePaths(dirname(parent.recordPath), id);
    try {
      publishJson(paths.claim, { v: 1, toolCallId: id, parentRunId: parent.id, claimedAt: Date.now() }, () => {});
    } catch (e) {
      const reason = (e as NodeJS.ErrnoException).code === "EEXIST"
        ? `call ${id} was already claimed; leaf outcome uncertain; not replayed`
        : `claim failed: ${(e as Error).message}`;
      this.respond(parent, id, { ok: false, reason });
      return;
    }
    const call: Call = { parent, id, done: false, outstanding: parent.pendingDelegations ?? 0 };
    this.calls.set(key, call);
    parent.pendingDelegations = (parent.pendingDelegations ?? 0) + 1;
    this.deps.registry.notify(parent);
    if (this.closed) { this.reject(call, "lead /reload closed this run's delegation broker; resume this run with ensemble_send to delegate again"); return; }
    void this.resolve(call, args, cwd).catch((e) => this.reject(call, `delegation failed: ${(e as Error).message}`));
  }

  private async resolve(call: Call, args: unknown, cwd: string): Promise<void> {
    const { parent } = call;
    const cfg = loadConfig(parent.cwd);
    const roster = await resolvePersonas({ cwd: parent.cwd, personaOverrides: cfg.personaOverrides });
    if (call.done) return; // an end, terminal parent or reload cancelled it during resolution
    const name = (args as { persona?: unknown } | undefined)?.persona;
    const target = typeof name === "string" ? roster.personas.get(name) : undefined;
    const verdict = validateDelegateRequest({ args, parent, current: this.deps.registry.get(parent.id) === parent, target,
      personaTimeoutMs: target ? resolveTimeoutMs(target, cfg.personaOverrides[target.name], cfg) : 0,
      outstanding: call.outstanding, now: Date.now() });
    if (!verdict.ok) { this.reject(call, verdict.reason); return; }
    const request = args as { task: string; files?: string[] };
    // The leaf would inherit a herdr selection; refuse it by name instead of overriding it to subprocess.
    if (prepareSpawnRuntime({ persona: target!, cwd: parent.cwd, runtimeEnv: this.deps.env }).runtime !== "subprocess") {
      this.reject(call, `persona ${target!.name} resolves to the herdr runtime; delegated leaves run on subprocess only until N5`);
      return;
    }
    const foreign = (request.files ?? []).find((f) => f.startsWith("run:") && this.deps.registry.get(f.slice(4))?.parentRunId !== parent.id);
    if (foreign) { this.reject(call, `files: ${foreign} is not a delegate child of this run`); return; }
    let task: string;
    try { task = appendFileEvidence(request.task, request.files, { cwd, registry: this.deps.registry, limit: cfg.inlineAttachmentLimitBytes }); }
    catch (e) { this.reject(call, (e as Error).message); return; }
    call.limit = cfg.inlineAttachmentLimitBytes;
    const result = this.deps.queue.enqueueOrSpawn({
      persona: target!, task, cwd, mode: "background", timeoutMs: verdict.timeoutMs, runtime: "subprocess", runtimeEnv: this.deps.env,
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
    const leaf = call.leafId ? this.deps.registry.get(call.leafId) : undefined;
    if (call.done || !leaf || isTerminal(leaf.status)) return;
    if (leaf.status === "queued") {
      this.reject(call, `timeout: ${leaf.id} did not start before its deadline`);
      this.deps.queue.removeQueued(leaf.id);
    } else forceTerminate(leaf, "timeout", this.deps.registry);
  }

  private changed(run: Run): void {
    if (run.parentRunId !== undefined && run.delegateToolCallId !== undefined && isTerminal(run.status)) {
      const call = this.calls.get(`${run.parentRunId}\0${run.delegateToolCallId}`);
      if (call && !call.done) void this.finish(call, run);
    }
    if (isTerminal(run.status) && (run.pendingDelegations ?? 0) > 0) {
      for (const call of [...this.calls.values()]) if (call.parent === run) this.cancel(call, `parent ${run.id} ended (${run.status})`);
    }
  }

  private async finish(call: Call, leaf: Run): Promise<void> {
    this.settle(call);
    await leaf.recordWrite;
    await writeFinal(leaf); // resultRef needs the persisted final; same bytes as the pipeline's write
    this.respond(call.parent, call.id, { ok: true, agentId: leaf.id, status: leaf.status, envelope: formatDelegateEnvelope(leaf, call.limit ?? 131072) });
  }

  /** Answer first, so the leaf's own terminal notification cannot answer the call as a result. */
  private cancel(call: Call, reason: string): void {
    if (call.done) return;
    this.reject(call, `cancelled: ${reason}`);
    const leaf = call.leafId ? this.deps.registry.get(call.leafId) : undefined;
    if (!leaf || isTerminal(leaf.status)) return;
    if (leaf.status === "queued") this.deps.queue.removeQueued(leaf.id);
    else forceTerminate(leaf, "killed", this.deps.registry);
  }

  private reject(call: Call, reason: string): void {
    if (call.done) return;
    this.settle(call);
    this.respond(call.parent, call.id, { ok: false, reason });
  }

  private settle(call: Call): void {
    call.done = true;
    clearTimeout(call.timer);
    this.calls.delete(`${call.parent.id}\0${call.id}`);
    call.parent.pendingDelegations = Math.max(0, (call.parent.pendingDelegations ?? 1) - 1);
    this.deps.registry.notify(call.parent);
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
   * Approved R6 fallback on reload: the new module instance has no event source for
   * subprocess parents, so every parent with an outstanding call is stopped, leaves
   * first, with a named diagnostic. Parents with nothing outstanding keep running.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.starts.clear();
    const pending = [...this.calls.values()];
    const parents = [...new Set(pending.map((c) => c.parent))];
    const leaves = pending.map((c) => (c.leafId ? this.deps.registry.get(c.leafId) : undefined)).filter((r): r is Run => !!r);
    for (const call of pending) this.cancel(call, RELOAD_INTERRUPTED);
    this.unsubscribe();
    for (const parent of parents) {
      if (isTerminal(parent.status)) continue;
      parent.errorMessage = RELOAD_INTERRUPTED;
      forceTerminate(parent, "killed", this.deps.registry, parent.onComplete);
    }
    await Promise.allSettled([...leaves, ...parents].map((r) => r.recordWrite));
  }
}
