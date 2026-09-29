// Private esbuild harness aliases Pi and all companion modules to the installed 0.87.1.
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ExtensionContext, VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installChildBridge } from "../../src/child-bridge.ts";
import { installContextRetirement } from "../../src/context-retirement.ts";
import { registerTools } from "../../src/tools.ts";
import { RunRegistry } from "../../src/runs.ts";
import { appendFileEvidence } from "../../src/file-evidence.ts";
import { writeInboxRequest, readInboxAck, readInbox, inboxMarker, CONTROL_PREFIX, type InboxRequest } from "../../src/herdr/inbox.ts";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

export async function nativeWitness(root: string, scenario: string, t: TestContext) {
  assert.equal(VERSION, "0.87.1");
  const runId = `oracle-${scenario}`, runDir = join(root, runId), agentDir = join(runDir, "agent");
  mkdirSync(join(runDir, "session"), { recursive: true });
  let sm = SessionManager.create(runDir, join(runDir, "session"));
  const binding = { runId, launchNonce: "nonce-1", sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), paneId: "fake-pane", terminalId: "fake-terminal", tabId: "fake-tab", workspaceId: "fake-workspace", socketPath: join(root, "fake.sock"), createdTab: true };
  const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_DIR: runDir, CONDUCTOR_RUN_ID: runId,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: binding.socketPath, HERDR_PANE_ID: binding.paneId, HERDR_TAB_ID: binding.tabId, HERDR_WORKSPACE_ID: binding.workspaceId };
  const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "offline", contextWindow: 8192, maxTokens: 1024 }] });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const settings = { compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: (scenario.includes("threshold") || (scenario.startsWith("early-between-turn") || scenario.startsWith("boundary-end"))) ? 8191 : 0 }, retry: { enabled: false }, cacheWarming: "off" };
  const settingsManager = SettingsManager.inMemory(settings);
  let bridge!: ReturnType<typeof installChildBridge>, session: any, nativeCtx: any, sequence = 0, shutdowns = 0, starts = 0;
  const modelInputs: string[][] = [];
  const errors: any[] = [], seen: string[] = [], inputs: string[] = [], compactEvents: any[] = [];
  let intercept = scenario === "intercept", settling = false;
  let late: InboxRequest | undefined, compactionMode = scenario;
  const held = deferred(), entered = deferred();
  let holdPreflight = scenario === "inflight";
  const boundaryEntered = deferred(), releaseBoundary = deferred();
  let boundaryHeld = false, boundaryContext: any;

  const put = (kind: InboxRequest["kind"] = "initial", text = "Prepared task", askId?: string) => {
    const r: InboxRequest = { v: 1, launchNonce: binding.launchNonce, requestId: `request-${++sequence}`, sequence, kind, text, ...(askId ? { askId } : {}) };
    writeInboxRequest(runDir, r); return r;
  };
  const response = (text = "offline done") => (context: any) => {
    const users = context.messages.filter((m: any) => m.role === "user").map((m: any) =>
      typeof m.content === "string" ? m.content : m.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
    modelInputs.push(users);
    const content = users.at(-1);
    seen.push(content); assert.ok(!content?.includes(CONTROL_PREFIX), "raw marker must never reach model");
    return fauxAssistantMessage(text);
  };
  async function open() {
    writeFileSync(join(runDir, "record.json"), JSON.stringify({ id: runId, runtime: "herdr", herdr: binding }));
    const loader = new DefaultResourceLoader({ cwd: runDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(faux.provider); pi.registerFlag("conductor-launch", { type: "string" });
        pi.on("agent_settled", () => {
          if (scenario === "settle-race" && !settling) { settling = true; late = put("steer", "Too late"); t.mock.timers.tick(250); }
        });
        const holdBoundary = async (_e: unknown, ctx: ExtensionContext) => {
          if (!boundaryHeld) { boundaryHeld = true; boundaryContext = ctx; boundaryEntered.resolve(); await releaseBoundary.promise; }
        };
        if (scenario.startsWith("boundary-start")) pi.on("turn_start", holdBoundary);
        if (scenario.startsWith("boundary-end")) pi.on("turn_end", holdBoundary);
        bridge = installChildBridge(pi, { env });
        installContextRetirement(pi);
        registerTools(pi, { getRegistry: () => new RunRegistry() } as never, env);
        if ((scenario.startsWith("early-between-turn") || scenario.startsWith("boundary-end"))) pi.registerTool({ name: "native_continue", label: "Continue", description: "Offline next-turn compaction fixture", parameters: Type.Object({}),
          async execute() { settingsManager.setCompactionEnabled(true); return { content: [{ type: "text", text: "Continue" }], details: {} }; } });
      }, pi => {
        pi.on("session_start", (_e, ctx) => { nativeCtx = ctx; });
        pi.on("input", e => { inputs.push(e.text); assert.ok(!e.text.startsWith(CONTROL_PREFIX), "marker must be consumed or transformed before later extensions"); if (intercept) return { action: "handled" }; });
        pi.on("before_agent_start", async () => { if (holdPreflight) { entered.resolve(); await held.promise; holdPreflight = false; } });
        pi.on("agent_start", () => { starts++; });
        pi.on("session_before_compact", e => {
          compactEvents.push({ type: "before", reason: e.reason });
          t.mock.timers.tick(250);
          if (compactionMode === "compaction-cancel") return { cancel: true };
          return { compaction: { summary: "Offline summary", firstKeptEntryId: compactionMode === "compaction-failure" ? "not-a-real-entry" : e.preparation.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore } };
        });
        pi.on("session_compact", async e => {
          compactEvents.push({ type: "success", reason: e.reason });
          t.mock.timers.tick(250);
          await turn();
        });
        pi.on("session_compact_failed", e => { compactEvents.push({ type: "failed", reason: e.reason, aborted: e.aborted }); });
      }],
    });
    await loader.reload(); loader.getExtensions().runtime.flagValues.set("conductor-launch", binding.launchNonce);
    ({ session } = await createAgentSession({ cwd: runDir, agentDir, modelRuntime: runtime, model: faux.getModel(), resourceLoader: loader, settingsManager, sessionManager: sm, tools: ["ask_owner", ...((scenario.startsWith("early-between-turn") || scenario.startsWith("boundary-end")) ? ["native_continue"] : [])] }));
    await session.bindExtensions({ mode: "tui", onError: (e: any) => errors.push(e), shutdownHandler: () => { shutdowns++; } });
    assert.equal(JSON.parse(readFileSync(join(runDir, "launch", `${binding.launchNonce}.json`), "utf8")).piVersion, "0.87.1");
  }
  const close = async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); bridge.dispose(); session.dispose(); };
  const tick = async () => { t.mock.timers.tick(250); await turn(); };
  const ack = (r: InboxRequest) => readInboxAck(runDir, r);
  const settle = () => { const d = deferred(); const off = session.subscribe((e: any) => { if (e.type === "agent_settled") { off(); d.resolve(); } }); return d.promise; };
  const record = () => JSON.parse(readFileSync(join(runDir, "record.json"), "utf8"));
  const savedEnv = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "1";
  try {
    await open();
    if (scenario.startsWith("boundary-")) {
      const faultBytes = scenario.includes("-fault-") ? Number(scenario.split("-").at(-1)) : undefined;
      const ending = scenario.startsWith("boundary-end"), reload = scenario.endsWith("reload") || faultBytes !== undefined;
      const phaseEntered = deferred(), releasePhase = deferred();
      const nativeAuth = session._getSummarizationRequestAuth;
      const auth = ending ? t.mock.method(session, "_getSummarizationRequestAuth", async (...args: any[]) => {
        phaseEntered.resolve(); await releasePhase.promise; return nativeAuth.apply(session, args);
      }) : undefined;
      faux.setResponses(ending ? [fauxAssistantMessage([fauxToolCall("native_continue", {}, { id: "continue-1" })], { stopReason: "toolUse" }), response("Next turn")]
        : [async () => { phaseEntered.resolve(); await releasePhase.promise; return fauxAssistantMessage("Held stream"); }, response()]);
      const operation = session.prompt("Boundary seed");
      const send = t.mock.method(session, "sendUserMessage");
      let r: InboxRequest;
      try {
        await boundaryEntered.promise;
        const signal = boundaryContext.signal;
        assert.ok(signal && !signal.aborted);
        if (reload) {
          const originalWrite = fs.writeSync;
          let remaining = faultBytes ?? 0;
          const write = faultBytes === undefined ? undefined : t.mock.method(fs, "writeSync", (fd: number, buffer: Buffer, offset: number, length: number) => {
            if (!buffer.includes('"type":"message_end"') || !buffer.includes('"_c"')) return originalWrite(fd, buffer, offset, length);
            if (remaining === 0) throw new Error("boundary reload tee full disk");
            const n = originalWrite(fd, buffer, offset, Math.min(length, remaining)); remaining -= n; return n;
          });
          syncBuiltinESMExports();
          try { await session.reload(); } finally { write?.mock.restore(); syncBuiltinESMExports(); }
          if (faultBytes !== undefined) assert.equal(remaining, 0, "zero/partial tee failure must occur during boundary-time reload");
          assert.throws(() => boundaryContext.signal, /no longer active|invalid|reload/i, "old runner context is invalidated");
          assert.equal(nativeCtx.signal, signal);
        }
        const beforeLateEvent = readFileSync(join(runDir, "transcript.jsonl"));
        releaseBoundary.resolve(); await phaseEntered.promise;
        if (reload) assert.ok(readFileSync(join(runDir, "transcript.jsonl")).subarray(beforeLateEvent.length).toString("utf8").split("\n").filter(Boolean)
          .every(line => JSON.parse(line).type !== (ending ? "turn_end" : "turn_start")), "disposed boundary callback must not project its late event");
        r = put("steer", "  Boundary control\r\n漢🙂  ");
        assert.equal(nativeCtx.isIdle(), false); assert.ok(nativeCtx.signal && !nativeCtx.signal.aborted);
        await tick();
        if (ending) {
          assert.equal(session.isCompacting, true);
          assert.deepEqual(readInbox(runDir, r.launchNonce), [{ request: r, dispatched: false }], "boundary-time reload must retain turn_end bookkeeping before native compaction");
          assert.equal(send.mock.callCount(), 0); assert.equal(ack(r), undefined);
        } else {
          assert.equal(ack(r)?.accepted, true, "boundary-time reload must retain turn_start bookkeeping for healthy streaming steer");
          assert.equal(send.mock.callCount(), 1);
        }
      } finally { releaseBoundary.resolve(); releasePhase.resolve(); await operation; auth?.mock.restore(); send.mock.restore(); }
      if (faultBytes !== undefined) {
        const damaged = readFileSync(join(runDir, "transcript.jsonl"));
        await session.reload(); await tick();
        assert.equal(ack(r!), undefined); assert.equal(shutdowns, 0);
        assert.deepEqual(readFileSync(join(runDir, "transcript.jsonl")), damaged, "late boundary cannot resurrect the poisoned writer");
        assert.equal(errors.length, 1); assert.match(errors[0].error, /boundary reload tee full disk/);
        return { version: VERSION, scenario, faultBytes, shutdowns, ack: false };
      }
      if (ending) {
        settingsManager.setCompactionEnabled(false);
        faux.setResponses([response()]); const done = settle(); await tick(); await done;
      }
      assert.equal(ack(r!)?.accepted, true); assert.ok(modelInputs.at(-1)?.includes(r!.text));
      assert.equal(inputs.filter(text => text === r!.text).length, 1); assert.equal(shutdowns, 0);
    } else if (scenario.startsWith("early-")) {
      faux.setResponses([response("Unaccepted seed history")]); await session.prompt("Human seed");
      const r = put("initial", "  Held-auth task\r\n漢🙂  ");
      const requestPath = join(runDir, "inbox", r.launchNonce, `${String(r.sequence).padStart(6, "0")}-${r.requestId}.json`);
      const requestBytes = readFileSync(requestPath);
      const authEntered = deferred(), releaseAuth = deferred();
      const nativeAuth = session._getSummarizationRequestAuth;
      const auth = t.mock.method(session, "_getSummarizationRequestAuth", async (...args: any[]) => {
        authEntered.resolve(); await releaseAuth.promise;
        if (scenario.endsWith("auth-failure")) throw new Error("held native summarization auth failure");
        return nativeAuth.apply(session, args);
      });
      const send = t.mock.method(session, "sendUserMessage");
      const manual = scenario.startsWith("early-manual"), betweenTurns = (scenario.startsWith("early-between-turn") || scenario.startsWith("boundary-end"));
      if (!manual) {
        settingsManager.setCompactionEnabled(!betweenTurns);
        faux.setResponses(betweenTurns ? [fauxAssistantMessage([fauxToolCall("native_continue", {}, { id: "continue-1" })], { stopReason: "toolUse" }), response("Next turn")]
          : scenario.endsWith("overflow") ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 9000 tokens > 8192 maximum" }), response("Recovery")]
          : [response("Threshold continued")]);
      }
      const operation = (manual ? session.compact() : session.prompt("Trigger early compaction")).then(() => undefined, (e: Error) => e);
      let operationError: Error | undefined;
      try {
        await authEntered.promise;
        assert.equal(session.isCompacting, true);
        assert.equal(nativeCtx.isIdle(), false, "public idle reflects the early native controller");
        assert.equal(nativeCtx.signal !== undefined, betweenTurns, "between-turn compaction retains the native run signal");
        assert.equal(compactEvents.length, 0, "auth is held before session_before_compact");
        await tick();
        assert.deepEqual(readInbox(runDir, r.launchNonce), [{ request: r, dispatched: false }], "native held-auth compaction must leave the request undispatched");
        assert.deepEqual(readFileSync(requestPath), requestBytes, "held-auth request bytes remain untouched");
        assert.equal(ack(r), undefined); assert.equal(send.mock.callCount(), 0, "no native prompt invocation during compaction auth");
        if (scenario.endsWith("reload")) {
          await session.reload(); await tick();
          assert.deepEqual(readInbox(runDir, r.launchNonce), [{ request: r, dispatched: false }], "reload must not turn an active run signal into compaction dispatch permission");
          assert.equal(send.mock.callCount(), 0);
        }
        if (scenario.endsWith("cancel")) session.abortCompaction();
      } finally { releaseAuth.resolve(); operationError = await operation; auth.mock.restore(); send.mock.restore(); }
      if (manual && scenario !== "early-manual-success") assert.ok(operationError, "manual auth failure/cancel must actually reject");
      else assert.equal(operationError, undefined);
      if (scenario.includes("threshold") || betweenTurns) assert.ok(compactEvents.some(e => e.type === "failed" && e.reason === "threshold"), "automatic threshold completion/cancellation is observed");
      else assert.ok(compactEvents.some(e => e.type === (scenario.endsWith("auth-failure") || scenario.endsWith("cancel") ? "failed" : "success")));
      settingsManager.setCompactionEnabled(false);
      faux.setResponses([response()]); const done = settle(); await tick(); await done;
      assert.equal(ack(r)?.accepted, true); assert.ok(modelInputs.at(-1)?.includes(r.text), "provider receives the exact held-auth request alongside A2 guidance");
      assert.equal(inputs.filter(text => text === r.text).length, 1); assert.equal(shutdowns, 1);
    } else if (scenario.startsWith("streaming-")) {
      const providerEntered = deferred(), releaseProvider = deferred();
      faux.setResponses([async () => { providerEntered.resolve(); await releaseProvider.promise; return fauxAssistantMessage("Streaming seed finished"); }, response()]);
      const operation = session.prompt("Human seed");
      const send = t.mock.method(session, "sendUserMessage");
      const r = put(scenario.endsWith("steer") ? "steer" : "follow_up", "  Live control\r\n漢🙂  ");
      try {
        await providerEntered.promise;
        assert.equal(nativeCtx.isIdle(), false); assert.ok(nativeCtx.signal && !nativeCtx.signal.aborted);
        if (scenario.includes("reload")) {
          const signal = nativeCtx.signal;
          await session.reload();
          assert.equal(nativeCtx.signal, signal, "native signal identity survives same-process reload");
        }
        await tick();
        assert.equal(ack(r)?.accepted, true, "healthy live streaming controls must not be blocked by the early-compaction guard");
        assert.equal(send.mock.callCount(), 1); assert.ok(session.pendingMessageCount > 0);
      } finally { releaseProvider.resolve(); await operation; send.mock.restore(); }
      assert.equal(seen.at(-1), r.text); assert.equal(inputs.filter(text => text === r.text).length, 1);
      assert.equal(shutdowns, 0, "a live control alone is not initial assignment acceptance");
    } else if (["compaction-success", "compaction-failure", "compaction-cancel", "threshold", "overflow"].includes(scenario)) {
      faux.setResponses([response("Unaccepted seed history")]); await session.prompt("Human seed");
      const r = put();
      if (scenario.startsWith("compaction-")) {
        if (scenario === "compaction-failure") {
          // Native failure after before_compact, without relying on a provider/network error.
          const append = t.mock.method(sm, "appendCompaction", () => { throw new Error("native compaction failed"); });
          try { await assert.rejects(session.compact(), /native compaction failed/); } finally { append.mock.restore(); }
        } else if (scenario === "compaction-cancel") await assert.rejects(session.compact(), /cancelled/);
        else await session.compact();
      } else {
        settingsManager.setCompactionEnabled(true);
        faux.setResponses(scenario === "overflow" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 9000 tokens > 8192 maximum" }), response("Overflow recovered")] : [response("Threshold continued")]);
        await session.prompt("Trigger native recovery");
        settingsManager.setCompactionEnabled(false);
      }
      assert.equal(ack(r), undefined, "no input during native compaction, including asynchronous success handlers");
      if (scenario === "threshold") assert.ok(compactEvents.some(e => e.type === "failed" && e.reason === "threshold" && e.aborted), "A2 cancellation emits native failure terminal");
      else if (scenario === "overflow") assert.ok(compactEvents.some(e => e.type === "success" && e.reason === "overflow"), "positive overflow recovery remains enabled");
      else assert.ok(compactEvents.some(e => e.type === (scenario === "compaction-success" ? "success" : "failed")));
      faux.setResponses([response()]); const done = settle(); await tick(); await done;
      assert.equal(ack(r)?.accepted, true, "native compaction terminal must reopen pump");
      assert.equal(shutdowns, 1);
    } else if (scenario === "ask-reply" || scenario === "stale-branch") {
      const path = join(runDir, "evidence.txt"); writeFileSync(path, "CRLF\r\n漢🙂 & <payload>\r\n");
      faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_owner", { question: "Choose?", files: [path] }, { id: "ask-native" })], { stopReason: "toolUse" })]);
      const r = put(); const done = settle(); await tick(); await done;
      assert.equal(ack(r)?.accepted, true); assert.equal(shutdowns, 1);
      const result: any = sm.getBranch().filter(e => e.type === "message").at(-1);
      assert.equal(result.message.details.askId, "ask-native"); assert.equal(result.message.isError, false);
      const answer = appendFileEvidence("  Answer\r\n🙂  ", [path], { cwd: runDir, registry: new RunRegistry() });
      writeFileSync(path, "CHANGED AFTER ACCEPTANCE");
      await close(); binding.launchNonce = "nonce-2"; sm = SessionManager.open(binding.sessionFile!);
      if (scenario === "stale-branch") sm.branch(sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id);
      await open();
      const reply = put("reply", answer, "ask-native");
      faux.setResponses([response()]);
      if (scenario === "stale-branch") {
        await tick(); assert.equal(ack(reply)?.code, "stale-ask"); assert.equal(shutdowns, 1); assert.equal(starts, 1);
      } else {
        const doneReply = settle(); await tick(); await doneReply;
        assert.equal(ack(reply)?.accepted, true); assert.equal(shutdowns, 2);
        assert.equal(seen.at(-1), `<owner-answer ask-id="ask-native">\nQuestion: Choose?\nAnswer: ${answer}\nContinue the original assignment, not a new task.\n</owner-answer>`);
        assert.equal(seen.at(-1)!.split("<owner-answer").length, 2, "owner framing exactly once");
        assert.ok(seen.at(-1)!.includes("CRLF\r\n漢🙂 &amp; &lt;payload&gt;\r\n"));
      }
      assert.equal(record().herdr.launchNonce, "nonce-2");
    } else {
      const text = "  /skill:literal\r\n漢🙂\u2028\u2029\n<files>snapshot</files>  ";
      const r = put("initial", text);
      if (scenario === "preflight") session.agent.state.model = undefined;
      faux.setResponses([response()]);
      if (scenario === "ack-failure") {
        const native = fs.writeSync;
        const write = t.mock.method(fs, "writeSync", (fd: number, buffer: Buffer, offset: number, length: number) => {
          if (buffer.includes('"accepted":true')) throw new Error("native ack write failure");
          return native(fd, buffer, offset, length);
        }); syncBuiltinESMExports();
        try { await tick(); } finally { write.mock.restore(); syncBuiltinESMExports(); }
        assert.equal(ack(r), undefined); assert.equal(faux.state.callCount, 0); assert.deepEqual(inputs, []);
        await session.reload(); await tick(); assert.equal(ack(r), undefined); assert.equal(starts, 0);
        assert.equal(faux.state.callCount, 0, "faulted input cannot resurrect on reload");
      } else if (scenario === "intercept" || scenario === "preflight") {
        await tick();
        assert.equal(ack(r)?.accepted, true, "bridge input accepted even though native run never starts");
        assert.equal(starts, 0); assert.equal(faux.state.callCount, 0); assert.equal(shutdowns, 0);
        assert.deepEqual(inputs, [text]);
        await session.reload(); await tick(); assert.equal(inputs.length, 1, "durable ack suppresses replay even without execution");
        if (scenario === "preflight") assert.ok(errors.some(e => /No model selected/.test(e.error)));
      } else if (scenario === "inflight") {
        t.mock.timers.tick(250); await entered.promise;
        assert.equal(ack(r)?.accepted, true); assert.equal(starts, 0);
        const second = put("steer", "Must wait for native start"); await tick(); assert.equal(ack(second), undefined);
        const done = settle(); held.resolve(); await done;
        await tick(); assert.equal(ack(second), undefined, "settled while pump held means no accepted control");
      } else {
        const done = settle(); await tick(); await done; await turn();
        assert.equal(ack(r)?.accepted, true); assert.deepEqual(seen, [text]); assert.deepEqual(inputs, [text]); assert.equal(shutdowns, 1);
        if (scenario === "settle-race") { assert.ok(late); assert.equal(ack(late!), undefined, "native deferred settle marker is handled without ack"); }
        await session.prompt(CONTROL_PREFIX + "foreign:1:unknown");
        await session.reload(); await tick(); assert.equal(seen.length, 1); assert.equal(shutdowns, 1);
      }
    }
    if (scenario !== "preflight") assert.deepEqual(errors, []);
    return { version: VERSION, scenario, starts, shutdowns, providerCalls: faux.state.callCount, compaction: compactEvents };
  } finally {
    held.resolve(); await close();
    if (savedEnv === undefined) delete process.env.CONDUCTOR_SUBAGENT; else process.env.CONDUCTOR_SUBAGENT = savedEnv;
  }
}
