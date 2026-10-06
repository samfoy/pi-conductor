/**
 * S4 `chief message/ask` and ask correlation without a native Pi. A lead may
 * write to the live chief of its exact socket only (never itself), before any
 * write. `ask` passes the A6 sole-call check with nothing queued, is staged
 * until its tool result is on the branch, and the branch alone decides the
 * outstanding ask (newest wins). Lead→chief kinds wake only the current exact
 * holder; chief→lead kinds wake only while their claim is the live holder; a
 * stale ordinary message is a non-waking "former chief" card. A `chief_reply`
 * that is stale, from another socket or not this branch's outstanding ask is
 * quarantined, never delivered, and never clears the ask; a reply whose
 * dispatch is unconfirmed or uncertain never counts as an answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { makeFakeClock } from "./helpers/fake-clock.ts";
import { s4Lead, type S4Lead } from "./helpers/supervision-s4.ts";
import { isSoleToolCall } from "../src/ask-owner.ts";
import { branchAsk, ASK_QUESTION_MAX, LeadAsks } from "../src/supervision/ask.ts";
import { admitCoordination, buildCoordination, inboxDir, INBOX_RETENTION_MS, recordBase } from "../src/supervision/inbox.ts";
import { claimChiefLease, readChiefLease, releaseChiefLease } from "../src/supervision/lease.ts";
import { leadPath, readLeadRecord, supervisionRoot } from "../src/supervision/store.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";

sandboxPi();
const fixtures = tmpDir("s4-ask-");
const SOCKET = join(fixtures, "fake.sock"), OTHER = `${SOCKET}2`;
const START = readProcessStartTime(process.pid);
const reset = () => rmSync(supervisionRoot(), { recursive: true, force: true });
const suffixes = (id: string) => existsSync(inboxDir(id)) ? readdirSync(inboxDir(id)).map(n => n.replace(/^\d{13}-[0-9a-f-]{36}/, "")).sort() : [];
const queuedRecords = (id: string) => existsSync(inboxDir(id)) ? readdirSync(inboxDir(id)).filter(n => /^\d{13}-[0-9a-f-]{36}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(inboxDir(id), n), "utf8"))) : [];
const cards = (l: S4Lead) => l.sent.filter(s => s.message.details.notice === undefined);
/** Reply cards in the lead's session file (not its in-memory branch). */
const persistedReplies = (l: S4Lead) => existsSync(l.sessionFile) ? readFileSync(l.sessionFile, "utf8").trim().split("\n").slice(1).map(x => JSON.parse(x))
  .filter(e => e.type === "custom_message" && e.details?.kind === "chief_reply" && e.details.notice === undefined) : [];
const memoryReplies = (l: S4Lead) => l.branch.filter(e => e.type === "custom_message" && e.details?.kind === "chief_reply" && e.details.notice === undefined);

function pair(o: { clock?: ReturnType<typeof makeFakeClock> } = {}) {
  reset();
  const clock = o.clock ?? makeFakeClock(Date.now());
  const a = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "chief" }), b = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "lead" });
  a.start(); b.start();
  a.chief.become();
  return { a, b, clock, stop: () => { a.stop(); b.stop(); } };
}
/** b asks, a drains: the ask is on b's branch and a's presence of b shows it. */
async function asked(a: S4Lead, b: S4Lead, question = "Which base branch?") {
  const { id, result } = await b.chiefCall({ action: "ask", question });
  // The ask turn ends (agent_settled): an idle drain settles the staged ask; the mirror republishes.
  b.state.idle = true; b.delivery.drain(); b.presence.touch();
  return { id, result };
}

// ── A6 sole-call extraction ─────────────────────────────────────────

test("S4 isSoleToolCall (the A6 check, extracted): exactly one call, by name and id, in the latest assistant message", () => {
  const msg = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });
  const call = (name: string, id: string) => ({ type: "toolCall", name, id });
  assert.equal(isSoleToolCall([msg([call("chief", "x")])], "chief", "x"), true);
  assert.equal(isSoleToolCall([msg([{ type: "text", text: "thinking" }, call("chief", "x")])], "chief", "x"), true, "text parts are not calls");
  assert.equal(isSoleToolCall([msg([call("chief", "x"), call("read", "y")])], "chief", "x"), false, "batch");
  assert.equal(isSoleToolCall([msg([call("ask_owner", "x")])], "chief", "x"), false, "name");
  assert.equal(isSoleToolCall([msg([call("chief", "z")])], "chief", "x"), false, "id");
  assert.equal(isSoleToolCall([msg([call("chief", "x")]), msg([call("chief", "y")])], "chief", "x"), false, "only the latest assistant message counts");
  assert.equal(isSoleToolCall([], "chief", "x"), false);
  assert.equal(isSoleToolCall([msg("not an array")], "chief", "x"), false);
});

// ── chief: preconditions before any write ───────────────────────────

