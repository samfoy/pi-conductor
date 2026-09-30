import test from "node:test";
import assert from "node:assert/strict";
import conductor from "../src/index.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { applyEvent } from "../src/event-handler.ts";
import type { Run } from "../src/types.ts";

import { sandboxPi } from "./helpers/tmp.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { installChildBridge } from "../src/child-bridge.ts";

// The fake is only the native ExtensionAPI boundary; claims and transcript use real files.
function fixture(runId = "oracle-h4") {
  const runDir = join(tmpDir("h4-bridge-"), runId);
  mkdirSync(join(runDir, "session"), { recursive: true });
  const sessionFile = join(runDir, "session", "child.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-h4" }) + "\n");
  const binding = { runId, launchNonce: "nonce-h4", sessionId: "session-h4", sessionFile,
    paneId: "pane-h4", terminalId: "terminal-h4", tabId: "tab-h4", workspaceId: "workspace-h4", socketPath: "/tmp/h4-fake.sock", createdTab: true };
  const record = { id: binding.runId, runtime: "herdr", herdr: binding };
  writeFileSync(join(runDir, "record.json"), JSON.stringify(record));
  const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: binding.runId, CONDUCTOR_RUN_DIR: runDir,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath, HERDR_PANE_ID: binding.paneId, HERDR_TAB_ID: binding.tabId, HERDR_WORKSPACE_ID: binding.workspaceId };
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const diagnostics: string[] = [];
  let shutdowns = 0;
  let token: unknown = binding.launchNonce;
  const pi = { getFlag: () => token, on: (name: string, handler: (event: any, ctx: any) => unknown) => {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    return () => { list.splice(list.indexOf(handler), 1); };
  } };
  const ctx = { sessionManager: { getSessionId: () => binding.sessionId, getSessionFile: () => binding.sessionFile },
    ui: { notify: (message: string) => diagnostics.push(message) }, shutdown: () => { shutdowns++; } };
  const fire = (type: string, fields: Record<string, unknown> = {}) => (handlers.get(type) ?? []).map(h => h({ type, ...fields }, ctx));
  const rows = () => existsSync(join(runDir, "transcript.jsonl")) ? readFileSync(join(runDir, "transcript.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
  return { runDir, env, binding, record, pi, ctx, fire, rows, handlers, diagnostics, setToken: (v: unknown) => { token = v; }, shutdowns: () => shutdowns };
}

test("H4 claims the exact managed invocation and leaves ordinary pane Pi inert", () => {
  for (const managed of [false, true]) {
    const f = fixture();
    if (!managed) f.setToken(undefined);
    const bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      assert.equal(f.rows().length, managed ? 1 : 0);
      assert.deepEqual(f.fire("session_before_switch"), [managed ? { cancel: true } : undefined]);
      assert.deepEqual(f.fire("session_before_fork"), [managed ? { cancel: true } : undefined]);
      if (managed) {
        const hello = JSON.parse(readFileSync(join(f.runDir, "launch/nonce-h4.json"), "utf8"));
        assert.equal(hello.pid, process.pid);
        assert.ok(hello.pid > 1 && hello.pidStartTime > 0);
        assert.equal(hello.terminalId, f.binding.terminalId);
        assert.equal(hello.sessionFile, f.binding.sessionFile);
        assert.equal(hello.bridgeProtocol, 1);
        assert.equal(f.rows()[0]._c.n, f.binding.launchNonce);
      }
    } finally { bridge.dispose(); }
  }
});


sandboxPi();

