/**
 * Tests for the ensemble_send tool — the LLM-callable counterpart of
 * sendToRun. Validates registration, parameter shape, agent_id lookup,
 * and the status-gating contract documented in the PRD.
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
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

function tmpSessionFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-send-tool-"));
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

interface RegisteredTool {
  name: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
}

function captureTools() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: { registerTool: (tool: RegisteredTool) => tools.push(tool) },
  };
}

function setup(extraRuns: Run[] = []) {
  const reg = new RunRegistry();
  for (const r of extraRuns) reg.register(r);
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const completions: Run[] = [];

  const cap = captureTools();
  registerTools(cap.pi as any, {
    getCwd: () => "/tmp",
    getRegistry: () => reg,
    getQueue: () => queue,
    getModel: () => model,
    openFocusedOverlay: () => {},
    pushCompletionNotification: (r: Run) => completions.push(r),
  });

  const sendTool = cap.tools.find((t) => t.name === "ensemble_send");
  return { reg, sendTool, completions };
}

test("ensemble_send tool is registered", () => {
  const { sendTool } = setup();
  assert.ok(sendTool, "ensemble_send tool should be registered");
});

test("ensemble_send rejects when agent_id is unknown", async () => {
  const { sendTool } = setup();
  assert.ok(sendTool);
  const result = await sendTool.execute("call-1", {
    agent_id: "ghost-9999",
    message: "hi",
  });
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /not found|unknown|ghost/i);
  assert.equal(result.details?.error !== undefined, true, "details.error is set on unknown agent_id");
});

test("ensemble_send rejects a running sub-agent (busy)", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("oracle-aaaa", { status: "running", sessionPath: path, finishedAt: undefined });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);
    const result = await sendTool.execute("call-1", {
      agent_id: "oracle-aaaa",
      message: "hi",
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /running|busy/i);
    // Run status must NOT have been mutated.
    assert.equal(run.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble_send rejects a paused sub-agent with a hint to resume", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("oracle-bbbb", { status: "paused", sessionPath: path });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);
    const result = await sendTool.execute("call-1", {
      agent_id: "oracle-bbbb",
      message: "hi",
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /paused|resume/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble_send rejects a queued sub-agent with a hint to wait", async () => {
  const run = makeRun("oracle-cccc", { status: "queued", sessionPath: undefined, finishedAt: undefined });
  const { sendTool } = setup([run]);
  assert.ok(sendTool);
  const result = await sendTool.execute("call-1", {
    agent_id: "oracle-cccc",
    message: "hi",
  });
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /queued|wait/i);
});

test("ensemble_send rejects empty message", async () => {
  const { dir, path } = tmpSessionFile();
  try {
    const run = makeRun("oracle-dddd", { status: "completed", sessionPath: path });
    const { sendTool } = setup([run]);
    assert.ok(sendTool);
    const result = await sendTool.execute("call-1", {
      agent_id: "oracle-dddd",
      message: "   ",
    });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /empty|message/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TERMINAL_STATES: RunStatus[] = ["completed", "failed", "killed", "timeout"];

for (const status of TERMINAL_STATES) {
  test(`ensemble_send accepts terminal-state sub-agent (status=${status}) and flips to running`, async () => {
    const { dir, path } = tmpSessionFile();
    try {
      const run = makeRun(`oracle-${status.slice(0, 4)}`, { status, sessionPath: path });
      const { sendTool } = setup([run]);
      assert.ok(sendTool);

      // background:false to avoid the foreground-await path racing past us.
      const promise = sendTool.execute("call-1", {
        agent_id: run.id,
        message: "another question",
        foreground: false,
      });

      // Status flip happens synchronously inside sendToRun.
      // Allow the microtask to run (the tool wraps in async).
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(run.status, "running", `run did not flip to running (status=${run.status})`);

      // Cleanup the spawned subprocess so the test exits cleanly.
      try {
        run.proc?.kill("SIGKILL");
      } catch {
        // already gone
      }
      // Don't await the tool's promise — its done handler may persist a record.
      void promise;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
