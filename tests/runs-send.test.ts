/**
 * Tests for `sendToRun` — the building block behind the ensemble_send tool.
 *
 * sendToRun(run, message, opts) resumes a finished sub-agent's pi session
 * via `pi --session <run.sessionPath>` with `message` as the user-role
 * prompt. We don't actually spawn pi here; we cover the pre-spawn
 * validation contract (status gating, missing sessionPath, etc.) which is
 * what the LLM-facing tool needs to enforce.
 *
 * Live end-to-end coverage lives in tests/spawn.integration.test.ts (gated).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunRegistry,
  buildResumePiArgs,
  resumeModel,
  sendToRun,
  sessionProviderForModel,
  validateSendable,
  type SendToRunResult,
} from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "conductor-send-"));
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-aaaa",
    persona: "oracle",
    task: "test",
    mode: "background",
    status: "completed",
    startTime: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/dev/null/record.json",
    transcriptPath: "/dev/null/transcript.jsonl",
    finalPath: "/dev/null/final.md",
    ...overrides,
  };
}

test("sendToRun: rejects when run is still running", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running", sessionPath: "/tmp/x.jsonl" });
  reg.register(run);
  const result = sendToRun(run, "hi", { registry: reg, timeoutMs: 60_000 });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.reason, /running|busy/i);
  }
});

test("sendToRun: rejects when run is paused (must resume first)", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "paused", sessionPath: "/tmp/x.jsonl" });
  reg.register(run);
  const result = sendToRun(run, "hi", { registry: reg, timeoutMs: 60_000 });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.reason, /paused/i);
  }
});

test("sendToRun: rejects when run is queued (not yet started)", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "queued", sessionPath: undefined });
  reg.register(run);
  const result = sendToRun(run, "hi", { registry: reg, timeoutMs: 60_000 });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.reason, /queued/i);
  }
});

test("sendToRun: rejects when run has no sessionPath (legacy or not-yet-started)", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "completed", sessionPath: undefined });
  reg.register(run);
  const result = sendToRun(run, "hi", { registry: reg, timeoutMs: 60_000 });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.reason, /session/i);
  }
});

test("sendToRun: rejects when sessionPath does not exist on disk", () => {
  const reg = new RunRegistry();
  const run = makeRun({
    status: "completed",
    sessionPath: "/tmp/conductor-does-not-exist-xyz.jsonl",
  });
  reg.register(run);
  const result = sendToRun(run, "hi", { registry: reg, timeoutMs: 60_000 });
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.reason, /session/i);
  }
});

test("sendToRun: empty message is rejected", () => {
  const dir = tmpDir();
  try {
    const sessionFile = join(dir, "abc.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const reg = new RunRegistry();
    const run = makeRun({ status: "completed", sessionPath: sessionFile });
    reg.register(run);
    const result = sendToRun(run, "   ", { registry: reg, timeoutMs: 60_000 });
    assert.equal(result.kind, "rejected");
    if (result.kind === "rejected") {
      assert.match(result.reason, /empty|message/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendToRun: a valid send flips status to running and clears terminal fields", () => {
  const dir = tmpDir();
  try {
    const sessionFile = join(dir, "abc.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const reg = new RunRegistry();
    const run = makeRun({
      status: "completed",
      finishedAt: 1_700_000_001_000,
      exitCode: 0,
      stopReason: "stop",
      sessionPath: sessionFile,
      // Use bogus paths so writeRecord/writeFinal silently no-op.
    });
    reg.register(run);

    const result: SendToRunResult = sendToRun(run, "another question", {
      registry: reg,
      timeoutMs: 60_000,
    });
    assert.equal(result.kind, "started", `got rejected: ${result.kind === "rejected" ? result.reason : ""}`);
    if (result.kind !== "started") return;

    // Status should be 'running' and terminal fields cleared.
    assert.equal(run.status, "running");
    assert.equal(run.finishedAt, undefined);
    assert.equal(run.exitCode, undefined);

    // Don't actually wait for pi to exit — kill the proc immediately.
    try {
      run.proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
    // Don't await result.done — we just assert state at start; the live
    // integration test covers the full lifecycle.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── validateSendable (pure pre-check used by both sendToRun and the overlay) ──

test("validateSendable: returns ok for a terminal run with a valid sessionPath", () => {
  const dir = tmpDir();
  try {
    const sessionFile = join(dir, "abc.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const run = makeRun({ status: "completed", sessionPath: sessionFile });
    const r = validateSendable(run);
    assert.equal(r.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateSendable: rejects running with a busy reason", () => {
  const run = makeRun({ status: "running", sessionPath: "/tmp/x.jsonl" });
  const r = validateSendable(run);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /running|busy/i);
});

test("validateSendable: rejects paused with a resume hint", () => {
  const run = makeRun({ status: "paused", sessionPath: "/tmp/x.jsonl" });
  const r = validateSendable(run);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /paused|resume/i);
});

test("validateSendable: rejects queued with a wait hint", () => {
  const run = makeRun({ status: "queued", sessionPath: undefined });
  const r = validateSendable(run);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /queued|wait/i);
});

test("validateSendable: rejects when sessionPath is missing", () => {
  const run = makeRun({ status: "completed", sessionPath: undefined });
  const r = validateSendable(run);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /session/i);
});

test("validateSendable: rejects when sessionPath does not exist on disk", () => {
  const run = makeRun({
    status: "completed",
    sessionPath: "/tmp/conductor-validateSendable-nonexistent.jsonl",
  });
  const r = validateSendable(run);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /session/i);
});

test("buildResumePiArgs: re-injects persona system prompt when run.systemPrompt is set", () => {
  // Pi sessions don't persist system prompts to disk, so without re-passing
  // --append-system-prompt the resumed sub-agent boots with pi's default
  // coding-agent prompt and loses persona identity.
  const run = makeRun({
    sessionPath: "/tmp/x.jsonl",
    systemPrompt: "You are the redteam: read-only auditor. Refuse to fix.",
    model: "anthropic:claude-opus-4-5",
    thinking: "high",
  });
  const args = buildResumePiArgs(run, "now find a bug AND fix it");
  assert.ok(args.includes("--session"));
  assert.equal(args[args.indexOf("--session") + 1], "/tmp/x.jsonl");
  assert.ok(args.includes("--append-system-prompt"));
  assert.equal(
    args[args.indexOf("--append-system-prompt") + 1],
    "You are the redteam: read-only auditor. Refuse to fix.",
  );
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--thinking"));
  assert.equal(args[args.length - 1], "now find a bug AND fix it");
});

test("buildResumePiArgs: omits --append-system-prompt when run.systemPrompt is unset", () => {
  // Back-compat: legacy Runs without a captured systemPrompt (e.g. from
  // before this fix) must keep working — sendToRun shouldn't crash, even
  // if the persona body is lost (which is the v0.5 latent bug).
  const run = makeRun({ sessionPath: "/tmp/x.jsonl", systemPrompt: undefined });
  const args = buildResumePiArgs(run, "hi");
  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(args.includes("--session"));
  assert.equal(args[args.length - 1], "hi");
});

test("buildResumePiArgs: passes a provider-qualified run.model through to --model", () => {
  const run = makeRun({
    sessionPath: "/tmp/x.jsonl",
    model: "pi-amazon-claude-provider/anthropic.claude-opus-5-5",
  });
  const args = buildResumePiArgs(run, "hi");
  assert.equal(args[args.indexOf("--model") + 1], "pi-amazon-claude-provider/anthropic.claude-opus-5-5");
});

// ── Legacy records: find the provider that served a bare run.model ──

function sessionText(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
const assistant = (provider: string | undefined, model: string) => ({
  type: "message",
  message: { role: "assistant", content: [], api: "anthropic-messages", provider, model },
});

test("sessionProviderForModel: reads the provider off an assistant message with the same model id", () => {
  const text = sessionText(
    { type: "session", version: 3, id: "s" },
    { type: "message", message: { role: "user", content: [] } },
    assistant("pi-amazon-claude-provider", "anthropic.claude-opus-5-5"),
  );
  assert.equal(sessionProviderForModel(text, "anthropic.claude-opus-5-5"), "pi-amazon-claude-provider");
});

test("sessionProviderForModel: reads a model_change entry", () => {
  const text = sessionText({ type: "model_change", provider: "amazon-bedrock", modelId: "anthropic.claude-opus-5-5" });
  assert.equal(sessionProviderForModel(text, "anthropic.claude-opus-5-5"), "amazon-bedrock");
});

test("sessionProviderForModel: the latest match wins over a seeded parent prefix", () => {
  // Seeded sessions start with the parent's messages; the child's own turns
  // come after them.
  const text = sessionText(
    assistant("amazon-bedrock", "anthropic.claude-opus-5-5"),
    assistant("pi-amazon-claude-provider", "anthropic.claude-opus-5-5"),
  );
  assert.equal(sessionProviderForModel(text, "anthropic.claude-opus-5-5"), "pi-amazon-claude-provider");
});

test("sessionProviderForModel: undefined when no entry names a provider for that model", () => {
  const text = sessionText(
    assistant("amazon-bedrock", "some.other-model"),
    assistant(undefined, "anthropic.claude-opus-5-5"),
  );
  assert.equal(sessionProviderForModel(text, "anthropic.claude-opus-5-5"), undefined);
});

test("sessionProviderForModel: skips malformed lines", () => {
  const text = `{not json\n${JSON.stringify(assistant("amazon-bedrock", "m"))}\n\n`;
  assert.equal(sessionProviderForModel(text, "m"), "amazon-bedrock");
});

// ── resumeModel: only qualify with a provider pi still registers ──
//
// Most legacy records name providers pi no longer loads (amazon-claude-code,
// bedrock-mantle). Their bare id resumed fine; `<gone-provider>/<id>` fails
// with `Model "..." not found`, and the id is persisted to record.json.

const OPUS = "anthropic.claude-opus-5-5";
const registeredOnly =
  (...pairs: string[]) =>
  (provider: string, id: string): boolean =>
    pairs.includes(`${provider}/${id}`);

function countingReader(text: string): { read: () => string; calls: () => number } {
  let n = 0;
  return {
    read: () => {
      n++;
      return text;
    },
    calls: () => n,
  };
}

test("resumeModel: a legacy bare id whose session provider is unregistered stays bare", () => {
  const text = sessionText(assistant("amazon-claude-code", OPUS));
  assert.equal(resumeModel(OPUS, () => text, registeredOnly(`amazon-bedrock/${OPUS}`)), OPUS);
});

test("resumeModel: a persisted `<unregistered>/<id>` from the session is repaired to the bare id", () => {
  const text = sessionText(assistant("amazon-claude-code", OPUS));
  assert.equal(resumeModel(`amazon-claude-code/${OPUS}`, () => text, registeredOnly(`amazon-bedrock/${OPUS}`)), OPUS);
});

test("resumeModel: a legacy bare id whose session provider is registered is prefixed", () => {
  const text = sessionText(assistant("pi-amazon-claude-provider", OPUS));
  assert.equal(
    resumeModel(OPUS, () => text, registeredOnly(`pi-amazon-claude-provider/${OPUS}`)),
    `pi-amazon-claude-provider/${OPUS}`,
  );
});

test("resumeModel: a registered qualified id skips the session read", () => {
  const reader = countingReader(sessionText(assistant("amazon-bedrock", OPUS)));
  assert.equal(resumeModel(`amazon-bedrock/${OPUS}`, reader.read, registeredOnly(`amazon-bedrock/${OPUS}`)), `amazon-bedrock/${OPUS}`);
  assert.equal(reader.calls(), 0, "5.7 MB sessions cost 33-52 ms to read");
});

test("resumeModel: an unregistered qualified id the session never served passes through", () => {
  // A configured persona model is the user's choice; only strip a prefix
  // the session itself vouches for.
  const text = sessionText(assistant("amazon-bedrock", OPUS));
  assert.equal(resumeModel("custom-provider/some-model", () => text, registeredOnly()), "custom-provider/some-model");
});

test("resumeModel: without a registry predicate, the session provider is prefixed as before", () => {
  const text = sessionText(assistant("amazon-claude-code", OPUS));
  assert.equal(resumeModel(OPUS, () => text), `amazon-claude-code/${OPUS}`);
  assert.equal(resumeModel(`amazon-claude-code/${OPUS}`, () => text), `amazon-claude-code/${OPUS}`);
});

test("resumeModel: an unreadable session passes the id through", () => {
  const boom = () => {
    throw new Error("ENOENT");
  };
  assert.equal(resumeModel(OPUS, boom, registeredOnly()), OPUS);
  assert.equal(resumeModel(undefined, boom, registeredOnly()), undefined);
});

test("sendToRun reseeds lastEventAt to now", () => {
  // Regression: sendToRun did not reset lastEventAt, so the watchdog's
  // next tick would compute silentMs against the *previous turn's*
  // lastEventAt and fire spurious stall alerts on resumed runs.
  const dir = tmpDir();
  try {
    const sessionFile = join(dir, "abc.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const reg = new RunRegistry();
    const run = makeRun({
      status: "completed",
      sessionPath: sessionFile,
      lastEventAt: 1_700_000_000_000, // far in the past
      stalledSince: 1_700_000_000_500, // leftover from previous turn
    });
    reg.register(run);

    const before = Date.now();
    const result = sendToRun(run, "continue", { registry: reg, timeoutMs: 60_000 });
    assert.equal(result.kind, "started");

    // lastEventAt must be reseeded to approximately now.
    assert.ok(
      Math.abs(run.lastEventAt - Date.now()) < 2000,
      `lastEventAt should be ~now but was ${run.lastEventAt} (delta: ${Date.now() - run.lastEventAt}ms)`,
    );
    // stalledSince must be cleared — no stale advisory state.
    assert.equal(run.stalledSince, undefined);

    // Cleanup: kill the spawned subprocess.
    try { run.proc?.kill("SIGKILL"); } catch { /* already gone */ }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Item 15 — sendToRun resets per-invocation markers BEFORE the new turn fires ──
