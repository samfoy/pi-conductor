import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { buildOnChainCallback, registerTools } from "../src/tools.ts";
import { RunRegistry, runDir, sendToRun } from "../src/runs.ts";
import { RpcStdinQueue } from "../src/rpc-stdin.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { DEFAULT_CONFIG, emptyUsage, toRunRecord, type Run } from "../src/types.ts";

sandboxPi();
const cwd = tmpDir("a5-tools-");
const other = tmpDir("a5-other-");
writeFileSync(join(cwd, "evidence.md"), "CALLER EVIDENCE");
writeFileSync(join(other, "evidence.md"), "OVERRIDE EVIDENCE");
const message = { role: "assistant", content: [{ type: "text", text: "Verified the changes; all checks passed and the handoff is ready." }], stopReason: "stop" };
function run(id: string, root = cwd): Run {
  const dir = runDir(id); mkdirSync(dir, { recursive: true });
  const r: Run = { id, persona: "inspector", task: "task", cwd: root, status: "completed", mode: "background", startTime: 1, lastEventAt: 1, messages: [message as any], usage: emptyUsage(), finalPath: join(dir, "final.md"), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), sessionPath: join(dir, "session.jsonl") };
  writeFileSync(r.finalPath, message.content[0].text);
  writeFileSync(r.recordPath, JSON.stringify(toRunRecord(r)));
  writeFileSync(r.sessionPath!, JSON.stringify({ type: "session", version: 3, id, cwd: root }) + "\n");
  return r;
}
function harness(statuses: Run["status"][] = []) {
  const registry = new RunRegistry(); const calls: any[] = []; const tools = new Map<string, any>();
  const queue = { enqueueOrSpawn(o: any) {
    calls.push(o); const r = run(`probe-${calls.length}`, o.cwd); r.task = o.task;
    r.status = statuses.shift() ?? "completed";
    if (r.status === "failed") r.failureClass = "environment";
    registry.register(r);
    return { kind: "spawned", run: r, done: Promise.resolve(r) };
  } };
  registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue as any,
    getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [], openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }), pushCompletionNotification: () => {},
  });
  return { registry, calls, tools, queue };
}

test("spawn tool prepares effective-cwd files before queue and retry reuses the accepted task", async () => {
  const h = harness();
  await h.tools.get("ensemble_spawn").execute("s", { persona: "inspector", task: "task", files: ["evidence.md"], cwd: other, foreground: false, chain: false });
  assert.match(h.calls[0].task, /OVERRIDE EVIDENCE/);
  writeFileSync(join(other, "evidence.md"), "CHANGED AFTER ACCEPTANCE");
  const failed = run("failed-retry"); failed.status = "failed"; failed.failureClass = "environment"; failed.retryPolicy = { maxAttempts: 3, retryableClasses: ["environment"] };
  h.calls[0].onRetry(failed);
  assert.match(h.calls[1].task, /OVERRIDE EVIDENCE/); assert.doesNotMatch(h.calls[1].task, /CHANGED AFTER/);
  assert.equal(h.calls[1].task.split("<files>").length, 2);
  assert.equal(h.calls[1].files, undefined);
  const before = h.calls.length;
  const bad = await h.tools.get("ensemble_spawn").execute("bad", { persona: "builder", task: "task", files: ["run:../bad"], foreground: false });
  assert.match(bad.content[0].text, /files/); assert.equal(h.calls.length, before);
});

test("auto validates ALL evidence before first step and feeds prepared tasks through in-loop retries", async () => {
  const h = harness();
  const bad = await h.tools.get("ensemble_auto").execute("bad", { goal: "g", max_steps: 4, steps: [{ persona: "inspector", task: "one" }, { persona: "inspector", task: "two", files: ["missing"] }] });
  assert.equal(bad.details.status, "halted"); assert.equal(h.calls.length, 0);
  const good = await h.tools.get("ensemble_auto").execute("a", { goal: "g", max_steps: 4, steps: [{ persona: "inspector", task: "one", files: ["evidence.md"] }] });
  assert.equal(good.details.status, "done"); assert.match(h.calls[0].task, /CALLER EVIDENCE/);
});

