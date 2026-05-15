/**
 * Tests for planSpawnPiArgs — the helper that decides whether a sub-agent
 * boots fresh (no parent context) or resumes from a seeded session file
 * containing the filtered parent transcript.
 *
 * Behavior matrix:
 *   inheritContext=none      → always fresh
 *   inheritContext=filtered  → resume IFF filtered messages > 0; else fresh
 *   inheritContext=full      → resume IFF parent messages > 0 (no filtering)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { planSpawnPiArgs } from "../src/runs.ts";
import type { ContextInheritance, Persona } from "../src/types.ts";

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "conductor-plan-"));
}

function persona(overrides: Partial<Persona> & { inheritContext: ContextInheritance }): Persona {
  return {
    name: "tester",
    description: "test persona",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "you are a tester",
    source: "builtin",
    sourcePath: "/tmp/tester.md",
    ...overrides,
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function assistantToolCall(name: string, id: string, preface?: string): AgentMessage {
  const content: any[] = [];
  if (preface) content.push({ type: "text", text: preface });
  content.push({ type: "toolCall", id, name, arguments: {} });
  return {
    role: "assistant",
    content,
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
    stopReason: "toolUse",
    timestamp: 0,
  } as AgentMessage;
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

test("planSpawnPiArgs: inheritContext=none → fresh, no seeded session", () => {
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "none" }),
      parentMessages: [user("hi")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
    assert.equal(result.seededSessionPath, undefined);
    assert.ok(result.piArgs.includes("--session-dir"));
    assert.ok(!result.piArgs.includes("--session"));
    assert.ok(result.piArgs.includes("--append-system-prompt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: inheritContext=filtered with no parent messages → fresh", () => {
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
    assert.equal(result.seededSessionPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: inheritContext=filtered with parent messages → resume + seed file written", () => {
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [user("the user said this earlier")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "resume");
    assert.ok(result.seededSessionPath);
    assert.ok(existsSync(result.seededSessionPath!));
    assert.ok(result.piArgs.includes("--session"));
    assert.ok(!result.piArgs.includes("--session-dir"));
    // Resume-mode for SEEDED sessions MUST also pass --append-system-prompt:
    // the seeded JSONL has no system prompt entry, so without re-injecting
    // the persona's body the sub-agent boots with pi's default coding-agent
    // prompt and loses its persona identity entirely.
    assert.ok(
      result.piArgs.includes("--append-system-prompt"),
      "seeded resume must re-pass the persona system prompt or the persona body is lost",
    );
    const idx = result.piArgs.indexOf("--append-system-prompt");
    assert.equal(result.piArgs[idx + 1], "sys");
    // Verify the prompt becomes the trailing positional argument.
    assert.equal(result.piArgs[result.piArgs.length - 1], "do the thing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: filtered seed without dropped content → no <filtered-history> sentinel", () => {
  const dir = tmpSessionDir();
  try {
    // No orchestration noise to drop. The sub-agent sees a clean transcript
    // and we don't want to clutter it with a sentinel that lies about
    // missing turns.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [user("hi"), user("do X")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "go",
      cwd: "/work",
    });
    assert.equal(result.mode, "resume");
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    const seededRoles = lines.slice(1).map((l) => JSON.parse(l).message.role);
    assert.deepEqual(seededRoles, ["user", "user"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: filtered seed WITH dropped content → prepends a <filtered-history> sentinel", () => {
  const dir = tmpSessionDir();
  try {
    // Parent had orchestration content (will be dropped) AND user prose
    // (will survive). The sentinel must land BEFORE the surviving prose so
    // the sub-agent reads it before any potentially-misleading dangling
    // reference.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [
        user("hi"),
        assistantToolCall("ensemble_spawn", "tc1"),
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "go",
      cwd: "/work",
    });
    assert.equal(result.mode, "resume");
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    const entries = lines.slice(1).map((l) => JSON.parse(l));
    // First seeded entry should be the sentinel (a user-role message).
    assert.equal(entries[0].message.role, "user");
    const text = typeof entries[0].message.content === "string"
      ? entries[0].message.content
      : entries[0].message.content[0].text;
    assert.match(text, /filtered-history|filtered/i);
    // The user's actual prose must come AFTER the sentinel.
    assert.equal(entries[1].message.role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: filtered seed starting with non-user message → falls back to fresh", () => {
  const dir = tmpSessionDir();
  try {
    // The parent's first surviving turn is a `read` toolResult (because the
    // assistant turn that called `read` was a tool-call-only orchestration
    // turn that got filtered). Anthropic and most providers reject a
    // request whose first message is a toolResult with no preceding tool_use
    // — so seeding a session that starts here would crash the sub-agent.
    // Defensive: drop leading non-user entries; if nothing remains, fall back
    // to fresh.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [
        // Tool-call-only assistant turn (will be dropped entirely).
        assistantToolCall("ensemble_spawn", "tc1"),
        // toolResult that survives the filter — but starting here would
        // crash on resume.
        {
          role: "toolResult",
          toolCallId: "orphan",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
          timestamp: 0,
        } as AgentMessage,
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
    assert.equal(result.seededSessionPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: filtered seed with leading non-user prefix → prefix is dropped, remainder seeded", () => {
  const dir = tmpSessionDir();
  try {
    // Leading toolResult must be skipped, but the user message after it
    // anchors a valid resume.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [
        {
          role: "toolResult",
          toolCallId: "orphan",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
          timestamp: 0,
        } as AgentMessage,
        user("hi"),
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "resume");
    assert.ok(result.seededSessionPath);
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    // Header + 1 message (the orphan toolResult was dropped, only `user` remains).
    assert.equal(lines.length, 2);
    const seededMsg = JSON.parse(lines[1]).message;
    assert.equal(seededMsg.role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: filtered drops orchestration-only history → falls back to fresh", () => {
  const dir = tmpSessionDir();
  try {
    // Only ensemble_spawn assistant turns (no prose, no user). After
    // filtering, nothing remains, so we must NOT seed an empty session
    // (pi rejects an empty resume) — fall back to fresh.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [
        assistantToolCall("ensemble_spawn", "tc1"),
        assistantToolCall("ensemble_spawn", "tc2"),
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
    assert.equal(result.seededSessionPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: inheritContext=full passes ALL parent messages, no filtering", () => {
  const dir = tmpSessionDir();
  try {
    // Same orchestration-heavy input that filtered would drop entirely;
    // full retains it.
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "full" }),
      parentMessages: [
        user("hi"),
        assistantToolCall("ensemble_spawn", "tc1"),
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "resume");
    assert.ok(result.seededSessionPath);
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    // 1 header + 2 messages.
    assert.equal(lines.length, 3);
    const second = JSON.parse(lines[2]);
    assert.equal(second.message.role, "assistant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: inheritContext=full with no parent messages → fresh", () => {
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "full" }),
      parentMessages: [],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "do the thing",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: model and thinking flags propagate in both modes", () => {
  const dir = tmpSessionDir();
  try {
    const fresh = planSpawnPiArgs({
      persona: persona({ inheritContext: "none" }),
      parentMessages: [],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "p",
      cwd: "/work",
      model: "anthropic:claude-opus-4-5",
      thinking: "high",
    });
    assert.ok(fresh.piArgs.includes("--model"));
    assert.ok(fresh.piArgs.includes("anthropic:claude-opus-4-5"));
    assert.ok(fresh.piArgs.includes("--thinking"));
    assert.ok(fresh.piArgs.includes("high"));

    const resume = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [user("hi")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "p",
      cwd: "/work",
      model: "anthropic:claude-opus-4-5",
      thinking: "high",
    });
    assert.ok(resume.piArgs.includes("--model"));
    assert.ok(resume.piArgs.includes("--thinking"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── v0.8.1 Item 1: strengthened <filtered-history> sentinel + Q#16 audit ──
//
// See docs/v0.8.1-item1-design.md §4 and §5.

test("planSpawnPiArgs: strengthened sentinel names role-identity drift and the last-user-message rule", () => {
  // Caveat (oracle gate adjustment 1): this test pins phrase PRESENCE in the
  // sentinel body. It is a weak proxy for the behavioral fix — a model
  // reading the sentinel and correctly anchoring to the last user message
  // is what we actually care about. Behavioral verification is gated on
  // §8.3 manual smoke (re-running the witnessed dogfood scenarios). Treat
  // green here as necessary, not sufficient.
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [
        user("hi"),
        assistantToolCall("ensemble_spawn", "tc1", "spawning"),
      ],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "go",
      cwd: "/work",
    });
    assert.ok(result.seededSessionPath);
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    const entries = lines.slice(1).map((l) => JSON.parse(l));
    const sentinelText: string =
      typeof entries[0].message.content === "string"
        ? entries[0].message.content
        : entries[0].message.content[0].text;

    // Hypothesis-pinning assertions (design §2 → §4.3): each cause is named.
    assert.match(sentinelText, /last user/i, "names the deterministic anchor (last user message rule)");
    assert.match(sentinelText, /third person|third-person/i, "names the role-identity failure mode");
    assert.match(
      sentinelText,
      /orchestration narration|leftover orchestration/i,
      "names the leak source",
    );
    assert.match(sentinelText, /your brief|YOUR brief/i, "anchors persona to its brief explicitly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: strengthened sentinel still fires on filtered+dropped (no regression)", () => {
  // Pins that the new content is what fires when the existing trigger
  // (filtered.length !== parentMessages.length OR identity walk) detects
  // dropped content. Complements the older "dropped → prepends sentinel"
  // assertion by checking the sentinel envelope tags.
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "filtered" }),
      parentMessages: [user("x"), assistantToolCall("ensemble_spawn", "t", "y")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "go",
      cwd: "/work",
    });
    assert.ok(result.seededSessionPath);
    const lines = readFileSync(result.seededSessionPath!, "utf8").trim().split("\n");
    const entries = lines.slice(1).map((l) => JSON.parse(l));
    const sentinelText: string =
      typeof entries[0].message.content === "string"
        ? entries[0].message.content
        : entries[0].message.content[0].text;
    assert.match(sentinelText, /<filtered-history>/);
    assert.match(sentinelText, /<\/filtered-history>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planSpawnPiArgs: persona with inherit_context=none never seeds (Q#16 flips)", () => {
  // Personas flipped to `none` in v0.8.1 (oracle/redteam/inspector/analyst/
  // profiler/scribe/verifier) must produce a `fresh` plan with no seeded
  // session even when parentMessages is non-empty.
  const dir = tmpSessionDir();
  try {
    const result = planSpawnPiArgs({
      persona: persona({ inheritContext: "none" }),
      parentMessages: [user("hi"), assistantText("hello")],
      sessionDir: dir,
      systemPrompt: "sys",
      prompt: "go",
      cwd: "/work",
    });
    assert.equal(result.mode, "fresh");
    assert.equal(result.seededSessionPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
