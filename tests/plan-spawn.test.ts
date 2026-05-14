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
import type { AgentMessage } from "@mariozechner/pi-agent-core";

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

function assistantToolCall(name: string, id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
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
    // Resume mode does NOT pass --append-system-prompt; the seeded session
    // already had its prompt configured at conductor-time.
    assert.ok(!result.piArgs.includes("--append-system-prompt"));
    // Verify the prompt becomes the trailing positional argument.
    assert.equal(result.piArgs[result.piArgs.length - 1], "do the thing");
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
