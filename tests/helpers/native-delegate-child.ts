// N2 native child: the real Pi CLI `main()` from one explicit installed root
// (bundled with an esbuild alias), loading the real conductor extension plus an
// offline faux model. Plays the depth-1 delegator or the depth-2 leaf by its env.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, main, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import conductor from "../../src/index.ts";

type Message = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };
const fixture = process.env.N2_FIXTURE!;
const depth = process.env.CONDUCTOR_DEPTH;
const text = (m: Message | undefined): string => !m ? "" : typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.map(p => (p as { type?: string; text?: string }).type === "text" ? (p as { text: string }).text : "").join("") : "";
/** Pi 0.99+ tools can call tools through ctx.executeTool(); those nested calls must never delegate. */
const nested = VERSION !== "0.87.1";

function parent(messages: Message[]) {
  const task = text(messages.find(m => m.role === "user"));
  const results = messages.filter(m => m.role === "toolResult");
  if (results.length) return fauxAssistantMessage(`N2 parent saw ${results.length} results:\n` + results.map(r => `${r.toolCallId}: ${r.isError ? "ERROR " : ""}${text(r)}`).join("\n---\n"));
  if (task.includes("N2-PARENT abort")) {
    return fauxAssistantMessage([fauxToolCall("delegate", { persona: "scout", task: "N2-LEAF scout hold until killed" }, { id: "d_abort" })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage([
    fauxToolCall("delegate", { persona: "scout", task: "N2-LEAF scout inspect the parser" }, { id: "d_scout" }),
    fauxToolCall("delegate", { persona: "auditor", task: "N2-LEAF auditor review the notes", files: ["notes.md"] }, { id: "d_auditor" }),
    fauxToolCall("delegate", { persona: "writer", task: "N2-LEAF writer must not run" }, { id: "d_denied" }),
    fauxToolCall("delegate", { persona: "scout" }, { id: "d_schema" }),
    fauxToolCall("delegate", { persona: "scout", task: "N2-LEAF scout blocked by a hook" }, { id: "d_blocked" }),
    ...(nested ? [fauxToolCall("nested_probe", {}, { id: "d_nested" })] : []),
  ], { stopReason: "toolUse" });
}

async function leaf(messages: Message[]) {
  const task = text(messages.find(m => m.role === "user"));
  const persona = task.match(/N2-LEAF (\w+)/)?.[1] ?? "unknown";
  const results = messages.filter(m => m.role === "toolResult");
  if (task.includes("hold until killed")) {
    writeFileSync(join(fixture, `leaf-running-${process.pid}`), String(process.pid));
    await new Promise(() => {}); // until the broker kills this leaf
  }
  // A leaf has no delegate: the call is unknown to Pi, so it starts and ends in error with no execution.
  if (persona === "scout" && !results.length) return fauxAssistantMessage([fauxToolCall("delegate", { persona: "auditor", task: "grandchild" }, { id: "leaf_delegate" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(`LEAF ${persona} done; evidence=${task.includes("N2-NOTES-EVIDENCE")}; saw=${results.map(r => text(r)).join("|")}`);
}

function harness(pi: ExtensionAPI) {
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  const next = async (context: { messages: Message[] }) => { faux.appendResponses([next]); return depth === "2" ? leaf(context.messages) : parent(context.messages); };
  faux.setResponses([next]);
  pi.registerProvider(faux.provider as never);
  // Pi's own permission seam: a blocked call starts and ends in error without executing.
  pi.on("tool_call", (e: { toolCallId: string }) => e.toolCallId === "d_blocked" ? { block: true, reason: "N2 test block" } : undefined);
  pi.on("tool_execution_update", (e: { toolCallId: string }, ctx: { abort(): void }) => {
    if (e.toolCallId !== "d_abort") return;
    // Never hold the event: the lead only spawns after this update reaches stdout.
    const poll = setInterval(() => {
      if (!readdirSync(fixture).some(f => f.startsWith("leaf-running-"))) return;
      clearInterval(poll);
      ctx.abort();
    }, 20);
  });
  if (nested) pi.registerTool({ name: "nested_probe", label: "Nested probe", description: "Offline nested delegate probe", parameters: Type.Object({}),
    async execute(_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: any) {
      const outcome = await ctx.executeTool("delegate", { persona: "scout", task: "N2-LEAF scout nested must not run" });
      return { content: [{ type: "text" as const, text: `nested: ${outcome.isError ? "ERROR " : ""}${(outcome.result?.content ?? []).map((p: { text?: string }) => p.text ?? "").join("")}` }], details: {} };
    } } as never);
}

const foreign = (pi: ExtensionAPI) => pi.registerTool({ name: "delegate", label: "Foreign", description: "Another extension's delegate", parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text" as const, text: "foreign delegate executed" }], details: {} }; } } as never);

process.env.PI_CODING_AGENT = "true";
await main(process.argv.slice(2), { extensionFactories: [
  { name: "conductor", factory: conductor },
  { name: "n2-faux", factory: harness },
  ...(process.env.N2_FOREIGN_DELEGATE === "1" ? [{ name: "foreign-delegate", factory: foreign }] : []),
] as never });
