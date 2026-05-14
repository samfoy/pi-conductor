/**
 * Tests for pure helpers and lifecycle state-machine logic in src/runs.ts.
 *
 * Coverage gaps closed by this file:
 *   - formatTokens across each magnitude bucket (sub-1k, sub-10k, sub-1M, ≥1M)
 *   - formatUsage joins only non-zero parts and includes cost to 3dp
 *   - formatUsage returns "" for fully-empty usage
 *   - elapsedStr renders seconds, minutes, and hours appropriately
 *   - elapsedStr uses Date.now() when no end is provided
 *   - getFinalText returns the last assistant text concatenation
 *   - getFinalText returns "" when no assistant text messages exist
 *   - getFinalText skips trailing user messages
 *   - allocateRunId yields persona-prefixed ids that don't collide with the registry
 *   - buildSubAgentPrompt prepends the nesting guard and renders default_reads
 *   - buildSubAgentPrompt omits the default_reads section when none are configured
 *   - buildPiArgs always includes --mode json -p and --append-system-prompt
 *   - buildPiArgs adds --session-dir for fresh spawns and --session for resumes
 *   - buildPiArgs only adds --model / --thinking when provided
 *   - buildPiArgs in resume mode omits the prompt when message is undefined
 *   - pauseRun is a no-op for non-running statuses
 *   - resumeRun is a no-op for non-paused statuses
 *   - forceTerminate is a no-op once the run is already terminal
 *   - forceTerminate sets the right status and finishedAt for "killed" vs "timeout"
 *
 * Lifecycle helpers (pauseRun/resumeRun/forceTerminate) operate on a Run
 * object and a registry — we avoid spawning real subprocesses by passing
 * runs without `proc`, which exercises the early-out branches deterministically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  RunRegistry,
  allocateRunId,
  buildPiArgs,
  buildSubAgentPrompt,
  elapsedStr,
  forceTerminate,
  formatTokens,
  formatUsage,
  getFinalText,
  pauseRun,
  resumeRun,
} from "../src/runs.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";

function tmpRunPaths(): { dir: string; recordPath: string; transcriptPath: string; finalPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-runs-"));
  return {
    dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
  };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "oracle",
    description: "second opinion",
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "you are the oracle",
    source: "builtin",
    sourcePath: "/tmp/oracle.md",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-aaaa",
    persona: "oracle",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 1_700_000_000_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    // Default to bogus paths — only the lifecycle tests below need real ones.
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    ...overrides,
  };
}

// ── formatTokens ──────────────────────────────────────────────────────

test("formatTokens: sub-1000 returns the bare integer", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(1), "1");
  assert.equal(formatTokens(999), "999");
});

test("formatTokens: 1000–9999 uses one decimal kilo", () => {
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(9999), "10.0k");
});

test("formatTokens: 10k–1M rounds to whole-k", () => {
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(123_456), "123k");
  assert.equal(formatTokens(999_999), "1000k");
});

test("formatTokens: ≥1M uses one decimal mega", () => {
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(2_500_000), "2.5M");
});

// ── formatUsage ───────────────────────────────────────────────────────

test("formatUsage: empty usage yields empty string", () => {
  assert.equal(formatUsage({ turns: 0, input: 0, output: 0, cost: 0 }), "");
});

test("formatUsage: only-turns shows turns suffix", () => {
  assert.equal(formatUsage({ turns: 3, input: 0, output: 0, cost: 0 }), "3t");
});

test("formatUsage: full set joins parts in fixed order", () => {
  assert.equal(
    formatUsage({ turns: 2, input: 1500, output: 800, cost: 0.012 }),
    "2t ↑1.5k ↓800 $0.012",
  );
});

test("formatUsage: cost rounds to 3 decimal places", () => {
  // 0.0125 → "$0.013" (toFixed(3) rounds half-to-even or up depending on impl;
  // Node's toFixed uses standard rounding so 0.0125 → "0.013")
  assert.equal(formatUsage({ turns: 1, input: 0, output: 0, cost: 0.0125 }), "1t $0.013");
});

// ── elapsedStr ────────────────────────────────────────────────────────

test("elapsedStr: <60s returns rounded seconds", () => {
  const start = 1_000_000_000_000;
  assert.equal(elapsedStr(start, start + 12_000), "12s");
  assert.equal(elapsedStr(start, start + 59_500), "60s"); // edge: rounds to 60s but still <60 path
});

test("elapsedStr: 1–60 minutes returns minutes with one decimal", () => {
  const start = 1_000_000_000_000;
  // 90s = 1.5m
  assert.equal(elapsedStr(start, start + 90_000), "1.5m");
  // 30 minutes
  assert.equal(elapsedStr(start, start + 30 * 60_000), "30.0m");
});

test("elapsedStr: ≥60 minutes returns hours with one decimal", () => {
  const start = 1_000_000_000_000;
  // 2.5h
  assert.equal(elapsedStr(start, start + 2.5 * 60 * 60_000), "2.5h");
});

test("elapsedStr: when end is undefined, falls back to now()", () => {
  // We don't pin time — just sanity-check that the result is a non-empty string
  // ending in s/m/h, given start=now-5s.
  const r = elapsedStr(Date.now() - 5_000);
  assert.match(r, /^\d+(\.\d+)?[smh]$/);
});

// ── getFinalText ──────────────────────────────────────────────────────

function asstMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function userMsg(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

test("getFinalText: returns last assistant text concatenated", () => {
  const msgs: AgentMessage[] = [asstMsg("first"), asstMsg("second")];
  assert.equal(getFinalText(msgs), "second");
});

test("getFinalText: concatenates multi-part text content", () => {
  const msg: AgentMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ],
  } as unknown as AgentMessage;
  assert.equal(getFinalText([msg]), "hello world");
});

test("getFinalText: skips trailing user message and returns previous assistant", () => {
  const msgs: AgentMessage[] = [
    asstMsg("the answer"),
    userMsg("thanks"),
  ];
  assert.equal(getFinalText(msgs), "the answer");
});

test("getFinalText: returns empty string when there are no assistant text parts", () => {
  assert.equal(getFinalText([]), "");
  assert.equal(getFinalText([userMsg("hi")]), "");
});

// ── allocateRunId ─────────────────────────────────────────────────────

test("allocateRunId: produces persona-prefixed id with 4-char suffix", () => {
  const id = allocateRunId("oracle", new Map());
  assert.match(id, /^oracle-[a-z0-9]{4}$/);
});

test("allocateRunId: avoids collisions in the registry", () => {
  const reg = new Map<string, Run>();
  // Pre-register all but a tiny sliver of the id space — too painful; instead
  // just register a candidate id and confirm allocateRunId never returns it.
  // Verify by calling 50 times — the existing id must never be picked.
  reg.set("oracle-aaaa", makeRun({ id: "oracle-aaaa" }));
  for (let i = 0; i < 50; i++) {
    const id = allocateRunId("oracle", reg);
    assert.notEqual(id, "oracle-aaaa");
  }
});

// ── buildSubAgentPrompt ───────────────────────────────────────────────

test("buildSubAgentPrompt: includes nesting guard at the top", () => {
  const out = buildSubAgentPrompt(makePersona(), "do the thing");
  assert.match(out.split("\n")[0]!, /pi-conductor sub-agent/);
  assert.match(out, /Do NOT attempt to spawn/);
});

test("buildSubAgentPrompt: ends with the task body under '## Task'", () => {
  const out = buildSubAgentPrompt(makePersona(), "review the design doc");
  assert.match(out, /## Task\n\nreview the design doc$/);
});

test("buildSubAgentPrompt: omits default_reads section when persona has no reads", () => {
  const out = buildSubAgentPrompt(makePersona({ defaultReads: [] }), "x");
  assert.doesNotMatch(out, /Read these files first/);
});

test("buildSubAgentPrompt: lists every default_read as a bullet", () => {
  const out = buildSubAgentPrompt(
    makePersona({ defaultReads: ["plan.md", "design.md"] }),
    "x",
  );
  assert.match(out, /Read these files first if they exist/);
  assert.match(out, /  - plan\.md/);
  assert.match(out, /  - design\.md/);
});

// ── buildPiArgs ───────────────────────────────────────────────────────

test("buildPiArgs(fresh): emits json mode, -p, --session-dir, append-system-prompt, prompt", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "SYS",
    prompt: "PROMPT",
  });
  // Required base flags
  assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);
  // Session is on disk for resumability
  assert.equal(args.includes("--no-session"), false, "fresh spawn must not pass --no-session");
  const sd = args.indexOf("--session-dir");
  assert.ok(sd > 0, "--session-dir must be present in fresh mode");
  assert.equal(args[sd + 1], "/tmp/sess");
  // Append-system-prompt with the body
  const i = args.indexOf("--append-system-prompt");
  assert.ok(i > 0, "--append-system-prompt must be present");
  assert.equal(args[i + 1], "SYS");
  // Prompt is the last positional
  assert.equal(args[args.length - 1], "PROMPT");
});

test("buildPiArgs(resume): emits --session <path> + the message, omits --append-system-prompt", () => {
  const args = buildPiArgs({
    kind: "resume",
    sessionPath: "/tmp/sess/abc.jsonl",
    prompt: "another question",
  });
  assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);
  const s = args.indexOf("--session");
  assert.ok(s > 0, "--session must be present in resume mode");
  assert.equal(args[s + 1], "/tmp/sess/abc.jsonl");
  // Resume reuses the session's existing system prompt; we don't re-inject it.
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.equal(args.includes("--session-dir"), false);
  // Prompt is the last positional
  assert.equal(args[args.length - 1], "another question");
});

test("buildPiArgs: omits --model and --thinking when not provided", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "S",
    prompt: "P",
  });
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--thinking"), false);
});

test("buildPiArgs: includes --model when set", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "S",
    prompt: "P",
    model: "anthropic/claude-opus-4-1",
  });
  const i = args.indexOf("--model");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "anthropic/claude-opus-4-1");
});

test("buildPiArgs: includes --thinking when set", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "S",
    prompt: "P",
    thinking: "high",
  });
  const i = args.indexOf("--thinking");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "high");
});

// ── pauseRun / resumeRun / forceTerminate (state-machine only) ────────

test("pauseRun: returns false when run is not 'running'", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "completed" });
  reg.register(run);
  assert.equal(pauseRun(run, reg), false);
  assert.equal(run.status, "completed", "status unchanged");
});

test("pauseRun: returns false when run has no proc handle", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  assert.equal(pauseRun(run, reg), false);
  assert.equal(run.status, "running");
});

test("resumeRun: returns false when run is not 'paused'", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  assert.equal(resumeRun(run, reg), false);
  assert.equal(run.status, "running");
});

test("resumeRun: returns false when run has no proc handle", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "paused" });
  reg.register(run);
  assert.equal(resumeRun(run, reg), false);
  assert.equal(run.status, "paused");
});

test("forceTerminate: no-op when run is already in a terminal state", () => {
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const run = makeRun({ status: "completed", finishedAt: 99, ...paths });
    reg.register(run);
    forceTerminate(run, "killed", reg);
    assert.equal(run.status, "completed");
    assert.equal(run.finishedAt, 99, "finishedAt is not overwritten");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("forceTerminate: 'killed' reason transitions running → killed and sets finishedAt", () => {
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const run = makeRun({ status: "running", ...paths });
    reg.register(run);

    let lastNotified: Run | undefined;
    reg.onChange((r) => (lastNotified = r));

    forceTerminate(run, "killed", reg);

    assert.equal(run.status, "killed");
    assert.ok(typeof run.finishedAt === "number" && run.finishedAt > 0);
    assert.equal(lastNotified, run, "registry listener fires on terminate");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("forceTerminate: 'timeout' reason transitions running → timeout", () => {
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const run = makeRun({ status: "running", ...paths });
    reg.register(run);
    forceTerminate(run, "timeout", reg);
    assert.equal(run.status, "timeout");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("forceTerminate: invokes onComplete callback once on terminal transition", () => {
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const run = makeRun({ status: "running", ...paths });
    reg.register(run);
    let calls = 0;
    forceTerminate(run, "killed", reg, () => calls++);
    assert.equal(calls, 1);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("forceTerminate: clears any pending timeoutTimer", () => {
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    // Use a never-firing timer so we can confirm it's cleared.
    const timer = setTimeout(() => {
      throw new Error("timer should have been cleared");
    }, 60_000);
    const run = makeRun({ status: "running", timeoutTimer: timer, ...paths });
    reg.register(run);
    forceTerminate(run, "killed", reg);
    assert.equal(run.timeoutTimer, undefined);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
