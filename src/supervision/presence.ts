/**
 * S1 lead presence: while a conductor-ON herdr lead with a saved session is
 * eligible, it publishes one bounded record and activates `peer`. Each
 * activation captures an immutable identity with a fresh epoch; every write is
 * fenced on it, so a superseded activation (OFF, shutdown, reload, session
 * switch) can neither republish nor delete. No herdr CLI call is ever made.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effortGit } from "../effort/open.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import type { RunRegistry } from "../runs.ts";
import {
  buildLeadRecord, createLeadRecord, leadLiveness, leadPath, readLeadRecord, removeLeadRecordIf, replaceLeadRecord, sameLeadIdentity, sameLeadVersion,
  type LeadIdentity, type LeadRecord, type LivenessOptions,
} from "./store.ts";

export const HEARTBEAT_MS = 30_000;
export const REGISTRY_DEBOUNCE_MS = 2_000;
const ENV_KEYS = ["CONDUCTOR_SUBAGENT", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"] as const;

export interface SessionFacts { sessionId?: string; sessionFile?: string; cwd: string }
export type Eligibility = { ok: true; socketPath: string; paneId: string; tabId?: string; workspaceId?: string } | { ok: false; reason: string };

/** A lead in a herdr pane. A pi typed by hand into a managed pane inherits CONDUCTOR_SUBAGENT=1 and is not one. */
export function herdrLeadEnv(env: NodeJS.ProcessEnv): boolean {
  return env.CONDUCTOR_SUBAGENT !== "1" && env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID;
}

export function leadEligibility(env: NodeJS.ProcessEnv, modeOn: boolean, session: Omit<SessionFacts, "cwd">): Eligibility {
  if (env.CONDUCTOR_SUBAGENT === "1") return { ok: false, reason: "this pi is a conductor sub-agent (CONDUCTOR_SUBAGENT=1)" };
  if (env.HERDR_ENV !== "1") return { ok: false, reason: "not a herdr pane (HERDR_ENV is not 1)" };
  if (!env.HERDR_SOCKET_PATH) return { ok: false, reason: "HERDR_SOCKET_PATH is unset" };
  if (!env.HERDR_PANE_ID) return { ok: false, reason: "HERDR_PANE_ID is unset" };
  if (!modeOn) return { ok: false, reason: "conductor mode OFF" };
  if (!session.sessionId) return { ok: false, reason: "no pi session id" };
  if (!session.sessionFile) return { ok: false, reason: "no saved session file (--no-session)" };
  return { ok: true, socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID,
    ...(env.HERDR_TAB_ID ? { tabId: env.HERDR_TAB_ID } : {}), ...(env.HERDR_WORKSPACE_ID ? { workspaceId: env.HERDR_WORKSPACE_ID } : {}) };
}

export interface PresenceStatus {
  state: "inactive" | "published" | "duplicate" | "error";
  reason?: string;
  sessionId?: string; generation?: string; path?: string;
  lastError?: string;
  toolOwned: boolean; toolActive?: boolean;
}

interface Timers { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface PresenceDeps {
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "getAllTools" | "getSessionName">;
  env: NodeJS.ProcessEnv;
  registry: Pick<RunRegistry, "list" | "onChange" | "countActive">;
  getMode: () => boolean;
  now?: () => number;
  timers?: Timers;
  liveness?: LivenessOptions;
  describeRepo?: (cwd: string) => { repo?: string; branch?: string };
}

interface Activation {
  readonly identity: LeadIdentity;
  readonly path: string;
  readonly cwd: string;
  readonly placement: Extract<Eligibility, { ok: true }>;
  readonly repo: { repo?: string; branch?: string };
  timer?: unknown;
  due: number;
  unsubscribe?: () => void;
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const message = (e: unknown) => (e as Error)?.message ?? String(e);
class Lost extends Error {}

/** Presentation only, read once per activation: repository basename and branch, if the cwd is a git checkout. */
function gitDescription(cwd: string): { repo?: string; branch?: string } {
  try { return { repo: basename(effortGit(cwd, "rev-parse", "--show-toplevel")), branch: effortGit(cwd, "rev-parse", "--abbrev-ref", "HEAD") }; }
  catch { return {}; }
}

export class LeadPresence {
  private readonly env: NodeJS.ProcessEnv;
  private readonly pid = process.pid;
  private readonly pidStartTime = readProcessStartTime(process.pid);
  /** Owned supervision tool names, each active only while published and its own condition (if any) holds. */
  private readonly owned = new Map<string, (() => boolean) | undefined>();
  private session?: Readonly<SessionFacts>;
  private notify?: (message: string, level: "info" | "warning" | "error") => void;
  private active?: Activation;
  private state: Omit<PresenceStatus, "toolOwned" | "toolActive"> = { state: "inactive", reason: "no session started" };