//
// Witness: `builder-501r` had cumulative-since-original-spawn duration
// and cost in its completion envelopes after each `ensemble_send`.
// Locked design: `sendToRun` re-stamps `thisInvocationStartedAt` and
// `thisInvocationUsageBaseline` BEFORE the new pi subprocess fires, and
// increments `resumeCount`. The completion envelope reads these to
// compute per-send deltas.

test(
  "sendToRun: spawn-resume path stamps thisInvocationStartedAt to now() before subprocess fires",
  () => {
    const dir = tmpDir();
    try {
      const sessionFile = join(dir, "abc.jsonl");
      writeFileSync(sessionFile, "{}\n");
      const reg = new RunRegistry();
      const t0 = 1_700_000_000_000;
      const t1 = 1_700_000_005_000;
      const run = makeRun({
        status: "completed",
        startTime: t0,
        finishedAt: t1,
        sessionPath: sessionFile,
        thisInvocationStartedAt: t0, // initial-spawn baseline
      });
      reg.register(run);

      const beforeSend = Date.now();
      const result = sendToRun(run, "another", {
        registry: reg,
        timeoutMs: 60_000,
      });
      const afterSend = Date.now();
      assert.equal(result.kind, "started");

      // The new invocation's start anchor must have advanced from the
      // pre-existing (initial-spawn) value to the wall-clock at
      // resume-fire time.
      assert.ok(
        run.thisInvocationStartedAt !== undefined &&
          run.thisInvocationStartedAt >= beforeSend &&
          run.thisInvocationStartedAt <= afterSend,
        `expected thisInvocationStartedAt in [${beforeSend}, ${afterSend}], got ${run.thisInvocationStartedAt}`,
      );
      // The original spawn timestamp must NOT be touched.
      assert.equal(run.startTime, t0, "startTime must remain the original-spawn anchor");

      try { run.proc?.kill("SIGKILL"); } catch { /* already gone */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "sendToRun: spawn-resume path captures usage baseline + increments resumeCount",
  () => {
    const dir = tmpDir();
    try {
      const sessionFile = join(dir, "abc.jsonl");
      writeFileSync(sessionFile, "{}\n");
      const reg = new RunRegistry();
      const run = makeRun({
        status: "completed",
        sessionPath: sessionFile,
        // Cumulative usage from one prior invocation:
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.5, turns: 4 },
        // Initial-spawn baseline (zeros).
        thisInvocationUsageBaseline: { turns: 0, input: 0, output: 0, cost: 0 },
        resumeCount: 0,
      });
      reg.register(run);

      const result = sendToRun(run, "another", {
        registry: reg,
        timeoutMs: 60_000,
      });
      assert.equal(result.kind, "started");

      // Baseline snapshot must equal the pre-resume cumulative usage so
      // future delta computation in the completion envelope is correct.
      assert.deepEqual(run.thisInvocationUsageBaseline, {
        turns: 4,
        input: 100,
        output: 200,
        cost: 1.5,
      });
      // resumeCount incremented by exactly 1.
      assert.equal(run.resumeCount, 1);
      // Cumulative usage must NOT be reset — the run's totals stay live.
      assert.deepEqual(run.usage, {
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 1.5,
        turns: 4,
      });

      try { run.proc?.kill("SIGKILL"); } catch { /* already gone */ }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
