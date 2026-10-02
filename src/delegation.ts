/**
 * N2 delegation: pure request validation, file layout and envelope bounds
 * shared by the lead broker (`delegation-broker.ts`) and the child tool
 * (`delegate-tool.ts`); N3 admission load; N4 ownership (lineage, the
 * child-first kill cascade and the finalization gate). Read-only leaves are a tool and prompt boundary,
 * not an OS sandbox; same-uid forgery of `delegate/*` is out of scope.
 */
import { join } from "node:path";
import { compactEnvelopeBlock, summarizeResultText } from "./compaction-hook.ts";
import { resultRef } from "./file-evidence.ts";
import { formatCompletionNotification } from "./notifications.ts";
import { forceTerminate, getCompletionText, type RunRegistry } from "./runs.ts";
import { consumesSlot, holdsSlot } from "./effort/admit.ts";
import { childToolScope, runScopeError } from "./personas.ts";
import { WRITE_CAPABLE_PERSONAS, isDelegating, isTerminal, type AbandonedChild, type Persona, type Run } from "./types.ts";

export const MAX_DELEGATE_TASK_BYTES = 65536;
export const MAX_OUTSTANDING_DELEGATIONS = 8;
/** How long a child waits past its clamped leaf deadline before reporting no broker response. */
export const DELEGATE_RESPONSE_GRACE_MS = 120_000;
export const RELOAD_INTERRUPTED = "lead /reload interrupted subprocess delegation; resume with ensemble_send";

const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Model-issued ids only: Pi 0.99 nested calls are `<parent>/<n>` and never delegate. */
export function isDelegateCallId(id: unknown): id is string {
  return typeof id === "string" && CALL_ID.test(id);
}

/** `claim` is the at-most-once spawn ledger; `response` is what the child awaits. Both are create-only. */
export function delegatePaths(runDir: string, toolCallId: string): { dir: string; claim: string; response: string } {
  const dir = join(runDir, "delegate");
  return { dir, claim: join(dir, `${toolCallId}.claim.json`), response: join(dir, `${toolCallId}.json`) };
}

export interface DelegateArgs { persona: string; task: string; files?: string[]; timeout_minutes?: number }

export interface DelegateResponse {
  v: 1; toolCallId: string; parentRunId: string; ok: boolean;
  reason?: string; agentId?: string; status?: Run["status"]; envelope?: string;
}

/** Shape checks both sides run; the child fails fast on the same reasons the broker would give. */
export function parseDelegateArgs(args: unknown): { ok: true; args: DelegateArgs } | { ok: false; reason: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, reason: "arguments must be an object" };
  const a = args as Record<string, unknown>;
  if (typeof a.persona !== "string" || !a.persona.trim()) return { ok: false, reason: "persona must be a non-empty string" };
  if (typeof a.task !== "string" || !a.task.trim()) return { ok: false, reason: "task must contain non-whitespace text" };
  if (Buffer.byteLength(a.task) > MAX_DELEGATE_TASK_BYTES) return { ok: false, reason: `task exceeds ${MAX_DELEGATE_TASK_BYTES} bytes` };
  if (a.files !== undefined && (!Array.isArray(a.files) || a.files.some((f) => typeof f !== "string"))) return { ok: false, reason: "files must be an array of strings" };
  if (a.timeout_minutes !== undefined && (typeof a.timeout_minutes !== "number" || !Number.isInteger(a.timeout_minutes) || a.timeout_minutes < 1)) {
    return { ok: false, reason: "timeout_minutes must be a positive integer" };
  }
  return { ok: true, args: { persona: a.persona, task: a.task, files: a.files as string[] | undefined, timeout_minutes: a.timeout_minutes as number | undefined } };
}

export interface DelegateRequestInput {
  args: unknown;
  parent: Run;
  /** The registry still maps the parent's id to this run object. */
  current: boolean;
  /** The target as the current roster resolves it, or undefined when unavailable. */
  target: Pick<Persona, "name" | "readOnly"> | undefined;
  personaTimeoutMs: number;
  /** The parent's other outstanding calls, excluding this one. */
  outstanding: number;
  now: number;
}

