import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { registerTools } from "../src/tools.ts";
import { RunRegistry, availableActions, sendToRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
sandboxPi();
for (const foreground of [false, true]) test(`H7 registered public fake CLI spawn/stream/final and Esc detach (foreground=${foreground})`, { timeout: 20000 }, async t => {
  const root = tmpDir("h7-public-"), statePath = join(root, "state.json"), manifest = join(root, "launch.json");
  const child = spawn(process.execPath, ["--import", "tsx", new URL("fixtures/herdr-pipeline-child.mjs", import.meta.url).pathname, manifest], { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe"] });
  let exited = false; child.once("exit", () => { exited = true; });
  const closed = once(child, "close");
  t.after(async () => { if (!exited && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  writeFileSync(statePath, JSON.stringify({ calls: [], childPid: child.pid, manifest, mode: "held", pane: { pane_id: "pane", terminal_id: "terminal", tab_id: "tab", workspace_id: "workspace", agent: null, agent_session: null } }));
  const env = { ...gitTestEnv(), HERDR_ENV: "1", HERDR_SOCKET_PATH: `${statePath}.socket`, HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "workspace", FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: new URL("fixtures/fake-herdr.mjs", import.meta.url).pathname };
  const registry = new RunRegistry(), queue = new SpawnQueue(registry, 2), registered = new Map<string, any>();
  let detach!: () => void, completed = 0;
  const detachSignal = new Promise<void>(resolve => { detach = resolve; });
  registerTools({ registerTool: (tool: any) => registered.set(tool.name, tool) } as any, {
    getCwd: () => root, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [],
    openFocusedOverlay() {}, registerForegroundDetach: () => ({ detachSignal, unregister() {} }), pushCompletionNotification() { completed++; },
  }, env);
  const executing = registered.get("ensemble_spawn").execute("h7", { persona: "inspector", task: "Probe fixture", foreground, runtime: "herdr" });
  if (foreground) detach();
  const response = await executing;
  assert.equal(registry.list().length, 1, JSON.stringify(response));
  const run = registry.list()[0];
  assert.equal(run.runtime, "herdr"); assert.equal(run.proc, undefined); assert.equal(run.pid, undefined);
  assert.ok(run.transport?.kind === "herdr"); await run.transport.ready;
  assert.equal(exited, false, "foreground detach must not stop child");
  for (const action of ["send", "steer", "follow_up", "pause", "resume"]) assert.ok(!availableActions(run).includes(action as never));
  assert.equal(sendToRun(run, "unsupported", { registry, timeoutMs: 1000 }).kind, "rejected");
  assert.equal(existsSync(run.finalPath), false, "no final before child exit");
  const settled = new Promise<void>(resolve => { const off = registry.onChange(r => { if (r.id === run.id && r.status === "completed") { off(); resolve(); } }); });
  writeFileSync(`${manifest}.exit`, "exit"); await closed; await settled; await run.recordWrite;
  // The registry transition precedes terminal I/O; use the transport-independent final event.
  await new Promise<void>(resolve => { const timer = setInterval(() => { if (existsSync(run.finalPath) && completed === 1) { clearInterval(timer); resolve(); } }, 10); t.after(() => clearInterval(timer)); });
  assert.equal(completed, 1); assert.equal(run.usage.turns, 1); assert.equal(run.usage.input, 19);
  assert.match(readFileSync(run.finalPath, "utf8"), /漢🙂\u2028\u2029/);
  assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).runtime, "herdr");
  assert.equal(readFileSync(run.transcriptPath, "utf8").trim().split("\n").length, 6);
  assert.ok(!JSON.parse(readFileSync(statePath, "utf8")).closed, "ordinary pane/scrollback preserved");
});
