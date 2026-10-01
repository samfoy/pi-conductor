// Bundled only into a private harness whose Pi imports alias one explicit installed root.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, parseArgs, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";

export { VERSION };

export interface NativeSurface {
  active: string[];
  registered: string[];
  /** 0.99+: tools a tool can reach through `ctx.executeTool()`. */
  callable?: string[];
  ends: { name: string; isError: boolean; text: string; details?: unknown }[];
  nested: Record<string, { isError: boolean; text: string }>;
  /** Extension load diagnostics, e.g. a same-named tool conflict (the CLI exits on these). */
  errors: string[];
}

const textOf = (result: any) => (result?.content ?? []).map((p: any) => p.text ?? "").join("");

/** A tool another extension might register; only argv, not its absence, may remove it. */
function decoy(name: string) {
  return { name, label: name, description: `Offline decoy ${name}`, parameters: Type.Object({}),
    // 0.99 calls deferred tools even when inactive; exclusion must still drop them.
    ...(name === "delegate" ? { exposure: "deferred" } : {}),
    async execute() { return { content: [{ type: "text" as const, text: `${name} executed` }], details: {} }; } };
}

/**
 * Build a real session from generated child argv (parsed by that Pi's own
 * `parseArgs`) and the injected child env, then optionally drive one
 * model-issued call and nested `ctx.executeTool()` calls through the faux model.
 */
export async function nativeSurface(root: string, label: string, opts: {
  argv: string[]; env: NodeJS.ProcessEnv; decoys: string[];
  calls?: { name: string; args: Record<string, unknown> }[]; nested?: string[];
}): Promise<NativeSurface> {
  const cwd = join(root, label), agentDir = join(cwd, "agent");
  mkdirSync(join(cwd, "session"), { recursive: true });
  const parsed = parseArgs(opts.argv);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const nested: NativeSurface["nested"] = {};
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      registerTools(pi, { getRegistry: () => new RunRegistry() } as never, opts.env);
      pi.registerTool({ name: "nested_probe", label: "Nested probe", description: "Offline nested-call probe", parameters: Type.Object({}),
        async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) {
          for (const name of opts.nested ?? []) {
            const args = name === "ask_owner" ? { question: "Nested?" } : name === "delegate" ? { persona: "inspector", task: "Nested probe." } : {};
            const outcome = await ctx.executeTool(name, args);
            nested[name] = { isError: outcome.isError, text: textOf(outcome.result) };
          }
          return { content: [{ type: "text" as const, text: "probed" }], details: {} };
        } } as never);
    }, pi => {
      // A separate extension, as another installed package would be.
      for (const name of opts.decoys) pi.registerTool(decoy(name) as never);
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(cwd, join(cwd, "session")), tools: parsed.tools, excludeTools: parsed.excludeTools });
  const ends: NativeSurface["ends"] = [];
  session.subscribe((e: any) => {
    if (e.type === "tool_execution_end" && !e.parentToolCallId) ends.push({ name: e.toolName, isError: e.isError, text: textOf(e.result), details: e.result?.details });
  });
  try {
    const any = session as any;
    const surface = { active: session.getActiveToolNames(), registered: session.getAllTools().map(t => t.name),
      errors: loader.getExtensions().errors.map((e: { error: string }) => e.error),
      callable: typeof any.getCallableToolNames === "function" ? any.getCallableToolNames() as string[] : undefined };
    if (opts.calls) {
      const calls = opts.calls.map((c, i) => fauxToolCall(c.name, c.args, { id: `n1-call-${i}` }));
      faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("Done after the probe calls.")]);
      await session.prompt("N1 native tool-surface probe");
    }
    return { ...surface, ends, nested };
  } finally { session.dispose(); }
}
