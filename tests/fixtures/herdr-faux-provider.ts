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

const RETIRING = "retiring because of context pressure";
async function child(messages: Message[], calls: number) {
  const users = messages.filter(m => m.role === "user").map(text);
  // N5 leaf (depth 2): "H11-LEAF hold <token>" holds its first call on release-<token>, then answers.
  const leafTask = users.find(t => /H11-LEAF /.test(t));
  if (leafTask) {
    const [, mode = "", token = ""] = leafTask.match(/H11-LEAF ([a-z0-9]+) ([a-z0-9]+)/) ?? [];
    if (mode === "hold" && calls === 1) {
      observe(`child-${token}-held`, { pid: process.pid, startTime: startTime(), depth: process.env.CONDUCTOR_DEPTH, runId: process.env.CONDUCTOR_RUN_ID });
      if (!await barrier(token)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "H11 barrier expired" });
    }
    return fauxAssistantMessage(`H11 leaf ${token} done depth=${process.env.CONDUCTOR_DEPTH}`);
  }
  const task = users.find(t => /H11-CHILD /.test(t)) ?? "";
  const [, scenario = "", token = ""] = task.match(/H11-CHILD ([a-z0-9]+) ([a-z0-9]+)/) ?? [];
  observe(`child-${token}-${process.pid}-call-${calls}`, { users, version: VERSION, pid: process.pid });
  const tools = messages.filter(m => m.role === "toolResult").length;
  const answered = tools > 0 || users.length > 1;
  // hold/holdwrite: call 1 waits for release-<token>; hold2 also holds call 2 on release-<token>-2.
  if (((scenario === "hold" || scenario === "holdwrite") && !answered && calls === 1) || (scenario === "hold2" && calls <= 2)) {
    const name = calls === 1 ? token : `${token}-${calls}`;
    observe(`child-${name}-held`, { pid: process.pid, startTime: startTime() });
    if (!await barrier(name)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "H11 barrier expired" });
    if (scenario !== "holdwrite" && calls === 1) return fauxAssistantMessage(`H11 held turn complete ${token}`);
  }
  // N5 delegating parent: two parallel read-only leaves, then one summary of both envelopes.
  if (scenario === "n5" && process.env.CONDUCTOR_DEPTH === "1" && process.env.CONDUCTOR_DELEGATE_ALLOW) {
    const results = messages.filter(m => m.role === "toolResult");
    if (!results.length) return fauxAssistantMessage([
      fauxToolCall("delegate", { persona: "inspector", task: `H11-LEAF hold ${token}a` }, { id: `n5_${token}_a` }),
      fauxToolCall("delegate", { persona: "critic", task: `H11-LEAF hold ${token}b` }, { id: `n5_${token}_b` }),
    ], { stopReason: "toolUse" });
    return fauxAssistantMessage(`H11 n5 parent ${token} saw ${results.length}: ` + results.map(r => `${r.toolCallId}=${text(r).match(/H11 leaf [a-z0-9]+ done depth=\d/)?.[0] ?? `UNEXPECTED ${text(r).slice(0, 300)}`}`).join("; "));
  }
  if (scenario === "ask" && !answered) {
    return fauxAssistantMessage([fauxToolCall("ask_owner", { question: `H11 question ${token}?`, evidence: `H11 evidence ${token}` }, { id: `ask_${token}` })], { stopReason: "toolUse" });
  }
  if ((scenario === "write" || scenario === "holdwrite") && !tools) {
    // Touches the generated region with a stale artifact: integration must rebuild it by policy.
    const command = `printf 'from ${token}\\n' > src/${token}.txt && printf 'stale ${token}\\n' > gen/all.txt && git add -- src/${token}.txt gen/all.txt && git commit -q -m 'test: h11 ${token}'`;
    return fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `bash_${token}` })], { stopReason: "toolUse" });
  }
  // retire: an ordinary multi-tool task whose growing context reaches Pi's own compaction policy.
  if (scenario === "retire") {
    const retiring = JSON.stringify(messages).includes(RETIRING);
    observe(`child-${token}-${process.pid}-retire-${calls}`, { retiring, tools });
    if (!retiring && tools < 12) return fauxAssistantMessage([fauxToolCall("read", { path: join(root!, "pads", "retire.txt") }, { id: `read_${token}_${tools}` })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`H11 retirement handoff ${token}: read ${tools} evidence chunks; ${retiring ? "retirement instruction received" : "no retirement instruction"}; next child should continue from the saved notes.`);
  }
  if (users.length > 1) return fauxAssistantMessage(`H11 saw ${token}: ${users.slice(1).join(" | ")}`);
  return fauxAssistantMessage(`H11 final ${token} 漢🙂 verified with offline faux evidence.`);
}

export default function (pi: ExtensionAPI) {
  // h11-small is a realistic small window: a few tool results reach Pi's compaction threshold.
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "h11-offline", contextWindow: 131072, maxTokens: 1024 }, { id: "h11-small", contextWindow: 8192, maxTokens: 1024 }] });
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
  pi.on("session_before_compact", event => { observe(`${role}-${process.pid}-compact-${Date.now()}`, { reason: event.reason, runId: process.env.CONDUCTOR_RUN_ID }); });
  if (role === "lead") pi.on("tool_execution_end", event => {
    observe(`lead-tool-${event.toolCallId}`, { toolName: event.toolName, isError: event.isError, result: event.result });
  });
}
