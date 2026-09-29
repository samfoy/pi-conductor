import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { readInbox } from "../src/herdr/inbox.ts";
sandboxPi();

for (const starts of [true, false]) test(`H6 real fake CLI/child: fast exit ${starts ? "after correlated start" : "without start"}`, { timeout: 15000 }, async t => {
  const root = tmpDir("h6-process-"), dir = join(root, "oracle-process"); mkdirSync(dir);
  const statePath = join(root, "fake-state.json"), script = join(root, "script.json");
  const env = { HOME: root, TMPDIR: root, PATH: dirname(process.execPath), CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)), FAKE_HERDR_STATE: statePath };
  const run: Run = { id: "oracle-process", runtime: "herdr", persona: "oracle", task: "private prepared text", status: "running", mode: "background", cwd: root, startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const pane = { pane_id: "pane-fixture", terminal_id: "terminal-fixture", tab_id: "tab-fixture", workspace_id: "workspace-fixture", agent: null, agent_session: null };
  writeFileSync(statePath, JSON.stringify({ calls: [], pane }));
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (value: object) => writeFileSync(statePath, JSON.stringify({ ...read(), ...value }));
  const base = createHerdrCli({ env, socketPath: `${statePath}.socket` });
  let child: ChildProcess | undefined, exited = false;
  t.after(async () => {
    if (child && !exited) { child.kill("SIGKILL"); await new Promise<void>(resolve => child!.once("close", () => resolve())); }
  });
  const runtime = new HerdrRuntime({ env, workspaceId: pane.workspace_id, trustArgs: () => [], piVersion: "fake-child", cli: { ...base, async json(args, limits) {
    if (args[1] !== "start") return base.json(args, limits);
    const binding = JSON.parse(readFileSync(run.recordPath, "utf8")).herdr;
    patch({ sessionFile: binding.sessionFile });
    const result = await base.json(args, limits);
    const request = readInbox(dir, binding.launchNonce)[0].request;
    writeFileSync(script, JSON.stringify([{ requestId: request.requestId, events: starts ? [{ type: "agent_start", initialRequestId: request.requestId }, { type: "agent_settled" }] : [] }]));
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/fake-child.mjs", import.meta.url)), "--run-dir", dir, "--conductor-launch", binding.launchNonce, "--script", script], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr!.on("data", data => { stderr += data.toString(); });
    child.once("exit", () => { exited = true; });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once("close", resolve); child!.once("error", reject); });
    assert.equal(code, 0, stderr); assert.equal(exited, true);
    patch({ pane }); // Fast settle: the real child is reaped before the CLI result is observed.
    return result;
  } } });
  const transport = runtime.launch(run, [], root, { line() { assert.fail("no H6 streaming"); }, close() { assert.fail("CLI close cannot settle a child"); }, error() {}, initialDeliveryFailed() {} }, run.task, { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "private" });
  if (starts) await transport.ready; else await assert.rejects(transport.ready, /native agent_start: child gone/);
  await transport.closed;
  assert.equal(run.proc, undefined); assert.equal(run.pid, undefined);
  assert.equal(run.herdr?.childPid, child!.pid); assert.equal(child!.signalCode, null); assert.equal(exited, true);
  assert.equal(read().calls.filter((c: {args: string[]}) => c.args[1] === "close").length, starts ? 0 : 1);
  for (const call of read().calls) assert.equal(call.socket, `${statePath}.socket`);
});
