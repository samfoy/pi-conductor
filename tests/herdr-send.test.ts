import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { availableActions, sendToRun, checkTurnLimit, GRACE_MESSAGE } from "../src/runs.ts";
import { readInbox, writeInboxAck } from "../src/herdr/inbox.ts";
import { herdrAgentName } from "../src/herdr/runtime.ts";

sandboxPi();
test("H8 accepted relaunch that exits without new output cannot reuse the prior final", { timeout: 5000 }, async () => {
  const h = herdrFixture(); await createRunPipeline(h.run, [], h.opts);
  const originalFinal = readFileSync(h.run.finalPath); h.setMode("accepted-no-output");
  const sent = sendToRun(h.run, "Resume", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  await sent.done; assert.equal(h.run.status, "failed");
  assert.equal(resultRef(h.run), undefined, "no current invocation output after accepted relaunch");
  assert.deepEqual(readFileSync(h.run.finalPath), originalFinal);
});

test("H8 grace cannot abandon a settling owner question", { timeout: 5000 }, async t => {
  const h = await live(t); h.run.maxTurns = h.run.usage.turns;
  h.run.pendingAsk = { askId: "q", question: "Keep the question", evidence: "" };
  checkTurnLimit(h.run, h.registry, () => assert.fail("grace must not abandon an owner ask"));
  assert.equal(readInbox(h.dir, h.run.herdr!.launchNonce).length, 1);
  assert.equal(h.run.pendingAsk.askId, "q"); h.run.pendingAsk = undefined;
});


test("H8 queued overlapping sends recheck owner ask before the second write", { timeout: 5000 }, async t => {
  const h = await live(t), first = h.send("First"), second = h.send("Second");
  assert.equal(first.kind, "started"); assert.equal(second.kind, "started");
  if (first.kind !== "started" || second.kind !== "started") return;
  h.onSleep(() => {
    const requests = readInbox(h.dir, h.run.herdr!.launchNonce); assert.equal(requests.length, 2);
    writeInboxAck(h.dir, requests[1].request);
    h.run.pendingAsk = { askId: "overlap", question: "Wait?", evidence: "" }; h.onSleep(() => {});
  });
  assert.equal((await first.ack)?.delivered, true);
  const refused = await second.ack; assert.equal(refused?.delivered, false); assert.equal(refused?.definite, true);
  assert.equal(readInbox(h.dir, h.run.herdr!.launchNonce).length, 2);
  h.run.pendingAsk = undefined;
});

test("H8 stale invocation ack never confirms current delivery", { timeout: 5000 }, async t => {
  const h = await live(t), sent = h.send(); assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  h.onSleep(() => {
    const r = readInbox(h.dir, h.run.herdr!.launchNonce)[1].request;
    writeFileSync(join(h.dir, "inbox", r.launchNonce, `${r.requestId}.ack.json`), JSON.stringify({ ...r, launchNonce: "previous-nonce", accepted: true, at: 1 }));
    h.onSleep(() => {});
  });
  const ack = await sent.ack; assert.equal(ack?.delivered, false); assert.equal(ack?.definite, false);
});

import { describeDelivery } from "../src/runtime.ts";
test("H8 delivery wording distinguishes accepted input, rejection and uncertainty", () => {
  assert.match(describeDelivery({ delivered: true, deliveredAt: 1 }), /input accepted.*not.*executed/);
  assert.match(describeDelivery({ delivered: false, deliveredAt: 0, definite: true, reason: "busy" }), /input rejected.*busy/);
  assert.match(describeDelivery({ delivered: false, deliveredAt: 0, definite: false, reason: "timeout" }), /unconfirmed.*do not resend blindly/);
});

import { resultRef } from "../src/file-evidence.ts";
import { forceTerminate } from "../src/runs.ts";

for (const mode of ["no-start", "no-ack", "busy-ack", "stale-ack", "preaccept-death"]) test(`H8 failed owner relaunch ${mode} preserves the original durable question`, { timeout: 5000 }, async () => {
  const h = herdrFixture("ask"); h.onSleep(h.exit);
  await createRunPipeline(h.run, [], h.opts); h.onSleep(() => {});
  const ask = { ...h.run.pendingAsk! }, original = { task: h.run.task, cwd: h.run.cwd, sessionPath: h.run.sessionPath };
  h.setMode(mode);
  const sent = sendToRun(h.run, "Owner choice", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  assert.deepEqual(h.run.pendingAsk, ask, "launch is not answer acceptance");
  await sent.done;
  assert.equal(h.run.status, "blocked", h.run.errorMessage);
  assert.deepEqual(h.run.pendingAsk, ask);
  assert.deepEqual({ task: h.run.task, cwd: h.run.cwd, sessionPath: h.run.sessionPath }, original);
  assert.deepEqual(JSON.parse(readFileSync(h.run.recordPath, "utf8")).pendingAsk, ask);
  assert.equal(resultRef(h.run), undefined);
});

test("H8 failed ordinary relaunch does not advertise the previous final", { timeout: 5000 }, async () => {
  const h = herdrFixture(); await createRunPipeline(h.run, [], h.opts);
  const oldFinal = readFileSync(h.run.finalPath, "utf8"); assert.ok(resultRef(h.run));
  h.setMode("no-start");
  const sent = sendToRun(h.run, "Resume", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  await sent.done;
  assert.equal(h.run.status, "failed");
  assert.equal(readFileSync(h.run.finalPath, "utf8"), oldFinal);
  assert.equal(resultRef(h.run), undefined, "prior final is historical, not the failed invocation's result");
});

test("H8 unknown prior child exit refuses relaunch before lifecycle effects", { timeout: 5000 }, async () => {
  const h = herdrFixture("stubborn"); await createRunPipeline(h.run, [], h.opts);
  const calls = h.calls.length, record = readFileSync(h.run.recordPath);
  const sent = sendToRun(h.run, "Do not duplicate", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "rejected"); assert.equal(h.calls.length, calls); assert.deepEqual(readFileSync(h.run.recordPath), record);
});

for (const kill of [false, true]) test(`H8 pending reply cancellation preserves ask unless user kill wins (${kill})`, { timeout: 5000 }, async () => {
  const h = herdrFixture("ask"); h.onSleep(h.exit); await createRunPipeline(h.run, [], h.opts);
  const ask = { ...h.run.pendingAsk! }; h.setMode("no-start");
  const sent = sendToRun(h.run, "Answer", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  h.onSleep(() => { h.onSleep(() => {}); forceTerminate(h.run, kill ? "killed" : "timeout", h.registry); });
  await sent.done;
  assert.equal(h.run.status, kill ? "killed" : "blocked");
  assert.deepEqual(h.run.pendingAsk, kill ? undefined : ask);
});

async function live(t: import("node:test").TestContext) {
  const h = herdrFixture("running");
  const done = createRunPipeline(h.run, [], { ...h.opts, timeoutMs: 60000 });
  assert.equal(h.run.transport?.kind, "herdr");
  if (h.run.transport?.kind !== "herdr") throw new Error("missing transport");
  await h.run.transport.ready;
  t.after(async () => { h.exit(); h.emit({ type: "agent_settled" }); h.run.transport?.drain(); await done; });
  return { ...h, done, dir: dirname(h.run.recordPath), send: (text = "Prepared evidence 漢🙂") => sendToRun(h.run, text, { registry: h.registry, timeoutMs: 60000 }) };
}

test("H8 attached herdr advertises live inbox controls, never RPC or pause", { timeout: 5000 }, async t => {
  const h = await live(t);
  assert.deepEqual(availableActions(h.run), ["steer", "follow_up", "kill"]);
  assert.equal(h.run.streamingMode, undefined);
  assert.equal(h.run.rpcStdinQueue, undefined);
  const result = h.send(); assert.equal(result.kind, "started");
  if (result.kind !== "started") return;
  h.onSleep(() => {
    const entry = readInbox(h.dir, h.run.herdr!.launchNonce).find(e => e.request.sequence === 2);
    assert.ok(entry); assert.equal(entry.request.kind, "follow_up"); assert.equal(entry.request.text, "Prepared evidence 漢🙂");
    writeInboxAck(h.dir, entry.request); h.onSleep(() => {});
  });
  assert.equal((await result.ack)?.delivered, true);
  assert.equal(h.run.steerCount, 1);
});

for (const guard of ["ask", "execution", "foreign", "unknown", "nonce"] as const) test(`H8 ${guard} rejects before inbox mutation`, { timeout: 5000 }, async t => {
  const h = await live(t), original = h.run.herdr!;
  const before = readInbox(h.dir, original.launchNonce).length;
  if (guard === "ask") h.run.pendingAsk = { askId: "q", question: "Choose?", evidence: "" };
  if (guard === "execution") h.run.askExecution = { askId: "q", question: "Choose?" };
  if (guard === "foreign") h.run.parentPid = process.pid + 1;
  if (guard === "unknown") h.unknown();
  if (guard === "nonce") h.run.herdr = { ...original, launchNonce: "other" };
  assert.equal(h.send().kind, "rejected");
  assert.equal(readInbox(h.dir, original.launchNonce).length, before);
  h.run.herdr = original; h.run.pendingAsk = undefined; h.run.askExecution = undefined; h.run.parentPid = undefined;
});

test("H8 controls re-drain ask evidence after the advisory snapshot and before write", { timeout: 5000 }, async t => {
  const h = await live(t);
  assert.ok(availableActions(h.run).includes("steer"));
  h.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "q", name: "ask_owner", arguments: { question: "Choose?" } }], stopReason: "toolUse" } });
  h.emit({ type: "tool_execution_start", toolName: "ask_owner", toolCallId: "q", args: { question: "Choose?" } });
  assert.equal(h.send().kind, "rejected");
  assert.equal(readInbox(h.dir, h.run.herdr!.launchNonce).length, 1);
  h.run.askExecution = undefined;
});

