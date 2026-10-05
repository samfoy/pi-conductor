import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { hasRetirement } from "./context-retirement.ts";
import { appendFileEvidence } from "./file-evidence.ts";
import type { RunRegistry } from "./runs.ts";

/**
 * A6 sole-call check, shared by `ask_owner` and S4 `chief ask`: Pi persists the
 * finalized assistant message before executing its tools, so the latest assistant
 * message on the branch must hold exactly this one call.
 */
export function isSoleToolCall(branch: readonly unknown[], name: string, id: string): boolean {
  const last = [...branch].reverse().find(e => (e as { type?: unknown }).type === "message" && (e as { message?: { role?: unknown } }).message?.role === "assistant") as
    { message: { content?: unknown } } | undefined;
  const content = last?.message.content;
  const calls = Array.isArray(content) ? content.filter(p => (p as { type?: unknown })?.type === "toolCall") as { name?: unknown; id?: unknown }[] : [];
  return calls.length === 1 && calls[0]!.name === name && calls[0]!.id === id;
}

export function registerAskOwner(pi: ExtensionAPI, getRegistry: () => RunRegistry, env: NodeJS.ProcessEnv): void {
  let outstanding = false;
  pi.registerTool({
    name: "ask_owner",
    label: "Ask owner",
    description: "Ask one blocking question required to continue your current assignment. Call alone as the only tool in this assistant turn. Ends your turn; the owner answers via ensemble_send in your saved session. Not a progress or generic messaging channel.",
    parameters: Type.Object({ question: Type.String(), files: Type.Optional(Type.Array(Type.String())) }),
    async execute(id, params, signal, _update, ctx) {
      if (!env.CONDUCTOR_RUN_ID || ctx.isIdle() || signal?.aborted || !ctx.sessionManager.getSessionFile()) throw new Error("ask_owner requires an active managed child context with a saved session");
      if (outstanding) throw new Error("An owner question is already outstanding");
      if (typeof params.question !== "string" || !params.question.trim()) throw new Error("question must contain non-whitespace text");
      if (ctx.hasPendingMessages()) throw new Error("Cannot ask with queued messages; process the owner messages first");
      if (!isSoleToolCall(ctx.sessionManager.getBranch(), "ask_owner", id)) throw new Error("Call ask_owner alone as the only tool call in the assistant turn");
      const config = loadConfig(env.CONDUCTOR_CONFIG_CWD || ctx.cwd);
      if (config.contextRetirement && hasRetirement(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId())) throw new Error("Session retired; return a handoff for a fresh child instead of asking for an impossible continuation");
      const question = params.question.trim();
      const evidence = appendFileEvidence("", params.files, { cwd: ctx.cwd, registry: getRegistry(), limit: config.inlineAttachmentLimitBytes });
      outstanding = true;
      return { content: [{ type: "text", text: "Assignment blocked. Your owner will answer this question via ensemble_send; stop and wait." }], details: { askId: id, question, evidence }, terminate: true };
    },
  });
}

export function formatOwnerAnswer(ask: { askId: string; question: string }, text: string): string {
  return `<owner-answer ask-id=${JSON.stringify(ask.askId)}>\nQuestion: ${ask.question}\nAnswer: ${text}\nContinue the original assignment, not a new task.\n</owner-answer>`;
}
