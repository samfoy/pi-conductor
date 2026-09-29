// Compiled only into a private harness with explicit installed Pi 0.87.1 aliases.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";
import { applyEvent } from "../../src/event-handler.ts";
import type { Run } from "../../src/types.ts";

export async function nativeWitness(root: string, scenario: string) {
  assert.equal(VERSION, "0.87.1", "native version gate must not silently use repository Pi");
  const runId = `oracle-${scenario}`;
  const runDir = join(root, runId), agentDir = join(root, "agent");
  mkdirSync(join(runDir, "session"), { recursive: true });
  const sm = SessionManager.create(root, join(runDir, "session"));
  const binding = { runId, launchNonce: "native-nonce", sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), paneId: "fake-pane", terminalId: "fake-terminal", tabId: "fake-tab", workspaceId: "fake-workspace", socketPath: join(root, "fake.sock"), createdTab: true };
  const record = { id: runId, runtime: "herdr", herdr: binding };
  writeFileSync(join(runDir, "record.json"), JSON.stringify(record));
  const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_DIR: runDir, CONDUCTOR_RUN_ID: runId,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath, HERDR_PANE_ID: binding.paneId, HERDR_TAB_ID: binding.tabId, HERDR_WORKSPACE_ID: binding.workspaceId };
  const settings = { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 0 }, retry: { enabled: false }, cacheWarming: "off" };
  const settingsManager = SettingsManager.inMemory(settings);
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let bridge!: ReturnType<typeof installChildBridge>;
  const errors: unknown[] = [], boundaries: string[] = [];
  let replacementObserved = false, shutdowns = 0;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.registerProvider(faux.provider);
      pi.registerFlag("conductor-launch", { type: "string" });
      bridge = installChildBridge(pi, { env });
      registerTools(pi, { getRegistry: () => new RunRegistry() } as never, env);
      pi.registerTool({ name: "control", label: "Control", description: "Offline control", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "control" }], details: {}, terminate: true }; } });
    }, pi => {
      // Registered later than the bridge: native Pi replaces the original object after dispatch.
      pi.on("message_end", e => {
        if (e.message.role !== "assistant") return;
        return { message: { ...e.message, content: e.message.content.map(p => p.type === "toolCall" && p.name === "ask_owner" ?
          { ...p, arguments: { question: "Corrected?\nA or B 🙂" } } : p.type === "text" ? { ...p, text: "Native replacement 🙂漢\u2028\u2029" } : p) } };
      });
      pi.on("tool_call", () => { boundaries.push("tool_call"); });
      pi.on("session_before_compact", e => ({ compaction: { summary: "PRIVATE huge context not copied", firstKeptEntryId: e.preparation.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore } }));
      pi.on("turn_end", e => { assert.ok("context" in e, "native BoundaryState exists, unlike a JSON event"); });
    }],
  });
  await loader.reload();
  loader.getExtensions().runtime.flagValues.set("conductor-launch", binding.launchNonce);
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, settingsManager, sessionManager: sm, tools: ["ask_owner", "control"] });
  const rows = (): any[] => readFileSync(join(runDir, "transcript.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  session.subscribe(e => { if (e.type === "message_end" && e.message.role === "assistant") replacementObserved = JSON.stringify(e.message).includes("Native replacement") || JSON.stringify(e.message).includes("Corrected?"); });
  try {
    await session.bindExtensions({ mode: "tui", onError: e => errors.push(e), shutdownHandler: () => {
      shutdowns++;
      assert.equal(rows().at(-1).type, "agent_settled", "native shutdown request follows synchronous flush");
      assert.equal(JSON.parse(readFileSync(join(runDir, "launch/native-nonce.closing.json"), "utf8")).pid, process.pid);
    } });
    const hello = JSON.parse(readFileSync(join(runDir, "launch/native-nonce.json"), "utf8"));
    assert.equal(hello.piVersion, "0.87.1", "bridge itself resolves native Pi, not only harness imports");
    assert.equal(hello.sessionFile, sm.getSessionFile());
    faux.setResponses([fauxAssistantMessage("Unaccepted human response")]);
    await session.prompt("A human typed before assignment acceptance");
    assert.equal(shutdowns, 0);
    assert.ok(replacementObserved);
    assert.ok(rows().some(e => e.message?.content?.[0]?.text === "Native replacement 🙂漢\u2028\u2029"), "deferred reference captures native in-place replacement");
    await session.compact();
    assert.equal(rows().filter(e => applyEvent({ messages: [], usage: {} } as unknown as Run, e).kind === "compacted").length, 1);
    assert.ok(bridge.acceptInitial(binding.launchNonce));
    const oldBridge = bridge;
    await session.reload();
    assert.equal(oldBridge.acceptInitial(binding.launchNonce), false, "native reload disposed old invocation resources");
    if (scenario === "failed") sm.appendCustomEntry("conductor-context-retired", { sessionId: sm.getSessionId() });
    const calls = [fauxToolCall("ask_owner", { question: "Wrong original" }, { id: "native-ask" })];
    if (scenario === "batch") calls.push(fauxToolCall("control", {}, { id: "sibling" }));
    faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("Recovery finished")]);
    await session.prompt("Accepted assignment needs decision");
    const run = { id: runId, messages: [], usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } as unknown as Run;
    const transcript = rows();
    // This is the production consumer, with the current-nonce read filter H7 will own.
    for (const e of transcript) if (e._c?.n === binding.launchNonce) applyEvent(run, e);
    assert.equal(run.pendingAsk?.question, scenario === "sole" ? "Corrected?\nA or B 🙂" : undefined, "H4 native production pipeline preserves corrected ask");
    const end = transcript.find(e => e.type === "tool_execution_end" && e.toolCallId === "native-ask");
    assert.equal(end.isError, scenario !== "sole");
    assert.equal(shutdowns, 1, "accepted assignment requests exit once after native settlement");
    assert.ok(boundaries.includes("tool_call"));
    assert.ok(transcript.every(e => e._c.n === binding.launchNonce));
    assert.ok(!JSON.stringify(transcript).includes("PRIVATE huge context"));
    assert.equal(transcript.filter(e => e.event === "launch").length, 1, "reload never duplicates launch");
    const bytes = readFileSync(join(runDir, "transcript.jsonl"), "utf8");
    await session.reload();
    assert.equal(bridge.acceptInitial(binding.launchNonce), false, "closing is durable across native reload");
    assert.equal(readFileSync(join(runDir, "transcript.jsonl"), "utf8"), bytes, "native reload replays no terminal event");
    assert.equal(shutdowns, 1);
    assert.deepEqual(errors, []);
    return { version: VERSION, records: transcript.length, shutdowns, scenario };
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    bridge.dispose(); session.dispose();
  }
}
