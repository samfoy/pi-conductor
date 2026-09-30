// Owned by the test process, not the short-lived fake CLI. No Pi/model/network.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readInbox, writeInboxAck } from "../../src/herdr/inbox.ts";
const manifest = process.argv[2];
while (!existsSync(manifest)) await delay(10);
const { runDir, mode } = JSON.parse(readFileSync(manifest, "utf8"));
const b = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8")).herdr;
const request = readInbox(runDir, b.launchNonce)[0].request;
const hello = { v: 1, bridgeProtocol: 1, runId: b.runId, launchNonce: b.launchNonce,
  sessionId: b.sessionId, sessionFile: b.sessionFile, paneId: b.paneId, pid: process.pid,
  pidStartTime: Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]),
  piVersion: "0.87.1", conductorVersion: "fixture", at: Date.now() };
mkdirSync(join(runDir, "launch"), { recursive: true });
writeFileSync(join(runDir, "launch", `${b.launchNonce}.json`), JSON.stringify(hello));
const path = join(runDir, "transcript.jsonl");
const emit = event => appendFileSync(path, JSON.stringify({ ...event, _c: { n: b.launchNonce } }) + "\n");
emit({ type: "conductor_child", event: "launch", ...hello });
emit({ type: "agent_settled" }); // preaccept human turn
writeInboxAck(runDir, request);
emit({ type: "agent_start", initialRequestId: request.requestId });
writeFileSync(`${manifest}.ready`, "ready");
const text = "Full Unicode final evidence 漢🙂\u2028\u2029 and verified outcome.";
const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 19, output: 23, cost: { total: 0.02 } } }, _c: { n: b.launchNonce } }) + "\n");
const split = bytes.indexOf(Buffer.from("🙂")) + 2;
appendFileSync(path, bytes.subarray(0, split)); await delay(25); appendFileSync(path, bytes.subarray(split));
appendFileSync(path, '{"type":"agent_settled","_c":{"n":"foreign"}}\n');
if (mode !== "crash") emit({ type: "agent_settled" });
if (mode === "held") while (!existsSync(`${manifest}.exit`)) await delay(10);