test("S4 chief ask: refused before any write without a live chief on this exact socket, for itself, as a batch, with queued messages, past 1024 chars or bytes, or with bad files", async () => {
  reset();
  const clock = makeFakeClock(Date.now());
  const b = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "lead" });
  b.start();
  assert.ok(b.active().includes("chief") && !b.active().includes("staff"), "a non-holder lead has chief, not staff");
  await assert.rejects(b.chiefCall({ action: "ask", question: "q?" }), /no live chief holds this herdr socket's lease/);
  // Another socket's chief (a prefix-extended socket string) is not this socket's.
  const other = s4Lead({ dir: fixtures, socket: OTHER, clock, label: "other" });
  other.start(); other.chief.become();
  await assert.rejects(b.chiefCall({ action: "message", message: "hi" }), /no live chief/);
  // Unknown liveness is no chief: a claim whose start time cannot be proven.
  const unknown = claimChiefLease(SOCKET, { sessionId: "unproven", sessionFile: "/s/u.jsonl", pid: process.pid, epoch: randomUUID() });
  await assert.rejects(b.chiefCall({ action: "message", message: "hi" }), /no live chief/, "unknown never permits an action");
  releaseChiefLease(unknown);
  const a = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "chief" });
  a.start(); a.chief.become();
  assert.ok(!a.active().includes("chief") && a.active().includes("staff"), "the holder has staff, not chief");
  await assert.rejects(a.chiefCall({ action: "ask", question: "me?" }), /this lead is the chief/, "never the chief itself");
  await assert.rejects(b.chiefCall({ action: "ask", question: "q?" }, { siblings: [{ type: "toolCall", id: "r", name: "read" }] }), /alone as the only tool call/);
  b.state.pending = true;
  await assert.rejects(b.chiefCall({ action: "ask", question: "q?" }), /queued messages/);
  b.state.pending = false;
  await assert.rejects(b.chiefCall({ action: "ask", question: "   " }), /needs `question`/);
  await assert.rejects(b.chiefCall({ action: "ask", question: "x".repeat(ASK_QUESTION_MAX + 1) }), /exceeds 1024 characters or UTF-8 bytes/);
  await assert.rejects(b.chiefCall({ action: "ask", question: "é".repeat(513) }), /exceeds 1024/, "513 characters but 1026 bytes");
  await assert.rejects(b.chiefCall({ action: "ask", question: "q?", files: ["missing.txt"] }), /files: missing\.txt/);
  await assert.rejects(b.chiefCall({ action: "message", message: "" }), /needs `message`/);
  assert.deepEqual(suffixes(a.sessionId), [], "no refusal wrote to the chief's inbox");
  assert.equal(b.asks.staged(), undefined, "no refusal staged an ask");
  assert.equal(b.asks.pending(), undefined, "an error result is never an outstanding ask");
  // Exactly 1024 bytes passes; the record names the exact holder, socket and claim.
  const ok = await b.chiefCall({ action: "ask", question: "é".repeat(512) });
  assert.equal(ok.result.terminate, true, "sole and final");
  assert.deepEqual(ok.result.details, { status: "queued", action: "ask", id: ok.result.details.id, chief: a.sessionId, leaseGeneration: readChiefLease(SOCKET).holder!.generation, askId: ok.id, question: "é".repeat(512), askedAt: ok.result.details.askedAt });
  const [record] = queuedRecords(a.sessionId);
  assert.deepEqual({ kind: record.kind, from: record.from, to: record.to, socketPath: record.socketPath, askId: record.askId }, { kind: "lead_ask", from: b.sessionId, to: a.sessionId, socketPath: SOCKET, askId: ok.id });
  assert.deepEqual(record.lease, readChiefLease(SOCKET).holder, "the full claim it judged current");
  for (const l of [a, b, other]) l.stop();
});

test("S4 chief ask: the fence re-proves the exact claim at publication; a lease change after the first check writes nothing and unstages", async () => {
  reset();
  const clock = makeFakeClock(Date.now());
  let sabotage = () => {};
  const liveness = { platform: "linux", probe: (pid: number) => { sabotage(); return { state: "alive" as const, startTime: pid === process.pid ? START : undefined }; } };
  const a = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "chief" }), b = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "lead", liveness });
  a.start(); b.start(); a.chief.become();
  let probes = 0;
  // The first probe passes; at the fence's probe the chief has left and reclaimed (same session and epoch, generation 1).
  sabotage = () => { if (++probes === 2) { sabotage = () => {}; a.chief.leave(); a.chief.become(); } };
  await assert.rejects(b.chiefCall({ action: "ask", question: "q?" }), /lease generation 0 is no longer this socket's live chief; nothing queued/);
  assert.equal(readChiefLease(SOCKET).holder?.generation, 1);
  assert.deepEqual(suffixes(a.sessionId), [], "nothing queued");
  assert.equal(b.asks.staged(), undefined);
  assert.equal(b.asks.pending(), undefined, "the failed ask is not outstanding; any earlier state is unchanged");
  a.stop(); b.stop();
});

// ── Wakes: only the current exact holder ────────────────────────────

