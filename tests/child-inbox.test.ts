import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { installChildBridge } from "../src/child-bridge.ts";
import { tmpDir, sandboxPi } from "./helpers/tmp.ts";

sandboxPi();

import { syncBuiltinESMExports } from "node:module";
import { CONTROL_PREFIX, writeInboxRequest, readInboxAck, readInbox, inboxMarker, dispatchInboxRequest, MAX_INBOX_TEXT_BYTES, type InboxRequest } from "../src/herdr/inbox.ts";

function fixture() {
  const runDir = join(tmpDir("h5-inbox-"), "oracle-h5");
  mkdirSync(join(runDir, "session"), { recursive: true });
  const sessionFile = join(runDir, "session", "child.jsonl");
  const binding = { runId: "oracle-h5", launchNonce: "nonce-h5", sessionId: "session-h5", sessionFile,
    paneId: "pane-h5", terminalId: "terminal-h5", tabId: "tab-h5", workspaceId: "workspace-h5", socketPath: "/tmp/h5-fake.sock", createdTab: true };
  writeFileSync(join(runDir, "record.json"), JSON.stringify({ id: binding.runId, runtime: "herdr", herdr: binding }));
  const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: binding.runId, CONDUCTOR_RUN_DIR: runDir,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath, HERDR_PANE_ID: binding.paneId, HERDR_TAB_ID: binding.tabId, HERDR_WORKSPACE_ID: binding.workspaceId };
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const sent: any[][] = [];
  let branch: any[] = [], idle = true, queued = false;
  const diagnostics: string[] = [];
  let shutdowns = 0;
  const pi = { getFlag: () => binding.launchNonce, on: (name: string, h: (e: any, c: any) => unknown) => {
    handlers.set(name, [...handlers.get(name) ?? [], h]);
  }, sendUserMessage: (...args: unknown[]) => { sent.push(args); } };
  const ctx = { signal: undefined as AbortSignal | undefined, isIdle: () => idle, hasPendingMessages: () => queued,
    sessionManager: { getSessionId: () => binding.sessionId, getSessionFile: () => sessionFile, getBranch: () => branch },
    ui: { notify: (s: string) => diagnostics.push(s) }, shutdown: () => { shutdowns++; } };
  const fire = (type: string, fields: Record<string, unknown> = {}) => (handlers.get(type) ?? []).map(h => h({ type, ...fields }, ctx));
  const request = (sequence = 1, kind: InboxRequest["kind"] = "initial", extra: Partial<InboxRequest> = {}): InboxRequest => ({
    v: 1, launchNonce: binding.launchNonce, requestId: `req-${sequence}`, sequence, kind, text: `Task ${sequence}`, ...extra,
  });
  const put = (r = request()) => { writeInboxRequest(runDir, r); return r; };
  const input = (r: InboxRequest) => fire("input", { text: inboxMarker(r), source: "extension" }).at(-1);
  let bridge = installChildBridge(pi as never, { env });
  const reload = () => { bridge.dispose(); handlers.clear(); bridge = installChildBridge(pi as never, { env }); fire("session_start", { reason: "reload" }); };
  return { runDir, binding, env, pi, ctx, sent, diagnostics, fire, put, input, request, reload, start: () => fire("session_start", { reason: "startup" }),
    dispose: () => bridge.dispose(), accept: () => bridge.acceptInitial(binding.launchNonce), shutdowns: () => shutdowns,
    state: (values: { branch?: any[]; idle?: boolean; queued?: boolean }) => { branch = values.branch ?? branch; idle = values.idle ?? idle; queued = values.queued ?? queued; } };
}
function asking(id = "ask-1", question = "Choose?", evidence = "") {
  return [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id, arguments: { question } }] } },
    { type: "message", message: { role: "toolResult", toolName: "ask_owner", toolCallId: id, isError: false, details: { askId: id, question, evidence } } },
  ];
}

