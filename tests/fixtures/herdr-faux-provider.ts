// H11 live fixture extension: offline faux model for a real interactive Pi in a
// private herdr pane. Lead turns execute test-written tool scripts; child turns
// follow a scenario named in the task. Barriers are explicit files, never delays.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Message = { role: string; content?: unknown; toolCallId?: string };
const root = process.env.H11_FIXTURE;
const role = process.env.CONDUCTOR_SUBAGENT === "1" ? "child" : "lead";
const text = (m: Message | undefined): string => !m ? "" : typeof m.content === "string" ? m.content
  : Array.isArray(m.content) ? m.content.map(p => p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text) : "").join("") : "";
const startTime = (): number | undefined => {
  try { return Number(readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]); } catch { return undefined; }
};
function observe(name: string, value: unknown): void {
  if (!root) return;
  mkdirSync(join(root, "obs"), { recursive: true });
  writeFileSync(join(root, "obs", `${name}.json`), JSON.stringify(value));
}
async function barrier(name: string): Promise<boolean> {
  const path = join(root!, "script", `release-${name}`), end = Date.now() + 240000;
  while (!existsSync(path)) {
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

function lead(messages: Message[]) {
  const last = messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`H11 lead ack ${last.toolCallId}`);
  const step = text(last).trim().match(/^H11 ([a-z0-9-]+)$/)?.[1];
  if (!step || !existsSync(join(root!, "script", `${step}.json`))) return fauxAssistantMessage("H11 lead idle");
  const { tool, args } = JSON.parse(readFileSync(join(root!, "script", `${step}.json`), "utf8"));
  return fauxAssistantMessage([fauxToolCall(tool, args, { id: `h11_${step.replace(/-/g, "_")}` })], { stopReason: "toolUse" });
}

async function child(messages: Message[], calls: number) {
  const users = messages.filter(m => m.role === "user").map(text);
  const task = users.find(t => /H11-CHILD /.test(t)) ?? "";
  const [, scenario = "", token = ""] = task.match(/H11-CHILD ([a-z0-9]+) ([a-z0-9]+)/) ?? [];
  observe(`child-${token}-${process.pid}-call-${calls}`, { users, version: VERSION, pid: process.pid });
  const answered = messages.some(m => m.role === "toolResult") || users.length > 1;
  // hold: first call waits for release-<token>; hold2 also holds the next call on release-<token>-2.
  if ((scenario === "hold" && !answered && calls === 1) || (scenario === "hold2" && calls <= 2)) {
    const name = calls === 1 ? token : `${token}-${calls}`;
    observe(`child-${name}-held`, { pid: process.pid, startTime: startTime() });
    if (!await barrier(name)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "H11 barrier expired" });
    if (calls === 1) return fauxAssistantMessage(`H11 held turn complete ${token}`);
  }
  if (scenario === "ask" && !answered) {
    return fauxAssistantMessage([fauxToolCall("ask_owner", { question: `H11 question ${token}?`, evidence: `H11 evidence ${token}` }, { id: `ask_${token}` })], { stopReason: "toolUse" });
  }
  if (users.length > 1) return fauxAssistantMessage(`H11 saw ${token}: ${users.slice(1).join(" | ")}`);
  return fauxAssistantMessage(`H11 final ${token} 漢🙂 verified with offline faux evidence.`);
}

export default function (pi: ExtensionAPI) {
  // h11-small puts one ordinary first turn between Pi's compaction threshold and its context window.
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "h11-offline", contextWindow: 16384, maxTokens: 1024 }, { id: "h11-small", contextWindow: 5120, maxTokens: 1024 }] });
  let calls = 0;
  const next = async (context: { messages: Message[] }) => {
    faux.appendResponses([next]);
    calls++;
    return role === "lead" ? lead(context.messages) : child(context.messages, calls);
  };
  faux.setResponses([next]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", (event, ctx) => {
    observe(`${role}-${process.pid}-start-${Date.now()}`, { role, pid: process.pid, startTime: startTime(), version: VERSION, mode: ctx.mode,
      reason: (event as { reason?: unknown }).reason, sessionFile: ctx.sessionManager.getSessionFile(), runId: process.env.CONDUCTOR_RUN_ID });
  });
  if (role === "lead") pi.on("tool_execution_end", event => {
    observe(`lead-tool-${event.toolCallId}`, { toolName: event.toolName, isError: event.isError, result: event.result });
  });
}
