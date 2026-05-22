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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  RunRegistry,
  allocateRunId,
  applyCloseHandlerTerminal,
  applySubstanceCheck,
  buildPiArgs,
  buildSubAgentPrompt,
  buildSubagentEnv,
  collectInheritedSkillPaths,
  discoverSessionPathIfMissing,
  elapsedStr,
  findSessionFile,
  forceTerminate,
  formatTokens,
  formatUsage,
  getFinalText,
  pauseRun,
  planSpawnPiArgs,
  attachSpawnedProc,
  recordSpawnedProc,
  resumeRun,
} from "../src/runs.ts";
import { emptyUsage, toRunRecord, type Persona, type Run } from "../src/types.ts";

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
    lastEventAt: 1_700_000_000_000,
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

// ── resolveTimeoutMs ─────────────────────────────────────────────

import { resolveTimeoutMs } from "../src/runs.ts";

test("resolveTimeoutMs: prefers override > persona > config default", () => {
  const cfg = { defaultTimeoutMinutes: 30 } as any;
  const persona = { timeoutMinutes: 15 } as any;
  const ov = { timeoutMinutes: 5 } as any;
  assert.equal(resolveTimeoutMs(persona, ov, cfg), 5 * 60_000);
});

test("resolveTimeoutMs: falls back to persona when override has no timeout", () => {
  const cfg = { defaultTimeoutMinutes: 30 } as any;
  const persona = { timeoutMinutes: 15 } as any;
  const ov = {} as any;
  assert.equal(resolveTimeoutMs(persona, ov, cfg), 15 * 60_000);
});

test("resolveTimeoutMs: falls back to config default when persona is undefined", () => {
  const cfg = { defaultTimeoutMinutes: 30 } as any;
  assert.equal(resolveTimeoutMs(undefined, {}, cfg), 30 * 60_000);
});

test("resolveTimeoutMs: ensemble_send must respect persona.timeoutMinutes too (regression)", () => {
  // The bug fixed in this commit: ensemble_send used to skip the persona
  // layer, falling straight from override to default. This test pins the
  // contract that the helper applies to BOTH spawn and send paths.
  const cfg = { defaultTimeoutMinutes: 30 } as any;
  const persona = { timeoutMinutes: 60 } as any;
  // No override — persona should win, NOT the default.
  assert.equal(resolveTimeoutMs(persona, {}, cfg), 60 * 60_000);
  assert.notEqual(resolveTimeoutMs(persona, {}, cfg), 30 * 60_000);
});

// ── findSessionFile ──────────────────────────────────────────────────────

import { writeFileSync, mkdirSync, utimesSync } from "node:fs";