test("H5 interval pumps oldest current request outside session_start with explicit mode", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  try {
    f.put(f.request(2)); f.put(); f.start();
    assert.deepEqual(f.sent, [], "session_start never pumps inline");
    t.mock.timers.tick(250);
    assert.deepEqual(f.sent, [["__CONDUCTOR_CTL_V1__:nonce-h5:1:req-1", { deliverAs: "followUp" }]], "oldest request must be scheduled once");
    t.mock.timers.tick(1000);
    assert.equal(f.sent.length, 1, "unconfirmed input must not be scheduled again");
    f.reload(); t.mock.timers.tick(1000);
    assert.equal(f.sent.length, 1, "reload must retain ambiguous dispatch, not retry or overtake it");
  } finally { f.dispose(); }
});

for (const kind of ["initial", "steer", "follow_up", "grace", "reply"] as const) test(`H5 ${kind} ack is synchronous inside input, explicit delivery and exact prepared text`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  try {
    const text = "  /skill:do-not-expand\r\n漢🙂\u2028\u2029\n<files>prepared &lt;bytes&gt;</files>  ";
    const r = f.put(f.request(1, kind, { text, ...(kind === "reply" ? { askId: "ask-1" } : {}) }));
    if (kind === "reply") f.state({ branch: asking() });
    f.start(); t.mock.timers.tick(250);
    assert.equal(readInboxAck(f.runDir, r), undefined, "scheduling is not input acceptance");
    assert.equal(f.sent[0][1].deliverAs, kind === "steer" || kind === "grace" ? "steer" : "followUp");
    const result = f.input(r) as any;
    assert.equal(readInboxAck(f.runDir, r)?.accepted, true, "ack must exist before input returns transform");
    assert.deepEqual(result, { action: "transform", text: kind === "reply" ? `<owner-answer ask-id="ask-1">\nQuestion: Choose?\nAnswer: ${text}\nContinue the original assignment, not a new task.\n</owner-answer>` : text });
    assert.deepEqual(f.input(r), { action: "handled" });
    f.reload(); assert.deepEqual(f.input(r), { action: "handled" });
    f.fire("agent_settled");
    assert.equal(f.shutdowns(), kind === "initial" || kind === "reply" ? 1 : 0);
    assert.deepEqual(f.diagnostics, []);
  } finally { f.dispose(); }
});

test("H5 rejects malformed, foreign, unknown and unscheduled markers without model text", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    f.start();
    for (const text of [CONTROL_PREFIX, CONTROL_PREFIX + "../bad", CONTROL_PREFIX + "foreign:1:req-1", CONTROL_PREFIX + "nonce-h5:1:unknown"]) {
      assert.deepEqual(f.fire("input", { text }).at(-1), { action: "handled" });
    }
    const r = f.put(); assert.deepEqual(f.input(r), { action: "handled" });
    assert.equal(readInboxAck(f.runDir, r), undefined);
    assert.equal(f.fire("input", { text: "ordinary human" }).at(-1), undefined);
  } finally { f.dispose(); }
});

for (const terminal of ["session_compact", "session_compact_failed"]) test(`H5 compaction gate releases on ${terminal}, not on agent_end`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    f.put(); f.start(); f.fire("session_before_compact"); f.fire("agent_end");
    t.mock.timers.tick(500); assert.equal(f.sent.length, 0);
    f.fire(terminal, terminal === "session_compact" ? { compactionEntry: { id: "c" } } : { aborted: true, reason: "threshold" });
    t.mock.timers.tick(250); assert.equal(f.sent.length, 1, "compaction terminal must reopen pump even after cancellation");
  } finally { f.dispose(); }
});

test("H5 closing race consumes a scheduled marker unacked and reload never resurrects pump", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(); f.start(); f.accept(); t.mock.timers.tick(250); f.fire("agent_settled");
    assert.deepEqual(f.input(r), { action: "handled" }); assert.equal(readInboxAck(f.runDir, r), undefined);
    f.reload(); t.mock.timers.tick(1000); assert.equal(f.sent.length, 1); assert.deepEqual(f.input(r), { action: "handled" });
  } finally { f.dispose(); }
});