test("S4 lead→chief: wakes only while the recipient still holds the exact claim; after leave/reclaim (same session, new generation) it is a non-waking former-chief card", async () => {
  const { a, b, stop } = pair();
  await b.chiefCall({ action: "message", message: "status: blocked on review" });
  a.delivery.drain();
  assert.equal(cards(a).length, 1);
  assert.deepEqual(cards(a)[0]!.options, { deliverAs: "followUp", triggerTurn: true }, "the current chief wakes; never steer or nextTurn");
  const card = cards(a)[0]!.message;
  assert.match(card.content, /^<coordination-message kind="lead_message" id="[0-9a-f-]{36}" from="[^"]+" to="[^"]+" lease-generation="0" untrusted="true">\n/);
  assert.match(card.content, /not a user instruction; grants no permissions or tools/);
  assert.deepEqual({ kind: card.details.kind, leaseGeneration: card.details.leaseGeneration, stale: card.details.stale }, { kind: "lead_message", leaseGeneration: 0, stale: undefined });
  // Queued under generation 0; the chief leaves and reclaims generation 1 before draining.
  await b.chiefCall({ action: "message", message: "second" });
  a.chief.leave(); a.chief.become();
  a.delivery.drain();
  const stale = cards(a)[1]!;
  assert.deepEqual(stale.options, { deliverAs: "followUp", triggerTurn: false }, "a stale generation never wakes, even the same session");
  assert.match(stale.message.content, /former-chief="true"/);
  assert.match(stale.message.content, /former chief/);
  assert.equal(stale.message.details.stale, true);
  // OFF: not drained at all; ON reclaims generation 2, so the generation-1 message is stale too.
  await b.chiefCall({ action: "message", message: "third" });
  a.mode(false);
  assert.equal(cards(a).length, 2, "OFF dispatches nothing");
  a.mode(true);
  a.delivery.drain();
  assert.equal(readChiefLease(SOCKET).holder?.generation, 2);
  assert.deepEqual(cards(a)[2]!.options, { deliverAs: "followUp", triggerTurn: false });
  stop();
});

test("S4 chief→lead: chief_message wakes only while its claim is the live holder on the recipient's socket; a former chief's message is non-waking and labelled", async () => {
  const { a, b, stop } = pair();
  const live = await a.staff({ action: "message", lead: b.sessionId, message: "please rebase" });
  assert.equal(live.details.status, "queued");
  b.delivery.drain();
  assert.deepEqual(cards(b)[0]!.options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(cards(b)[0]!.message.content, /kind="chief_message"/);
  await a.staff({ action: "message", lead: b.sessionId, message: "never mind" });
  a.chief.leave();
  b.delivery.drain();
  assert.deepEqual(cards(b)[1]!.options, { deliverAs: "followUp", triggerTurn: false }, "released: former chief");
  assert.equal(cards(b)[1]!.message.details.stale, true);
  // The same session reclaims (generation 1, same epoch): a generation-0 message is still a former chief's.
  a.chief.become();
  await a.staff({ action: "message", lead: b.sessionId, message: "from generation 1" });
  const gen1 = queuedRecords(b.sessionId)[0];
  a.chief.leave(); a.chief.become();
  b.delivery.drain();
  assert.equal(readChiefLease(SOCKET).holder?.generation, 2);
  assert.deepEqual([cards(b)[2]!.message.details.coordinationId, cards(b)[2]!.options.triggerTurn, cards(b)[2]!.message.details.stale], [gen1.id, false, true], "a stale generation of the same session never wakes");
  // Peer stays non-waking whatever the lease says.
  await a.peer({ action: "message", lead: b.sessionId, message: "fyi" });
  b.delivery.drain();
  assert.deepEqual(cards(b)[3]!.options, { deliverAs: "followUp", triggerTurn: false });
  assert.equal(cards(b)[3]!.message.details.kind, "peer");
  stop();
});

// ── Reply correlation: the branch decides ───────────────────────────

test("S4 reply: accepted only against this branch's outstanding ask; the accepted reply wakes the lead and, once its receipt retires the dispatch, clears the ask", async () => {
  const { a, b, stop } = pair();
  const { id } = await asked(a, b);
  assert.deepEqual(b.asks.pending(), { askId: id, question: "Which base branch?", askedAt: b.asks.pending()!.askedAt, chief: a.sessionId, leaseGeneration: 0 });
  assert.deepEqual(readLeadRecord(leadPath(b.sessionId))!.pendingAsk, { askId: id, question: "Which base branch?", askedAt: b.asks.pending()!.askedAt }, "presence mirrors the branch");
  const listed = await a.staff({ action: "list" });
  assert.deepEqual(listed.details.leads[0].pending_ask?.askId, id);
  assert.deepEqual(listed.details.leads[0].available_actions, ["staff transcript", "staff message", "staff reply"]);
  await assert.rejects(a.staff({ action: "reply", lead: b.sessionId, ask_id: "some-other-ask", message: "x" }), /shows no pending ask "some-other-ask" \(its pending ask is/);
  await assert.rejects(a.staff({ action: "reply", lead: b.sessionId, message: "x" }), /needs `ask_id`/);
  assert.deepEqual(suffixes(b.sessionId), [], "a refused reply writes nothing");
  const q = await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "main" });
  assert.match(q.content[0].text, /Queued is not delivered or accepted: the lead's current branch decides/);
  assert.ok(b.asks.pending(), "queued (not yet delivered) does not answer the ask");
  b.delivery.drain();
  assert.deepEqual(cards(b).map(s => [s.message.details.kind, s.options.triggerTurn]), [["chief_reply", true]]);
  assert.match(cards(b)[0]!.message.content, new RegExp(`kind="chief_reply"[^>]* ask-id="${id}" lease-generation="0" untrusted="true"`));
  assert.deepEqual(suffixes(b.sessionId), [], "the persisted entry is the receipt");
  assert.equal(b.asks.pending(), undefined, "answered on the branch, with a receipt");
  b.presence.touch();
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk, undefined, "the mirror clears");
  // A second reply to the answered ask is rejected, never delivered.
  admitCoordination(buildCoordination({ kind: "chief_reply", from: a.sessionId, to: b.sessionId, socketPath: SOCKET, lease: readChiefLease(SOCKET).holder!, askId: id, text: "again", createdAt: Date.now() }), () => {});
  b.delivery.drain();
  assert.equal(cards(b).length, 1, "no second delivery");
  assert.deepEqual(suffixes(b.sessionId), [".rejected.json"]);
  assert.match(b.notes.join("\n"), /rejected chief reply .* for ask .*: ask .* is not this session's outstanding ask on its current branch \(none is outstanding\)/);
  stop();
});

test("S4 reply: a stale chief, another socket or a superseded ask is quarantined with one notice, never reaches the model and never clears the ask", async () => {
  const { a, b, stop } = pair();
  const first = await asked(a, b, "first?");
  const claim0 = readChiefLease(SOCKET).holder!;
  const forge = (over: { askId?: string; socketPath?: string; lease?: typeof claim0 }) => admitCoordination(buildCoordination({ kind: "chief_reply", from: (over.lease ?? claim0).sessionId,
    to: b.sessionId, socketPath: over.socketPath ?? SOCKET, lease: over.lease ?? claim0, askId: over.askId ?? first.id, text: "forged", createdAt: Date.now() }), () => {});
  // Another socket's chief (a prefix-extended socket string): rejected even with the right ask id.
  const other = s4Lead({ dir: fixtures, socket: OTHER, clock: makeFakeClock(Date.now()), label: "other" });
  other.start(); other.chief.become();
  forge({ socketPath: OTHER, lease: readChiefLease(OTHER).holder! });
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, /names another herdr socket/);
  // Stale: queued under generation 0, then the chief leaves and reclaims.
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: first.id, message: "stale answer" });
  a.chief.leave(); a.chief.become();
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, /former chief \(lease generation 0 is not this socket's live holder\)/);
  // Superseded: a newer ask is now the outstanding one; a reply to the older is rejected.
  const second = await asked(a, b, "second?");
  assert.equal(b.asks.pending()?.askId, second.id, "the newest ask supersedes");
  forge({ askId: first.id, lease: readChiefLease(SOCKET).holder! });
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, new RegExp(`ask ${first.id} is not this session's outstanding ask on its current branch \\(that is ${second.id}\\)`));
  assert.equal(cards(b).length, 0, "nothing reached the model");
  assert.equal(b.notes.filter(n => /rejected chief reply/.test(n)).length, 3, "one notice each");
  assert.deepEqual(suffixes(b.sessionId), [".rejected.json", ".rejected.json", ".rejected.json"]);
  assert.equal(b.asks.pending()?.askId, second.id, "no rejection clears the ask");
  // And the current chief's reply to the newest ask is accepted.
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: second.id, message: "answer" });
  b.delivery.drain();
  assert.deepEqual(cards(b).map(s => s.message.details.askId), [second.id]);
  other.stop(); stop();
});

