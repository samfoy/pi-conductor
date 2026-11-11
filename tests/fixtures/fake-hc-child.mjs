// Marker-free process fixture started by fake hc through HcHost's argv; not evidence about native Pi.
import { register } from "tsx/esm/api";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

register();
const { readInbox, dispatchInboxRequest, writeInboxAck } = await import("../../src/herdr/inbox.ts");
const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const nonce = flag("--conductor-launch"), runDir = process.env.CONDUCTOR_RUN_DIR, terminal = process.env.HC_TERMINAL_ID;
const record = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
const b = record.herdr;
if (record.runtime !== "herdr" || b?.host !== "hc" || b.launchNonce !== nonce || process.env.HC_TERMINAL_SOCKET !== b.socketPath || !terminal) {
  throw new Error("fake hc child binding mismatch");
}
const mode = process.env.FAKE_CHILD_MODE ?? "hold";
if (mode === "ignore-term") process.on("SIGTERM", () => {});
else process.on("SIGTERM", () => { writeFileSync(join(runDir, `fake-child-${nonce}.sigterm`), String(process.pid)); process.exit(143); });
const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(HC_|HERDR_|CONDUCTOR_|AWS_)/.test(key)));
writeFileSync(join(runDir, `fake-child-${nonce}.json`), JSON.stringify({ argv: process.argv.slice(2), env: seen }));
const startTime = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]);
const hello = { v: 1, bridgeProtocol: 1, runId: b.runId, launchNonce: nonce, pid: process.pid, pidStartTime: startTime, paneId: terminal, terminalId: terminal,
  sessionId: b.sessionId, sessionFile: b.sessionFile, piVersion: "fake-child", conductorVersion: "fixture", at: Date.now() };
mkdirSync(join(runDir, "launch"), { recursive: true });
writeFileSync(join(runDir, "launch", `${nonce}.json`), JSON.stringify(hello), { flag: "wx", mode: 0o600 });
const emit = event => appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify({ ...event, _c: { n: nonce } }) + "\n");
emit({ type: "conductor_child", event: "launch", ...hello });
const inputs = [];
let task, finished = false;
const finish = () => {
  finished = true;
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Final verified hc evidence for ${task.text} with sufficient substance.` }],
    stopReason: "stop", usage: { input: 11, output: 7, cost: { total: 0.01 } } } });
  emit({ type: "agent_settled" });
  setTimeout(() => process.exit(0), 20);
};
setInterval(() => {
  if (task && !finished && existsSync(join(runDir, `fake-child-${nonce}.finish`))) finish();
  for (const { request } of readInbox(runDir, nonce).filter(entry => !entry.dispatched)) {
    dispatchInboxRequest(runDir, request);
    inputs.push({ kind: request.kind, text: request.text });
    writeFileSync(join(runDir, `fake-child-${nonce}.inputs.json`), JSON.stringify(inputs));
    if (mode === "exit-on-task") process.exit(3);
    writeInboxAck(runDir, request);
    if (request.kind === "initial" || request.kind === "reply") {
      emit({ type: "agent_start", initialRequestId: request.requestId });
      task = request;
      if (mode === "task" && !request.text.includes("HOLD")) finish();
    }
  }
}, 10);