for (const code of ["busy", "stale-ask"] as const) test(`H8 ${code} ack is definite rejection, not execution`, { timeout: 5000 }, async t => {
  const h = await live(t), result = h.send(); assert.equal(result.kind, "started");
  if (result.kind !== "started") return;
  h.onSleep(() => { const r = readInbox(h.dir, h.run.herdr!.launchNonce)[1]?.request; assert.ok(r); writeInboxAck(h.dir, r, code); h.onSleep(() => {}); });
  assert.deepEqual(await result.ack, { delivered: false, deliveredAt: 0, definite: true, reason: code });
});

test("H8 timeout is unconfirmed without a duplicate request or blind retry", { timeout: 5000 }, async t => {
  const h = await live(t), result = h.send(); assert.equal(result.kind, "started");
  if (result.kind !== "started") return;
  assert.deepEqual(await result.ack, { delivered: false, deliveredAt: 0, definite: false, reason: "ack timeout; do not resend blindly" });
  assert.equal(readInbox(h.dir, h.run.herdr!.launchNonce).length, 2);
});

test("H8 grace uses nonce inbox steer kind without opting in to RPC", { timeout: 5000 }, async t => {
  const h = await live(t); h.run.maxTurns = h.run.usage.turns;
  h.onSleep(() => { const r = readInbox(h.dir, h.run.herdr!.launchNonce)[1]?.request; assert.ok(r); assert.equal(r.kind, "grace"); assert.equal(r.text, GRACE_MESSAGE); writeInboxAck(h.dir, r); h.onSleep(() => {}); });
  checkTurnLimit(h.run, h.registry, () => assert.fail("live herdr gets grace"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.run.gracePeriodActive, true);
});

test("H8 saved-session send relaunches exact session with a fresh nonce", { timeout: 5000 }, async () => {
  const h = herdrFixture(); await createRunPipeline(h.run, [], h.opts);
  const previous = { ...h.run.herdr! }, session = h.run.sessionPath;
  const sent = sendToRun(h.run, "Resume evidence", { registry: h.registry, timeoutMs: 4000, maxTurns: 99, graceTurns: 4 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  await sent.done;
  assert.equal(h.run.status, "completed", h.run.errorMessage);
  assert.notEqual(h.run.herdr!.launchNonce, previous.launchNonce);
  assert.equal(h.run.herdr!.paneId, previous.paneId); assert.equal(h.run.sessionPath, session);
  assert.equal(h.run.resumeCount, 1); assert.equal(h.run.usage.turns, 2);
  assert.equal(h.run.maxTurns, 99); assert.equal(h.run.graceTurns, 4);
  assert.equal(h.calls.filter(c => c === "tab create").length, 1);
  assert.match(readFileSync(h.run.finalPath, "utf8"), /verified evidence/);
});

// Window: herdr registered the idle child (agent start returned, hello written) but the
// prepared reply is not yet published. Triggered in the first pane get after registration.
for (const variant of ["died", "timeout", "killed"] as const) test(`H11 reply relaunch ${variant} before publication keeps the reply unpublished, one start, correct ask outcome`, { timeout: 8000 }, async () => {
  const h = herdrFixture("ask"); h.onSleep(h.exit);
  await createRunPipeline(h.run, [], h.opts); h.onSleep(() => {});
  assert.equal(h.run.status, "blocked");
  const ask = { ...h.run.pendingAsk! }, firstNonce = h.run.herdr!.launchNonce, dir = dirname(h.run.recordPath);
  const json = h.cli.json; let starts = 0, fired = false;
  h.cli.json = async (args, limits) => {
    const result = await json(args, limits);
    if (args[0] === "agent" && args[1] === "start") starts++;
    else if (args[1] === "get" && starts === 1 && !fired && existsSync(join(dir, "launch", `${h.run.herdr!.launchNonce}.json`))) {
      fired = true;
      if (variant === "died") h.exit(); else forceTerminate(h.run, variant, h.registry);
    }
    return result;
  };
  const signalsBefore = h.signals.length;
  const sent = sendToRun(h.run, "Owner choice", { registry: h.registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  await sent.done;
  const nonce = h.run.herdr!.launchNonce, inbox = join(dir, "inbox", nonce);
  assert.equal(fired, true, "triggered inside the registration -> publication window");
  assert.notEqual(nonce, firstNonce); assert.equal(h.run.herdr!.agentName, herdrAgentName(h.run.id, nonce));
  assert.equal(starts, 1, "exactly one agent start; no blind retry");
  assert.equal(readInbox(dir, nonce).length, 0, "the task never became visible to the child pump");
  const prepared = readdirSync(inbox).filter(f => f.endsWith(".prepared.json")).map(f => JSON.parse(readFileSync(join(inbox, f), "utf8")));
  assert.equal(prepared.length, 1, "prepared reply retained durably");
  assert.equal(prepared[0].kind, "reply"); assert.equal(prepared[0].askId, ask.askId);
  assert.deepEqual(readdirSync(inbox).filter(f => f.endsWith(".ack.json")), [], "no ack for an unpublished task");
  if (variant === "killed") {
    assert.equal(h.run.status, "killed"); assert.equal(h.run.pendingAsk, undefined, "user kill wins");
  } else {
    assert.equal(h.run.status, "blocked", h.run.errorMessage);
    assert.deepEqual(h.run.pendingAsk, ask, "the owner question survives");
    assert.deepEqual(JSON.parse(readFileSync(h.run.recordPath, "utf8")).pendingAsk, ask);
  }
  assert.deepEqual(h.signals.slice(signalsBefore), variant === "died" ? [] : ["SIGTERM"], "only a proven live child is signalled");
});
