import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerTools } from "../src/tools.ts";
import { buildPiArgs, RunRegistry } from "../src/runs.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
function setup(env: NodeJS.ProcessEnv = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUN_ID: "oracle-test" }) {
  const tools: any[] = []; // heterogeneous extension registration boundary
  const cwd = tmpDir("a6-child-");
  const entries: any[] = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: "ask-1", arguments: { question: "Which?" } }] } }];
  const ctx = { cwd, isIdle: () => false, hasPendingMessages: () => false, sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-1", getSessionFile: () => join(cwd, "session.jsonl") } };
  registerTools({ registerTool: (tool: unknown) => tools.push(tool) } as any, { getRegistry: () => new RunRegistry() } as any, env);
  return { tools, ctx, entries, cwd, ask: (params: unknown = { question: "Which?" }) => tools.find(t => t.name === "ask_owner")?.execute("ask-1", params, undefined, undefined, ctx) };
}

test("A6 registration: only managed depth-one children get ask_owner, parents retain only ensemble tools", () => {
  assert.deepEqual(setup().tools.map(t => t.name), ["ask_owner"]);
  assert.deepEqual(setup({ CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2" }).tools, []);
  assert.ok(setup({}).tools.every(t => t.name.startsWith("ensemble_")));
});

test("A6 explicit allowlist retains owner infrastructure, never adds spawning tools", () => {
  const args = buildPiArgs({ kind: "fresh", sessionDir: "/tmp/s", systemPrompt: "s", prompt: "p", tools: ["read"], steerable: false });
  assert.equal(args[args.indexOf("--tools") + 1], "read,ask_owner");
  assert.ok(!args[args.indexOf("--exclude-tools") + 1].split(",").includes("ask_owner"));
});

test("A6 accepts sole call with prepared cwd-relative evidence, toolCallId and terminate; rejects duplicate", async () => {
  const h = setup();
  writeFileSync(join(h.cwd, "evidence.txt"), "Unicode evidence 🦊 <choice>");
  const result = await h.ask({ question: "  Which?  ", files: ["evidence.txt"] });
  assert.equal(result?.terminate, true);
  assert.equal(result.details.askId, "ask-1");
  assert.equal(result.details.question, "Which?");
  assert.match(result.details.evidence, /Unicode evidence 🦊 &lt;choice&gt;/);
  await assert.rejects(h.ask(), /outstanding/);
});

for (const scenario of ["empty", "files", "batch", "queued", "inactive", "identity", "retired"]) {
  test(`A6 rejects ${scenario} without terminate or consuming question eligibility`, async () => {
    const h = setup(scenario === "identity" ? { CONDUCTOR_SUBAGENT: "1" } : undefined);
    if (scenario === "batch") h.entries[0].message.content.push({ type: "toolCall", name: "read", id: "read-1" });
    if (scenario === "queued") h.ctx.hasPendingMessages = () => true;
    if (scenario === "inactive") h.ctx.isIdle = () => true;
    if (scenario === "retired") h.entries.push({ type: "custom", customType: "conductor-context-retired", data: { sessionId: "session-1" } });
    await assert.rejects(async () => { const result = await h.ask(scenario === "empty" ? { question: "  " } : scenario === "files" ? { question: "Which?", files: [4] } : undefined); assert.notEqual(result, undefined, "ask_owner must be registered"); }, /question|files|alone|queued|active|context|retired/i);
    if (scenario === "empty" || scenario === "files") assert.equal((await h.ask()).terminate, true);
    if (scenario === "retired") {
      mkdirSync(join(h.cwd, ".pi")); writeFileSync(join(h.cwd, ".pi/conductor.json"), '{"contextRetirement":false}');
      assert.equal((await h.ask()).terminate, true);
    }
  });
}
