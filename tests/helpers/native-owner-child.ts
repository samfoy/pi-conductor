// Sandbox-only Pi 0.87.1 protocol adapter: native preflight, events, tools and queues.
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8")).version;
const args = process.argv.slice(2);
const rpc = args[1] === "rpc";
const flag = (name: string) => args[args.indexOf(name) + 1];
const cwd = process.cwd();
const agentDir = join(process.env.HOME!, "agent");
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + "\n");
let scenario = rpc ? "" : args.at(-1)!;
let release: (() => void) | undefined;
process.on("SIGUSR2", () => release?.());
let deferredSend: { id: string; type: string; message: string } | undefined;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const faux = fauxProvider({ tokensPerSecond: Infinity });
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    registerTools(pi, { getRegistry: () => new RunRegistry() } as any, process.env);
    pi.on("agent_settled", async () => {
      if (scenario.includes("H1_RELOAD")) {
        const keepAlive = setInterval(() => {}, 1000);
        try { await new Promise<void>(resolve => { release = resolve; emit({ type: "probe", point: "before-settle" }); }); }
        finally { clearInterval(keepAlive); }
      }
    });
    pi.on("tool_execution_start", async e => {
      if (e.toolName === "ask_owner" && scenario.includes("B2_INFLIGHT")) {
        await new Promise<void>(resolve => { release = resolve; emit({ type: "probe", point: "before-start" }); });
      }
    });
    pi.on("tool_execution_end", async e => {
      if (e.toolName !== "ask_owner") return;
      if (scenario.includes("B2_HELD_END")) {
        await new Promise<void>(resolve => { release = resolve; emit({ type: "probe", point: "held-end" }); });
      }
      if (deferredSend) {
        await session.followUp(deferredSend.message);
        emit({ type: "response", id: deferredSend.id, command: deferredSend.type, success: true });
      }
      if (scenario.includes("B2_EXTENSION")) pi.sendUserMessage("Use B from the extension-queued owner answer", { deliverAs: "followUp" });
    });
  }],
});
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, settingsManager,
  sessionManager: args.includes("--session") ? SessionManager.open(flag("--session")) : SessionManager.create(cwd, flag("--session-dir")), tools: ["ask_owner"] });
session.subscribe(emit);
async function prompt(message: string, id?: string) {
  scenario = message;
  writeFileSync(join(dirname(session.sessionManager.getSessionFile()!), "receipt.json"), JSON.stringify({ message, args, session: session.sessionManager.getSessionFile(), version }));
  if (message.includes("B1_EXIT")) process.exit(1);
  if (message.includes("B1_EOF")) process.exit(0);
  if (message.includes("B1_HANG")) { setInterval(() => {}, 1000); return; }
  // Exercise native missing-model preflight, not a fabricated transport response.
  if (message.includes("B1_REJECT")) session.agent.state.model = undefined as any;
  const answering = message.startsWith("<owner-answer") || message.includes("CONTROL");
  faux.setResponses([
    ...(answering ? [] : [fauxAssistantMessage(fauxToolCall("ask_owner", { question: "Use A or B?" }, { id: "native-ask" }), { stopReason: "toolUse" })]),
    fauxAssistantMessage("Used B from the owner answer and completed the original assignment with all checks."),
  ]);
  let accepted = false;
  try {
    await session.prompt(message, { source: rpc ? "rpc" : "interactive", preflightResult: success => {
      if (success) { accepted = true; if (rpc) emit({ type: "response", id, command: "prompt", success: true }); }
    } });
    if (!rpc) { session.dispose(); process.exit(0); }
  } catch (e) {
    if (rpc && !accepted) emit({ type: "response", id, command: "prompt", success: false, error: (e as Error).message });
    else { console.error(e); session.dispose(); process.exit(1); }
  }
}
if (!rpc) await prompt(scenario);
else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const command = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      if (command.type === "release") { release?.(); continue; }
      if (command.type === "prompt") { void prompt(command.message, command.id); continue; }
      if (command.type === "follow_up") {
        if (scenario.includes("B2_INFLIGHT")) { deferredSend = command; release?.(); }
        else void session.followUp(command.message).then(() => emit({ type: "response", id: command.id, command: command.type, success: true }));
      }
    }
  });
  process.stdin.on("end", () => { session.dispose(); process.exit(0); });
}
