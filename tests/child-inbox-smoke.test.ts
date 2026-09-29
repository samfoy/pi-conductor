import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { writeInboxRequest, readInboxAck, type InboxRequest } from "../src/herdr/inbox.ts";

sandboxPi();
test("H5 scripted fake child consumes only its nonce, distinct from native marker witness", { timeout: 10000 }, async () => {
  const root = tmpDir("h5-scripted-"), runDir = join(root, "oracle-fake");
  mkdirSync(join(runDir, "session"), { recursive: true });
  const binding = { runId: "oracle-fake", launchNonce: "current", sessionId: "fake-session", sessionFile: join(runDir, "session", "fake.jsonl"), paneId: "fake-pane", terminalId: "fake-terminal" };
  writeFileSync(join(runDir, "record.json"), JSON.stringify({ id: binding.runId, runtime: "herdr", herdr: binding }));
  const r: InboxRequest = { v: 1, launchNonce: "current", requestId: "same-id", sequence: 1, kind: "initial", text: "Fake task" };
  const foreign = { ...r, launchNonce: "foreign" };
  writeInboxRequest(runDir, r);
  mkdirSync(join(runDir, "inbox", "foreign"));
  writeFileSync(join(runDir, "inbox", "foreign", "000001-same-id.json"), JSON.stringify(foreign));
  const script = join(root, "script.json");
  writeFileSync(script, JSON.stringify([{ requestId: r.requestId, events: [{ type: "agent_start" }, { type: "agent_settled" }] }]));
  await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url)), "--run-dir", runDir, "--conductor-launch", "current", "--script", script], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_OFFLINE: "1", CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") }, timeout: 5000, killSignal: "SIGKILL",
  });
  assert.equal(readInboxAck(runDir, r)?.accepted, true); assert.equal(readInboxAck(runDir, foreign), undefined);
  const rows = readFileSync(join(runDir, "transcript.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x));
  assert.ok(rows.every(row => row._c.n === "current")); assert.equal(rows.at(-1).type, "agent_settled");
  assert.equal(rows[0].piVersion, "fake-child", "fixture never impersonates native Pi");
});
