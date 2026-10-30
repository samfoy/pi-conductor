import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { buildConductorSystemPrompt } from "../src/conductor-prompt.ts";
import { CONDUCTOR_LLM_TOOLS, CONDUCTOR_LLM_TOOL_NAMES } from "../src/types.ts";
import { tmpDir } from "./helpers/tmp.ts";

interface Registered {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, { description?: string }> };
  exposure?: string;
  namespace?: { name: string; description?: string };
}

const T = CONDUCTOR_LLM_TOOLS;
const CODEMODE = [T.pause, T.resume, T.focus, T.recommend, T.auto, T.cwd, T.effort];
const DIRECT = [T.list, T.status, T.spawn, T.send, T.kill];

function registered(): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const reg = new RunRegistry();
  const cwd = tmpDir("conductor-tool-exposure-");
  registerTools({ registerTool: (t: Registered) => void tools.set(t.name, t) } as never, {
    getCwd: () => cwd,
    getRegistry: () => reg,
    getQueue: () => new SpawnQueue(reg, 4),
    getModel: () => new FocusedStreamModel(reg),
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    pushCompletionNotification: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
  }, {});
  return tools;
}

const namesCodemodeTool = (text: string) => CODEMODE.some((n) => text.includes(n));

test("the seven rarely used conductor tools register with codemode exposure under one conductor namespace", () => {
  const tools = registered();
  const namespaces = CODEMODE.map((name) => {
    const tool = tools.get(name);
    assert.ok(tool, name + " is registered");
    assert.equal(tool.exposure, "codemode", name);
    assert.equal(tool.namespace?.name, "conductor", name);
    assert.match(tool.namespace?.description ?? "", /codemode/, name);
    return tool.namespace;
  });
  for (const ns of namespaces) assert.deepEqual(ns, namespaces[0]);
});

test("the five core conductor tools keep the default direct exposure", () => {
  const tools = registered();
  for (const name of DIRECT) {
    const tool = tools.get(name);
    assert.ok(tool, name + " is registered");
    assert.equal("exposure" in tool, false, name);
    assert.equal("namespace" in tool, false, name);
  }
});

test("all twelve conductor tools are still registered and still named by the sub-agent exclusion list", () => {
  assert.deepEqual([...CODEMODE, ...DIRECT].sort(), [...CONDUCTOR_LLM_TOOL_NAMES].sort());
  assert.deepEqual([...registered().keys()].sort(), [...CONDUCTOR_LLM_TOOL_NAMES].sort());
});

test("a direct tool that points at a codemode tool says it is reached from codemode", () => {
  const tools = registered();
  for (const name of DIRECT) {
    const tool = tools.get(name)!;
    for (const text of [tool.description, tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])]) {
      if (namesCodemodeTool(text)) assert.match(text, /codemode/, name + ": " + text);
    }
  }
  assert.match(tools.get(T.spawn)!.parameters.properties.cwd!.description ?? "", /ensemble_cwd[^.]*codemode/);
});

test("the conductor prompt says codemode wherever it names a codemode tool", () => {
  const lines = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 }).split("\n").filter(namesCodemodeTool);
  assert.ok(lines.length > 0, "the prompt names some codemode tools");
  for (const line of lines) assert.match(line, /codemode/, line);
});