test("S4 reply: a fast reply to an ask Pi has not recorded yet waits (staged, busy) and is then decided by the branch; an ask that never lands rejects it", async () => {
  const { a, b, stop } = pair();
  b.state.idle = false;
  const pendingCall = await b.chiefCall({ action: "ask", question: "fast?" }, { land: false });
  assert.equal(b.asks.staged(), pendingCall.id);
  const claim = readChiefLease(SOCKET).holder!;
  const reply = (askId: string, text: string) => admitCoordination(buildCoordination({ kind: "chief_reply", from: a.sessionId, to: b.sessionId, socketPath: SOCKET, lease: claim, askId, text, createdAt: Date.now() }), () => {});
  reply(pendingCall.id, "fast answer");
  b.delivery.drain();
  assert.equal(cards(b).length, 0, "frozen while the ask is staged and the session busy");
  assert.deepEqual(suffixes(b.sessionId), [".json", ".slot"], "left queued, neither delivered nor rejected");
  pendingCall.land();
  b.state.idle = true;
  b.delivery.drain();
  assert.deepEqual(cards(b).map(s => s.message.details.askId), [pendingCall.id], "accepted once the branch has the ask");
  assert.equal(b.asks.staged(), undefined);
  // An ask whose result never reaches the branch (aborted turn): once idle, the reply is rejected.
  b.state.idle = false;
  const lost = await b.chiefCall({ action: "ask", question: "lost?" }, { land: false });
  reply(lost.id, "too late");
  b.delivery.drain();
  assert.equal(cards(b).length, 1);
  b.state.idle = true;
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, new RegExp(`ask ${lost.id} is not this session's outstanding ask`));
  stop();
});

test("S4 reply: an in-flight (.sending) or uncertain reply is no answer; a second reply waits for the first to settle, and a failed write never clears the ask", async () => {
  const { a, b, stop } = pair();
  const { id } = await asked(a, b);
  b.state.persist = false; b.state.idle = false; // Pi holds it in memory; the file never gets it
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "first" });
  b.delivery.drain();
  assert.equal(cards(b).length, 1);
  assert.deepEqual(suffixes(b.sessionId), [".sending.json"]);
  assert.ok(b.branch.some(e => e.details?.kind === "chief_reply"), "the in-memory branch holds the card ...");
  assert.equal(b.asks.pending()?.askId, id, "... but an unconfirmed dispatch is no answer");
  b.presence.touch();
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk?.askId, id, "the mirror still shows it");
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "second" });
  b.delivery.drain();
  assert.equal(cards(b).length, 1, "a second reply to an ask with one in flight waits");
  b.state.idle = true; b.state.persist = true;
  b.delivery.drain(); // dispatched while busy (not held): its run ended without the first card reaching the file // the first settles uncertain; only then is the second decided, against the branch
  assert.match(b.notes.join("\n"), /chief reply .* may or may not have been delivered; not replayed/);
  assert.deepEqual(cards(b).map(s => s.message.details.askId), [id, id], "the second is accepted only after the first settled uncertain");
  assert.deepEqual(persistedReplies(b).map(e => e.content.includes("second")), [true], "only the second card is in the file: the first never answered");
  assert.deepEqual(suffixes(b.sessionId), [".uncertain.json"], "the second's persisted entry retired it");
  assert.equal(b.asks.pending(), undefined, "answered only by the confirmed second reply");
  stop();
});

