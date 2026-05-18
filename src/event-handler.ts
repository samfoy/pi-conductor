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
    return UPDATED;
  }

  return NONE;
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
