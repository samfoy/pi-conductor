/**
 * Tests for v0.8.3 — per-call `timeout_minutes` override on
 * `ensemble_spawn` / `ensemble_send`, plus the global default bump 30 → 60.
 *
 * The behavior path is "tool-arg → ov.timeoutMinutes → resolveTimeoutMs →
 * queue.enqueueOrSpawn opts.timeoutMs". We pin:
 *   - schema: each tool declares an optional `timeout_minutes` integer in
 *     [1, 1440].
 *   - plumbing: a tool-arg is propagated as the `ov.timeoutMinutes` override,
 *     winning over persona/global defaults. Verified by capturing the
 *     `timeoutMs` passed into the queued PendingSpawn.
 *   - range validation: `0` and `1441` are rejected at the tool level,
 *     before persona resolution / queue dispatch.
 *   - default: `DEFAULT_CONFIG.defaultTimeoutMinutes === 60` and the
 *     persona-frontmatter fallback is also `60`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run } from "../src/types.ts";
import { resolvePersonas, projectPersonasDir } from "../src/personas.ts";
import { mkdirSync } from "node:fs";

interface RegisteredTool {
  name: string;
  description?: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any>;
}

function tmpSessionFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-timeout-"));
  const path = join(dir, "abc.jsonl");
  writeFileSync(path, "{}\n");
  return { dir, path };
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "completed",
    startTime: Date.now() - 10_000,
    lastEventAt: Date.now() - 10_000,
    finishedAt: Date.now() - 1_000,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...overrides,
  };
}

function setup(extraRuns: Run[] = []) {
  const reg = new RunRegistry();
  for (const r of extraRuns) reg.register(r);
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const tools: RegisteredTool[] = [];
  registerTools(
    { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
    {
      getCwd: () => "/tmp",
      getRegistry: () => reg,
      getQueue: () => queue,
      getModel: () => model,
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({
        detachSignal: new Promise<void>(() => {}),
        unregister: () => {},
      }),
      pushCompletionNotification: () => {},
    },
  );
  return {
    reg,
    queue,
    spawnTool: tools.find((t) => t.name === "ensemble_spawn")!,
    sendTool: tools.find((t) => t.name === "ensemble_send")!,
  };
}

// Build a queue whose only job is to capture enqueueOrSpawn opts and queue
// a placeholder, never spawning a real subprocess.
function captureQueue(reg: RunRegistry) {
  const captured: {
    timeoutMs?: number;
    killOnStall?: boolean;
    softStallSeconds?: number;
    called: boolean;
  } = { called: false };
  const fakeQueue = {
    enqueueOrSpawn(opts: any) {
      captured.called = true;
      captured.timeoutMs = opts.timeoutMs;
      captured.killOnStall = opts.killOnStall;
      captured.softStallSeconds = opts.softStallSeconds;
      const placeholder = makeRun(`fake-${Math.random().toString(36).slice(2, 6)}`, {
        status: "queued",
        persona: opts.persona.name,
        finishedAt: undefined,
      });
      reg.register(placeholder);
      return {
        kind: "queued" as const,
        pending: { id: placeholder.id } as any,
        placeholderRun: placeholder,
        downgraded: false,
        queuePosition: 1,
      };
    },
  };
  return { fakeQueue, captured };
}

function setupWithCaptureQueue() {
  const reg = new RunRegistry();
  const { fakeQueue, captured } = captureQueue(reg);
  const model = new FocusedStreamModel(reg);
  const tools: RegisteredTool[] = [];
  registerTools(
    { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
    {
      getCwd: () => "/tmp",
      getRegistry: () => reg,
      getQueue: () => fakeQueue as any,
      getModel: () => model,
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({
        detachSignal: new Promise<void>(() => {}),
        unregister: () => {},
      }),
      pushCompletionNotification: () => {},
    },
  );
  return {
    captured,
    spawnTool: tools.find((t) => t.name === "ensemble_spawn")!,
  };
}

// ── Default constant pinning ──────────────────────────────────────────

test("DEFAULT_CONFIG.defaultTimeoutMinutes is 60 (raised from 30 in v0.8.3)", () => {
  assert.equal(DEFAULT_CONFIG.defaultTimeoutMinutes, 60);
});

test("persona frontmatter fallback for missing timeout_minutes is 60", async () => {
  // Persona file with NO timeout_minutes: in frontmatter — should default
  // to 60, matching DEFAULT_CONFIG.defaultTimeoutMinutes.
  const cwd = mkdtempSync(join(tmpdir(), "conductor-persona-default-"));
  try {
    const dir = projectPersonasDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "defaultless.md"),
      `---
name: defaultless
description: persona with no timeout_minutes
inherit_context: filtered
---

system prompt body`,
    );
    const resolved = await resolvePersonas({ cwd });
    const persona = resolved.personas.get("defaultless");
    assert.ok(persona, "persona must resolve");
    assert.equal(persona.timeoutMinutes, 60);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Schema pinning ────────────────────────────────────────────────────

test("ensemble_spawn schema declares optional timeout_minutes integer in [1, 1440]", () => {
  const { spawnTool } = setup();
  const props = spawnTool.parameters?.properties;
  assert.ok(props, "spawn tool exposes a TypeBox object schema");
  assert.ok(props.timeout_minutes, "timeout_minutes is in the schema");
  const required: string[] = spawnTool.parameters.required ?? [];
  assert.ok(!required.includes("timeout_minutes"), "timeout_minutes is optional");
  const t = props.timeout_minutes;
  assert.equal(t.minimum, 1, "minimum is 1");
  assert.equal(t.maximum, 1440, "maximum is 1440 (24h)");
});

test("ensemble_send schema declares optional timeout_minutes integer in [1, 1440]", () => {
  const { sendTool } = setup();
  const props = sendTool.parameters?.properties;
  assert.ok(props, "send tool exposes a TypeBox object schema");
  assert.ok(props.timeout_minutes, "timeout_minutes is in the schema");
  const required: string[] = sendTool.parameters.required ?? [];
  assert.ok(!required.includes("timeout_minutes"), "timeout_minutes is optional");
  const t = props.timeout_minutes;
  assert.equal(t.minimum, 1);
  assert.equal(t.maximum, 1440);
});

// ── Plumbing: spawn-tool arg → queue opts.timeoutMs ───────────────────

test("ensemble_spawn: timeout_minutes arg propagates to queue as opts.timeoutMs (overrides default)", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-1", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    timeout_minutes: 5,
  });
  // result is the queued return; what matters is the captured opts.
  assert.ok(captured.called, "queue.enqueueOrSpawn was called");
  assert.equal(captured.timeoutMs, 5 * 60_000, "timeout_minutes=5 → 300000ms");
  // Sanity: result is a queued envelope, not an error.
  assert.equal(result.details?.error, undefined, "no errorResult on valid input");
  assert.equal(result.details?.status, "queued");
});

test("ensemble_spawn: omitting timeout_minutes falls back to DEFAULT_CONFIG (60m)", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  await spawnTool.execute("call-2", {
    persona: "inspector",
    task: "noop",
    foreground: false,
  });
  assert.ok(captured.called);
  // No persona override, no tool-arg override → falls through to global.
  assert.equal(captured.timeoutMs, 60 * 60_000, "default → 60m");
});

// ── Range validation ─────────────────────────────────────────────────

test("ensemble_spawn: timeout_minutes=0 returns errorResult and does NOT call queue", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-3", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    timeout_minutes: 0,
  });
  assert.equal(captured.called, false, "queue must not be invoked on invalid range");
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /timeout_minutes/i);
  assert.match(text, /0|range|1.*1440/);
  assert.ok(result.details?.error, "errorResult sets details.error");
});

test("ensemble_spawn: timeout_minutes=1441 returns errorResult", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-4", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    timeout_minutes: 1441,
  });
  assert.equal(captured.called, false);
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /timeout_minutes/i);
  assert.match(text, /1441|range|1.*1440/);
});

test("ensemble_spawn: timeout_minutes=-3 returns errorResult", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-5", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    timeout_minutes: -3,
  });
  assert.equal(captured.called, false);
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /timeout_minutes/i);
});

// ── Send-path range validation (no queue capture needed) ──────────────

test("ensemble_send: timeout_minutes=0 is rejected with errorResult", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("inspector-zzzz", {
      status: "completed",
      sessionPath: path,
    });
    const { sendTool } = setup([run]);
    const result = await sendTool.execute("call-6", {
      agent_id: run.id,
      message: "hi",
      timeout_minutes: 0,
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /timeout_minutes/i);
    // Must not have re-resumed the run.
    assert.equal(run.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble_send: timeout_minutes=1441 is rejected", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("inspector-yyyy", {
      status: "completed",
      sessionPath: path,
    });
    const { sendTool } = setup([run]);
    const result = await sendTool.execute("call-7", {
      agent_id: run.id,
      message: "hi",
      timeout_minutes: 1441,
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /timeout_minutes/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── v0.10 Slice 3: kill_on_stall + stall_threshold_seconds ────────────
//
// Mirrors the timeout_minutes pattern: schema pinning, propagation
// through the queue capture, and tool-level range validation. The
// watchdog enforcement itself is exercised in tests/watchdog-*.test.ts.

test("ensemble_spawn schema declares optional kill_on_stall boolean", () => {
  const { spawnTool } = setup();
  const props = spawnTool.parameters?.properties;
  assert.ok(props.kill_on_stall, "kill_on_stall is in the schema");
  const required: string[] = spawnTool.parameters.required ?? [];
  assert.ok(!required.includes("kill_on_stall"), "kill_on_stall is optional");
  assert.equal(props.kill_on_stall.type, "boolean");
  // Description must mention the watchdog so the LLM understands the
  // semantic, not just the field shape.
  assert.match(String(props.kill_on_stall.description ?? ""), /watchdog/i);
});

test("ensemble_spawn schema declares optional stall_threshold_seconds integer >= 30", () => {
  const { spawnTool } = setup();
  const props = spawnTool.parameters?.properties;
  assert.ok(props.stall_threshold_seconds, "stall_threshold_seconds is in the schema");
  const required: string[] = spawnTool.parameters.required ?? [];
  assert.ok(
    !required.includes("stall_threshold_seconds"),
    "stall_threshold_seconds is optional",
  );
  assert.equal(props.stall_threshold_seconds.minimum, 30);
  assert.match(
    String(props.stall_threshold_seconds.description ?? ""),
    /watchdog|soft|stall/i,
  );
});

test("ensemble_send schema declares optional kill_on_stall boolean", () => {
  const { sendTool } = setup();
  const props = sendTool.parameters?.properties;
  assert.ok(props.kill_on_stall, "kill_on_stall is in the send schema");
  const required: string[] = sendTool.parameters.required ?? [];
  assert.ok(!required.includes("kill_on_stall"));
  assert.equal(props.kill_on_stall.type, "boolean");
});

test("ensemble_send schema declares optional stall_threshold_seconds integer >= 30", () => {
  const { sendTool } = setup();
  const props = sendTool.parameters?.properties;
  assert.ok(props.stall_threshold_seconds, "stall_threshold_seconds is in the send schema");
  const required: string[] = sendTool.parameters.required ?? [];
  assert.ok(!required.includes("stall_threshold_seconds"));
  assert.equal(props.stall_threshold_seconds.minimum, 30);
});

test("ensemble_spawn: kill_on_stall=true propagates to queue opts.killOnStall", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  await spawnTool.execute("call-kos-1", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    kill_on_stall: true,
  });
  assert.equal(captured.called, true);
  assert.equal(captured.killOnStall, true);
});

test("ensemble_spawn: omitting kill_on_stall leaves opts.killOnStall undefined (defaults apply downstream)", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  await spawnTool.execute("call-kos-2", {
    persona: "inspector",
    task: "noop",
    foreground: false,
  });
  assert.equal(captured.called, true);
  assert.equal(
    captured.killOnStall,
    undefined,
    "undefined → conductor default applies at watchdog-dispatch time",
  );
});

test("ensemble_spawn: stall_threshold_seconds=300 propagates to opts.softStallSeconds", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  await spawnTool.execute("call-sts-1", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    stall_threshold_seconds: 300,
  });
  assert.equal(captured.called, true);
  assert.equal(captured.softStallSeconds, 300);
});

test("ensemble_spawn: stall_threshold_seconds=29 is rejected (< 30 floor)", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-sts-rej", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    stall_threshold_seconds: 29,
  });
  assert.equal(captured.called, false, "validation runs before queue dispatch");
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /stall_threshold_seconds/i);
  assert.match(text, /\b30\b/);
  assert.ok(result.details?.error);
});

test("ensemble_spawn: stall_threshold_seconds=-1 is rejected", async () => {
  const { spawnTool, captured } = setupWithCaptureQueue();
  const result = await spawnTool.execute("call-sts-neg", {
    persona: "inspector",
    task: "noop",
    foreground: false,
    stall_threshold_seconds: -1,
  });
  assert.equal(captured.called, false);
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /stall_threshold_seconds/i);
});

test("ensemble_send: stall_threshold_seconds=20 is rejected (sub-30 floor)", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("inspector-w0w0", {
      status: "completed",
      sessionPath: path,
    });
    const { sendTool } = setup([run]);
    const result = await sendTool.execute("call-send-sts", {
      agent_id: run.id,
      message: "hi",
      stall_threshold_seconds: 20,
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /stall_threshold_seconds/i);
    assert.equal(run.status, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_CONFIG: watchdog defaults are present and default-off for kill_on_stall", () => {
  // Pin the design's chosen defaults so a careless config refactor
  // doesn't silently drop the watchdog. defaultKillOnStall is OFF by
  // design (advisory-only); autonomous chains opt in.
  assert.equal(DEFAULT_CONFIG.watchdog.enabled, true);
  assert.equal(DEFAULT_CONFIG.watchdog.defaultSoftSeconds, 120);
  assert.equal(DEFAULT_CONFIG.watchdog.defaultHardSeconds, 600);
  assert.equal(DEFAULT_CONFIG.watchdog.graceSeconds, 30);
  assert.equal(
    DEFAULT_CONFIG.watchdog.defaultKillOnStall,
    false,
    "default-off guards against surprise auto-kills",
  );
});
