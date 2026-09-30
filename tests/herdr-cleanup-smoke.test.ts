import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { RunRegistry, forceTerminate } from "../src/runs.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
sandboxPi();
for (const mode of ["running", "stubborn", "unproven", "diagnostic-timeout", "diagnostic-overflow"] as const) test(`H9 private owned child/fake CLI kill and explicit quit: ${mode}`, { timeout: 15000 }, async t => {
  const root = tmpDir("h9-kill-smoke-"), statePath = join(root, "state.json"), manifest = join(root, "launch.json");
  const env = { HOME: root, TMPDIR: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl"), PI_OFFLINE: "1" };
  const child = spawn(process.execPath, ["--import", "tsx", new URL("fixtures/herdr-pipeline-child.mjs", import.meta.url).pathname, manifest], { env, stdio: ["ignore", "ignore", "pipe"] });
  const start = readProcessStartTime(child.pid!);
  let exited = false; child.once("exit", () => { exited = true; }); const closed = once(child, "close");
  t.after(async () => {
    if (!exited && child.signalCode === null) { assert.equal(readProcessStartTime(child.pid!), start); child.kill("SIGKILL"); }
    await closed;
  });
  writeFileSync(statePath, JSON.stringify({ calls: [], childPid: child.pid, manifest, mode: mode === "stubborn" ? mode : "running",
    pane: { pane_id: "owned", terminal_id: "terminal", tab_id: "tab", workspace_id: "workspace", agent: null, agent_session: null } }));
  const cli = createHerdrCli({ env: { ...env, FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: new URL("fixtures/fake-herdr.mjs", import.meta.url).pathname }, socketPath: `${statePath}.socket` });
  const dir = join(root, "oracle-h9"); mkdirSync(dir);
  const run: Run = { id: "oracle-h9", runtime: "herdr", persona: "oracle", task: "probe", cwd: root, status: "running", mode: "background", messages: [], usage: emptyUsage(), startTime: Date.now(), lastEventAt: Date.now(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const runtime = new HerdrRuntime({ cli, env, workspaceId: "workspace", trustArgs: () => [] });
  const transport = runtime.launch(run, [], root, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "probe" });
  run.transport = transport; await transport.ready; transport.observe();
  assert.equal(run.herdr!.childPid, child.pid); assert.equal(run.herdr!.childStartTime, start);
  assert.equal(run.proc, undefined, "the short-lived CLI never becomes the run process");
  if (mode.startsWith("diagnostic-")) {
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...before, fault: mode === "diagnostic-timeout" ? "hang" : "overflow" }));
    assert.match(await transport.readStallEvidence!(), /unavailable/);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(after.calls.filter((c: any) => c.args[1] === "read").length, 1);
    delete after.fault; writeFileSync(statePath, JSON.stringify(after));
    assert.equal(exited, false, "diagnostic failure is not authority to kill");
  }
  const original = run.herdr;
  if (mode === "unproven") run.herdr = { ...original!, childStartTime: start! + 1 };
  const registry = new RunRegistry(); registry.register(run);
  forceTerminate(run, "killed", registry);
  assert.equal(run.status, "killed"); await transport.stop();
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.calls.filter((c: any) => c.args[1] === "close").length, 0, "kill preserves scrollback");
  if (mode === "unproven") {
    assert.equal(exited, false); assert.equal(child.signalCode, null); assert.equal(readProcessStartTime(child.pid!), start);
    assert.match(transport.stderr, /preserved|unconfirmed/); return;
  }
  await closed;
  assert.equal(exited, true); assert.equal(child.signalCode, mode === "stubborn" ? "SIGKILL" : "SIGTERM");
  await handleSessionShutdown({ reason: "quit" }, { runs: [run], resetSanitizer() {} });
  state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.calls.filter((c: any) => c.args[0] === "pane" && c.args[1] === "close").length, 1);
  assert.equal(state.calls.filter((c: any) => c.args[0] === "tab" && c.args[1] === "close").length, 0);
  assert.equal(state.closed, true); await run.recordWrite;
});