for (const bytes of [0, 17]) for (const boundary of ["event", "dispose"]) {
  test(`H4 failed tee after ${bytes} bytes at ${boundary} stays disqualified across module reload`, async t => {
    const f = fixture();
    // Isolate the process-lifetime fault registry, without adding a production reset API.
    const key = Symbol.for("pi-conductor.child-bridge.tee-faults.v1");
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: new Set<string>(), writable: true, configurable: true });
    t.after(() => { if (prior) Object.defineProperty(globalThis, key, prior); else Reflect.deleteProperty(globalThis, key); });
    const moduleUrl = new URL("../src/child-bridge.ts", import.meta.url).href;
    let factory: typeof installChildBridge = (await import(`${moduleUrl}?fault=${encodeURIComponent(f.runDir)}-initial`)).installChildBridge;
    let bridge = factory(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      assert.ok(bridge.acceptInitial(f.binding.launchNonce));
      const before = readFileSync(join(f.runDir, "transcript.jsonl"));
      const nativeWrite = fs.writeSync;
      let remaining = bytes, failures = 0;
      t.mock.method(fs, "writeSync", (fd: number, buffer: Buffer, offset: number, length: number) => {
        if (remaining === 0) { failures++; throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" }); }
        const written = nativeWrite(fd, buffer, offset, Math.min(length, remaining));
        remaining -= written; return written;
      });
      syncBuiltinESMExports();
      try {
        f.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "lost final 🙂" }], stopReason: "stop" } });
        if (boundary === "event") f.fire("context");
        else assert.throws(() => bridge.dispose(), /injected full disk/);
        bridge.dispose();
      } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.ok(failures > 0, "real tee write failed even if a marker write is attempted");
      const damaged = readFileSync(join(f.runDir, "transcript.jsonl"));
      assert.equal(damaged.length, before.length + bytes);
      for (let generation = 0; generation < 2; generation++) {
        f.handlers.clear();
        const next = await import(`${moduleUrl}?fault=${encodeURIComponent(f.runDir)}-${generation}`);
        assert.notEqual(next.installChildBridge, factory, "witness must re-evaluate the module, not retain an instance bool");
        factory = next.installChildBridge;
        bridge = factory(f.pi as never, { env: f.env });
        f.fire("session_start", { reason: "reload" });
        f.fire("agent_start"); f.fire("agent_settled");
        const data = readFileSync(join(f.runDir, "transcript.jsonl"), "utf8");
        const run = observer();
        const effects = data.split("\n").flatMap(line => {
          try { return [applyEvent(run, JSON.parse(line))]; } catch { return []; }
        });
        assert.ok(!effects.some(e => e.kind === "finalize" && e.status === "completed"), "H4 failed tee reload must not finalize completed through production applyEvent");
        assert.doesNotMatch(data, /agent_settled/);
        assert.equal(existsSync(join(f.runDir, "launch/nonce-h4.closing.json")), false);
        assert.equal(f.shutdowns(), 0);
        assert.equal(bridge.acceptInitial(f.binding.launchNonce), false);
        assert.deepEqual(readFileSync(join(f.runDir, "transcript.jsonl")), damaged, "reload must not append to a failed tee, including partial lines");
        assert.match(f.diagnostics.at(-1)!, /tee.*failed.*reload/i);
        bridge.dispose();
      }
      // Faults cannot cross run/session identities, even with an identical launch nonce.
      const other = fixture("oracle-other");
      const otherBridge = factory(other.pi as never, { env: other.env });
      try {
        other.fire("session_start", { reason: "startup" });
        assert.ok(otherBridge.acceptInitial(other.binding.launchNonce));
        other.fire("agent_settled"); assert.equal(other.shutdowns(), 1);
      } finally { otherBridge.dispose(); }
      if (bytes === 0) {
        // A new nonce can use the intact transcript; this is not repair of a partial line.
        f.binding.launchNonce = "next-invocation"; f.setToken(f.binding.launchNonce);
        writeFileSync(join(f.runDir, "record.json"), JSON.stringify(f.record));
        f.handlers.clear(); bridge = factory(f.pi as never, { env: f.env });
        f.fire("session_start", { reason: "startup" });
        assert.ok(bridge.acceptInitial(f.binding.launchNonce));
        f.fire("agent_settled"); assert.equal(f.shutdowns(), 1);
      }
    } finally { bridge.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("H4 healthy accepted invocation still settles after genuine module reload", async () => {
  const f = fixture();
  let bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" }); assert.ok(bridge.acceptInitial(f.binding.launchNonce));
    f.fire("message_end", { message: { role: "user", content: "retained across reload" } });
    bridge.dispose(); f.handlers.clear();
    const reloaded = await import(`${new URL("../src/child-bridge.ts", import.meta.url).href}?healthy=${encodeURIComponent(f.runDir)}`);
    assert.notEqual(reloaded.installChildBridge, installChildBridge);
    bridge = reloaded.installChildBridge(f.pi as never, { env: f.env });
    f.fire("session_start", { reason: "reload" }); f.fire("agent_settled");
    assert.equal(f.shutdowns(), 1);
    assert.ok(f.rows().some(e => applyEvent(observer(), e).kind === "finalize"));
    assert.deepEqual(f.diagnostics, []);
  } finally { bridge.dispose(); }
});


