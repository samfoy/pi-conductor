// M6a native merger child: the real Pi CLI `main()` from one explicit installed root (bundled
// with an esbuild alias by tests/effort-merger-smoke.test.ts), the real conductor extension
// (child ask_owner) and an offline faux model that drives Pi's real bash tool in the candidate.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, main, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import conductor from "../../src/index.ts";

type Message = { role: string; content?: unknown; toolCallId?: string; isError?: boolean };
const fixture = process.env.M6A_FIXTURE!;
const scenario = process.env.M6A_MERGER_SCENARIO ?? "resolve";
const text = (m: Message | undefined): string => !m ? "" : typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.map(p => (p as { type?: string; text?: string }).type === "text" ? (p as { text: string }).text : "").join("") : "";

const RESOLVE = (body = "landed\\nwriter\\n") => `printf '${body}' > base && git add -- base && git commit -q --no-edit && git status --porcelain --ignored --untracked-files=all`;
const SCRIPTS: Record<string, string> = {
  resolve: RESOLVE(),
  hold: `while ! test -f "${join(fixture, "release")}"; do sleep 0.05; done; ${RESOLVE()}`,
  fix: "git rm -q -- broken && git commit -q -m 'fix: drop the broken marker'",
  markers: "git add -- base && git commit -q --no-edit",
  "trailing-space": RESOLVE("landed\\nwriter  \\n"),
  "blank-eof": RESOLVE("landed\\nwriter\\n\\n"),
  inherit: RESOLVE("landed\\nwriter  \\n"),
  "no-commit": "printf 'landed\\nwriter\\n' > base && git add -- base",
  dirty: `${RESOLVE()} && echo junk > notes.md`,
  failure: RESOLVE(),
  timeout: `${RESOLVE()} && echo $$ > "${join(fixture, "timeout-pid")}" && exec sleep 20`,
};

function respond(messages: Message[]) {
  const results = messages.filter(m => m.role === "toolResult");
  const leaked = Object.keys(process.env).filter(k => k.startsWith("GIT_")).join(",");
  writeFileSync(join(fixture, `merger-turn-${process.pid}-${results.length}`), `${VERSION}\n${leaked}\n${process.cwd()}`);
  if (scenario === "ask") {
    const answer = messages.map(m => m.role === "user" ? text(m) : "").find(t => t.includes("<owner-answer"))?.match(/Answer: (.*)/)?.[1];
    if (!answer) return fauxAssistantMessage([fauxToolCall("ask_owner", { question: "Keep landed first, or writer first?" }, { id: "merger_ask" })], { stopReason: "toolUse" });
    const order = /writer/i.test(answer) ? "writer\\nlanded\\n" : "landed\\nwriter\\n";
    if (!results.some(r => r.toolCallId === "merger_bash")) return fauxAssistantMessage([fauxToolCall("bash", { command: RESOLVE(order) }, { id: "merger_bash" })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`Resolved after the owner's answer (${answer}).`);
  }
  if (!results.length) return fauxAssistantMessage([fauxToolCall("bash", { command: SCRIPTS[scenario] ?? SCRIPTS.resolve! }, { id: "merger_bash" })], { stopReason: "toolUse" });
  // Crash probe: the proposal is committed, then the merger holds before it can settle.
  if (scenario === "commit-hold" && results.length === 1) {
    // The hold publishes its own PID and procfs start time atomically, and records a cooperative exit.
    const hold = `read -r stat < /proc/$$/stat; rest=\${stat##*") "}; set -- $rest; echo "$$ \${20}" > "${join(fixture, "hold-pid.tmp")}" && mv "${join(fixture, "hold-pid.tmp")}" "${join(fixture, "hold-pid")}"; ` +
      `while ! test -f "${join(fixture, "release")}"; do sleep 0.05; done; echo released > "${join(fixture, "hold-exit")}"`;
    return fauxAssistantMessage([fauxToolCall("bash", { command: hold }, { id: "merger_hold" })], { stopReason: "toolUse" });
  }
  if (scenario === "failure") throw new Error("faux merger provider failure after committing");
  const last = results.at(-1)!;
  return fauxAssistantMessage(last.isError ? `Command failed: ${text(last)}` : `Resolved both intents. git status: ${text(last).trim() || "clean"}`);
}

function harness(pi: ExtensionAPI) {
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "faux-1" }] });
  const next = async (context: { messages: Message[] }) => { faux.appendResponses([next]); return respond(context.messages); };
  faux.setResponses([next]);
  pi.registerProvider(faux.provider as never);
  // The faux provider reports zero cost; the final answer carries the fixture's 0.02.
  pi.on("message_end", (e: { message: any }) => {
    const m = e.message;
    if (m.role !== "assistant" || m.content?.some((p: { type: string }) => p.type === "toolCall")) return undefined;
    return { message: { ...m, usage: { ...m.usage, cost: { ...m.usage.cost, total: 0.02 } } } };
  });
}

if (existsSync(join(fixture, "merger-launch-forbidden"))) throw new Error("a merger launched where none may start");
process.env.PI_CODING_AGENT = "true";
await main(process.argv.slice(2), { extensionFactories: [
  { name: "conductor", factory: conductor },
  { name: "m6a-faux", factory: harness },
] as never });
