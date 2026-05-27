/**
 * Pure event handler extracted from spawnRun's processLine closure.
 *
 * Mutates the supplied Run in place based on a parsed JSON event from a
 * `pi --mode json -p` subprocess. Returns an `EventEffect` describing what
 * the caller should do next (notify listeners, finalize the run, or nothing).
 *
 * No I/O. No registry calls. No `fs`. No `child_process`. This is the
 * single seam between the wire protocol and the run-state machine, and it's
 * unit-testable because it has no environmental dependencies.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcExtensionUIRequest, RpcResponse } from "./rpc-types.ts";
import { shortenMiddle } from "./tool-summary.ts";
import type { Run } from "./types.ts";

export type EventEffect =
  | { kind: "none" }
  | { kind: "updated" }
  | { kind: "finalize"; status: "completed" | "failed"; exitCode: number };

const NONE: EventEffect = { kind: "none" };
const UPDATED: EventEffect = { kind: "updated" };

/**
 * Apply a single parsed JSON event to a run. Mutates `run` in place.
 *
 * Returns:
 *   - `{ kind: "none" }`     — event is not interesting to us; ignore.
 *   - `{ kind: "updated" }`  — run state changed; the caller should notify
 *                              registry listeners and any onUpdate callback.
 *   - `{ kind: "finalize" }` — run reached a terminal state; the caller
 *                              must finalize the run (set status, persist,
 *                              fire onComplete).
 */
export function applyEvent(run: Run, event: unknown): EventEffect {
  if (!event || typeof event !== "object") return NONE;
  const e = event as Record<string, any>;
  if (typeof e.type !== "string") return NONE;

  // ── v0.12 slice 3 — RPC-only line dispatch ──────────────────
  //
  // `--mode rpc` emits two line shapes that are NOT `AgentEvent`s:
  //   - `RpcResponse` (`{type: "response", id, command, success, ...}`)
  //     — acks for commands the conductor sent (init prompt, steers,
  //     follow-ups). Slice 4 wires the correlation Map; slice 3 ships
  //     a stub.
  //   - `RpcExtensionUIRequest` — sub-agent's extension code calling
  //     `ctx.ui.confirm` / `ctx.ui.select` / etc. Sub-agent BLOCKS
  //     until we answer. Always-cancel-and-warn policy (Risk 2 lock).
  //
  // Watchdog `lastEventAt` bump asymmetry (oracle fix #2 / design
  // §4.7) is OWNED BY SLICE 5. Slice 3 must NOT bump on either path:
  //   - `response` will bump in slice 5 (genuine progress).
  //   - `extension_ui_request` will NEVER bump (sub-agent is blocked
  //     on the host's reply; bumping would mask the legitimate
  //     stall class "sub-agent waiting on unanswered UI request").
  if (e.type === "response") {
    routeRpcResponse(run, e as RpcResponse);
    return UPDATED;
  }
  if (e.type === "extension_ui_request") {
    return handleExtensionUiRequest(run, e as RpcExtensionUIRequest);
  }

  if (e.type === "agent_end") {
    return { kind: "finalize", status: "completed", exitCode: 0 };
  }

  if (e.type === "turn_end") {
    if (!e.message) return NONE;
    const msg = e.message as AgentMessage;
    const content = (msg as any).content;
    const hasToolCall = Array.isArray(content)
      ? content.some((p: any) => p?.type === "toolCall")
      : false;
    const stopReason = (msg as any).stopReason;
    const errored = stopReason === "error" || stopReason === "aborted";
    if (!hasToolCall && !errored) {
      return { kind: "finalize", status: "completed", exitCode: 0 };
    }
    return NONE;
  }

  if (e.type === "message_end") {
    if (!e.message) return NONE;
    const msg = e.message as AgentMessage;
    run.messages.push(msg);
    run.lastEventAt = Date.now();
    if (msg.role === "assistant") {
      run.usage.turns += 1;
      const u = (msg as any).usage;
      if (u) {
        run.usage.input += u.input || 0;
        run.usage.output += u.output || 0;
        run.usage.cacheRead += u.cacheRead || 0;
        run.usage.cacheWrite += u.cacheWrite || 0;
        run.usage.cost += u.cost?.total || 0;
      }
      const m = (msg as any).model;
      if (m && !run.model) run.model = m;
      const sr = (msg as any).stopReason;
      if (sr) run.stopReason = sr;
      const em = (msg as any).errorMessage;
      if (em && !run.errorMessage) run.errorMessage = em;

      const content = (msg as any).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "toolCall") {
            run.lastToolCall = formatToolCallShort(part.name, part.arguments);
          }
        }
      }
    }
    return UPDATED;
  }

  if (e.type === "tool_result_end") {
    if (!e.message) return NONE;
    run.messages.push(e.message as AgentMessage);
    run.lastEventAt = Date.now();
    return UPDATED;
  }

  return NONE;
}