test("H4 binding validation preserves A5 large parent task records and maximum valid evidence", () => {
  const f = fixture();
  writeFileSync(join(f.runDir, "record.json"), JSON.stringify({ ...f.record, task: "large task 🙂".repeat(10000) }));
  const bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" });
    assert.equal(f.rows().length, 1, "parent record size is not a launch identity failure");
    const details = { askId: "x", question: "Multi-line?\nChoose 🙂", evidence: "🙂".repeat(1048576) };
    f.fire("tool_execution_end", { toolName: "ask_owner", toolCallId: "x", isError: false, result: { details } });
    assert.deepEqual(f.rows().at(-1).result.details, details, "valid A5 four-times maximum cap survives intact");
    assert.deepEqual(f.diagnostics, []);
  } finally { bridge.dispose(); }
});


test("H4 fresh invocation nonce never inherits prior accepted/closing state", () => {
  const f = fixture(); const bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" });
    assert.ok(bridge.acceptInitial(f.binding.launchNonce)); f.fire("agent_settled");
    assert.equal(f.shutdowns(), 1);
    f.fire("session_shutdown", { reason: "quit" });
    f.binding.launchNonce = "fresh-nonce"; f.setToken(f.binding.launchNonce);
    writeFileSync(join(f.runDir, "record.json"), JSON.stringify(f.record));
    f.fire("session_start", { reason: "startup" }); f.fire("agent_settled");
    assert.equal(f.shutdowns(), 1, "old acceptance cannot settle fresh invocation");
    assert.equal(f.rows().at(-1)._c.n, "fresh-nonce");
    assert.equal(f.rows().filter(e => e.event === "launch").length, 2);
    assert.equal(bridge.acceptInitial("nonce-h4"), false);
    assert.deepEqual(f.diagnostics, []);
  } finally { bridge.dispose(); }
});

test("H4 production entry point installs the bridge only in child scope", () => {
  const saved = { ...process.env };
  for (const child of [false, true]) {
    const f = fixture();
    Object.assign(process.env, f.env, { CONDUCTOR_SUBAGENT: child ? "1" : "0" });
    const pi = new Proxy(f.pi, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} });
    try {
      conductor(pi as never);
      if (child) {
        f.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, f.ctx);
        assert.equal(f.rows()[0].event, "launch");
        f.handlers.get("session_shutdown")![0]({ type: "session_shutdown", reason: "quit" }, f.ctx);
      } else assert.equal(f.handlers.has("session_before_switch"), false);
    } finally {
      for (const key of Object.keys(f.env)) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  }
});


test("H4 switch/fork boundaries flush, and repeated reload/shutdown own at most one append fd", t => {
  const f = fixture();
  const nativeOpen = fs.openSync, nativeClose = fs.closeSync;
  const owned = new Set<number>(), append = new Set<number>();
  let maxAppend = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = nativeOpen(...args); owned.add(fd);
    if (typeof args[1] === "number" && args[1] & fs.constants.O_APPEND) append.add(fd);
    maxAppend = Math.max(maxAppend, append.size);
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { owned.delete(fd); append.delete(fd); nativeClose(fd); });
  syncBuiltinESMExports();
  const bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" });
    for (let i = 0; i < 20; i++) {
      f.fire("message_end", { message: { role: "user", content: `boundary-${i}` } });
      assert.deepEqual(f.fire(i % 2 ? "session_before_fork" : "session_before_switch"), [{ cancel: true }]);
      assert.equal(f.rows().at(-1).message?.content, `boundary-${i}`, "session boundary must flush the deferred message");
      if (i % 2) f.fire("session_shutdown", { reason: "reload" });
      f.fire("session_start", { reason: "reload" });
    }
    bridge.dispose(); bridge.dispose(); f.fire("session_shutdown", { reason: "quit" });
    assert.equal(maxAppend, 1); assert.equal(owned.size, 0); assert.equal(f.rows().filter(e => e.event === "launch").length, 1);
  } finally { bridge.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});


test("H4 refuses conflicting recorded process evidence and a symlinked session before claim", () => {
  for (const scenario of ["pid", "start", "session-link"]) {
    const f = fixture();
    if (scenario === "session-link") {
      fs.unlinkSync(f.binding.sessionFile);
      fs.symlinkSync(join(f.runDir, "record.json"), f.binding.sessionFile);
    } else {
      writeFileSync(join(f.runDir, "record.json"), JSON.stringify({ ...f.record, herdr: { ...f.binding, [scenario === "pid" ? "childPid" : "childStartTime"]: 1 } }));
    }
    const bridge = installChildBridge(f.pi as never, { env: f.env });
    try { f.fire("session_start", { reason: "startup" }); assert.deepEqual(f.rows(), []); assert.equal(f.diagnostics.length, 1); }
    finally { bridge.dispose(); }
  }
});


