// Marker-free scripted process fixture, not evidence about native Pi acceptance.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInbox, dispatchInboxRequest, writeInboxAck } from "../../src/herdr/inbox.ts";

const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const runDir = value("--run-dir"), nonce = value("--conductor-launch");
if (!runDir || resolve(runDir) !== runDir || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(nonce)) throw new Error("invalid fake invocation");
const record = JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
const b = record.herdr;
if (record.runtime !== "herdr" || record.id !== b?.runId || b.launchNonce !== nonce) throw new Error("fake child binding mismatch");
const script = JSON.parse(readFileSync(value("--script"), "utf8"));
let index = 0;
const emit = event => appendFileSync(join(runDir, "transcript.jsonl"), JSON.stringify({ ...event, _c: { n: nonce } }) + "\n");
const startTime = process.platform === "linux" ? Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19]) : undefined;
const hello = { v: 1, bridgeProtocol: 1, runId: b.runId, launchNonce: nonce, pid: process.pid, pidStartTime: startTime,
  paneId: b.paneId, terminalId: b.terminalId, sessionId: b.sessionId, sessionFile: b.sessionFile, piVersion: "fake-child", conductorVersion: "fixture", at: Date.now() };
mkdirSync(join(runDir, "launch"), { recursive: true });
writeFileSync(join(runDir, "launch", `${nonce}.json`), JSON.stringify(hello), { flag: "wx", mode: 0o600 });
emit({ type: "conductor_child", event: "launch", ...hello });
const timer = setInterval(() => {
  const entry = readInbox(runDir, nonce).find(e => !e.dispatched);
  if (!entry) return;
  const step = script[index];
  if (!step || step.requestId !== entry.request.requestId) throw new Error("unexpected fake child request");
  dispatchInboxRequest(runDir, entry.request);
  if (step.ack !== false) writeInboxAck(runDir, entry.request, step.code);
  for (const event of step.events ?? []) emit(event);
  if (++index === script.length) clearInterval(timer);
}, 10);
