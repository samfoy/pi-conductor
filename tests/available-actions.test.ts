import test from "node:test";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { registerTools } from "../src/tools.ts";
import { RunRegistry, validateSendable, pauseRun, resumeRun, observeRunActions, computeAvailableActions } from "../src/runs.ts";
import { RpcStdinQueue } from "../src/rpc-stdin.ts";
import { applyEvent } from "../src/event-handler.ts";
import { cardLinesToPlainText, renderNotificationCard } from "../src/notification-renderer.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { buildCompletionMessage, buildStallMessage } from "../src/notifications.ts";
import { renderForegroundSummary } from "../src/foreground-stream.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const terminal: RunStatus[] = ["completed", "failed", "killed", "timeout", "hook_failed", "merge_conflict", "aborted"];
function fixture(status: RunStatus = "completed") {
  const cwd = tmpDir("a3-actions-");
  const run: Run = { id: "oracle-a3", persona: "oracle", task: "test", mode: "background", status,
    startTime: 1, lastEventAt: 2, cwd, messages: [], usage: emptyUsage(),
    recordPath: join(cwd, "record.json"), transcriptPath: join(cwd, "transcript.jsonl"), finalPath: join(cwd, "final.md"), sessionPath: join(cwd, "session.jsonl") };
  writeFileSync(run.sessionPath!, JSON.stringify({ type: "session", id: "child" }) + "\n");
  return run;
}
function retire(run: Run, fresh = false) {
  if (fresh) {
    mkdirSync(join(run.cwd, "session"));
    run.sessionPath = join(run.cwd, "session", "child.jsonl");
  }
  writeFileSync(run.sessionPath!, [ { type: "session", id: "child" },
    { type: "custom", customType: "conductor-context-retired", data: { sessionId: "child" } } ].map(x => JSON.stringify(x)).join("\n"));
  if (fresh) run.sessionPath = undefined;
}
// Capture Pi's heterogeneous tool definitions at the API boundary.
function harness(run: Run) {
  const registry = new RunRegistry(); registry.register(run);
  const queue = new SpawnQueue(registry, 4);
  const model = new FocusedStreamModel(registry);
  const tools = new Map<string, any>();
  let opened = 0;
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    getCwd: () => run.cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => model,
    getParentMessages: () => [], openFocusedOverlay: () => { opened++; }, pushCompletionNotification: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
  });
  const call = (name: string, params = {}, mode = "json") => tools.get(`ensemble_${name}`).execute("call", { agent_id: run.id, ...params }, undefined, undefined, { mode, hasUI: mode === "tui" || mode === "rpc" });
  return { registry, queue, call, opened: () => opened };
}
async function actions(h: ReturnType<typeof harness>, mode = "json"): Promise<string[]> {
  const result = await h.call("status", {}, mode);
  const rows = [ ...result.details.running, ...result.details.queued, ...result.details.paused, ...result.details.finished ];
  assert.equal(rows.length, 1, "every status, including all terminals, is reported");
  assert.ok(Array.isArray(rows[0].available_actions), "status record has available_actions");
  assert.match(result.content[0].text, /available_actions=/, "model-facing status includes actions");
  return rows[0].available_actions;
}
function rpc(run: Run) {
  run.streamingMode = "rpc";
  const stream = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  run.rpcStdinQueue = new RpcStdinQueue(stream);
  return stream;
}

for (const status of terminal) {
  test(`A3 ${status}: saved-session send, no control action, idempotent kill`, async () => {
    const run = fixture(status); const h = harness(run);
    assert.deepEqual(await actions(h), ["send"]);
    assert.equal(validateSendable(run, "resume").ok, true);
    assert.deepEqual(await actions(h, "tui"), ["send", "focus"]);
    const killed = await h.call("kill");
    assert.equal(killed.details.error, undefined);
    assert.equal(run.status, status);
  });
}

