import test from "node:test";
import assert from "node:assert/strict";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { forceTerminate } from "../src/runs.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
sandboxPi();

test("H9 slash stop does not claim an unproven child stopped", async () => {
  const { registerCommands } = await import("../src/commands.ts");
  const h = await attached(); h.unknown();
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  registerCommands({ registerCommand: (_name: string, command: any) => { handler = command.handler; } } as any, { getRegistry: () => h.registry } as any);
  const notices: string[] = [];
  await handler(`stop ${h.run.id}`, { ui: { notify: (text: string) => notices.push(text) } });
  assert.match(notices[0], /requested.*proof/);
  await h.transport.stop(); assert.deepEqual(h.signals, []);
});


test("H9 tool kill reports a request, not proven cleanup, and stays notification-silent", async () => {
  const { registerTools } = await import("../src/tools.ts");
  const { SpawnQueue } = await import("../src/queue.ts");
  const { FocusedStreamModel } = await import("../src/focused-stream-model.ts");
  const h = await attached(); h.unknown();
  const tools = new Map<string, any>(); let notifications = 0;
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    getCwd: () => h.run.cwd, getRegistry: () => h.registry, getQueue: () => new SpawnQueue(h.registry, 1),
    getModel: () => new FocusedStreamModel(h.registry), getParentMessages: () => [], openFocusedOverlay() {}, pushCompletionNotification() { notifications++; },
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }),
  });
  const result = await tools.get("ensemble_kill").execute("kill", { agent_id: h.run.id });
  assert.match(result.content[0].text, /requested.*proof|proof.*requested/);
  assert.equal(result.details.status, "killed"); assert.equal(notifications, 0);
  await h.transport.stop(); assert.deepEqual(h.signals, []);
});


test("H9 release refuses a resume status change during pane lookup", async () => {
  const h = await attached("healthy"); h.run.status = "completed";
  const json = h.cli.json; h.cli.json = async (args, limits) => {
    const result = await json(args, limits);
    if (args[1] === "get") h.run.status = "running";
    return result;
  };
  assert.equal(await h.transport.releasePane(), false);
  assert.equal(h.calls.includes("pane close"), false, "do not close a newly resuming invocation pane");
});


test("H9 five-second pane budget starts after M5 suspension and terminal I/O; abort fences pending cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await attached("healthy"); h.run.status = "integrating";
  let releaseSuspend!: () => void, releaseSettlement!: () => void;
  h.run.effort = { name: "protected" } as typeof h.run.effort;
  h.run.integrationSuspension = new Promise<void>(resolve => { releaseSuspend = resolve; });
  h.run.integrationSettlement = new Promise<void>(resolve => { releaseSettlement = resolve; });
  let started = false, aborted = false, finished = false;
  h.transport.shutdown = async signal => {
    started = true; await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  };
  const done = handleSessionShutdown({ reason: "quit" }, { runs: [h.run], resetSanitizer() {}, reconcileRunning() { assert.fail("integrating must never become killed"); } }).then(() => { finished = true; });
  t.mock.timers.tick(6000); await Promise.resolve(); assert.equal(started, false); assert.equal(finished, false);
  releaseSuspend(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(6000); await Promise.resolve(); assert.equal(started, false);
  releaseSettlement(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(started, true); t.mock.timers.tick(4999); assert.equal(aborted, false);
  t.mock.timers.tick(1); await done; assert.equal(aborted, true); assert.equal(h.run.status, "integrating");
  assert.match(h.run.worktreeKept!, /budget expired/);
});


async function attached(mode = "running") {
  const h = herdrFixture(mode);
  const transport = h.runtime.launch(h.run, [], h.run.cwd, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", h.opts.core);
  h.run.transport = transport;
  await transport.ready;
  transport.observe();
  return { ...h, transport };
}

for (const field of ["childPid", "childStartTime", "launchNonce", "paneId", "terminalId", "socketPath"] as const) {
  test(`H9 current ${field} replacement forbids signals and release`, async () => {
    const h = await attached();
    h.run.herdr = { ...h.run.herdr!, [field]: field === "childPid" ? 54321 : field === "childStartTime" ? 88 : "replaced" };
    await h.transport.stop();
    assert.deepEqual(h.signals, [], "never signal a child using superseded binding evidence");
    assert.equal(await h.transport.releasePane(), false);
    assert.match(h.transport.stderr, /preserved|unconfirmed/);
  });
}
test("H9 rechecks current binding before escalation, retaining scrollback", async () => {
  const h = await attached("stubborn");
  h.onSleep(() => { h.run.herdr = { ...h.run.herdr!, launchNonce: "resumed" }; });
  await h.transport.stop();
  assert.deepEqual(h.signals, ["SIGTERM"]);
  assert.equal(h.calls.includes("pane close"), false);
});
test("H9 force kill synchronously settles once and also terminates the owned hook group", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await attached();
  h.run.hookProc = { pid: 45678 } as typeof h.run.hookProc;
  const groups: unknown[] = []; let completed = 0;
  forceTerminate(h.run, "stalled", h.registry, () => completed++, (pid, signal) => groups.push([pid, signal]));
  assert.equal(h.run.status, "killed"); assert.equal(h.run.failureClass, "stall");
  assert.equal(h.run.hookProc, undefined);
  assert.deepEqual(groups, [[45678, "SIGTERM"]]);
  t.mock.timers.tick(2000);
  assert.deepEqual(groups, [[45678, "SIGTERM"], [45678, "SIGKILL"]]);
  await h.transport.stop();
  forceTerminate(h.run, "stalled", h.registry, () => completed++);
  assert.equal(completed, 1); assert.deepEqual(h.signals, ["SIGTERM"]);
  assert.equal(h.calls.includes("pane close"), false);
});
test("H9 quit stops children and releases completed empty panes, but reload preserves both", async () => {
  const active = await attached(), completed = await attached("healthy");
  completed.run.status = "completed";
  const runs = [active.run, completed.run];
  await handleSessionShutdown({ reason: "reload" }, { runs, resetSanitizer() {} });
  assert.deepEqual(active.signals, []); assert.equal(completed.calls.includes("pane close"), false);
  await handleSessionShutdown({ reason: "quit" }, { runs, resetSanitizer() {} });
  assert.deepEqual(active.signals, ["SIGTERM"]);
  assert.equal(active.calls.filter(c => c === "pane close").length, 1);
  assert.equal(completed.calls.filter(c => c === "pane close").length, 1);
  assert.equal(completed.run.status, "completed");
});
test("H9 already exited child plus fresh agent never signals or closes the pane", async () => {
  const h = await attached("healthy"); h.run.status = "completed";
  h.pane.agent = "manual";
  await handleSessionShutdown({ reason: "quit" }, { runs: [h.run], resetSanitizer() {} });
  assert.deepEqual(h.signals, []); assert.equal(h.calls.includes("pane close"), false);
});