test("findSessionFile: returns the .jsonl path when exactly one is present", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const f = join(sd, "2026-05-14T00-00-00-000Z_abc.jsonl");
    writeFileSync(f, "{}\n");
    assert.equal(findSessionFile(sd), f);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("findSessionFile: returns undefined when no .jsonl exists", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    assert.equal(findSessionFile(sd), undefined);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("findSessionFile: returns undefined when the directory does not exist", () => {
  assert.equal(findSessionFile("/dev/null/does/not/exist"), undefined);
});

test("findSessionFile: returns the most-recently-modified .jsonl when multiple exist", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const oldF = join(sd, "old.jsonl");
    const newF = join(sd, "new.jsonl");
    writeFileSync(oldF, "{}\n");
    // Backdate the older file so the newer one wins.
    const past = Date.now() / 1000 - 60;
    utimesSync(oldF, past, past);
    writeFileSync(newF, "{}\n");
    assert.equal(findSessionFile(sd), newF);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
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

test("pauseRun: happy path — SIGSTOPs the proc, flips status to paused, sets pausedAt, notifies", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  // Fake child-process handle so pauseRun's pid check passes.
  run.proc = { pid: 12345 } as any;
  reg.register(run);
  const calls: { pid: number; signal: NodeJS.Signals | number }[] = [];
  const signaler = (pid: number, signal: NodeJS.Signals | number) => {
    calls.push({ pid, signal });
  };
  let notifyCount = 0;
  reg.onChange(() => {
    notifyCount++;
  });
  const before = Date.now();
  assert.equal(pauseRun(run, reg, signaler), true);
  assert.deepEqual(calls, [{ pid: 12345, signal: "SIGSTOP" }]);
  assert.equal(run.status, "paused");
  assert.ok(run.pausedAt && run.pausedAt >= before, "pausedAt should be set to ~now");
  assert.equal(notifyCount, 1, "registry.notify should fire exactly once");
});

test("pauseRun: signaler throws — returns false, run state unchanged", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  run.proc = { pid: 99 } as any;
  reg.register(run);
  const throwingSignaler = () => {
    throw new Error("ESRCH");
  };
  assert.equal(pauseRun(run, reg, throwingSignaler), false);
  assert.equal(run.status, "running", "status must not flip on signaler failure");
  assert.equal(run.pausedAt, undefined, "pausedAt must not be written on failure");
});

test("resumeRun: happy path — SIGCONTs the proc, flips status to running, clears pausedAt, notifies", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "paused" });
  run.proc = { pid: 6789 } as any;
  run.pausedAt = 1_700_000_000_000;
  reg.register(run);
  const calls: { pid: number; signal: NodeJS.Signals | number }[] = [];
  const signaler = (pid: number, signal: NodeJS.Signals | number) => {
    calls.push({ pid, signal });
  };
  let notifyCount = 0;
  reg.onChange(() => {
    notifyCount++;
  });
  assert.equal(resumeRun(run, reg, signaler), true);
  assert.deepEqual(calls, [{ pid: 6789, signal: "SIGCONT" }]);
  assert.equal(run.status, "running");
  assert.equal(run.pausedAt, undefined, "pausedAt should be cleared on resume");
  assert.equal(notifyCount, 1, "registry.notify should fire exactly once");
});

test("resumeRun: signaler throws — returns false, run state unchanged", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "paused" });
  run.proc = { pid: 99 } as any;
  run.pausedAt = 42;
  reg.register(run);
  const throwingSignaler = () => {
    throw new Error("ESRCH");
  };
  assert.equal(resumeRun(run, reg, throwingSignaler), false);
  assert.equal(run.status, "paused", "status must not flip on signaler failure");
  assert.equal(run.pausedAt, 42, "pausedAt must not be cleared on failure");
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

test(
  "forceTerminate: refuses to mutate foreign run (parentPid !== process.pid)",
  () => {
    // Defense-in-depth against the foreign-adoption bug. If reconcile
    // ever leaks a sibling-pi-session run into the local registry (or
    // an LLM-tool caller passes its agent_id), forceTerminate must
    // NOT flip status, NOT writeRecord, NOT notify listeners, and NOT
    // call onComplete. The owning session is responsible for that run.
    const paths = tmpRunPaths();
    try {
      const reg = new RunRegistry();
      const run = makeRun({
        status: "running",
        parentPid: process.pid + 1,
        parentStartTime: 12345,
        ...paths,
      });
      reg.register(run);

      let notified = 0;
      reg.onChange(() => notified++);
      let completed = 0;

      // Suppress the warn so test output stays clean.
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        forceTerminate(run, "killed", reg, () => completed++);
      } finally {
        console.warn = origWarn;
      }

      assert.equal(run.status, "running", "status must NOT flip");
      assert.equal(run.finishedAt, undefined, "finishedAt must NOT be set");
      assert.equal(notified, 0, "registry listener must NOT fire");
      assert.equal(completed, 0, "onComplete must NOT fire");
    } finally {
      rmSync(paths.dir, { recursive: true, force: true });
    }
  },
);