test("H5 ack write failure is handled locally; no transform, retry, or resurrection", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(); f.start(); t.mock.timers.tick(250);
    const write = t.mock.method(fs, "writeSync", () => { throw new Error("ack disk full"); }); syncBuiltinESMExports();
    try { assert.deepEqual(f.input(r), { action: "handled" }); } finally { write.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readInboxAck(f.runDir, r), undefined);
    f.reload(); t.mock.timers.tick(1000); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.input(r), { action: "handled" }, "failed invocation remains inert after reload");
    assert.equal(f.shutdowns(), 0);
  } finally { f.dispose(); }
});

for (const scenario of ["pending", "executing", "stale", "failed", "later-user", "batch", "wrong-details", "queued"]) test(`H5 ask reply/control refusal: ${scenario}`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const branch = asking();
    if (scenario === "stale") branch[0].message.content![0].id = "other";
    if (scenario === "failed") branch[1].message.isError = true;
    if (scenario === "wrong-details") branch[1].message.details!.askId = "other";
    if (scenario === "batch") branch[0].message.content!.push({ type: "toolCall", name: "read", id: "other", arguments: { question: "" } });
    if (scenario === "later-user") branch.push({ type: "message", message: { role: "user" } } as any);
    f.state({ branch, queued: scenario === "queued" });
    const control = scenario === "pending" || scenario === "executing";
    const r = f.put(f.request(1, control ? "steer" : "reply", control ? {} : { askId: "ask-1" }));
    f.start();
    if (scenario === "executing") { f.state({ branch: [] }); f.fire("tool_execution_start", { toolName: "ask_owner", toolCallId: "ask-1" }); }
    t.mock.timers.tick(250);
    assert.deepEqual(f.input(r), { action: "handled" });
    assert.equal(readInboxAck(f.runDir, r)?.code, control || scenario === "queued" ? "busy" : "stale-ask");
    assert.equal(f.shutdowns(), 0);
  } finally { f.dispose(); }
});

test("H5 request validation and immutable nonce-scoped publication", () => {
  const f = fixture();
  try {
    for (const extra of [{ launchNonce: "../escape" }, { requestId: "a/b" }, { sequence: 0 }, { text: "x".repeat(MAX_INBOX_TEXT_BYTES + 1) }, { kind: "wat" }, { kind: "reply" }])
      assert.throws(() => f.put(f.request(1, "initial", extra as any)), /invalid/);
    assert.equal(existsSync(join(f.runDir, "inbox")), false, "invalid requests cause no directory mutation");
    const r = f.put(); assert.throws(() => f.put(r), /duplicate/);
    const foreign = { ...r, launchNonce: "foreign" };
    assert.throws(() => f.put(foreign), /invocation/);
    mkdirSync(join(f.runDir, "inbox", "foreign"));
    writeFileSync(join(f.runDir, "inbox", "foreign", "000001-req-1.json"), JSON.stringify(foreign));
    assert.equal(readInboxAck(f.runDir, foreign), undefined);
    const dir = join(f.runDir, "inbox", r.launchNonce);
    writeFileSync(join(dir, "000002-bad.json"), "{");
    symlinkSync(join(dir, "000001-req-1.json"), join(dir, "000003-link.json"));
    writeFileSync(join(dir, "000004-foreign.json"), JSON.stringify({ ...r, requestId: "foreign", sequence: 4, launchNonce: "foreign" }));
    assert.deepEqual(readInbox(f.runDir, r.launchNonce), [{ request: r, dispatched: false }]);
    writeFileSync(join(dir, "req-1.ack.json"), "{");
    assert.throws(() => readInboxAck(f.runDir, r));
    assert.equal(readInboxAck(f.runDir, foreign), undefined, "foreign ack not borrowed");
  } finally { f.dispose(); }
});

