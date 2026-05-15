/**
 * Tests for ensemble_pause / ensemble_resume tools (v0.5 stretch).
 *
 * The runtime helpers `pauseRun` / `resumeRun` are already covered in
 * tests/runs-helpers.test.ts. These tests pin the LLM-callable tool
 * surface: registration, agent_id validation, error messages.
 *
 * We don't actually invoke SIGSTOP/SIGCONT here because the `proc` field
 * on Run is undefined for synthetic runs — that's the same early-out
 * pauseRun/resumeRun take in their unit tests, and it lets us assert
 * the tool's failure paths cleanly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now() - 5_000,
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
  execute: (id: string, params: any) => Promise<any>;
}

function setup(extraRuns: Run[] = []) {
  const reg = new RunRegistry();
  for (const r of extraRuns) reg.register(r);
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const tools: RegisteredTool[] = [];
  registerTools(
    {
      registerTool: (t: RegisteredTool) => tools.push(t),
    } as any,
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
    pauseTool: tools.find((t) => t.name === "ensemble_pause"),
    resumeTool: tools.find((t) => t.name === "ensemble_resume"),
  };
}

test("ensemble_pause tool is registered", () => {
  const { pauseTool } = setup();
  assert.ok(pauseTool, "ensemble_pause should be registered");
});

test("ensemble_resume tool is registered", () => {
  const { resumeTool } = setup();
  assert.ok(resumeTool, "ensemble_resume should be registered");
});

test("ensemble_pause errors when agent_id is unknown", async () => {
  const { pauseTool } = setup();
  assert.ok(pauseTool);
  const result = await pauseTool.execute("call-1", { agent_id: "ghost" });
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /not found|unknown|ghost/i);
});

test("ensemble_resume errors when agent_id is unknown", async () => {
  const { resumeTool } = setup();
  assert.ok(resumeTool);
  const result = await resumeTool.execute("call-1", { agent_id: "ghost" });
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /not found|unknown|ghost/i);
});

const NON_PAUSABLE: RunStatus[] = ["completed", "failed", "killed", "timeout", "queued", "paused"];
for (const status of NON_PAUSABLE) {
  test(`ensemble_pause rejects status=${status} with a clear reason`, async () => {
    const run = makeRun(`oracle-${status.slice(0, 4)}`, { status });
    const { pauseTool } = setup([run]);
    assert.ok(pauseTool);
    const result = await pauseTool.execute("call-1", { agent_id: run.id });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /paused|cannot|not running|status/i);
    assert.equal(run.status, status, "status must not change on rejection");
  });
}

const NON_RESUMABLE: RunStatus[] = ["running", "completed", "failed", "killed", "timeout", "queued"];
for (const status of NON_RESUMABLE) {
  test(`ensemble_resume rejects status=${status} with a clear reason`, async () => {
    const run = makeRun(`oracle-${status.slice(0, 4)}`, { status });
    const { resumeTool } = setup([run]);
    assert.ok(resumeTool);
    const result = await resumeTool.execute("call-1", { agent_id: run.id });
    const text = result.content.map((c: any) => c.text).join("\n");
    assert.match(text, /resume|cannot|not paused|status/i);
    assert.equal(run.status, status, "status must not change on rejection");
  });
}
