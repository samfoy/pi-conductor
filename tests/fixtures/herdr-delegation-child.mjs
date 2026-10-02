// N5 fake pane child, one process per `agent start` manifest, owned by the test.
// Plays a delegating parent (depth 1 with an allowlist) or a leaf from its pane env,
// writing nonce-stamped tee events as the H4 child bridge would. No Pi, model or network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readInbox, writeInboxAck } from "../../src/herdr/inbox.ts";

const manifestPath = process.argv[2];
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const b = JSON.parse(readFileSync(join(m.runDir, "record.json"), "utf8")).herdr;
if (b.launchNonce !== m.nonce) throw new Error("manifest/binding nonce mismatch");
const startTime = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]);
const hello = { v: 1, bridgeProtocol: 1, runId: b.runId, launchNonce: b.launchNonce, sessionId: b.sessionId, sessionFile: b.sessionFile, paneId: b.paneId,
  pid: process.pid, pidStartTime: startTime, piVersion: "0.87.1", conductorVersion: "fixture", at: Date.now() };
mkdirSync(join(m.runDir, "launch"), { recursive: true });
writeFileSync(join(m.runDir, "launch", `${b.launchNonce}.json`), JSON.stringify(hello));
const transcript = join(m.runDir, "transcript.jsonl");
const emit = (event, nonce = b.launchNonce) => appendFileSync(transcript, JSON.stringify({ ...event, _c: { n: nonce } }) + "\n");
const wait = async (path, ms = 60000) => { const end = Date.now() + ms; while (!existsSync(path)) { if (Date.now() > end) throw new Error(`fixture barrier expired: ${path}`); await delay(10); } };
emit({ type: "conductor_child", event: "launch", ...hello });
emit({ type: "agent_settled" }); // the idle human turn before the task
writeFileSync(`${manifestPath}.ready`, String(process.pid));
let request;
while (!(request = readInbox(m.runDir, b.launchNonce)[0]?.request)) await delay(10);
writeInboxAck(m.runDir, request);
emit({ type: "agent_start", initialRequestId: request.requestId });
const env = m.paneEnv;
const say = (text, cost = 0.01) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 10, output: 5, cost: { total: cost } } } });
const fixture = dirname(manifestPath);

if (env.CONDUCTOR_DEPTH === "1" && env.CONDUCTOR_DELEGATE_ALLOW) {
  // Delegating parent: a fan-out turn of real-shaped tool events, then a summary turn.
  const scenario = request.text.match(/N5-PARENT (\S+)/)?.[1] ?? "fanout";
  // gate<N>: N sequential calls, each released by the test writing <manifest>.go-<i>.
  const gated = Number(scenario.match(/^gate(\d+)$/)?.[1] ?? 0);
  const results = [];
  for (let i = 0; i < gated; i++) {
    await wait(`${manifestPath}.go-${i}`, 120000);
    const id = `d_g${i}`, path = join(m.runDir, "delegate", `${id}.json`);
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "delegate", args: { persona: "scout", task: "N5-LEAF scout once" } });
    emit({ type: "tool_execution_update", toolCallId: id, toolName: "delegate" });
    await wait(path, 120000);
    const r = JSON.parse(readFileSync(path, "utf8"));
    emit({ type: "tool_execution_end", toolCallId: id, toolName: "delegate", isError: !r.ok });
    results.push(`${id}: ${r.ok ? r.status : `ERROR ${r.reason}`}`);
  }
  const calls = gated ? [] : scenario === "hold"
    ? [{ id: "d_hold", persona: "scout", task: "N5-LEAF scout hold" }]
    : [{ id: "d_scout", persona: "scout", task: "N5-LEAF scout fanout" }, { id: "d_auditor", persona: "auditor", task: "N5-LEAF auditor fanout" },
      { id: "d_denied", persona: "writer", task: "N5-LEAF writer must not run" }];
  if (calls.length) emit({ type: "message_end", message: { role: "assistant", content: calls.map(c => ({ type: "toolCall", id: c.id, name: "delegate", arguments: c })), stopReason: "toolUse" } });
  for (const c of calls) emit({ type: "tool_execution_start", toolCallId: c.id, toolName: "delegate", args: { persona: c.persona, task: c.task } });
  // A call Pi rejects before execute: start then error end, never an update.
  if (scenario === "fanout") {
    emit({ type: "tool_execution_start", toolCallId: "d_schema", toolName: "delegate", args: { persona: "scout" } });
    emit({ type: "tool_execution_end", toolCallId: "d_schema", toolName: "delegate", isError: true });
    // Another invocation's stream line is never this run's evidence.
    emit({ type: "tool_execution_start", toolCallId: "d_foreign", toolName: "delegate", args: { persona: "scout", task: "N5-LEAF scout foreign" } }, "foreign");
    emit({ type: "tool_execution_update", toolCallId: "d_foreign", toolName: "delegate" }, "foreign");
  }
  for (const c of calls) emit({ type: "tool_execution_update", toolCallId: c.id, toolName: "delegate" });
  if (scenario === "fanout") emit({ type: "tool_execution_update", toolCallId: "d_scout", toolName: "delegate" }); // a throttled repeat
  const answers = [];
  for (const c of calls) {
    const path = join(m.runDir, "delegate", `${c.id}.json`);
    await wait(path, 120000);
    const r = JSON.parse(readFileSync(path, "utf8"));
    emit({ type: "tool_execution_end", toolCallId: c.id, toolName: "delegate", isError: !r.ok });
    answers.push(`${c.id}: ${r.ok ? `${r.status} ${r.agentId} ${r.envelope.match(/<result>\n([^\n]*)/)?.[1] ?? ""}` : `ERROR ${r.reason}`}`);
  }
  say(`N5 parent saw ${answers.length + results.length} results\n${[...results, ...answers].join("\n")}`);
} else {
  const [, persona = "unknown", mode = ""] = request.text.match(/N5-LEAF (\S+) (\S+)/) ?? [];
  writeFileSync(join(fixture, `leaf-running-${process.pid}`), persona);
  if (mode === "fanout") await wait(join(fixture, "release-leaves"));
  if (mode === "hold") await wait(`${manifestPath}.release`, 120000);
  say(`LEAF ${persona} done depth=${env.CONDUCTOR_DEPTH} allow=${env.CONDUCTOR_DELEGATE_ALLOW ?? "none"} cwd=${m.cwd}`, 0.02);
}
emit({ type: "agent_settled" });
// pi exits when its run settles; the pane returns to its shell.