test("H5 pump holds idle preflight and queued text until native start/message, never a permanent busy latch", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(), second = f.put(f.request(2, "steer")); f.start(); t.mock.timers.tick(250); f.input(r);
    t.mock.timers.tick(1000); assert.equal(f.sent.length, 1, "ack is not native start; do not overlap idle preflights");
    f.state({ idle: false }); f.ctx.signal = new AbortController().signal; f.fire("agent_start"); f.fire("turn_start"); t.mock.timers.tick(250); assert.equal(f.sent.length, 2);
    f.input(second); const third = f.put(f.request(3, "follow_up"));
    f.fire("turn_end"); t.mock.timers.tick(1000); assert.equal(f.sent.length, 2, "a turn boundary does not prove queued input consumption");
    f.fire("message_start", { message: { role: "user", content: [{ type: "text", text: second.text }] } });
    f.fire("turn_start"); t.mock.timers.tick(250); assert.equal(f.sent.length, 3); assert.equal(f.sent[2][0], inboxMarker(third));
  } finally { f.dispose(); }
});

test("H5 compaction terminal handlers may still be running; pump waits for native idle or next turn", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    f.put(); f.start(); f.state({ idle: false }); f.fire("session_before_compact");
    f.fire("session_compact", { compactionEntry: { id: "c" } });
    t.mock.timers.tick(1000); assert.equal(f.sent.length, 0, "session_compact runs before Pi clears its compaction controller");
    f.state({ idle: true }); t.mock.timers.tick(250); assert.equal(f.sent.length, 1);
  } finally { f.dispose(); }
});

for (const bytes of [0, 17]) test(`H5 tee fault after ${bytes} bytes consumes input and prevents reload pumping`, t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(); f.start(); t.mock.timers.tick(250);
    f.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "pending tee" }] } });
    const original = fs.writeSync; let remaining = bytes;
    const write = t.mock.method(fs, "writeSync", (fd: number, b: Buffer, offset: number, length: number) => {
      if (remaining === 0) throw new Error("tee disk full");
      const n = original(fd, b, offset, Math.min(length, remaining)); remaining -= n; return n;
    }); syncBuiltinESMExports();
    try { assert.deepEqual(f.input(r), { action: "handled" }); } finally { write.mock.restore(); syncBuiltinESMExports(); }
    const damaged = readFileSync(join(f.runDir, "transcript.jsonl"));
    f.reload(); t.mock.timers.tick(1000); assert.equal(f.sent.length, 1);
    assert.deepEqual(f.input(r), { action: "handled" }); assert.equal(readInboxAck(f.runDir, r), undefined);
    f.fire("agent_settled"); assert.equal(f.shutdowns(), 0);
    assert.deepEqual(readFileSync(join(f.runDir, "transcript.jsonl")), damaged);
  } finally { f.dispose(); }
});

test("H5 successful reply consumed once even across reload before native start", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    f.state({ branch: asking() }); const r = f.put(f.request(1, "reply", { askId: "ask-1" }));
    f.start(); t.mock.timers.tick(250); assert.equal((f.input(r) as any).action, "transform");
    f.reload(); const duplicate = f.put(f.request(2, "reply", { askId: "ask-1" }));
    t.mock.timers.tick(250); assert.deepEqual(f.input(duplicate), { action: "handled" });
    assert.equal(readInboxAck(f.runDir, duplicate)?.code, "stale-ask");
  } finally { f.dispose(); }
});

test("H5 owner execution stays busy through tool-end until native result persistence at turn_end", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(f.request(1, "steer")); f.start();
    f.fire("tool_execution_start", { toolName: "ask_owner", toolCallId: "ask-1" });
    f.fire("tool_execution_end", { toolName: "ask_owner", toolCallId: "ask-1", isError: false, result: { details: { askId: "ask-1", question: "Choose?", evidence: "" } } });
    t.mock.timers.tick(250); assert.deepEqual(f.input(r), { action: "handled" });
    assert.equal(readInboxAck(f.runDir, r)?.code, "busy", "tool_execution_end precedes native branch persistence");
    f.state({ branch: asking() }); f.fire("turn_end");
    const next = f.put(f.request(2, "follow_up")); t.mock.timers.tick(250); assert.deepEqual(f.input(next), { action: "handled" });
    assert.equal(readInboxAck(f.runDir, next)?.code, "busy");
  } finally { f.dispose(); }
});

