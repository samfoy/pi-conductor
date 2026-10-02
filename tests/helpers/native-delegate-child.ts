// N2/N3 native child: the real Pi CLI `main()` from one explicit installed root
// (bundled with an esbuild alias), loading the real conductor extension plus an
// offline faux model. Plays the depth-1 delegator or the depth-2 leaf by its env.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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

/**
 * N3 roles hold their exit after settling until the test releases them, ignoring
 * the conductor's settlement SIGTERM as a slow shutdown would; its SIGKILL
 * escalation still ends them. Each SIGTERM is recorded as evidence.
 */
let holdExit: string | undefined;
function holdAfterSettle(release: string) {
  if (holdExit) return;
  holdExit = release;
  process.on("SIGTERM", () => writeFileSync(join(fixture, `n3-sigterm-${process.pid}`), release));
}

/** What Pi actually requested: the model id and the thinking level it sent (undefined is off). */
type Served = { model: string; reasoning: string };

/**
 * N4: a leaf's QUESTION reaches the parent in its envelope once the call settled; the
 * parent escalates with its own sole ask_owner, and after the owner's answer delegates again.
 */
function questionParent(messages: Message[]) {
  const result = (id: string) => messages.find(m => m.role === "toolResult" && m.toolCallId === id);
  const answer = messages.map(m => m.role === "user" ? text(m) : "").find(t => t.includes("<owner-answer"))?.match(/Answer: (.*)/)?.[1];
  const second = result("n4_second");
  if (second) return fauxAssistantMessage(`N4 parent done: ${text(second).match(/N4 LEAF followup done with [^\n<]*/)?.[0] ?? "no followup"}`);
  if (answer) return fauxAssistantMessage([fauxToolCall("delegate", { persona: "scout", task: `N4-LEAF followup ${answer}` }, { id: "n4_second" })], { stopReason: "toolUse" });
  const question = text(result("n4_first")).match(/QUESTION: ([^\n<]*)/)?.[1];
  if (question) return fauxAssistantMessage([fauxToolCall("ask_owner", { question: `A leaf asks: ${question}` }, { id: "n4_ask" })], { stopReason: "toolUse" });
  return fauxAssistantMessage([fauxToolCall("delegate", { persona: "scout", task: "N4-LEAF question" }, { id: "n4_first" })], { stopReason: "toolUse" });
}

function parent(messages: Message[], served: Served) {
  const task = text(messages.find(m => m.role === "user"));
  const results = messages.filter(m => m.role === "toolResult");
  if (task.includes("N4-PARENT question")) return questionParent(messages);
  // N3 barrier: a lead-level run with nothing to delegate.
  if (task.includes("N3-PLAIN")) return fauxAssistantMessage("N3 plain done");
  if (results.length) return fauxAssistantMessage(`N2 parent model=${served.model} reasoning=${served.reasoning} saw ${results.length} results:\n` + results.map(r => `${r.toolCallId}: ${r.isError ? "ERROR " : ""}${text(r)}`).join("\n---\n"));
  const n3 = task.match(/N3-PARENT (\d+)/)?.[1];
  if (n3) holdAfterSettle("n3-exit-parent");
  if (n3) {
    return fauxAssistantMessage(["a", "b"].map(c => fauxToolCall("delegate", { persona: "scout", task: `N3-LEAF ${n3}-${c}` }, { id: `n3_${n3}_${c}` })), { stopReason: "toolUse" });
  }
  if (task.includes("N2-PARENT reload")) {
    return fauxAssistantMessage([fauxToolCall("delegate", { persona: "scout", task: "N2-LEAF scout after reload must not run" }, { id: "d_reload" })], { stopReason: "toolUse" });
  }
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

async function leaf(messages: Message[], served: Served) {
  const task = text(messages.find(m => m.role === "user"));
  const persona = task.match(/N2-LEAF (\w+)/)?.[1] ?? "unknown";
  const results = messages.filter(m => m.role === "toolResult");
  // N4: a leaf has no ask_owner (Pi reports it unknown: start, then error end), so its question travels in its final text.
  if (task.includes("N4-LEAF question")) {
    if (!results.length) return fauxAssistantMessage([fauxToolCall("ask_owner", { question: "may a leaf escalate?" }, { id: "leaf_ask" })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`N4 LEAF needs input; saw=${results.map(r => text(r)).join("|")}\nQUESTION: Which config, A or B?`);
  }
  const followup = task.match(/N4-LEAF followup (.*)/)?.[1];
  if (followup) return fauxAssistantMessage(`N4 LEAF followup done with ${followup}`);
  // N3 barrier: every leaf holds until the test has seen the admission state, then answers.
  const n3 = task.match(/N3-LEAF (\S+)/)?.[1];
  if (n3) {
    holdAfterSettle("n3-exit-leaf");
    writeFileSync(join(fixture, `n3-running-${process.pid}`), n3);
    while (!existsSync(join(fixture, "n3-release"))) await new Promise(r => setTimeout(r, 20));
    return fauxAssistantMessage(`N3 LEAF ${n3} done`);
  }
  if (task.includes("hold until killed")) {
    writeFileSync(join(fixture, `leaf-running-${process.pid}`), String(process.pid));
    await new Promise(() => {}); // until the broker kills this leaf
  }
  // A leaf has no delegate: the call is unknown to Pi, so it starts and ends in error with no execution.
  if (persona === "scout" && !results.length) return fauxAssistantMessage([fauxToolCall("delegate", { persona: "auditor", task: "grandchild" }, { id: "leaf_delegate" })], { stopReason: "toolUse" });
  return fauxAssistantMessage(`LEAF ${persona} done; model=${served.model}; reasoning=${served.reasoning}; evidence=${task.includes("N2-NOTES-EVIDENCE")}; saw=${results.map(r => text(r)).join("|")}`);
}

function harness(pi: ExtensionAPI) {
  // faux-1 is the agent default; the leaf models exist only so a persona's configured model can be proven served.
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "faux-1" }, { id: "faux-scout", reasoning: true }, { id: "faux-auditor", reasoning: true }] });
  const next = async (context: { messages: Message[] }, options?: { reasoning?: string }, _state?: unknown, model?: { id: string }) => {
    faux.appendResponses([next]);
    const served = { model: model?.id ?? "unknown", reasoning: options?.reasoning ?? "off" };
    return depth === "2" ? leaf(context.messages, served) : parent(context.messages, served);
  };
  faux.setResponses([next]);
  pi.registerProvider(faux.provider as never);
  // Pi's own permission seam: a blocked call starts and ends in error without executing.
  pi.on("tool_call", async (e: { toolCallId: string }) => {
    if (e.toolCallId === "d_blocked") return { block: true, reason: "N2 test block" };
    // Holds d_reload between its start (already on stdout) and execute, so the lead can /reload in that window.
    if (e.toolCallId === "d_reload") while (!existsSync(join(fixture, "release-reload"))) await new Promise(r => setTimeout(r, 20));
    return undefined;
  });
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
// Print mode's own SIGTERM handler is gone once main returns; the hold's listener keeps the process alive.
while (holdExit && !existsSync(join(fixture, holdExit))) await new Promise(r => setTimeout(r, 20));