/** One fail-closed reason per check; on success the leaf's clamped timeout and absolute deadline. */
export function validateDelegateRequest(input: DelegateRequestInput): { ok: true; timeoutMs: number; deadlineAt: number } | { ok: false; reason: string } {
  const parsed = parseDelegateArgs(input.args);
  if (!parsed.ok) return parsed;
  const { args } = parsed;
  const { parent, target } = input;
  const scope = { depth: parent.depth ?? 1, delegateAllow: parent.delegateAllow ?? [] };
  if (!isDelegating(scope)) return { ok: false, reason: "only a depth-1 delegator may delegate" };
  if (parent.runtime === "herdr") return { ok: false, reason: "delegation supports subprocess parents only until N5" };
  if (parent.status !== "running") return { ok: false, reason: `parent ${parent.id} is ${parent.status}, not running` };
  if (parent.delegationClosed) return { ok: false, reason: `parent ${parent.id} is finalizing; it starts no new delegation` };
  if (!input.current) return { ok: false, reason: `parent ${parent.id} is not the current registered run` };
  if (!scope.delegateAllow.includes(args.persona)) {
    return { ok: false, reason: `persona ${args.persona} is not in this run's delegation allowlist (${scope.delegateAllow.join(", ")})` };
  }
  if (!target || target.name !== args.persona) return { ok: false, reason: `persona ${args.persona} is not available` };
  if (WRITE_CAPABLE_PERSONAS.has(target.name)) return { ok: false, reason: `persona ${target.name} is write-capable` };
  if (target.readOnly !== true) return { ok: false, reason: `persona ${target.name} is not read_only` };
  if (input.outstanding >= MAX_OUTSTANDING_DELEGATIONS) {
    return { ok: false, reason: `parent ${parent.id} already has ${MAX_OUTSTANDING_DELEGATIONS} delegate calls outstanding` };
  }
  if (parent.deadlineAt === undefined) return { ok: false, reason: `parent ${parent.id} deadline is unknown` };
  const remaining = parent.deadlineAt - input.now;
  if (remaining <= 0) return { ok: false, reason: `parent ${parent.id} has no time left` };
  const timeoutMs = Math.min(input.personaTimeoutMs, remaining, args.timeout_minutes === undefined ? Infinity : args.timeout_minutes * 60_000);
  return { ok: true, timeoutMs, deadlineAt: input.now + timeoutMs };
}

/**
 * N3: the unanswered `delegate` calls a current, slot-holding depth-1 delegator
 * is blocked on. Zero for A6-blocked, terminal, depth-2, invalid-scope or
 * replaced runs. The panel's ⇣N, ensemble_status and stall suppression read it.
 */
export function awaitingChildren(parent: Run, runs: readonly Run[]): number {
  if (!consumesSlot(parent) || runScopeError(parent) || !isDelegating(childToolScope(parent)) || !runs.includes(parent)) return 0;
  return parent.pendingDelegations ?? 0;
}

/**
 * N3 admission load. `active` (A) counts slot reservations; `lending` (W) counts
 * awaiting delegators whose own slot a leaf of theirs holds, plus `candidate`, the
 * parent of a leaf about to run on that parent's slot. Executing work is A - W. A
 * claim or a queued leaf lends nothing, so a parent that stops waiting before its
 * leaf ran takes back no slot that another parent's leaf is using.
 */
export function delegationLoad(runs: readonly Run[], candidate?: Run): { active: number; lending: number } {
  const lends = (p: Run) => awaitingChildren(p, runs) > 0 && (p === candidate || runs.some((l) => l.depth === 2 && l.parentRunId === p.id && holdsSlot(l)));
  return { active: runs.filter(holdsSlot).length, lending: runs.filter(lends).length };
}

/**
 * N4: the depth-2 leaves `parent` directly owns, by exact lineage only: a depth-1
 * parent, a depth-2 run naming it, started at or after `since` (so never a reused
 * id's earlier leaf). Each id once. Pure over the given runs.
 */
export function childrenOf(parent: Run, runs: readonly Run[], since = parent.startTime): Run[] {
  if (parent.depth !== 1) return [];
  return [...new Map(runs.filter(r => r !== parent && r.depth === 2 && r.parentRunId === parent.id && r.startTime >= since).map(r => [r.id, r])).values()];
}

/** Lifetime cost of `root` plus each leaf it owns, each counted once: the `ensemble_auto` budget. */
export function subtreeCost(root: Run, runs: readonly Run[]): number {
  return childrenOf(root, runs).reduce((sum, leaf) => sum + leaf.usage.cost, root.usage.cost);
}

/** 2 s TERM→KILL plus time to reap and close the pipes. */
const CHILD_EXIT_BOUND_MS = 2_500;

/** What this module instance has observed of a leaf's process; undefined when nothing yet. A bare pid is unobservable. */
function observedExit(leaf: Run): AbandonedChild["exit"] | undefined {
  const t = leaf.transport;
  if (t?.kind === "herdr") return t.childExited ? "confirmed" : undefined;
  if (t?.kind !== "subprocess") return leaf.pid === undefined ? "confirmed" : undefined;
  if (t.proc.pid === undefined || leaf.processOpen !== true) return "confirmed";
  return t.proc.exitCode != null || t.proc.signalCode != null ? "stdio-open" : undefined;
}

/** Bounded: a subprocess gets CHILD_EXIT_BOUND_MS to close; herdr uses its own exit proof. Never waits for an answer. */
async function awaitExit(leaf: Run): Promise<AbandonedChild["exit"]> {
  const t = leaf.transport;
  if (observedExit(leaf) === "confirmed") return "confirmed";
  if (t?.kind === "herdr") return await t.waitForExit() ? "confirmed" : "unconfirmed";
  if (t?.kind !== "subprocess") return "unconfirmed";
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([t.closed, new Promise(resolve => { timer = setTimeout(resolve, CHILD_EXIT_BOUND_MS); })]);
  clearTimeout(timer);
  return observedExit(leaf) ?? "unconfirmed";
}

