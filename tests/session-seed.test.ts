/**
 * Tests for seedSessionFile — writes a fresh pi-format JSONL session file
 * containing a header + one message entry per filtered parent message.
 *
 * The sub-agent boots from this file via `pi --session <path>` and sees
 * the seeded messages as its conversation history.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { seedSessionFile } from "../src/session-seed.ts";

function tmpSessionPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-seed-"));
  return join(dir, "session.jsonl");
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function assistantText(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

test("seedSessionFile: empty messages → only the header line is written", () => {
  const path = tmpSessionPath();
  try {
    seedSessionFile(path, [], "/tmp/cwd");
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.cwd, "/tmp/cwd");
    assert.ok(typeof header.id === "string" && header.id.length > 0);
    assert.ok(typeof header.timestamp === "string" && header.timestamp.length > 0);
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
});

test("seedSessionFile: header is followed by one entry per message in order", () => {
  const path = tmpSessionPath();
  try {
    const msgs = [user("hi"), assistantText("hello"), user("ok")];
    seedSessionFile(path, msgs, "/work");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].type, "session");
    for (let i = 1; i <= 3; i++) {
      assert.equal(parsed[i].type, "message");
      assert.deepEqual(parsed[i].message, msgs[i - 1]);
    }
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
});

test("seedSessionFile: parentId chain is correct (first null, each next points to prev)", () => {
  const path = tmpSessionPath();
  try {
    const msgs = [user("a"), assistantText("b"), user("c")];
    seedSessionFile(path, msgs, "/work");
    const parsed = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const entries = parsed.slice(1);
    assert.equal(entries[0].parentId, null, "first entry's parentId must be null");
    for (let i = 1; i < entries.length; i++) {
      assert.equal(
        entries[i].parentId,
        entries[i - 1].id,
        `entry ${i}'s parentId should equal previous entry's id`,
      );
    }
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
});

test("seedSessionFile: every entry has a unique non-empty id and a timestamp", () => {
  const path = tmpSessionPath();
  try {
    const msgs = [user("a"), user("b"), user("c"), user("d"), user("e")];
    seedSessionFile(path, msgs, "/work");
    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    const ids = new Set<string>();
    for (const e of entries) {
      assert.ok(typeof e.id === "string" && e.id.length > 0, `id must be non-empty: ${JSON.stringify(e)}`);
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
      ids.add(e.id);
      assert.ok(typeof e.timestamp === "string" && e.timestamp.length > 0);
    }
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
});

test("seedSessionFile: every line round-trips through JSON.parse without error", () => {
  const path = tmpSessionPath();
  try {
    const msgs = [user("hi\nwith newline"), assistantText("backslash \\ and quote \"")];
    seedSessionFile(path, msgs, "/work");
    const raw = readFileSync(path, "utf8");
    const lines = raw.trim().split("\n");
    for (const line of lines) {
      // Must not throw.
      JSON.parse(line);
    }
    // Sanity: the original message text round-trips.
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[1].message.content, "hi\nwith newline");
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // best effort
    }
  }
});

test("seedSessionFile: creates intermediate directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "conductor-seed-deep-"));
  const path = join(dir, "deeply", "nested", "session.jsonl");
  try {
    seedSessionFile(path, [user("hi")], "/work");
    assert.ok(existsSync(path));
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});