// ── v0.12 slice 3 — RPC line handlers ────────────────────────────

/**
 * Route an RPC `response` line to the correlation router. Slice 3
 * STUB: the body is a no-op that returns `{kind: "updated"}`. Slice 4
 * fills in the `Run.pendingAcks` Map lookup that resolves the LLM
 * tool's send-promise with `delivered: true / false` based on
 * `evt.success`.
 *
 * Signature is pinned here so slice 4 doesn't have to renegotiate the
 * export shape — it only swaps the body.
 */
export function routeRpcResponse(
  _run: Run,
  _evt: RpcResponse,
): EventEffect {
  // Slice 4 will:
  //   const entry = _run.pendingAcks?.get(_evt.id);
  //   if (!entry) return UPDATED;
  //   clearTimeout(entry.timer);
  //   _run.pendingAcks!.delete(_evt.id);
  //   entry.resolve(_evt.success);
  // Slice 3 leaves the body as a no-op stub. The dispatch in
  // `applyEvent` already returns UPDATED on our behalf; the direct-
  // invocation path returns UPDATED here for symmetry.
  return UPDATED;
}

/**
 * Handle an inbound `extension_ui_request` line under `--mode rpc`.
 * The sub-agent's extension code (or pi's own slash-command flow)
 * called `ctx.ui.*` and the subprocess is now BLOCKED on our reply.
 *
 * Policy: always-cancel-and-warn (oracle Risk 2 lock; design §4.2).
 * Every method gets the canonical cancellation envelope
 * `{type: "extension_ui_response", id, cancelled: true}` enqueued
 * SYNCHRONOUSLY (no setImmediate / queueMicrotask defer) via the run's
 * `RpcStdinQueue`. A one-line warning fires; the sub-agent's
 * extension code receives `cancelled: true` and is expected to fail
 * gracefully. Personas that depend on `ctx.ui.confirm` / `ctx.ui.select`
 * / `ctx.ui.input` / `ctx.ui.editor` SHOULD NOT be spawned with
 * `steerable: true` — the constraint is documented in persona-author
 * guidance.
 *
 * The handler does NOT bump `run.lastEventAt`: the sub-agent is
 * blocked on our reply, not making progress. Once the sub-agent
 * resumes after our cancellation, the next `message_end` /
 * `tool_result_end` bumps `lastEventAt` through the normal path.
 *
 * Defensive: if `run.rpcStdinQueue` is missing (a print-mode run that
 * somehow received this line, or a test fixture that didn't attach
 * the queue), the envelope is dropped silently and the warning still
 * fires. We never throw — a misrouted wire line must not crash the
 * event loop.
 */
export function handleExtensionUiRequest(
  run: Run,
  evt: RpcExtensionUIRequest,
): EventEffect {
  const id = (evt as { id?: string }).id;
  const method = (evt as { method?: string }).method ?? "unknown";
  // eslint-disable-next-line no-console
  console.warn(
    `sub-agent ${run.id} emitted ${method} request under steerable=true; auto-cancelled`,
  );
  if (!run.rpcStdinQueue || typeof id !== "string") return UPDATED;
  // Synchronous-same-tick enqueue. Do NOT defer via setImmediate /
  // queueMicrotask — the sub-agent is blocked and any added latency
  // adds to its perceived stall.
  void run.rpcStdinQueue
    .enqueue({ type: "extension_ui_response", id, cancelled: true })
    .catch(() => {
      // The queue may be destroyed (forceTerminate raced us) or the
      // pipe may be closed (sub-agent already exited). Either way the
      // sub-agent isn't around to see our reply; nothing to do.
    });
  return UPDATED;
}

// ── Helper: short tool-call summary for the live widget ──────────────

function shortenPath(p: string): string {
  // Keep widget-helper consistent with runs.ts. Imported lazily to avoid
  // a cycle; small enough to duplicate.
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCallShort(name: string, args: Record<string, any> | undefined): string {
  const a = args ?? {};
  switch (name) {
    case "bash": {
      const cmd = (a.command as string) ?? "...";
      // Total visible width is preserved at 53 chars (`$ ` + 51-char body).
      // shortenMiddle keeps both head and tail of the command visible.
      return `$ ${shortenMiddle(cmd, 51)}`;
    }
    case "read":
      return `read ${shortenPath((a.file_path || a.path || "...") as string)}`;
    case "write":
      return `write ${shortenPath((a.file_path || a.path || "...") as string)}`;
    case "edit":
      return `edit ${shortenPath((a.file_path || a.path || "...") as string)}`;
    case "grep":
      return `grep ${(a.pattern as string) ?? "..."}`;
    default:
      return name;
  }
}