  constructor(private readonly deps: PresenceDeps) {
    this.env = Object.freeze(Object.fromEntries(ENV_KEYS.map(k => [k, deps.env[k]])));
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h as NodeJS.Timeout) };
  }

  private readonly now: () => number;
  private readonly timers: Timers;
  livenessOptions(): LivenessOptions { return { now: this.now, ...this.deps.liveness }; }

  /** Marks a supervision tool name this lead registered; only owned names are ever (de)activated. `when` narrows it (S3: `staff` only for the chief). */
  ownTool(name: string, when?: () => boolean): void { this.owned.set(name, when); }

  start(session: SessionFacts, notify?: (message: string, level: "info" | "warning" | "error") => void): void {
    this.stop();
    this.session = Object.freeze({ sessionId: session.sessionId, sessionFile: session.sessionFile, cwd: session.cwd });
    this.notify = notify;
    this.refresh();
  }

  /** Re-evaluates eligibility (mode, env, session): publishes, or unpublishes, then syncs owned tools. */
  refresh(): void {
    const eligibility = this.eligibility();
    if (!eligibility.ok) {
      this.deactivate();
      this.state = { state: "inactive", reason: eligibility.reason };
    } else if (!this.active) this.activate(eligibility);
    this.syncTools();
  }

  /** Every shutdown reason: unpublish only an own record and dispose timers. The session is being torn down. */
  stop(): void {
    this.deactivate();
    this.session = undefined;
    this.notify = undefined;
    this.state = { state: "inactive", reason: "no session started" };
  }

  status(): PresenceStatus {
    const eligibility = this.eligibility();
    let toolActive: boolean | undefined;
    // The unconditional names (`peer`); a conditional one reports through its own owner.
    try { toolActive = this.owned.size ? this.deps.pi.getActiveTools().some(n => this.owned.has(n) && !this.owned.get(n)) : undefined; } catch { /* not bound */ }
    return { ...this.state, ...(this.state.state === "inactive" && !eligibility.ok ? { reason: eligibility.reason } : {}), toolOwned: this.owned.size > 0, toolActive };
  }

  /** Execution-time revalidation: still eligible, and the record on disk is this activation's own. */
  assertOwned(): LeadRecord {
    const eligibility = this.eligibility();
    if (!eligibility.ok) throw new Error(`peer unavailable: ${eligibility.reason}`);
    const act = this.active;
    if (!act) throw new Error(`peer unavailable: ${this.state.reason ?? "lead presence is not published"}`);
    const record = readLeadRecord(act.path);
    if (!record || !sameLeadIdentity(record, act.identity)) throw new Error("peer unavailable: this lead's presence record is not its own");
    return record;
  }

  /** Adds or removes only owned names in the current native active set; Pi's allow/exclude filtering wins. */
  syncTools(): void {
    if (this.owned.size === 0) return;
    const { pi } = this.deps;
    try {
      const active = pi.getActiveTools();
      const available = new Set(pi.getAllTools().map(t => t.name));
      const wanted = (n: string) => !!this.active && (this.owned.get(n)?.() ?? true);
      const next = [...active.filter(n => !this.owned.has(n) || wanted(n)), ...[...this.owned.keys()].filter(n => wanted(n) && !active.includes(n) && available.has(n))];
      if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
    } catch (e) { this.state = { ...this.state, lastError: `tool sync failed: ${message(e)}` }; }
  }

  private eligibility(): Eligibility {
    return this.session ? leadEligibility(this.env, this.deps.getMode(), this.session) : { ok: false, reason: "no session started" };
  }

  private activate(placement: Extract<Eligibility, { ok: true }>): void {
    const session = this.session!;
    const identity: LeadIdentity = { sessionId: session.sessionId!, sessionFile: session.sessionFile!, pid: this.pid,
      ...(this.pidStartTime !== undefined ? { pidStartTime: this.pidStartTime } : {}), generation: randomUUID() };
    const act: Activation = { identity, path: leadPath(identity.sessionId), cwd: session.cwd, placement,
      repo: (this.deps.describeRepo ?? gitDescription)(session.cwd), due: 0 };
    this.active = act;
    try {
      this.publishFirst(act);
    } catch (e) {
      this.active = undefined;
      const duplicate = e instanceof Lost || errno(e) === "EEXIST";
      const reason = duplicate ? (e instanceof Lost ? e.message : `session ${identity.sessionId} already has a live lead presence`) : `presence not published: ${message(e)}`;
      this.state = { state: duplicate ? "duplicate" : "error", reason, sessionId: identity.sessionId, path: act.path };
      this.notify?.(`conductor supervision: ${reason}; peer stays inactive.`, "warning");
      return;
    }
    this.state = { state: "published", sessionId: identity.sessionId, generation: identity.generation, path: act.path };
    act.unsubscribe = this.deps.registry.onChange(() => this.schedule(act, REGISTRY_DEBOUNCE_MS));
    this.schedule(act, HEARTBEAT_MS);
  }

