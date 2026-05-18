/**
 * Tests for the ensemble_focus tool's behavior at the model level.
 *
 * The tool's full effect is: 1) update the FocusedStreamModel's focused id,
 * 2) request the UI to open the overlay if one isn't already open. We test
 * (1) directly by invoking the registered tool's execute() against a fake
 * ExtensionAPI. Side effect (2) is verified via a spy on the open callback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(id: string): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
  };
}

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
}

function captureTools(): {
  tools: RegisteredTool[];
  pi: { registerTool: (tool: RegisteredTool) => void };
} {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: { registerTool: (tool) => tools.push(tool) },
  };
}

function setup() {
  const reg = new RunRegistry();
  reg.register(makeRun("a-1"));
  reg.register(makeRun("b-2"));
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const opens: (string | undefined)[] = [];

  const cap = captureTools();
  registerTools(cap.pi as any, {
    getCwd: () => "/tmp",
    getRegistry: () => reg,
    getQueue: () => queue,
    getModel: () => model,
    getParentMessages: () => [],
    openFocusedOverlay: (id?: string) => {
      opens.push(id);
    },
    registerForegroundDetach: () => ({
      detachSignal: new Promise<void>(() => {}),
      unregister: () => {},
    }),
    pushCompletionNotification: () => {},
  });

  const focusTool = cap.tools.find((t) => t.name === "ensemble_focus");
  return { reg, model, opens, focusTool };
}

test("ensemble_focus tool is registered", () => {
  const { focusTool } = setup();
  assert.ok(focusTool, "ensemble_focus tool should be registered");
});

test("ensemble_focus updates the model's focused id when agent_id matches", async () => {
  const { model, focusTool } = setup();
  assert.ok(focusTool);
  await focusTool.execute("call-1", { agent_id: "b-2" });
  assert.equal(model.focused()?.id, "b-2");
});

test("ensemble_focus calls openFocusedOverlay with the matched agent_id", async () => {
  const { opens, focusTool } = setup();
  assert.ok(focusTool);
  await focusTool.execute("call-1", { agent_id: "a-1" });
  assert.deepEqual(opens, ["a-1"]);
});

test("ensemble_focus returns an error result when agent_id doesn't match a run", async () => {
  const { focusTool, opens } = setup();
  assert.ok(focusTool);
  const result = await focusTool.execute("call-1", { agent_id: "ghost" });
  // The tool should NOT request opening when the id is unknown.
  assert.equal(opens.length, 0);
  // Result content should mention the missing id.
  const text = result.content.map((c: any) => c.text).join("\n");
  assert.match(text, /not found|unknown|ghost/i);
});

test("ensemble_focus with no agent_id opens the overlay on the current focus (most recent)", async () => {
  // Useful as a no-arg "open the focused-stream overlay" entry point.
  const { opens, model, focusTool } = setup();
  assert.ok(focusTool);
  // Capture what model.focused() resolves to BEFORE the call so we can
  // compare against what the tool requested to open.
  const expected = model.focused()?.id;
  await focusTool.execute("call-1", {});
  assert.deepEqual(opens, [expected]);
});