test("S4 rewind and restart: the current branch, as restored, decides acceptance (accepted vs unaccepted matrix)", async () => {
  const { a, b, stop } = pair();
  const claim = () => readChiefLease(SOCKET).holder!;
  const reply = (askId: string) => admitCoordination(buildCoordination({ kind: "chief_reply", from: a.sessionId, to: b.sessionId, socketPath: SOCKET, lease: claim(), askId, text: `re ${askId}`, createdAt: Date.now() }), () => {});
  // Rewind to before the ask: no outstanding ask, so the reply is rejected and the mirror clears.
  const mark = b.branch.length;
  const { id } = await asked(a, b, "rewound?");
  b.branch.length = mark;
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk?.askId, id, "the mirror has not caught up with the rewind yet ...");
  reply(id);
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, /none is outstanding/, "... but the branch, not the mirror, decides");
  assert.equal(cards(b).length, 0);
  b.presence.touch();
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk, undefined, "then the mirror follows");
  // Restart from the persisted file: the persisted ask is outstanding again, so a reply is accepted.
  const restored = (l: S4Lead) => readFileSync(l.sessionFile, "utf8").trim().split("\n").slice(1).map(x => JSON.parse(x));
  const asked2 = await asked(a, b, "persisted?");
  b.stop();
  b.branch.splice(0, b.branch.length, ...restored(b));
  b.start();
  assert.equal(b.asks.pending()?.askId, asked2.id, "after restart the persisted ask is outstanding");
  reply(asked2.id);
  b.delivery.drain();
  assert.deepEqual(cards(b).map(s => s.message.details.askId), [asked2.id]);
  // Restart again: the persisted reply answers it, so another reply is rejected.
  b.stop();
  b.branch.splice(0, b.branch.length, ...restored(b));
  b.start();
  assert.equal(b.asks.pending(), undefined, "a persisted reply card with no pending dispatch answers the ask");
  reply(asked2.id);
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, /none is outstanding/);
  // An ask whose result never reached the file (crash before Pi flushed it): rejected after restart.
  b.state.persist = false;
  const unflushed = await asked(a, b, "unflushed?");
  b.state.persist = true;
  b.stop();
  b.branch.splice(0, b.branch.length, ...restored(b));
  b.start();
  reply(unflushed.id);
  b.delivery.drain();
  assert.equal(cards(b).filter(s => s.message.details.askId === unflushed.id).length, 0);
  stop();
});

test("S4 branchAsk: only a successful chief ask tool result whose details name its own call can be outstanding; notices and foreign entries grant nothing", () => {
  const ask = (id: string, over: Record<string, unknown> = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "chief", isError: false,
    details: { action: "ask", askId: id, question: "q?", askedAt: 1, chief: "c", leaseGeneration: 0, ...over }, ...(over.isError ? { isError: true } : {}) } });
  const reply = (askId: string, notice?: string) => ({ type: "custom_message", customType: "conductor-coordination", details: { kind: "chief_reply", askId, coordinationId: randomUUID(), createdAt: 1, to: "me", ...(notice ? { notice } : {}) } });
  assert.equal(branchAsk([ask("a")])?.askId, "a");
  assert.equal(branchAsk([ask("a"), ask("b")])?.askId, "b", "newest wins");
  assert.equal(branchAsk([ask("a"), ask("b", { isError: true })])?.askId, "a", "a failed ask supersedes nothing");
  assert.equal(branchAsk([ask("a"), reply("a")]), undefined);
  assert.equal(branchAsk([ask("a"), reply("a", "uncertain")])?.askId, "a", "an uncertainty notice is no answer");
  assert.equal(branchAsk([ask("a"), reply("a")], () => true)?.askId, "a", "an unconfirmed reply is no answer");
  assert.equal(branchAsk([ask("a"), ask("b"), reply("a")])?.askId, "b", "an answer to a superseded ask does not clear the newest");
  assert.equal(branchAsk([ask("a", { askId: "other" })]), undefined, "details must name the tool call itself");
  assert.equal(branchAsk([{ ...ask("a"), message: { ...ask("a").message, toolName: "ask_owner" } }]), undefined);
  assert.equal(branchAsk([ask("a", { question: "x".repeat(1025) })]), undefined, "out-of-bounds questions are not asks");
  assert.equal(branchAsk([{ type: "custom", customType: "conductor-role", data: { askId: "a" } }, { type: "custom_message", customType: "conductor-coordination", details: { kind: "lead_ask", askId: "a" } }]), undefined, "no record or card can create an ask");
});