// ── applyCloseHandlerTerminal (proc.on("close") race-fix) ─────────────
//
// `runPiSubprocess` finalizes a run through two paths:
//   1. The subprocess's natural exit (proc.on("close")) routes through
//      the closure-local `finalize`.
//   2. An external `forceTerminate` (called by runStop, the timeout
//      timer, or session_shutdown) settles the run synchronously.
//
// If (2) ran first, SIGTERM/SIGKILL eventually causes (1) with a
// non-zero exit code. The legacy `finalize` only checked its own
// `finalized` flag — not `run.status` — so the close handler would
// silently regress "killed" → "failed" and double-fire onComplete.
//
// `applyCloseHandlerTerminal` is the testable seam that owns the
// guard + the run-state mutation. The closure uses its return value
// to gate the rest of finalize's body (errorMessage fallback,
// session-file discovery, persistence writes, onComplete).

test("applyCloseHandlerTerminal: applies status/exitCode/finishedAt on the happy path", () => {
  const paths = tmpRunPaths();
  try {
    const run = makeRun({ status: "running", ...paths });
    const t0 = Date.now();
    const mutated = applyCloseHandlerTerminal(run, "completed", 0);
    assert.equal(mutated, true);
    assert.equal(run.status, "completed");
    assert.equal(run.exitCode, 0);
    assert.ok(typeof run.finishedAt === "number" && run.finishedAt >= t0);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("applyCloseHandlerTerminal: bails when run is already terminal — status must NOT regress", () => {
  // Race-fix invariant: a late close handler must not flip an
  // already-killed run back to "failed" with the SIGTERM exit code.
  const paths = tmpRunPaths();
  try {
    const run = makeRun({
      status: "killed",
      finishedAt: 99,
      exitCode: undefined,
      ...paths,
    });
    const mutated = applyCloseHandlerTerminal(run, "failed", 143);
    assert.equal(mutated, false, "must bail when run is already terminal");
    assert.equal(run.status, "killed", "status must NOT regress to failed");
    assert.equal(run.finishedAt, 99, "finishedAt must not be overwritten");
    assert.equal(run.exitCode, undefined, "exitCode must not be set on bail");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("applyCloseHandlerTerminal: bails for every terminal status (killed / timeout / completed / failed)", () => {
  const paths = tmpRunPaths();
  try {
    for (const prior of ["killed", "timeout", "completed", "failed"] as const) {
      const run = makeRun({ status: prior, finishedAt: 1, ...paths });
      const mutated = applyCloseHandlerTerminal(run, "failed", 1);
      assert.equal(mutated, false, `must bail when status=${prior}`);
      assert.equal(run.status, prior, `status must remain ${prior}`);
      assert.equal(run.finishedAt, 1, "finishedAt must not be overwritten");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("applyCloseHandlerTerminal: after forceTerminate, the close handler bails", () => {
  // Reproduces the exact race the bug report described:
  //   forceTerminate sets status=killed and fires onComplete.
  //   The subprocess then exits (SIGTERM → exit code 143).
  //   proc.on("close") routes through finalize → applyCloseHandlerTerminal.
  //   The helper must bail; no status regress, no second onComplete via
  //   this path.
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const run = makeRun({ status: "running", ...paths });
    reg.register(run);
    let onCompleteCalls = 0;

    forceTerminate(run, "killed", reg, () => onCompleteCalls++);
    assert.equal(run.status, "killed");
    assert.equal(onCompleteCalls, 1, "forceTerminate fires onComplete once");

    // Subprocess exits afterwards with SIGTERM:
    const mutated = applyCloseHandlerTerminal(run, "failed", 143);
    assert.equal(mutated, false, "helper must bail — forceTerminate already settled");
    assert.equal(run.status, "killed", "status must NOT regress to failed");
    // The closure caller, on receiving false, skips its onComplete branch
    // and only resolves `done`. The full closure-level guarantee is
    // exercised by the live spawn integration test; here we pin the
    // helper-level invariant the closure depends on.
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ── discoverSessionPathIfMissing (bail-path session discovery) ─────────
//
// `findSessionFile` is owned by the close-handler `finalize` path,
// not by `forceTerminate`. The bail branch must still discover the
// pi session file so a force-killed/timed-out sub-agent remains
// resumable via `ensemble_send` (otherwise `validateSendable` rejects
// it with "sessionPath unset").
//
// `discoverSessionPathIfMissing` is the shared seam used by both the
// happy path and the bail path inside `finalize`. Tests pin its
// guard semantics; a composition test below pins the bail-path
// regression specifically.

test("discoverSessionPathIfMissing: sets sessionPath when sessionDir holds a .jsonl and sessionPath is unset", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const f = join(sd, "2026-05-15T00-00-00-000Z_abc.jsonl");
    writeFileSync(f, "{}\n");
    const run = makeRun({ sessionPath: undefined, ...paths });
    discoverSessionPathIfMissing(run, sd);
    assert.equal(run.sessionPath, f);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("discoverSessionPathIfMissing: no-op when sessionDir is undefined", () => {
  const run = makeRun({ sessionPath: undefined });
  discoverSessionPathIfMissing(run, undefined);
  assert.equal(run.sessionPath, undefined);
});

test("discoverSessionPathIfMissing: no-op when sessionPath is already set (never overwrite)", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const decoy = join(sd, "decoy.jsonl");
    writeFileSync(decoy, "{}\n");
    const run = makeRun({ sessionPath: "/already/set.jsonl", ...paths });
    discoverSessionPathIfMissing(run, sd);
    assert.equal(
      run.sessionPath,
      "/already/set.jsonl",
      "must NOT overwrite an existing sessionPath",
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("discoverSessionPathIfMissing: no-op when sessionDir contains no .jsonl", () => {
  const paths = tmpRunPaths();
  try {
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const run = makeRun({ sessionPath: undefined, ...paths });
    discoverSessionPathIfMissing(run, sd);
    assert.equal(run.sessionPath, undefined);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("bail path composition: after forceTerminate, discoverSessionPathIfMissing must still populate sessionPath", () => {
  // Pins the critic's regression report: pre-fix, the bail branch
  // returned before findSessionFile, leaving sessionPath undefined.
  // Without this the run is unresumable via ensemble_send (rejected
  // by validateSendable as 'sessionPath unset').
  const paths = tmpRunPaths();
  try {
    const reg = new RunRegistry();
    const sd = join(paths.dir, "session");
    mkdirSync(sd, { recursive: true });
    const sessionFile = join(sd, "2026-05-15T00-00-00-000Z_xyz.jsonl");
    writeFileSync(sessionFile, "{}\n");

    const run = makeRun({ status: "running", sessionPath: undefined, ...paths });
    reg.register(run);
    forceTerminate(run, "killed", reg);
    assert.equal(run.status, "killed");
    assert.equal(run.sessionPath, undefined, "forceTerminate does not discover sessionPath");

    // Subprocess exits afterwards; close handler enters the bail branch.
    const mutated = applyCloseHandlerTerminal(run, "failed", 143);
    assert.equal(mutated, false, "helper bails because forceTerminate already settled");
    discoverSessionPathIfMissing(run, sd);

    assert.equal(
      run.sessionPath,
      sessionFile,
      "bail branch must still discover sessionPath so ensemble_send can resume",
    );
    assert.equal(run.status, "killed", "status remains killed");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ── applySubstanceCheck (v0.8.1 Item 4) ───────────────────────────
//
// The integration seam: finalize() calls applySubstanceCheck(run, terminal)
// only on the completed path; failed/killed/timeout paths skip it. These
// tests pin that contract without spawning a real subprocess.

function asstMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

test("applySubstanceCheck: completed run with short final text sets nonSubstantiveFinal", () => {
  const run = makeRun({ status: "completed", messages: [asstMessage("Done.")] });
  applySubstanceCheck(run, "completed");
  assert.equal(run.nonSubstantiveFinal?.reason, "too_short");
  assert.match(run.nonSubstantiveFinal!.message, /5 chars/);
});

test("applySubstanceCheck: completed run with substantive text leaves the field unset", () => {
  const longText =
    "## Verdict\n\nAll three slices land cleanly. The regression net pins each " +
    "branch with byte-exact assertions; mutation tests confirm teeth on the load-bearing " +
    "checks. No drift detected vs the design or the PRD locks. Ship it.";
  const run = makeRun({ status: "completed", messages: [asstMessage(longText)] });
  applySubstanceCheck(run, "completed");
  assert.equal(run.nonSubstantiveFinal, undefined);
});

test("applySubstanceCheck: failed terminal does NOT trigger the heuristic", () => {
  const run = makeRun({ status: "failed", messages: [asstMessage("x")] });
  applySubstanceCheck(run, "failed");
  assert.equal(run.nonSubstantiveFinal, undefined);
});

test("applySubstanceCheck: killed terminal does NOT trigger the heuristic", () => {
  const run = makeRun({ status: "killed", messages: [asstMessage("Let me check.")] });
  applySubstanceCheck(run, "killed");
  assert.equal(run.nonSubstantiveFinal, undefined);
});

test("applySubstanceCheck: timeout terminal does NOT trigger the heuristic", () => {
  const run = makeRun({ status: "timeout", messages: [asstMessage("Now I'll inspect.")] });
  applySubstanceCheck(run, "timeout");
  assert.equal(run.nonSubstantiveFinal, undefined);
});

test("applySubstanceCheck: idempotent — a second call does not overwrite the existing flag", () => {
  const run = makeRun({
    status: "completed",
    messages: [asstMessage("Brief.")],
    nonSubstantiveFinal: { reason: "existing", message: "prior warning" },
  });
  applySubstanceCheck(run, "completed");
  assert.equal(run.nonSubstantiveFinal?.reason, "existing");
  assert.equal(run.nonSubstantiveFinal?.message, "prior warning");
});

// ── v0.10 A1: buildSubagentEnv ────────────────────────────────────────────────────

test("buildSubagentEnv: sets CONDUCTOR_SUBAGENT=1", () => {
  const env = buildSubagentEnv({ FOO: "bar" });
  assert.equal(env.CONDUCTOR_SUBAGENT, "1");
});

test("buildSubagentEnv: passes through caller env keys verbatim", () => {
  const env = buildSubagentEnv({ FOO: "bar", PATH: "/usr/bin" });
  assert.equal(env.FOO, "bar");
  assert.equal(env.PATH, "/usr/bin");
});

test("buildSubagentEnv: caller-supplied CONDUCTOR_SUBAGENT is overridden to 1 (transitive sub-spawns)", () => {
  // Even if the caller is itself a sub-agent (CONDUCTOR_SUBAGENT=1) or has
  // some other value, the spawn helper pins it to "1" — conductor-context
  // propagates transitively.
  const env = buildSubagentEnv({ CONDUCTOR_SUBAGENT: "0", OTHER: "keep" });
  assert.equal(env.CONDUCTOR_SUBAGENT, "1");
  assert.equal(env.OTHER, "keep");
});

test("buildSubagentEnv: defaults to process.env when no base provided", () => {
  const prev = process.env.CONDUCTOR_TEST_MARKER;
  process.env.CONDUCTOR_TEST_MARKER = "sentinel";
  try {
    const env = buildSubagentEnv();
    assert.equal(env.CONDUCTOR_TEST_MARKER, "sentinel");
    assert.equal(env.CONDUCTOR_SUBAGENT, "1");
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_TEST_MARKER;
    else process.env.CONDUCTOR_TEST_MARKER = prev;
  }
});

// ── inherit_skills (PRD #15) ────────────────────────────────

test("collectInheritedSkillPaths: both dirs absent → [] (no error)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pic-skills-none-"));
  try {
    const fakeHome = join(tmp, "home");
    const fakeCwd = join(tmp, "proj");
    const paths = collectInheritedSkillPaths({ homeDir: fakeHome, cwd: fakeCwd });
    assert.deepEqual(paths, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectInheritedSkillPaths: user dir exists, project dir absent → ONE path (user only)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pic-skills-user-"));
  try {
    const fakeHome = join(tmp, "home");
    const userSkills = join(fakeHome, ".pi", "agent", "skills");
    mkdirSync(userSkills, { recursive: true });
    const fakeCwd = join(tmp, "proj");
    const paths = collectInheritedSkillPaths({ homeDir: fakeHome, cwd: fakeCwd });
    assert.deepEqual(paths, [userSkills]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectInheritedSkillPaths: both dirs exist → TWO paths in user-then-project order", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pic-skills-both-"));
  try {
    const fakeHome = join(tmp, "home");
    const fakeCwd = join(tmp, "proj");
    const userSkills = join(fakeHome, ".pi", "agent", "skills");
    const projectSkills = join(fakeCwd, ".pi", "skills");
    mkdirSync(userSkills, { recursive: true });
    mkdirSync(projectSkills, { recursive: true });
    const paths = collectInheritedSkillPaths({ homeDir: fakeHome, cwd: fakeCwd });
    assert.deepEqual(paths, [userSkills, projectSkills]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectInheritedSkillPaths: project dir exists, user dir absent → ONE path (project only)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pic-skills-proj-"));
  try {
    const fakeHome = join(tmp, "home");
    const fakeCwd = join(tmp, "proj");
    const projectSkills = join(fakeCwd, ".pi", "skills");
    mkdirSync(projectSkills, { recursive: true });
    const paths = collectInheritedSkillPaths({ homeDir: fakeHome, cwd: fakeCwd });
    assert.deepEqual(paths, [projectSkills]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectInheritedSkillPaths: existsFn injection probes both candidates, no real fs touch", () => {
  const probed: string[] = [];
  const paths = collectInheritedSkillPaths({
    homeDir: "/fake/home",
    cwd: "/fake/proj",
    existsFn: (p) => {
      probed.push(p);
      return p === "/fake/home/.pi/agent/skills";
    },
  });
  assert.deepEqual(probed, ["/fake/home/.pi/agent/skills", "/fake/proj/.pi/skills"]);
  assert.deepEqual(paths, ["/fake/home/.pi/agent/skills"]);
});

test("buildPiArgs(fresh) + skillPaths: emits one --skill <path> per entry, all before the prompt", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "S",
    prompt: "P",
    skillPaths: ["/u/skills", "/p/skills"],
  });
  const skillIdxs: number[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--skill") skillIdxs.push(i);
  assert.equal(skillIdxs.length, 2, "expected exactly two --skill flags");
  assert.equal(args[skillIdxs[0]! + 1], "/u/skills");
  assert.equal(args[skillIdxs[1]! + 1], "/p/skills");
  for (const i of skillIdxs) assert.ok(i < args.length - 1, "--skill must precede prompt");
  assert.equal(args[args.length - 1], "P");
});

test("buildPiArgs: omits --skill when skillPaths is undefined or empty (default behavior unchanged)", () => {
  const a1 = buildPiArgs({ kind: "fresh", sessionDir: "/tmp", systemPrompt: "S", prompt: "P" });
  assert.equal(a1.includes("--skill"), false);
  const a2 = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp",
    systemPrompt: "S",
    prompt: "P",
    skillPaths: [],
  });
  assert.equal(a2.includes("--skill"), false);
});

test("buildPiArgs(resume) + skillPaths: emits --skill flags on resume too", () => {
  const args = buildPiArgs({
    kind: "resume",
    sessionPath: "/tmp/s.jsonl",
    prompt: "msg",
    skillPaths: ["/u/skills"],
  });
  const i = args.indexOf("--skill");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "/u/skills");
  assert.equal(args[args.length - 1], "msg");
});

test("planSpawnPiArgs: skillPaths threads through to fresh-mode piArgs in caller order", () => {
  const persona: Persona = {
    name: "tester",
    description: "",
    systemPrompt: "S",
    inheritContext: "none",
    inheritSkills: true,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    source: "builtin",
    sourcePath: "<test>",
  } as Persona;
  const plan = planSpawnPiArgs({
    persona,
    sessionDir: "/tmp/sess",
    systemPrompt: "S",
    prompt: "P",
    cwd: "/proj",
    skillPaths: ["/u/skills", "/p/skills"],
  });
  assert.equal(plan.mode, "fresh");
  const skillIdxs = plan.piArgs.map((a, i) => (a === "--skill" ? i : -1)).filter((i) => i >= 0);
  assert.equal(skillIdxs.length, 2);
  assert.equal(plan.piArgs[skillIdxs[0]! + 1], "/u/skills");
  assert.equal(plan.piArgs[skillIdxs[1]! + 1], "/p/skills");
});

// ── v0.9.x post-startup reconcile (slice 1): pid persistence ─────────
//
// W6: spawnRun must capture proc.pid into run.pid so post-startup
//     reconcile can liveness-probe orphaned `running` records. We test
//     the pure helper `recordSpawnedProc(run, proc)` directly to avoid
//     forking a real pi subprocess (slow + AWS-coupled in this repo).
// W7: toRunRecord must persist pid so the next runtime sees it on disk.

test("W6 recordSpawnedProc captures pid + proc on the Run", () => {
  const fakeProc = { pid: 123456 } as unknown as Run["proc"];
  const run = makeRun({ id: "test-w6" });
  recordSpawnedProc(run, fakeProc!);
  assert.equal(run.proc, fakeProc);
  assert.equal(run.pid, 123456);
});

test("W6b recordSpawnedProc tolerates a proc whose pid is undefined", () => {
  // child_process.spawn() can return a ChildProcess whose pid is
  // undefined when spawn fails synchronously between event-loop
  // ticks (rare). The helper must not throw and must leave
  // run.pid undefined (explicit "not captured").
  const fakeProc = { pid: undefined } as unknown as Run["proc"];
  const run = makeRun({ id: "test-w6b" });
  recordSpawnedProc(run, fakeProc!);
  assert.equal(run.proc, fakeProc);
  assert.equal(run.pid, undefined);
});

test("W7 toRunRecord persists pid", () => {
  const run = makeRun({ id: "test-w7", pid: 99999 });
  const rec = toRunRecord(run);
  assert.equal(rec.pid, 99999);
});

test("W7b toRunRecord omits pid when Run has no pid (back-compat)", () => {
  const run = makeRun({ id: "test-w7b" });
  const rec = toRunRecord(run);
  assert.equal(rec.pid, undefined);
});

// W7c: regression test for the orphaned-record bug. spawnRun's initial
//      writeRecord runs before child_process.spawn() returns a pid, so
//      the on-disk record is briefly `running` with no pid. If a
//      concurrent pi process starts up during that window, its
//      reconcileOrphansAtStartup classifies the record as
//      `reclassify-pre-schema` and flips it to `killed`. Fix: persist
//      the record again right after recordSpawnedProc captures the
//      pid. The witness is `attachSpawnedProc` — a thin helper that
//      does both steps and is the single call site spawnRun uses.
test("W7c attachSpawnedProc persists pid to disk so reconcile sees a live pid", async () => {
  const paths = tmpRunPaths();
  try {
    const run = makeRun({
      id: "test-w7c",
      recordPath: paths.recordPath,
      transcriptPath: paths.transcriptPath,
      finalPath: paths.finalPath,
    });
    const fakeProc = { pid: 4242 } as unknown as Run["proc"];
    await attachSpawnedProc(run, fakeProc!);
    assert.equal(run.pid, 4242);
    const onDisk = JSON.parse(readFileSync(paths.recordPath, "utf8"));
    assert.equal(
      onDisk.pid,
      4242,
      "on-disk record must carry the spawned pid so concurrent pi startups don't reclassify-pre-schema this run",
    );
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