for (const field of ["v", "bridgeProtocol", "runId", "launchNonce", "pid", "pidStartTime", "paneId", "terminalId", "sessionId", "sessionFile", "piVersion", "conductorVersion", "at"]) {
  test(`H4 reload rejects conflicting hello ${field} without clobber or fd leaks`, () => {
    const f = fixture();
    const bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      f.fire("session_shutdown", { reason: "reload" });
      const file = join(f.runDir, "launch/nonce-h4.json");
      const hello = JSON.parse(readFileSync(file, "utf8"));
      hello[field] = field === "at" ? -1 : typeof hello[field] === "number" ? hello[field] + 1 : "foreign";
      const bytes = JSON.stringify(hello); writeFileSync(file, bytes);
      const before = f.rows();
      f.fire("session_start", { reason: "reload" }); f.fire("agent_start");
      assert.equal(f.diagnostics.length, 1);
      assert.deepEqual(f.rows(), before);
      assert.equal(readFileSync(file, "utf8"), bytes);
      assert.deepEqual(f.fire("session_before_switch"), [undefined]);
    } finally { bridge.dispose(); }
  });
}

for (const field of ["CONDUCTOR_SUBAGENT", "CONDUCTOR_RUNTIME", "CONDUCTOR_RUN_ID", "CONDUCTOR_RUN_DIR", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) {
  test(`H4 activation rejects missing ${field}`, () => {
    const f = fixture();
    const env = { ...f.env, [field]: "" };
    const bridge = installChildBridge(f.pi as never, { env });
    try { f.fire("session_start", { reason: "startup" }); assert.deepEqual(f.rows(), []); }
    finally { bridge.dispose(); }
  });
}
for (const nonce of ["", " ", "../escape", "x/y", "x\u0000y", true]) {
  test(`H4 invalid launch flag ${JSON.stringify(nonce)} stays inert`, () => {
    const f = fixture(); f.setToken(nonce);
    const bridge = installChildBridge(f.pi as never, { env: f.env });
    try { f.fire("session_start", { reason: "startup" }); assert.deepEqual(f.rows(), []); assert.equal(f.diagnostics.length, 1); }
    finally { bridge.dispose(); }
  });
}

test("H4 startup collision, malformed claims and durable state fail closed; foreign nonce state is not restored", () => {
  for (const scenario of ["startup", "malformed", "accepted", "closing", "closing-only", "foreign-nonce"]) {
    const f = fixture(); const bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" }); f.fire("session_shutdown", { reason: "reload" });
      const claim = join(f.runDir, "launch/nonce-h4.json");
      const hello = JSON.parse(readFileSync(claim, "utf8"));
      if (scenario === "malformed") writeFileSync(claim, "{");
      if (scenario === "accepted" || scenario === "closing") writeFileSync(join(f.runDir, `launch/nonce-h4.${scenario}.json`), JSON.stringify({ ...hello, pid: hello.pid + 1 }));
      if (scenario === "closing-only") writeFileSync(join(f.runDir, "launch/nonce-h4.closing.json"), JSON.stringify(hello));
      if (scenario === "foreign-nonce") writeFileSync(join(f.runDir, "launch/foreign.accepted.json"), JSON.stringify({ ...hello, launchNonce: "foreign" }));
      const before = f.rows();
      f.fire("session_start", { reason: scenario === "startup" ? "startup" : "reload" });
      assert.equal(f.diagnostics.length, scenario === "foreign-nonce" ? 0 : 1);
      if (scenario !== "foreign-nonce") assert.deepEqual(f.rows(), before);
      f.fire("agent_settled"); assert.equal(f.shutdowns(), 0);
    } finally { bridge.dispose(); }
  }
});