test("S4 woken dispatch: a card Pi deferred stays pending until its OWN message_start; other cards, notices, user prompts and foreign types release nothing", async () => {
  const { a, b, stop } = pair();
  await b.chiefCall({ action: "message", message: "wake up" });
  a.state.persist = false; // as during agent_settled: Pi defers the woken prompt, so nothing is appended yet and the session looks idle
  a.delivery.drain();
  a.delivery.drain();
  assert.deepEqual(suffixes(a.sessionId), [".sending.json"], "idle, no receipt, but held: still pending");
  assert.equal(a.delivery.status().heldWakes, 1, "the doctor sees it");
  const [card] = cards(a).map(s => s.message);
  for (const other of [{ role: "user", content: "a user prompt" }, { role: "custom", customType: "other-extension", details: card.details },
    { role: "custom", ...card, details: { ...card.details, coordinationId: randomUUID() } }, { role: "custom", ...card, details: { ...card.details, notice: "uncertain" } }]) {
    a.delivery.messageStarted(other);
    a.delivery.drain();
  }
  assert.deepEqual(suffixes(a.sessionId), [".sending.json"], "no other start releases it");
  a.begin(); // its own run began
  a.state.idle = false;
  a.delivery.drain();
  assert.deepEqual(suffixes(a.sessionId), [".sending.json"], "busy in that run");
  a.state.idle = true;
  a.delivery.drain();
  assert.deepEqual(suffixes(a.sessionId), [".uncertain.json"], "after the run, still no persisted entry: uncertain");
  stop();
});

test("S4 mode OFF: the chief tool is inactive and refuses; nothing is drained while OFF", async () => {
  const { a, b, stop } = pair();
  b.mode(false);
  assert.ok(!b.active().includes("chief") && !b.active().includes("peer"));
  await assert.rejects(b.chiefCall({ action: "message", message: "x" }), /conductor mode OFF/);
  await a.staff({ action: "message", lead: b.sessionId, message: "hi" }).then(() => assert.fail("an OFF lead is not live presence"), (e: unknown) => assert.match(String(e), /no live lead/));
  b.mode(true);
  assert.ok(b.active().includes("chief"));
  stop();
});

test("S4 record mirror: pendingAsk is presentation within 4 KiB: the askId stays exact, the question is control-free and shrinks to fit; malformed asks are invalid", async () => {
  const { buildLeadRecord, validLeadRecord, LEAD_RECORD_MAX_BYTES } = await import("../src/supervision/store.ts");
  const base = { sessionId: "s", sessionFile: `/${"s".repeat(900)}`, generation: randomUUID(), pid: 4000, pidStartTime: 1, socketPath: `/${"k".repeat(900)}`, paneId: "p",
    cwd: `/${"d".repeat(900)}`, displayName: "lead", runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1 };
  const quoted = buildLeadRecord({ ...base, pendingAsk: { askId: "call-1", question: `"\\\u0001`.repeat(341), askedAt: 5 } });
  assert.ok(Buffer.byteLength(JSON.stringify(quoted)) <= LEAD_RECORD_MAX_BYTES, "JSON escaping cannot push it over");
  assert.equal(quoted.pendingAsk!.askId, "call-1");
  assert.ok(!/[\u0000-\u001f]/.test(quoted.pendingAsk!.question) && quoted.pendingAsk!.question.endsWith("…"), "shrunk and marked");
  assert.equal(validLeadRecord(JSON.parse(JSON.stringify(quoted))), true);
  const good = JSON.parse(JSON.stringify(buildLeadRecord({ ...base, sessionFile: "/s.jsonl", socketPath: "/k", cwd: "/d", pendingAsk: { askId: "call-1", question: "q?", askedAt: 5 } })));
  assert.equal(validLeadRecord(good), true);
  for (const bad of [{ askId: "call-1" }, { askId: "", question: "q", askedAt: 1 }, { askId: "a", question: "x".repeat(1025), askedAt: 1 }, { askId: "a", question: "q", askedAt: 1, extra: 1 }, { askId: "a", question: "q\n", askedAt: 1 }]) {
    assert.equal(validLeadRecord({ ...good, pendingAsk: bad }), false, JSON.stringify(bad).slice(0, 60));
  }
});

test("S4 activation: chief follows presence and the lease additively; a native policy that leaves chief out is never widened", () => {
  reset();
  const clock = makeFakeClock(Date.now());
  const narrow = s4Lead({ dir: fixtures, socket: SOCKET, clock, label: "narrow", registered: ["read", "peer", "staff"] });
  narrow.start();
  assert.deepEqual(narrow.active(), ["read", "peer"], "no chief without it in Pi's tool set; staff only for a holder");
  narrow.chief.become();
  assert.deepEqual(narrow.active(), ["read", "peer", "staff"]);
  narrow.chief.leave();
  assert.deepEqual(narrow.active(), ["read", "peer"], "leave never adds chief past the policy");
  narrow.stop();
});

// ── Receipts: only this session's own file proves an answer ─────────