const cases: { name: string; status?: RunStatus; setup: (run: Run) => void; expected: string[]; error?: RegExp }[] = [
  { name: "print running", status: "running", setup: () => {}, expected: ["kill"], error: /not steerable/ },
  { name: "live RPC", status: "running", setup: r => { rpc(r); }, expected: ["steer", "follow_up", "kill"] },
  { name: "fresh live RPC", status: "running", setup: r => { rpc(r); r.sessionPath = undefined; }, expected: ["steer", "follow_up", "kill"] },
  { name: "fresh live RPC retirement before finalize", status: "running", setup: r => { rpc(r); retire(r, true); }, expected: ["kill"], error: /retired/ },
  { name: "retired session", setup: r => retire(r), expected: [], error: /retired/ },
  { name: "persisted retirement", setup: r => { r.contextRetired = true; }, expected: [], error: /retired/ },
  { name: "retirement disabled", setup: r => { retire(r); r.contextRetired = true; mkdirSync(join(r.cwd, ".pi")); writeFileSync(join(r.cwd, ".pi/conductor.json"), '{"contextRetirement":false}'); }, expected: ["send"] },
  { name: "missing session path", setup: r => { r.sessionPath = undefined; }, expected: [], error: /no resumable session/ },
  { name: "session path is a directory", setup: r => { unlinkSync(r.sessionPath!); mkdirSync(r.sessionPath!); }, expected: [], error: /missing on disk/ },
  { name: "deleted session", setup: r => unlinkSync(r.sessionPath!), expected: [], error: /missing on disk/ },
  { name: "exited RPC process with open stream", status: "running", setup: r => { rpc(r); r.proc = { pid: 999999, exitCode: 0 } as Run["proc"]; }, expected: ["kill"], error: /stdin/ },
  { name: "signalled RPC process with open stream", status: "running", setup: r => { rpc(r); r.proc = { pid: 999999, signalCode: "SIGKILL" } as Run["proc"]; }, expected: ["kill"], error: /stdin/ },
  { name: "fresh live RPC retirement disabled", status: "running", setup: r => { rpc(r); retire(r, true); mkdirSync(join(r.cwd, ".pi")); writeFileSync(join(r.cwd, ".pi/conductor.json"), '{"contextRetirement":false}'); }, expected: ["steer", "follow_up", "kill"] },
  { name: "live RPC bound session deleted", status: "running", setup: r => { rpc(r); unlinkSync(r.sessionPath!); }, expected: ["kill"], error: /missing on disk/ },
  { name: "closed RPC stdin", status: "running", setup: r => { rpc(r).end(); }, expected: ["kill"], error: /stdin|writable/ },
  { name: "destroyed RPC queue", status: "running", setup: r => { rpc(r); r.rpcStdinQueue!.destroy("test"); }, expected: ["kill"], error: /stdin|writable/ },
  { name: "missing RPC queue", status: "running", setup: r => { r.streamingMode = "rpc"; }, expected: ["kill"], error: /stdin queue gone/ },
  { name: "paused without handle", status: "paused", setup: () => {}, expected: ["kill"], error: /paused/ },
  { name: "queued", status: "queued", setup: () => {}, expected: ["kill"], error: /queued/ },
  { name: "foreign live RPC", status: "running", setup: r => { rpc(r); r.parentPid = process.pid + 1; }, expected: [], error: /foreign|owned/ },
];
for (const c of cases) {
  test(`A3 eligibility and tool validation: ${c.name}`, async () => {
    const run = fixture(c.status); c.setup(run); const h = harness(run);
    assert.deepEqual(await actions(h), c.expected);
    const validation = validateSendable(run);
    assert.equal(validation.ok, c.expected.some(a => ["send", "follow_up"].includes(a)), "send validation agrees with reported eligibility");
    if (c.error) {
      const result = await h.call("send", { message: "follow up", foreground: false });
      assert.match(result.details.error, c.error);
    }
    for (const behavior of ["steer", "follow_up", "resume"] as const) {
      const token = behavior === "resume" ? "send" : behavior;
      assert.equal(validateSendable(run, behavior).ok, c.expected.includes(token), `${behavior} validation agrees`);
    }
  });
}

