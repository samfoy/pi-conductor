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
  sendToRun,
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