test("S4 receipt A: a reply held only in memory (its write failed) never answers, even after its uncertain record is swept; a second reply is accepted and its persisted card answers", async () => {
  const { a, b, stop } = pair();
  const { id } = await asked(a, b);
  b.state.persist = false; // Pi keeps the card in memory; its file write fails
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "first, never written" });
  b.delivery.drain(); b.begin("chief_reply"); b.delivery.drain();
  assert.deepEqual(suffixes(b.sessionId), [".uncertain.json"]);
  assert.deepEqual([memoryReplies(b).length, persistedReplies(b).length], [1, 0]);
  assert.equal(b.asks.pending()?.askId, id, "control: outstanding while the record is uncertain");
  // Eight days later a restart (same in-memory branch, as /reload keeps it) sweeps the uncertain record.
  const [name] = readdirSync(inboxDir(b.sessionId));
  const old = (Date.now() - INBOX_RETENTION_MS - 86_400_000) / 1000;
  utimesSync(join(inboxDir(b.sessionId), name!), old, old);
  b.state.persist = true;
  b.stop(); b.start();
  assert.deepEqual(suffixes(b.sessionId), [], "swept: no inbox record left at all");
  assert.equal(b.asks.pending()?.askId, id, "no inbox record is no receipt: the ask stays outstanding");
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk?.askId, id, "the mirror still shows it");
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "second" });
  b.delivery.drain();
  assert.deepEqual(persistedReplies(b).map(e => e.details.askId), [id], "exactly one persisted answer");
  assert.match(persistedReplies(b)[0].content, /second/);
  assert.equal(b.asks.pending(), undefined, "the persisted second reply answers it");
  stop();
});

test("S4 receipt B: a persisted reply answers even when its dispatch was classified uncertain; a second reply is refused and rejected, so only one answer is persisted", async () => {
  const { a, b, stop } = pair();
  const { id } = await asked(a, b);
  await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "first" });
  b.delivery.drain();
  const [card] = persistedReplies(b);
  assert.equal(card?.details.askId, id);
  // The record was misclassified uncertain before Pi persisted the card (two wakes in one agent_settled).
  writeFileSync(join(inboxDir(b.sessionId), `${recordBase({ createdAt: card.details.createdAt, id: card.details.coordinationId })}.uncertain.json`), "{}", { mode: 0o600 });
  b.presence.touch();
  assert.equal(b.asks.pending(), undefined, "the persisted card is the answer; an uncertain record does not reopen the ask");
  assert.equal(readLeadRecord(leadPath(b.sessionId))!.pendingAsk, undefined);
  await assert.rejects(a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "second" }), /shows no pending ask/);
  admitCoordination(buildCoordination({ kind: "chief_reply", from: a.sessionId, to: b.sessionId, socketPath: SOCKET, lease: readChiefLease(SOCKET).holder!, askId: id, text: "second, forced", createdAt: Date.now() }), () => {});
  b.delivery.drain();
  assert.match(b.notes.at(-1)!, /none is outstanding/, "rejected at dispatch by the branch too");
  assert.equal(persistedReplies(b).length, 1, "only one persisted answer");
  stop();
});

test("S4 receipt proof: a fork's file (new header id) holding the copied card addressed to the parent answers; absent, unpersisted, foreign-header, wrong-to, wrong-id, notice, corrupt and symlinked files do not", () => {
  const PARENT = "parent-session", FORK = "fork-session", CID = randomUUID();
  const ask = { type: "message", id: "e1", message: { role: "toolResult", toolCallId: "call-1", toolName: "chief", isError: false, content: [],
    details: { action: "ask", askId: "call-1", question: "q?", askedAt: 1, chief: "c", leaseGeneration: 0 } } };
  const card = (over: Record<string, unknown> = {}) => ({ type: "custom_message", id: "e2", customType: "conductor-coordination", content: "re", display: true,
    details: { v: 1, coordinationId: CID, kind: "chief_reply", from: "c", to: PARENT, createdAt: 5, askId: "call-1", leaseGeneration: 0, ...over } });
  const header = (id: string) => ({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/" });
  const branch = [ask, card()]; // the fork's in-memory branch: the card keeps the parent as its `to`
  const judge = (lines: unknown[] | undefined, setup?: (file: string) => void) => {
    const file = join(fixtures, `fork-${randomUUID()}.jsonl`);
    if (lines) writeFileSync(file, lines.map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n");
    setup?.(file);
    const asks = new LeadAsks();
    asks.start({ getBranch: () => branch, sessionId: FORK, sessionFile: file });
    return asks.pending()?.askId;
  };
  assert.equal(judge([header(FORK), ask, card()]), undefined, "the persisted copy in this session's own file answers");
  for (const [label, lines, setup] of [
    ["no file yet", undefined],
    ["unpersisted copy", [header(FORK), ask]],
    ["header names the parent", [header(PARENT), ask, card()]],
    ["corrupt header", ["{not json", ask, card()]],
    ["card addressed to the fork instead of its own to", [header(FORK), ask, card({ to: FORK })]],
    ["another card id", [header(FORK), ask, card({ coordinationId: randomUUID() })]],
    ["an uncertainty notice", [header(FORK), ask, card({ notice: "uncertain" })]],
    ["a symlink to a valid file", undefined, (file: string) => { writeFileSync(`${file}.real`, [header(FORK), ask, card()].map(l => JSON.stringify(l)).join("\n") + "\n"); symlinkSync(`${file}.real`, file); }],
  ] as const) assert.equal(judge(lines as unknown[] | undefined, setup as ((f: string) => void) | undefined), "call-1", label);
  // The session id the file is judged against is the CURRENT one: the parent's own view of a parent file answers too.
  const parentFile = join(fixtures, `parent-${randomUUID()}.jsonl`);
  writeFileSync(parentFile, [header(PARENT), ask, card()].map(l => JSON.stringify(l)).join("\n") + "\n");
  const asParent = new LeadAsks();
  asParent.start({ getBranch: () => branch, sessionId: PARENT, sessionFile: parentFile });
  assert.equal(asParent.pending(), undefined);
});

test("S4 receipt proof cache: a negative scan resumes where it stopped (append-only), a proof holds for that exact file, and a replaced file is judged afresh", () => {
  const ID = "s-cache", CID = randomUUID(), file = join(fixtures, `cache-${randomUUID()}.jsonl`);
  const ask = { type: "message", message: { role: "toolResult", toolCallId: "call-9", toolName: "chief", isError: false, content: [],
    details: { action: "ask", askId: "call-9", question: "q?", askedAt: 1, chief: "c", leaseGeneration: 0 } } };
  const card = { type: "custom_message", customType: "conductor-coordination", content: "re", display: true,
    details: { v: 1, coordinationId: CID, kind: "chief_reply", from: "c", to: ID, createdAt: 5, askId: "call-9", leaseGeneration: 0 } };
  const head = JSON.stringify({ type: "session", version: 3, id: ID, timestamp: new Date(0).toISOString(), cwd: "/" }) + "\n" + JSON.stringify(ask) + "\n";
  writeFileSync(file, head);
  const asks = new LeadAsks();
  asks.start({ getBranch: () => [ask, card], sessionId: ID, sessionFile: file });
  assert.equal(asks.pending()?.askId, "call-9", "not yet in the file");
  for (let i = 0; i < 50; i++) appendFileSync(file, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `filler ${i}` }] } }) + "\n");
  assert.equal(asks.pending()?.askId, "call-9");
  appendFileSync(file, JSON.stringify(card) + "\n");
  assert.equal(asks.pending(), undefined, "the appended card is found from the cursor");
  assert.equal(asks.pending(), undefined, "and stays proven for this file");
  // Replaced (rename: a new inode) by a file without the card: no stale proof survives.
  writeFileSync(`${file}.new`, head);
  renameSync(`${file}.new`, file);
  assert.equal(asks.pending()?.askId, "call-9", "a replaced file is scanned afresh");
  rmSync(file);
  assert.equal(asks.pending()?.askId, "call-9", "an absent file proves nothing");
  // A new start (fork, resume) never inherits the previous session's proofs.
  writeFileSync(file, head + JSON.stringify(card) + "\n");
  assert.equal(asks.pending(), undefined);
  asks.start({ getBranch: () => [ask, card], sessionId: "another-session", sessionFile: file });
  assert.equal(asks.pending()?.askId, "call-9", "the header no longer names the current session");
});

