/**
 * pi-conductor — seedSessionFile
 *
 * Writes a fresh pi-format JSONL session file containing:
 *   1) One SessionHeader (`type: "session"`, version 3).
 *   2) One SessionMessageEntry per supplied AgentMessage, with a
 *      parentId chain (first entry's parentId is null; each subsequent
 *      points to the previous entry's id).
 *
 * The seeded file is consumable by `pi --session <path>` (resume mode).
 * The sub-agent boots seeing the seeded messages as its conversation
 * history and processes the new task as the next user message.
 *
 * Used by the spawn path when a persona has `inherit_context: filtered`.
 *
 * No I/O abstractions; node:fs synchronous writes are intentional —
 * spawn must not race the subprocess.
 *
 * Tested in tests/session-seed.test.ts.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Pi entry ids are 8-char hex strings. */
function newEntryId(): string {
  return randomBytes(4).toString("hex");
}

/** Pi session ids look like UUIDs in the wild but the format isn't load-bearing. */
function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Write a JSONL session file at `path` containing a header followed by one
 * message entry per supplied message. Creates intermediate directories.
 *
 * Behavior is idempotent in the sense that callers can replace an existing
 * file by calling this again — `writeFileSync` truncates.
 *
 * Spec compliance:
 *   - First line: SessionHeader ({ type: "session", version: 3, id, timestamp, cwd }).
 *     No id/parentId on the header itself.
 *   - Subsequent lines: SessionMessageEntry ({ type: "message", id, parentId,
 *     timestamp, message }).
 *   - First message entry has parentId === null; each next entry's parentId
 *     is the previous entry's id (linear chain).
 */
export function seedSessionFile(
  path: string,
  messages: AgentMessage[],
  cwd: string,
): void {
  mkdirSync(dirname(path), { recursive: true });

  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: newSessionId(),
      timestamp: now,
      cwd,
    }),
  );

  let parentId: string | null = null;
  for (const message of messages) {
    const id = newEntryId();
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message,
      }),
    );
    parentId = id;
  }

  writeFileSync(path, lines.join("\n") + "\n");
}