test("H4 tool updates throttle independently, omit bodies, and compaction has one telemetry record", () => {
  const f = fixture(); let now = 0;
  const bridge = installChildBridge(f.pi as never, { env: f.env, now: () => now });
  try {
    f.fire("session_start", { reason: "startup" });
    for (const at of [0, 4999, 5000]) {
      now = at;
      for (const toolCallId of ["a", "b"]) f.fire("tool_execution_update", { toolCallId, toolName: "read", partialResult: "HUGE" });
    }
    f.fire("tool_execution_end", { toolCallId: "a", toolName: "read", isError: false, result: "HUGE" });
    f.fire("ui_prompt_start", { kind: "confirm", title: "Permission" });
    f.fire("ui_prompt_end", { kind: "confirm", title: "Permission" });
    f.fire("session_compact_failed", { errorMessage: "HUGE" });
    f.fire("session_compact", { compactionEntry: { id: "compact-1", summary: "HUGE", systemMessage: "HUGE" } });
    f.fire("session_compact", { compactionEntry: { id: "compact-1", summary: "HUGE" } });
    f.fire("message_end", { message: { role: "compactionSummary", summary: "HUGE" } });
    f.fire("agent_end");
    const rows = f.rows();
    assert.deepEqual(rows.filter(e => e.type === "tool_execution_update").map(e => e.toolCallId), ["a", "b", "a", "b"]);
    assert.deepEqual(rows.filter(e => e.event === "ui_prompt").map(e => e.state), ["start", "end"]);
    assert.equal(rows.filter(e => applyEvent(observer(), e).kind === "compacted").length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /HUGE/);
  } finally { bridge.dispose(); }
});

test("H4 invalid/oversize successful owner details are rejected, never truncated into a valid ask", () => {
  for (const details of [{ askId: "x", question: "q" }, { askId: "x", question: "q", evidence: "x".repeat(4 * 1048576 + 1) }, { askId: "x", question: "x".repeat(8 * 1048576), evidence: "" }]) {
    const f = fixture(); const bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      f.fire("tool_execution_end", { toolName: "ask_owner", toolCallId: "x", isError: false, result: { details } });
      f.fire("agent_settled");
      assert.equal(f.rows().length, 1); assert.equal(f.diagnostics.length, 1); assert.equal(f.shutdowns(), 0);
    } finally { bridge.dispose(); }
  }
});


test("H4 accepted settlement closes once after flush; reload restores state without terminal replay", () => {
  const f = fixture();
  let bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" });
    assert.equal(bridge.acceptInitial("foreign"), false);
    f.fire("agent_settled");
    assert.equal(f.shutdowns(), 0);
    assert.equal(bridge.acceptInitial(f.binding.launchNonce), true);
    f.fire("session_shutdown", { reason: "reload" });
    f.fire("session_start", { reason: "reload" });
    assert.equal(f.rows().filter(e => e.event === "launch").length, 1);
    f.ctx.shutdown = () => {
      assert.equal(f.rows().at(-1).type, "agent_settled", "settle and final message flushed before shutdown request");
      assert.equal(f.rows().at(-2).message.content, "final 🙂");
      assert.ok(existsSync(join(f.runDir, "launch/nonce-h4.closing.json")));
      f.fire("session_shutdown", { reason: "quit" });
    };
    f.fire("message_end", { message: { role: "user", content: "final 🙂" } });
    f.fire("agent_settled");
    const before = readFileSync(join(f.runDir, "transcript.jsonl"), "utf8");
    f.fire("agent_settled");
    f.fire("session_shutdown", { reason: "reload" });
    f.fire("session_start", { reason: "reload" });
    assert.equal(bridge.acceptInitial(f.binding.launchNonce), false, "closing invocation cannot be reexecuted");
    f.fire("agent_start"); f.fire("agent_settled");
    assert.equal(readFileSync(join(f.runDir, "transcript.jsonl"), "utf8"), before);
    assert.deepEqual(f.diagnostics, []);
    assert.equal(existsSync(join(f.runDir, "final.md")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(f.runDir, "record.json"), "utf8")), f.record);
  } finally { bridge.dispose(); bridge.dispose(); }
});


