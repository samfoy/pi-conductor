import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
for (const scenario of ["sole", "batch", "queued", "terminate-queued-control"]) {
  test(`A6 native Pi SDK faux provider: ${scenario}`, { timeout: 10000 }, async () => {
    const cwd = tmpDir("a6-native-");
    const agentDir = join(cwd, "agent");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    let queued = false;
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerTools(pi, { getRegistry: () => new RunRegistry() } as any, { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUN_ID: "oracle-native" });
        pi.registerTool({ name: "control", label: "Control", description: "Test control", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "control" }], details: {}, terminate: true }; } });
        pi.on("tool_execution_start", () => {
          if (!queued && (scenario === "queued" || scenario === "terminate-queued-control")) {
            queued = true; pi.sendUserMessage("Already queued owner follow-up", { deliverAs: "followUp" });
          }
        });
      }],
    });
    await loader.reload();
    const calls = [fauxToolCall(scenario === "terminate-queued-control" ? "control" : "ask_owner", scenario === "terminate-queued-control" ? {} : { question: "Which option?" }, { id: "native-ask" })];
    if (scenario === "batch") calls.push(fauxToolCall("control", {}, { id: "sibling" }));
    faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("Follow-up control response"), fauxAssistantMessage("Queued work complete")]);
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), tools: ["ask_owner", "control"] });
    const events: any[] = [];
    session.subscribe(e => events.push(e));
    try {
      await session.prompt("Need a decision");
      const tool = events.find(e => e.type === "tool_execution_end" && e.toolCallId === "native-ask");
      assert.ok(tool, "native execution was observed");
      assert.equal(events.at(-1).type, "agent_settled");
      if (scenario === "sole") {
        assert.equal(tool.isError, false); assert.equal(tool.result.terminate, true);
        assert.equal(tool.result.details.askId, "native-ask"); assert.equal(faux.state.callCount, 1, "accepted ask skips automatic model follow-up");
      } else {
        assert.equal(faux.state.callCount, scenario === "queued" ? 3 : 2, "queued follow-ups survive terminate, or rejected ask gets normal recovery turn");
        if (scenario === "terminate-queued-control") assert.equal(tool.result.terminate, true);
        else { assert.equal(tool.isError, true); assert.match(JSON.stringify(tool.result), scenario === "batch" ? /alone/ : /queued/); }
      }
    } finally { session.dispose(); }
  });
}