test("A3 observations are read-only and status snapshots are not authorization", async (t) => {
  const run = fixture(); const h = harness(run);
  run.worktreePath = join(run.cwd, ".worktrees/conductor-wt", run.id);
  run.worktreeBranch = "conductor-wt/kept";
  writeFileSync(run.sessionPath!, JSON.stringify({ type: "session", id: "child", cwd: run.worktreePath }) + "\n");
  t.mock.method(cp, "spawn", () => assert.fail("status must not spawn"));
  t.mock.method(cp, "spawnSync", () => assert.fail("status must not run git or restore worktrees"));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const before = readdirSync(run.cwd); const session = readFileSync(run.sessionPath!, "utf8");
  assert.deepEqual(await actions(h), ["send"]);
  assert.deepEqual(readdirSync(run.cwd), before);
  assert.equal(readFileSync(run.sessionPath!, "utf8"), session);
  assert.equal(run.contextRetired, undefined);
  assert.equal(run.worktreeBranch, "conductor-wt/kept");
  retire(run);
  assert.match((await h.call("send", { message: "after snapshot" })).details.error, /retired/);
  run.contextRetired = undefined;
  unlinkSync(run.sessionPath!);
  assert.match((await h.call("send", { message: "after deletion" })).details.error, /missing on disk/);
  assert.equal(run.status, "completed");
});

test("A3 pause/resume share eligibility and recheck ownership before signals", async () => {
  const run = fixture("running");
  run.proc = { pid: 999999, kill: () => true } as Run["proc"];
  const h = harness(run); const signals: (string | number)[] = [];
  const signaler = (_pid: number, signal: string | number) => { signals.push(signal); };
  assert.deepEqual(await actions(h), ["pause", "kill"]);
  assert.equal(pauseRun(run, h.registry, signaler), true);
  assert.deepEqual(await actions(h), ["resume", "kill"]);
  assert.equal(resumeRun(run, h.registry, signaler), true);
  assert.deepEqual(signals, ["SIGSTOP", "SIGCONT"]);
  run.parentPid = process.pid + 1;
  assert.equal(pauseRun(run, h.registry, signaler), false);
  assert.ok((await h.call("pause")).details.error);
  assert.ok((await h.call("kill")).details.error);
  assert.equal(run.status, "running");
  assert.deepEqual(signals, ["SIGSTOP", "SIGCONT"]);
});

test("A3 focus depends on terminal UI, not RPC hasUI, and revalidates", async () => {
  const run = fixture(); const h = harness(run);
  assert.deepEqual(await actions(h, "tui"), ["send", "focus"]);
  for (const mode of ["rpc", "json", "print"]) {
    assert.deepEqual(await actions(h, mode), ["send"]);
    assert.equal((await h.call("focus", {}, mode)).details.opened, false);
  }
  assert.equal(h.opened(), 0);
  assert.equal((await h.call("focus", {}, "tui")).details.opened, true);
  assert.equal(h.opened(), 1);
});

test("A3 background, foreground and stall results expose actions without retired continuation", () => {
  const run = fixture();
  const completion = buildCompletionMessage(run);
  assert.match(completion.content, /<available-actions>send<\/available-actions>/);
  assert.deepEqual((completion.details as any).available_actions, ["send"]);
  assert.match(renderForegroundSummary(run), /available_actions=send/);
  run.status = "running"; rpc(run); retire(run, true);
  const stall = buildStallMessage(run, { severity: "soft", silentSeconds: 120, thresholdSeconds: 120 });
  assert.match(stall.content, /<available-actions>kill<\/available-actions>/);
  assert.deepEqual((stall.details as any).available_actions, ["kill"]);
  run.status = "completed";
  assert.match(buildCompletionMessage(run).content, /<available-actions><\/available-actions>/);
  assert.match(renderForegroundSummary(run), /available_actions=\(none\)/);
});


test("A3 capability inputs are explicit; pure computation cannot reread disk", () => {
  const run = fixture("running"); rpc(run);
  run.proc = { pid: 999999 } as Run["proc"];
  const observed = observeRunActions(run, true);
  retire(run);
  assert.deepEqual(computeAvailableActions(run, observed), ["steer", "follow_up", "pause", "kill", "focus"]);
  assert.deepEqual(computeAvailableActions(run, { ...observed, capabilities: { pause: false, liveSend: false } }), ["kill", "focus"]);
});

