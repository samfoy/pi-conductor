import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import type { Run } from "./types.ts";

const RETIRED_ENTRY = "conductor-context-retired";
const FINALIZE_INSTRUCTION =
  "This session is retiring because of context pressure. Start no new objectives. " +
  "Bring the current coherent operation to a safe stopping point, preserving essential validation. " +
  "Return a self-contained handoff describing completed work, current state, relevant files, " +
  "checks performed and their results, unresolved issues, and exact next steps for a fresh child. " +
  "Retirement is not evidence that the task is complete; distinguish verified work from unfinished work.";

function hasRetirement(entries: readonly unknown[], sessionId: string): boolean {
  return entries.some(entry => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as { type?: unknown; customType?: unknown; data?: { sessionId?: unknown } };
    return e.type === "custom" && e.customType === RETIRED_ENTRY && e.data?.sessionId === sessionId;
  });
}

export function installContextRetirement(pi: ExtensionAPI): void {
  if (process.env.CONDUCTOR_SUBAGENT !== "1") return;
  pi.on("session_before_compact", (event, ctx) => {
    if (!loadConfig(process.env.CONDUCTOR_CONFIG_CWD || ctx.cwd).contextRetirement || event.reason === "manual") return;
    const sessionId = ctx.sessionManager.getSessionId();
    // Retirement belongs to the entire session, including abandoned branches.
    if (!hasRetirement(ctx.sessionManager.getEntries(), sessionId)) {
      pi.appendEntry(RETIRED_ENTRY, { sessionId });
    }
    // Overflow must retain Pi's compact-and-retry recovery.
    if (event.reason === "threshold") return { cancel: true };
  });
  pi.on("context", (event, ctx) => {
    if (!loadConfig(process.env.CONDUCTOR_CONFIG_CWD || ctx.cwd).contextRetirement) return;
    if (!hasRetirement(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId())) return;
    return {
      messages: [
        ...event.messages.filter(m => !(m.role === "custom" && m.customType === RETIRED_ENTRY)),
        { role: "custom", customType: RETIRED_ENTRY, content: FINALIZE_INSTRUCTION, display: false, timestamp: Date.now() },
      ],
    };
  });
}

/** Match only the session header's identity, never an inherited parent's marker. */
export function savedSessionRetired(sessionPath: string | undefined): boolean {
  if (!sessionPath) return false;
  try {
    const entries: unknown[] = readFileSync(sessionPath, "utf8").split("\n").map(line => {
      try { return JSON.parse(line); } catch { return undefined; }
    });
    const header = entries[0] as { type?: unknown; id?: unknown } | undefined;
    return header?.type === "session" && typeof header.id === "string" && header.id.length > 0 && hasRetirement(entries.slice(1), header.id);
  } catch {
    return false; // Missing/unreadable sessions retain existing send validation.
  }
}

export function contextRetirementNotice(run: Pick<Run, "contextRetired" | "cwd">): string | undefined {
  if (!run.contextRetired || !loadConfig(run.cwd).contextRetirement) return undefined;
  return "Session retired due to context pressure. Use a fresh child with the handoff for follow-up; retirement does not mean the task is complete.";
}