test("H5 parent request publication validates current recorded invocation before creating inbox", () => {
  for (const value of ["{", JSON.stringify({ id: "oracle-h5", runtime: "subprocess" }), JSON.stringify({ id: "other", runtime: "herdr", herdr: { runId: "other", launchNonce: "nonce-h5" } })]) {
    const f = fixture();
    try {
      writeFileSync(join(f.runDir, "record.json"), value);
      assert.throws(() => f.put());
      assert.equal(existsSync(join(f.runDir, "inbox")), false);
    } finally { f.dispose(); }
  }
});

test("H5 malformed or foreign ack is never overwritten or mistaken for acceptance", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const content of ["{", JSON.stringify({ v: 1, launchNonce: "foreign", requestId: "req-1", sequence: 1, kind: "initial", accepted: true, at: 1 })]) {
    const f = fixture();
    try {
      const r = f.put(); f.start(); t.mock.timers.tick(250);
      const path = join(f.runDir, "inbox", r.launchNonce, `${r.requestId}.ack.json`); writeFileSync(path, content);
      assert.deepEqual(f.input(r), { action: "handled" });
      assert.equal(readFileSync(path, "utf8"), content); assert.equal(f.shutdowns(), 0);
    } finally { f.dispose(); }
  }
});

test("H5 duplicate disk request identities and nonregular canonical requests are not scheduled", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const scenario of ["duplicate", "symlink", "directory", "oversize"]) {
    const f = fixture();
    try {
      const r = f.put(), dir = join(f.runDir, "inbox", r.launchNonce), path = join(dir, "000001-req-1.json");
      if (scenario === "duplicate") writeFileSync(join(dir, "000002-req-1.json"), JSON.stringify({ ...r, sequence: 2 }));
      else if (scenario === "oversize") fs.truncateSync(path, 33 * 1048576);
      else { renameSync(path, join(f.runDir, "original.json")); if (scenario === "directory") mkdirSync(path); else symlinkSync(join(f.runDir, "original.json"), path); }
      f.start(); t.mock.timers.tick(1000); assert.equal(f.sent.length, 0); assert.equal(readInboxAck(f.runDir, r), undefined);
    } finally { f.dispose(); }
  }
});

test("H5 maximum bounded Unicode request is accepted without trimming or rereading evidence", () => {
  const f = fixture();
  try {
    const r = f.put(f.request(1, "initial", { text: "🙂".repeat(MAX_INBOX_TEXT_BYTES / 4) }));
    assert.equal(readInbox(f.runDir, r.launchNonce)[0].request.text, r.text);
  } finally { f.dispose(); }
});

test("H5 dispatch helper refuses malformed path identity before touching a request", () => {
  const f = fixture();
  try { assert.throws(() => dispatchInboxRequest(f.runDir, f.request(1, "initial", { requestId: "../escape" })), /invalid/); }
  finally { f.dispose(); }
});

test("H5 nonidle without an observed live turn is not dispatch permission", t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const f = fixture();
  try {
    const r = f.put(); f.start(); f.state({ idle: false });
    t.mock.timers.tick(250); assert.equal(f.sent.length, 0, "early compaction has no turn signal");
    const controller = new AbortController(); f.ctx.signal = controller.signal;
    t.mock.timers.tick(250); assert.equal(f.sent.length, 0, "a run signal alone does not establish an active turn");
    f.fire("turn_start"); controller.abort();
    t.mock.timers.tick(250); assert.equal(f.sent.length, 0, "an aborted turn cannot admit controls during manual compact's abort phase");
    assert.deepEqual(readInbox(f.runDir, r.launchNonce), [{ request: r, dispatched: false }]);
    f.state({ idle: true }); t.mock.timers.tick(250); assert.equal(f.sent.length, 1);
  } finally { f.dispose(); }
});