test("H4 synchronous partial writes preserve burst order, Unicode, and deferred replacement at any boundary", (t) => {
  const f = fixture();
  const nativeWrite = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd: number, buffer: Buffer, offset: number, length: number) => {
    assert.ok(Buffer.isBuffer(buffer), "every write uses the complete-buffer loop, including claims");
    return nativeWrite(fd, buffer, offset, Math.min(length, 17));
  });
  syncBuiltinESMExports();
  const bridge = installChildBridge(f.pi as never, { env: f.env });
  try {
    f.fire("session_start", { reason: "startup" });
    for (let i = 0; i < 100; i++) {
      const message = { role: "assistant", content: [{ type: "text", text: "before" }], timestamp: i };
      f.fire("message_end", { message });
      message.content = [{ type: "text", text: `${i}:🙂漢\u2028\u2029`.repeat(100) }];
      f.fire("context", { messages: ["must not be projected"] });
      assert.equal(f.rows().length, i + 2, "an unprojected event flushes the retained message reference");
    }
    f.fire("agent_end", { messages: ["HUGE"] });
    f.fire("agent_settled");
    const rows = f.rows();
    assert.deepEqual(rows.slice(1, 101).map(e => e.message.timestamp), Array.from({ length: 100 }, (_, i) => i));
    assert.equal(rows[43].message.content[0].text, "42:🙂漢\u2028\u2029".repeat(100));
    assert.ok(rows.every(e => e._c.n === f.binding.launchNonce));
    assert.deepEqual(rows.at(-2), { type: "agent_end", _c: { n: "nonce-h4" } });
    assert.equal(f.shutdowns(), 0, "unaccepted human turn must not end the assignment");
    assert.deepEqual(f.diagnostics, []);
  } finally { bridge.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); }
});

function observer(): Run {
  return { id: "oracle-h4", messages: [], usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } } as unknown as Run;
}

test("H4 A6 projection feeds sole successful details to production applyEvent, never failed/batched asks", () => {
  for (const scenario of ["sole", "failed", "batch"]) {
    const f = fixture();
    const bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      const calls = [{ type: "toolCall", id: "ask-1", name: "ask_owner", arguments: { question: "Choose?" } }];
      if (scenario === "batch") calls.push({ ...calls[0], id: "ask-2" });
      f.fire("message_end", { message: { role: "assistant", content: calls, stopReason: "toolUse" } });
      f.fire("tool_execution_start", { toolName: "ask_owner", toolCallId: "ask-1", args: { question: "Choose?" } });
      f.fire("tool_execution_end", { toolName: "ask_owner", toolCallId: "ask-1", isError: scenario === "failed",
        result: { content: "ordinary body not copied", details: { askId: "ask-1", question: "Choose?", evidence: "🙂 evidence", ignored: "HUGE" } } });
      f.fire("turn_end", { turnIndex: 0, context: { llmMessages: "HUGE" }, entries: ["HUGE"], toolResults: ["HUGE"] });
      f.fire("agent_settled");
      const run = observer();
      for (const row of f.rows()) applyEvent(run, row);
      assert.equal(run.pendingAsk?.askId, scenario === "sole" ? "ask-1" : undefined);
      if (scenario === "sole") assert.equal(run.pendingAsk?.evidence, "🙂 evidence");
      assert.doesNotMatch(JSON.stringify(f.rows()), /HUGE|ordinary body/);
      const end = f.rows().find(e => e.type === "tool_execution_end");
      assert.equal(!!end.result, scenario !== "failed");
    } finally { bridge.dispose(); }
  }
});

test("H4 entry point registers the launch flag before lifecycle handlers", () => {
  const calls: string[] = [];
  const pi = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => {
    calls.push(`${String(key)}:${String(args[0])}`);
    return () => {};
  } });
  conductor(pi as never);
  assert.equal(calls[0], "registerFlag:conductor-launch");
});

test("H11 hello reports the executing host Pi, not conductor's imported library copy", async t => {
  const { VERSION } = await import("@earendil-works/pi-coding-agent");
  const root = tmpDir("h11-host-pi-"), cli = join(root, "dist", "bundle", "cli.js");
  mkdirSync(join(root, "dist", "bundle"), { recursive: true }); writeFileSync(cli, "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9-host", bin: { pi: "dist/bundle/cli.js" } }));
  const argv1 = process.argv[1]; process.argv[1] = cli; t.after(() => { process.argv[1] = argv1; });
  for (const [entry, expected] of [[cli, "9.9.9-host"], [join(root, "missing.js"), "unknown"]] as const) {
    process.argv[1] = entry;
    const f = fixture(), bridge = installChildBridge(f.pi as never, { env: f.env });
    try {
      f.fire("session_start", { reason: "startup" });
      const hello = JSON.parse(readFileSync(join(f.runDir, "launch/nonce-h4.json"), "utf8"));
      assert.equal(hello.piVersion, expected, "a look-alike session object is not host evidence; the executing CLI entry is");
      assert.equal(hello.piLibraryVersion, VERSION, "the imported copy is labelled separately");
    } finally { bridge.dispose(); }
  }
});
