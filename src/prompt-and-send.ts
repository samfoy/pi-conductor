/**
 * Slice 7 (overlay redesign): extracted `promptAndSendToRun`.
 *
 * Originally an inner closure of `setupConductor` in `src/index.ts`.
 * Lifted into its own module so:
 *   1. The `presuppliedText` overload (the InputPane's onSubmit
 *      forwards the Editor buffer here, skipping the `ctx.ui.input`
 *      modal) is unit-testable without spinning up an
 *      ExtensionContext.
 *   2. The "all six preserved steps" contract (validateSendable,
 *      persona resolution, resolveTimeoutMs, sendToRun,
 *      pushCompletionNotification, rejection notify) survives
 *      regression by being directly asserted in
 *      `tests/promptAndSendToRun.test.ts`.
 *
 * Behaviour parity with the previous inline implementation:
 *   - `agentId` not in the registry → notify, abort.
 *   - validateSendable fails → notify the rejection reason, abort.
 *   - `presuppliedText` provided AND non-empty after trim → use it as
 *     the message; the `ctx.ui.input` modal is NOT opened.
 *   - `presuppliedText` empty / whitespace / undefined → open the
 *     modal (or, when `presuppliedText` is given but trims to empty,
 *     return early without sending — matches the design §9
 *     "whitespace-only Enter is a no-op" rule for the InputPane).
 *   - sendToRun runs with `onComplete: pushCompletionNotification`.
 *   - sendToRun rejected → notify the reason.
 */

import type { Run } from "./types.ts";
import type { RunRegistry } from "./runs.ts";

export interface PromptAndSendCtx {
  ui: {
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, kind?: string): void;
  };
}

export interface PromptAndSendDeps {
  getCtx: () => PromptAndSendCtx | null | undefined;
  registry: RunRegistry;
  cwd: string;
  validateSendable: (run: Run) => { ok: true } | { ok: false; reason: string };
  loadConfig: (cwd: string) => { personaOverrides: Record<string, unknown> };
  resolvePersonas: (args: {
    cwd: string;
    personaOverrides: Record<string, unknown>;
  }) => Promise<{ personas: Map<string, unknown> }>;
  resolveTimeoutMs: (
    persona: unknown,
    overrides: unknown,
    cfg: unknown,
  ) => number;
  sendToRun: (
    run: Run,
    message: string,
    opts: {
      registry: RunRegistry;
      timeoutMs: number;
      onComplete: (r: Run) => void;
    },
  ) => { kind: "queued" } | { kind: "rejected"; reason: string };
  pushCompletionNotification: (run: Run) => void;
}

export async function executePromptAndSend(
  deps: PromptAndSendDeps,
  agentId: string,
  presuppliedText?: string,
): Promise<void> {
  const ctx = deps.getCtx();
  if (!ctx) return;
  const run = deps.registry.get(agentId);
  if (!run) {
    ctx.ui.notify(`agent_id "${agentId}" not found.`, "warning");
    return;
  }
  // Pre-check sendability BEFORE opening the input modal so the user
  // doesn't waste typing a message that will be rejected anyway. Same
  // pre-check applies to the presuppliedText branch — design §9 keeps
  // the check unconditional.
  const check = deps.validateSendable(run);
  if (!check.ok) {
    try {
      ctx.ui.notify(check.reason, "warning");
    } catch {
      // ctx may have gone stale
    }
    return;
  }
  let message: string | undefined;
  // Slice 7: when the InputPane forwarded a buffer, skip the modal.
  // Empty / whitespace `presuppliedText` returns early without
  // calling `sendToRun` — matches the InputPane's whitespace-only
  // close semantics.
  if (presuppliedText !== undefined) {
    const trimmed = presuppliedText.trim();
    if (trimmed.length === 0) return;
    message = trimmed;
  } else {
    try {
      message = await ctx.ui.input(
        `Send to ${agentId}`,
        "Type a follow-up message; Esc to cancel.",
      );
    } catch {
      // Stale ctx or user dismissed — silently abort.
      return;
    }
    if (!message || !message.trim()) return;
    message = message.trim();
  }
  const cfg = deps.loadConfig(deps.cwd);
  const ov = (cfg.personaOverrides as Record<string, unknown>)[run.persona] ?? {};
  const resolved = await deps.resolvePersonas({
    cwd: deps.cwd,
    personaOverrides: cfg.personaOverrides,
  });
  const persona = resolved.personas.get(run.persona);
  const timeoutMs = deps.resolveTimeoutMs(persona, ov, cfg);
  const result = deps.sendToRun(run, message, {
    registry: deps.registry,
    timeoutMs,
    onComplete: (r) => deps.pushCompletionNotification(r),
  });
  if (result.kind === "rejected") {
    try {
      ctx.ui.notify(result.reason, "warning");
    } catch {
      // ctx may have gone stale
    }
  }
}