test("S4 held wakes across starts: a reload start inherits same-process woken claims (Pi keeps its deferred prompts) and keeps the reply lock; any other start does not", async () => {
  for (const reason of ["reload", "resume"] as const) {
    const { a, b, stop } = pair();
    const { id } = await asked(a, b);
    b.state.persist = false; // deferred: nothing appended yet, and the session looks idle
    await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "answer one" });
    b.delivery.drain();
    await a.staff({ action: "reply", lead: b.sessionId, ask_id: id, message: "answer two" });
    b.delivery.drain();
    assert.deepEqual(suffixes(b.sessionId), [".json", ".sending.json", ".slot"], "reply 2 waits behind the held reply 1");
    b.stop(); b.start(reason);
    if (reason === "resume") {
      // Pi's session was replaced: its deferred prompts are gone, so reply 1 is uncertain and reply 2 is decided.
      assert.equal(suffixes(b.sessionId).filter(s => s === ".uncertain.json").length, 1);
      assert.equal(b.notes.filter(n => /may or may not have been delivered/.test(n)).length, 1);
      stop();
      continue;
    }
    assert.deepEqual(suffixes(b.sessionId), [".json", ".sending.json", ".slot"], "reload: still held, reply 2 still waits");
    assert.equal(b.delivery.status().heldWakes, 1);
    // Pi now runs the deferred reply 1: its own start, then its persisted card.
    const [first] = cards(b).filter(s => s.message.details.kind === "chief_reply").map(s => s.message);
    b.delivery.messageStarted({ role: "custom", ...first });
    appendFileSync(b.sessionFile, JSON.stringify({ type: "custom_message", customType: first.customType, content: first.content, display: true, details: first.details }) + "\n");
    b.state.persist = true;
    b.delivery.drain();
    assert.deepEqual(persistedReplies(b).map(e => /answer one/.test(e.content)), [true], "one answer: reply 1");
    assert.deepEqual(suffixes(b.sessionId), [".rejected.json"], "reply 2 rejected");
    assert.equal(b.notes.filter(n => /may or may not have been delivered/.test(n)).length, 0, "no false notice");
    stop();
  }
});

test("S4 held wakes: a reload instance does not inherit a card it already saw start before its first owned pass", async () => {
  const { a, b, stop } = pair();
  await b.chiefCall({ action: "message", message: "wake up" });
  a.state.persist = false;
  a.delivery.drain();
  const [card] = cards(a).map(s => s.message);
  a.stop();
  a.state.on = false; // the reload instance is not an owned lead yet: no pass runs at start
  a.start("reload");
  a.delivery.messageStarted({ role: "custom", ...card }); // Pi started it under the new instance
  a.state.idle = true;
  a.mode(true);
  assert.deepEqual(suffixes(a.sessionId), [".uncertain.json"], "started and never persisted: uncertain, not held");
  stop();
});
