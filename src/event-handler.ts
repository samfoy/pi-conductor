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

  // ── v0.12 slice 5 — RPC `lastEventAt` bump policy (oracle fix #2) ──
  //
  // Print-mode short-circuit: only RPC runs route through bumpOnRpcLine.
  // Print-mode runs keep their pre-v0.12 bump sites exactly
  // (`message_end` / `tool_result_end` below). The RPC bump-asymmetry
  // (`response` bumps; `extension_ui_request` does NOT) is captured in
  // `bumpOnRpcLine` per design §4.7 + oracle fix #2; W2 mutation
  // witness in tests/event-handler-rpc.test.ts pins both directions.
  if (run.streamingMode === "rpc" && bumpOnRpcLine(run, Date.now(), e.type)) {
    run.lastEventAt = Date.now();
  }

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

  // ── Backlog item 3 fix — tool_execution_update bump policy ───────────────────────
  //
  // Pi emits `tool_execution_update` events as a long-running tool
  // produces output. Pre-fix, the watchdog's `lastEventAt` was only
  // bumped on `message_end` / `tool_result_end` (and the slice-5
  // RPC `response`); a long bash with multi-minute output buffering
  // (e.g. piped through `tail -N` which holds output until the
  // upstream pipe closes) emitted no `_end` events for 10+ minutes
  // and the watchdog killed the run. See docs/backlog.md item 3
  // (witness `builder-ccl8`).
  //
  // Asymmetry locked: `_update` bumps; `_start` and `_end` do not.
  // `_start` is informational (a tool kicked off; no progress yet);
  // `_end` fires alongside `tool_result_end` which already bumps.
  // Mirrors slice-5's `response` / `extension_ui_request` bump-
  // asymmetry pattern (see `bumpOnRpcLine` and the W2 mutation
  // witness in tests/event-handler-rpc.test.ts), but for the
  // mode-agnostic tool-execution event family.
  //
  // We do NOT push to `run.messages` here — these events may carry
  // partial / streaming content and the canonical transcript only
  // accepts complete AgentMessages from `message_end` /
  // `tool_result_end`. The bump is the only side effect.
  if (e.type === "tool_execution_update") {
    run.lastEventAt = Date.now();
    return UPDATED;
  }

  return NONE;
}

// ── v0.12 slice 5 — RPC `lastEventAt` bump policy (oracle fix #2) ──

/**
 * Decide whether an RPC-only line type should bump `Run.lastEventAt`.
 *
 * Pure: no I/O, deterministic on (run, now, evtType). Exposed so the
 * W2 mutation witness can pin the formula directly per `docs/wdd.md`
 * parallel-formula rule (mirrors `src/watchdog.ts:287` `resolveKillOnStall`
 * + slice-1 `resolveSteerable`).
 *
 * Truth table:
 *   - `"response"`              → true  (sub-agent acked our command;
 *                                       progress evidence)
 *   - `"extension_ui_request"`  → false (sub-agent is BLOCKED on
 *                                       host's reply; not progress)
 *   - any other line type        → false (defensive default; build-on-demand)
 *
 * The `now` parameter is reserved for future thresholding (e.g. ack
 * de-duplication) but is currently unused. Caller is responsible for
 * applying the bump (`run.lastEventAt = now`) when this returns true.
 *
 * Caller is also responsible for the print-mode short-circuit
 * (`run.streamingMode === "rpc"`); the helper itself does NOT gate
 * on streamingMode so the W2 unit tests can exercise the formula in
 * isolation. `applyEvent` short-circuits at the call site.
 */
export function bumpOnRpcLine(
  _run: Run,
  _now: number,
  evtType: string,
): boolean {
  return evtType === "response";
}

// ── v0.12 slice 3 — RPC line handlers ────────────────────────────

/**
 * Route an RPC `response` line to the correlation router. Slice 4
 * implements the body: looks up `evt.id` in `run.pendingAcks`, clears
 * the timeout timer, deletes the entry, and resolves the LLM tool's
 * send-promise with `delivered = evt.success`.
 *
 * No `lastEventAt` bump on this path — oracle fix #2 / design §4.7
 * (slice 5 owns the bump-on-`response` policy). Slice 4 is correlation
 * routing only.
 *
 * Defensive: if `pendingAcks` is undefined or `evt.id` doesn't match a
 * registered entry (response arrived after the entry was already
 * cleared by the timeout timer, or for an unsolicited ack), we no-op.
 * The dispatch in `applyEvent` already returned UPDATED.
 */
export function routeRpcResponse(
  run: Run,
  evt: RpcResponse,
): EventEffect {
  const id = (evt as { id?: string }).id;
  if (typeof id !== "string" || !run.pendingAcks) return UPDATED;
  const entry = run.pendingAcks.get(id);
  if (!entry) return UPDATED;
  clearTimeout(entry.timer);
  run.pendingAcks.delete(id);
  entry.resolve((evt as { success?: boolean }).success === true);
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