test("auto retries use the original prepared evidence without rereading or stacking blocks", async () => {
  const h = harness(["failed", "completed"]);
  const p = join(cwd, "auto-snapshot.md"); writeFileSync(p, "AUTO ACCEPTED");
  const enqueue = h.queue.enqueueOrSpawn.bind(h.queue);
  h.queue.enqueueOrSpawn = o => { const res = enqueue(o); writeFileSync(p, "AUTO CHANGED"); return res; };
  const res = await h.tools.get("ensemble_auto").execute("a", { goal: "g", max_steps: 4, retry_max_attempts: 2, steps: [{ persona: "inspector", task: "one", files: [p] }] });
  assert.equal(res.details.status, "done"); assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.match(call.task, /AUTO ACCEPTED/); assert.doesNotMatch(call.task, /AUTO CHANGED/);
    assert.equal(call.task.split("<files>").length, 2);
  }
});

test("configured chain files are prepared at chain cwd before queue or refusal registration", async () => {
  const h = harness(); const parent = run("chain-parent");
  const cfg = { ...DEFAULT_CONFIG, chains: { inspector: { then: "critic", files: ["evidence.md"] } } };
  const args = { chainEnabled: true, personaName: "inspector", cfg, queue: h.queue as any, registry: h.registry, cwd: other, pushNotification: () => {}, getParentMessages: () => [] };
  await buildOnChainCallback(args)!(parent);
  assert.match(h.calls[0].task, /CALLER EVIDENCE/);
  await buildOnChainCallback({ ...args, cfg: { ...cfg, chains: { inspector: { then: "builder", files: ["missing"] } } } })!(parent);
  assert.equal(h.calls.length, 1); assert.equal(h.registry.list().length, 1);
});

test("send tool files use conductor caller cwd, not target or saved session cwd", async () => {
  const h = harness(); const r = run("live-send", other); r.status = "running"; r.streamingMode = "rpc"; r.steerable = true;
  let delivered: any;
  r.rpcStdinQueue = new RpcStdinQueue(new Writable({ write(chunk, _encoding, cb) {
    delivered = JSON.parse(chunk.toString()); cb();
    queueMicrotask(() => { const ack = r.pendingAcks?.get(delivered.id); if (ack) { clearTimeout(ack.timer); r.pendingAcks?.delete(delivered.id); ack.resolve(true); } });
  } }));
  h.registry.register(r);
  const res = await h.tools.get("ensemble_send").execute("s", { agent_id: r.id, message: "follow up", files: ["evidence.md"], streaming_behavior: "steer" });
  assert.match(delivered.message, /CALLER EVIDENCE/); assert.doesNotMatch(delivered.message, /CHANGED AFTER/);
  const markers = r.steerCount;
  const bad = sendToRun(r, "x", { registry: h.registry, timeoutMs: 1000, files: ["missing"], callerCwd: cwd });
  assert.equal(bad.kind, "rejected"); assert.equal(r.steerCount, markers);
  assert.ok(res);
  r.rpcStdinQueue.destroy("test done");
});

test("retired send rejects before reading evidence, changing markers or restoring worktrees", () => {
  const h = harness(); const r = run("retired-send"); r.contextRetired = true;
  const before = JSON.stringify(toRunRecord(r));
  const res = sendToRun(r, "continue", { registry: h.registry, timeoutMs: 1000, files: ["missing"], callerCwd: cwd });
  assert.equal(res.kind, "rejected"); if (res.kind === "rejected") assert.match(res.reason, /retired/);
  assert.equal(JSON.stringify(toRunRecord(r)), before);
});

test("foreground and background completion expose reusable result refs; absent output does not", async () => {
  const h = harness();
  const foreground = await h.tools.get("ensemble_spawn").execute("s", { persona: "inspector", task: "task", chain: false });
  assert.match(foreground.content[0].text, /result-ref: run:probe-1/);
  assert.equal(foreground.details.result_ref, "run:probe-1");
  const r = h.registry.get("probe-1")!; r.contextRetired = true;
  const bg = buildCompletionMessage(r);
  assert.match(bg.content, /<result-ref>run:probe-1<\/result-ref>/);
  assert.ok(bg.details.notes.some(n => n.text.includes("run:probe-1")));
  writeFileSync(r.finalPath, "(no output)");
  assert.doesNotMatch(buildCompletionMessage(r).content, /<result-ref>/);
});
