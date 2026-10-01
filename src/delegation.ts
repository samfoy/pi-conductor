/**
 * N2 delegation: pure request validation, file layout and envelope bounds
 * shared by the lead broker (`delegation-broker.ts`) and the child tool
 * (`delegate-tool.ts`). Read-only leaves are a tool and prompt boundary,
 * not an OS sandbox; same-uid forgery of `delegate/*` is out of scope.
 */
import { join } from "node:path";
import { compactEnvelopeBlock, summarizeResultText } from "./compaction-hook.ts";
import { resultRef } from "./file-evidence.ts";
import { formatCompletionNotification } from "./notifications.ts";
import { getCompletionText } from "./runs.ts";
import { WRITE_CAPABLE_PERSONAS, isDelegating, type Persona, type Run } from "./types.ts";

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

/** The child's own bound: the same clamp from its side, plus the response grace. */
export function delegateWaitDeadline(o: { startedAt: number; timeoutMinutes?: number; personaTimeoutMs?: number; ownDeadlineAt?: number }): number {
  const limits = [o.personaTimeoutMs, o.timeoutMinutes === undefined ? undefined : o.timeoutMinutes * 60_000,
    o.ownDeadlineAt === undefined ? undefined : o.ownDeadlineAt - o.startedAt].filter((n): n is number => n !== undefined && Number.isFinite(n));
  return o.startedAt + Math.max(0, Math.min(...limits, 24 * 3_600_000)) + DELEGATE_RESPONSE_GRACE_MS;
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeXml(s).replace(/"/g, "&quot;");

/**
 * The leaf's canonical completion envelope, within `limit` bytes. Over the
 * limit the result body is replaced by a summary plus where the whole
 * answer lives (`result-ref`, `final.md`), never a cut `<result>`.
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