  private deactivate(): void {
    const act = this.active;
    if (!act) return;
    this.dispose(act);
    try { removeLeadRecordIf(act.path, r => sameLeadIdentity(r, act.identity)); }
    catch (e) { this.state = { ...this.state, lastError: `unpublish failed: ${message(e)}` }; }
  }

  private dispose(act: Activation): void {
    if (this.active === act) this.active = undefined;
    if (act.timer !== undefined) this.timers.clearTimeout(act.timer);
    act.timer = undefined;
    act.unsubscribe?.();
  }

  private fence(act: Activation): () => void {
    return () => { if (this.active !== act) throw new Error("lead presence fenced: superseded activation"); };
  }

  private record(act: Activation): LeadRecord {
    const runs = this.deps.registry.list();
    let name: string | undefined;
    try { name = this.deps.pi.getSessionName(); } catch { /* presentation only */ }
    return buildLeadRecord({ ...act.identity, socketPath: act.placement.socketPath, paneId: act.placement.paneId,
      ...(act.placement.tabId ? { tabId: act.placement.tabId } : {}), ...(act.placement.workspaceId ? { workspaceId: act.placement.workspaceId } : {}),
      cwd: act.cwd, ...act.repo, displayName: name ?? basename(act.cwd),
      runs: { active: this.deps.registry.countActive(), blocked: runs.filter(r => r.status === "blocked").length, total: runs.length },
      runsBrief: [...runs].sort((a, b) => b.startTime - a.startTime)
        .map(r => ({ id: r.id, persona: r.persona, status: r.status, ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}) })),
      updatedAt: this.now() });
  }

  /** Create-only; an existing record is replaced only when its owner is proven dead. */
  private publishFirst(act: Activation): void {
    try { createLeadRecord(this.record(act), this.fence(act)); return; }
    catch (e) { if (errno(e) !== "EEXIST") throw e; }
    const existing = readLeadRecord(act.path);
    if (existing) {
      const state = leadLiveness(existing, this.livenessOptions());
      if (state !== "dead") throw new Lost(`session ${act.identity.sessionId} already has a ${state === "live" ? "live" : "possibly live (unproven)"} lead presence (pid ${existing.pid})`);
      removeLeadRecordIf(act.path, r => sameLeadVersion(r, existing));
    }
    createLeadRecord(this.record(act), this.fence(act));
  }

  /** One timer per activation: the heartbeat, pulled forward to 2 s by a registry change. */
  private schedule(act: Activation, ms: number): void {
    if (this.active !== act) return;
    const due = this.now() + ms;
    if (act.timer !== undefined && act.due <= due) return;
    if (act.timer !== undefined) this.timers.clearTimeout(act.timer);
    act.due = due;
    act.timer = this.timers.setTimeout(() => {
      if (this.active !== act) return;
      act.timer = undefined;
      this.republish(act);
      this.schedule(act, HEARTBEAT_MS);
    }, ms);
    (act.timer as { unref?: () => void }).unref?.();
  }

  private republish(act: Activation): void {
    const fence = this.fence(act);
    const lost = () => new Lost(`another instance published session ${act.identity.sessionId}'s presence`);
    try {
      let vanished = false;
      try {
        replaceLeadRecord(this.record(act), () => {
          fence();
          const current = readLeadRecord(act.path);
          if (!current) { vanished = true; throw new Error("lead record vanished"); }
          if (!sameLeadIdentity(current, act.identity)) throw lost();
        });
      } catch (e) {
        if (!vanished) throw e;
        // Swept (off Linux, stale) or removed by hand: re-create create-only; EEXIST means another owner won.
        try { createLeadRecord(this.record(act), fence); } catch (again) { throw errno(again) === "EEXIST" ? lost() : again; }
      }
      this.state = { ...this.state, lastError: undefined };
    } catch (e) {
      if (this.active !== act) return;
      if (!(e instanceof Lost)) { this.state = { ...this.state, lastError: message(e) }; return; }
      this.dispose(act);
      this.state = { state: "duplicate", reason: e.message, sessionId: act.identity.sessionId, path: act.path };
      this.notify?.(`conductor supervision: ${e.message}; peer is now inactive.`, "warning");
      this.syncTools();
    }
  }
}