/** Merge by id, so the gate's waited exit replaces a kill's earlier `requested`. */
function noteAbandoned(parent: Run, leaves: readonly Run[], exits: readonly AbandonedChild["exit"][]): void {
  const entries = new Map((parent.abandonedChildren ?? []).map(c => [c.id, c]));
  leaves.forEach((leaf, i) => entries.set(leaf.id, { id: leaf.id, persona: leaf.persona, status: leaf.status, exit: exits[i]! }));
  parent.abandonedChildren = [...entries.values()];
}

/**
 * N4 cascade, before the parent's own termination: cancel the leaves the
 * current registered parent owns, queued ones first so a freed slot never
 * launches a leaf about to be cancelled. A stale or replaced parent object owns
 * nothing. Closes delegation for the parent and records what it abandoned.
 */
export function terminateChildren(parent: Run, registry: RunRegistry): void {
  if (parent.depth !== 1 || registry.get(parent.id) !== parent) return;
  parent.delegationClosed = true;
  const live = childrenOf(parent, registry.list()).filter(c => !isTerminal(c.status));
  const ordered = [...live.filter(c => c.status === "queued"), ...live.filter(c => c.status !== "queued")];
  for (const leaf of ordered) {
    leaf.errorMessage ??= `cancelled: parent ${parent.id} stopped before this leaf finished`;
    forceTerminate(leaf, "killed", registry);
  }
  if (ordered.length) noteAbandoned(parent, ordered, ordered.map(leaf => observedExit(leaf) ?? "requested"));
}

/**
 * N4 finalization gate, before any of the parent's hook, merge, footprint,
 * integration, final.md, terminal record or card: cancel this invocation's
 * unsettled leaves (started at or after `since`) and wait, bounded, for each
 * process to exit. A terminal status is not an exit.
 */
export async function settleOwnedChildren(parent: Run, registry: RunRegistry, since: number): Promise<void> {
  if (parent.depth !== 1 || registry.get(parent.id) !== parent) return;
  parent.delegationClosed = true;
  const abandoned = new Set(parent.abandonedChildren?.map(c => c.id));
  const owned = childrenOf(parent, registry.list(), since).filter(c => abandoned.has(c.id) || !isTerminal(c.status) || observedExit(c) !== "confirmed");
  if (!owned.length) return;
  terminateChildren(parent, registry);
  noteAbandoned(parent, owned, await Promise.all(owned.map(awaitExit)));
}

/** The child's own bound: the same clamp from its side, plus the response grace. */
export function delegateWaitDeadline(o: { startedAt: number; timeoutMinutes?: number; personaTimeoutMs?: number; ownDeadlineAt?: number }): number {
  const limits = [o.personaTimeoutMs, o.timeoutMinutes === undefined ? undefined : o.timeoutMinutes * 60_000,
    o.ownDeadlineAt === undefined ? undefined : o.ownDeadlineAt - o.startedAt].filter((n): n is number => n !== undefined && Number.isFinite(n));
  return o.startedAt + Math.max(0, Math.min(...limits, 24 * 3_600_000)) + DELEGATE_RESPONSE_GRACE_MS;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeXml(s).replace(/"/g, "&quot;");

/**
 * The leaf's canonical completion envelope, aiming for `limit` bytes. Over the
 * limit the result body is replaced by a summary plus where the whole answer
 * lives (`result-ref`, `final.md`), never a cut `<result>`. The last, minimal
 * form is not re-checked: it is bounded by a constant (~2 KB), not by `limit`.
 */
export function formatDelegateEnvelope(leaf: Run, limit: number): string {
  const full = formatCompletionNotification(leaf, []);
  if (Buffer.byteLength(full) <= limit) return full;
  const text = getCompletionText(leaf);
  const omitted = `  <result-omitted bytes="${Buffer.byteLength(text)}" path="${escapeAttr(leaf.finalPath)}">envelope exceeded ${limit} bytes; read the full result from result-ref or path</result-omitted>`;
  const compact = compactEnvelopeBlock(full).replace("</sub-agent-completed>", `${omitted}\n</sub-agent-completed>`);
  if (Buffer.byteLength(compact) <= limit) return compact;
  const ref = resultRef(leaf);
  const lines = ["```xml", "<sub-agent-completed>", `  <agent-id>${escapeXml(leaf.id)}</agent-id>`, `  <persona>${escapeXml(leaf.persona)}</persona>`,
    `  <status>${leaf.status}</status>`, ...(ref ? [`  <result-ref>${ref}</result-ref>`] : []),
    ...(leaf.errorMessage ? [`  <error-omitted bytes="${Buffer.byteLength(leaf.errorMessage)}">see the transcript</error-omitted>`] : []),
    ...(text ? [`  <result-summary>${escapeXml(summarizeResultText(text))}</result-summary>`] : []),
    omitted, `  <transcript>${escapeXml(leaf.transcriptPath)}</transcript>`, "</sub-agent-completed>", "```"];
  return lines.join("\n");
}
