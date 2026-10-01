/**
 * N2 child tool. A depth-1 delegator's `delegate` call is brokered by the
 * lead from this run's own event stream; the tool only proves it executed
 * (its first update) and then awaits the broker's create-only response.
 */
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { MAX_DELEGATE_TARGETS, resolvePersonas } from "./personas.ts";
import { resolveTimeoutMs } from "./runs.ts";
import { delegatePaths, delegateWaitDeadline, isDelegateCallId, parseDelegateArgs, type DelegateResponse } from "./delegation.ts";

const NAME = /^[A-Za-z0-9_.:-]+$/;
const POLL_MS = 1000;

/** The allowlist the launcher set, or undefined when this env is not an eligible depth-1 delegator. */
export function delegatorAllowlist(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.CONDUCTOR_SUBAGENT !== "1" || env.CONDUCTOR_DEPTH !== "1" || !env.CONDUCTOR_RUN_DIR || !env.CONDUCTOR_RUN_ID) return undefined;
  const names = (env.CONDUCTOR_DELEGATE_ALLOW ?? "").split(",");
  if (!names[0] || names.length > MAX_DELEGATE_TARGETS || names.some((n) => !NAME.test(n)) || new Set(names).size !== names.length) return undefined;
  return names;
}

export function registerDelegate(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  const allow = delegatorAllowlist(env);
  if (!allow) return;
  const runDir = env.CONDUCTOR_RUN_DIR!, runId = env.CONDUCTOR_RUN_ID!;
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: `Run one bounded read-only task with a leaf sub-agent and wait for its result. Allowed personas: ${allow.join(", ")}. ` +
      "Several calls in one turn run in parallel. The leaf cannot edit, delegate or ask questions; it may end with QUESTION: for you to decide.",
    promptSnippet: `Delegate bounded read-only work to: ${allow.join(", ")}`,
    parameters: Type.Object({
      persona: Type.String({ description: `One of: ${allow.join(", ")}` }),
      task: Type.String({ description: "Complete, self-contained task for the leaf (at most 64 KiB)." }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Local paths (relative to your cwd) or run:<agent_id> of your own earlier delegate results." })),
      timeout_minutes: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      if (!isDelegateCallId(toolCallId)) throw new Error("delegate rejected: nested calls cannot delegate; call delegate directly");
      const parsed = parseDelegateArgs(params);
      if (!parsed.ok) throw new Error(`delegate rejected: ${parsed.reason}`);
      if (signal?.aborted) throw new Error("delegate aborted");
      const paths = delegatePaths(runDir, toolCallId);
      if (existsSync(paths.claim) || existsSync(paths.response)) throw new Error(`delegate rejected: call id ${toolCallId} was already used in this run`);
      const startedAt = Date.now();
      // The lead spawns only after seeing this update: it is the proof that execute ran.
      onUpdate?.({ content: [{ type: "text", text: `delegating to ${parsed.args.persona}; waiting for the lead` }], details: {} });
      let personaTimeoutMs: number | undefined;
      try {
        const cfg = loadConfig(env.CONDUCTOR_CONFIG_CWD || process.cwd());
        const target = (await resolvePersonas({ cwd: env.CONDUCTOR_CONFIG_CWD || process.cwd(), personaOverrides: cfg.personaOverrides })).personas.get(parsed.args.persona);
        if (target) personaTimeoutMs = resolveTimeoutMs(target, cfg.personaOverrides[target.name], cfg);
      } catch { /* the broker is authoritative; fall back to the run's own bounds */ }
      const ownDeadline = Number(env.CONDUCTOR_DEADLINE_AT);
      const deadlineAt = delegateWaitDeadline({ startedAt, timeoutMinutes: parsed.args.timeout_minutes, personaTimeoutMs,
        ownDeadlineAt: Number.isFinite(ownDeadline) && ownDeadline > 0 ? ownDeadline : undefined });
      const response = await waitForDelegateResponse(paths.response, { toolCallId, parentRunId: runId }, deadlineAt, signal);
      if (!response.ok) {
        const reason = response.reason!;
        throw new Error(reason.startsWith("cancelled: ") ? `delegate cancelled: ${reason.slice("cancelled: ".length)}` : `delegate rejected: ${reason}`);
      }
      return { content: [{ type: "text" as const, text: response.envelope! }], details: { agentId: response.agentId, status: response.status } };
    },
  });
}

function validResponse(value: unknown, expect: { toolCallId: string; parentRunId: string }): value is DelegateResponse {
  const r = value as Partial<DelegateResponse> | null;
  return !!r && typeof r === "object" && r.v === 1 && r.toolCallId === expect.toolCallId && r.parentRunId === expect.parentRunId &&
    (r.ok === true ? typeof r.envelope === "string" : r.ok === false && typeof r.reason === "string");
}

/** fs.watch plus a 1 s poll, bounded by `deadlineAt` and `signal`; every handle is released on settle. */
export function waitForDelegateResponse(path: string, expect: { toolCallId: string; parentRunId: string }, deadlineAt: number, signal?: AbortSignal): Promise<DelegateResponse> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(path), { recursive: true });
    let settled = false;
    const cleanup: (() => void)[] = [];
    const finish = (error: Error | undefined, value?: DelegateResponse) => {
      if (settled) return;
      settled = true;
      for (const release of cleanup) release();
      if (error) reject(error); else resolve(value!);
    };
    const check = () => {
      if (settled || !existsSync(path)) return;
      let value: unknown;
      try { value = JSON.parse(readFileSync(path, "utf8")); } catch { value = undefined; }
      if (validResponse(value, expect)) finish(undefined, value);
      else finish(new Error("delegate rejected: malformed or foreign broker response"));
    };
    const onAbort = () => finish(new Error("delegate aborted"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => signal?.removeEventListener("abort", onAbort));
    const watcher = watch(dirname(path), () => check());
    watcher.on("error", () => {}); // the poll still observes the file
    cleanup.push(() => watcher.close());
    const poll = setInterval(check, POLL_MS);
    cleanup.push(() => clearInterval(poll));
    // No answer is not proof of rejection: a leaf may have run.
    const timer = setTimeout(() => finish(new Error("delegate outcome unconfirmed: no broker response before the deadline; a leaf may have run")), Math.max(0, deadlineAt - Date.now()));
    cleanup.push(() => clearTimeout(timer));
    check();
  });
}