for (const behavior of ["steer", "follow_up"] as const) {
  test(`A3 advertised ${behavior} delivers through real tool and RPC queue`, { timeout: 5000 }, async () => {
    const run = fixture("running"); const h = harness(run);
    const delivered: unknown[] = [];
    const stream = new Writable({ write(chunk, _encoding, cb) {
      const command = JSON.parse(String(chunk)); delivered.push(command);
      applyEvent(run, { type: "response", id: command.id, command: command.type, success: true });
      cb();
    } });
    run.streamingMode = "rpc"; run.rpcStdinQueue = new RpcStdinQueue(stream);
    assert.ok((await actions(h)).includes(behavior));
    const result = await h.call("send", { message: "course correction", streaming_behavior: behavior });
    assert.equal(result.details.delivered, true);
    assert.equal(delivered.length, 1);
    assert.equal((delivered[0] as { type: string }).type, behavior);
    stream.end();
    assert.match((await h.call("send", { message: "after close", streaming_behavior: behavior })).details.error, /stdin/);
    assert.equal(delivered.length, 1, "no bytes after closed-stdin revalidation");
    run.status = "completed"; h.registry.notify(run);
  });
}

test("A3 queued cancellation and paused controls execute through real tools", async (t) => {
  const signals: unknown[] = [];
  t.mock.method(process, "kill", (pid: number, signal: string | number) => { signals.push([pid, signal]); return true; });
  const run = fixture("running"); run.proc = { pid: 999999 } as Run["proc"];
  const h = harness(run);
  assert.ok((await actions(h)).includes("pause"));
  assert.equal((await h.call("pause")).details.status, "paused");
  assert.ok((await actions(h)).includes("resume"));
  assert.equal((await h.call("resume")).details.status, "running");
  assert.ok((await h.call("resume")).details.error, "state changed since paused snapshot");
  assert.deepEqual(signals, [[999999, "SIGSTOP"], [999999, "SIGCONT"]]);
  run.proc = undefined; run.status = "queued";
  (h.queue as any).pending.push({ id: run.id, spawn: { persona: { name: run.persona } } });
  assert.deepEqual(await actions(h), ["kill"]);
  assert.equal((await h.call("kill")).details.status, "killed");
  assert.equal(h.queue.size(), 0);
});

for (const tool of ["spawn", "send"]) for (const status of ["completed", "failed"] as const) {
  test(`A3 foreground ${tool} ${status} exposes matching completion text and details`, { timeout: 5000 }, async (t) => {
    const run = fixture(); const h = harness(run);
    t.mock.method(cp, "spawn", () => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true, unref() {} });
      queueMicrotask(() => proc.emit("close", status === "completed" ? 0 : 1, null));
      return proc;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await h.call(tool, tool === "send" ? { message: "continue" } : { persona: "oracle", task: "test", foreground: true, chain: false });
    assert.equal(result.details.status, status);
    const actions = result.details.available_actions;
    assert.ok(Array.isArray(actions));
    assert.match(result.content[0].text, new RegExp(`available_actions=${actions.join(",") || "\\(none\\)"}`));
    if (tool === "send") assert.deepEqual(actions, ["send"]);
  });
}

test("A3 completion cards show advisory actions on expansion, including an empty set", () => {
  const run = fixture();
  for (const retired of [false, true]) {
    run.contextRetired = retired;
    const message = buildCompletionMessage(run, true);
    const text = cardLinesToPlainText(renderNotificationCard(message.details, { expanded: true }));
    assert.match(text, retired ? /available_actions=focus/ : /available_actions=send,focus/);
  }
  const legacy = buildCompletionMessage(run).details;
  delete legacy.available_actions;
  assert.doesNotMatch(cardLinesToPlainText(renderNotificationCard(legacy, { expanded: true })), /available_actions=/);
});
