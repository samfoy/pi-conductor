import { CONTROL_PREFIX, dispatchInboxRequest, inboxMarker, readInbox, readInboxAck, writeInboxAck } from "./herdr/inbox.ts";
import { formatOwnerAnswer } from "./ask-owner.ts";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import packageInfo from "../package.json" with { type: "json" };
import { isRecord } from "./herdr/cli.ts";
import type { HerdrBinding, LaunchHello } from "./herdr/identity.ts";
import { readProcessStartTime } from "./reconcile-startup.ts";

const PROTOCOL = 1;
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\0\r\n]/.test(value);
const path = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
type Hello = LaunchHello & Pick<HerdrBinding, "terminalId">;
interface BridgeOptions { env?: NodeJS.ProcessEnv; now?: () => number }

// A full disk cannot reliably store a failure marker. Keep faults for this process's
// lifetime, across module reload; disposal must never erase an incomplete invocation.
const faultKey = Symbol.for("pi-conductor.child-bridge.tee-faults.v1");
// Keep phase handoffs, not native contexts: a snapshotted handler may run after
// reload invalidates its context. Only the matching invocation/signal may update it.
interface TurnPhase { identity: string; owner: object; signal?: AbortSignal; active: boolean }
const turnKey = Symbol.for("pi-conductor.child-bridge.turn-phases.v2");
const processState = globalThis as typeof globalThis & { [faultKey]?: Set<string>; [turnKey]?: Map<string, TurnPhase> };
const faultIdentity = (h: Hello): string => JSON.stringify([h.runId, h.launchNonce, h.sessionId, h.sessionFile, h.pid, h.pidStartTime]);

function writeAll(fd: number, buffer: Buffer): void {
  for (let offset = 0; offset < buffer.length;) {
    const count = writeSync(fd, buffer, offset, buffer.length - offset);
    if (count <= 0) throw new Error("incomplete transcript write");
    offset += count;
  }
}

function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("invalid identity file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

function sameHello(value: unknown, expected: Hello): boolean {
  return isRecord(value) && Object.entries(expected).every(([key, v]) => value[key] === v);
}
function exclusive(file: string, value: Hello): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeAll(fd, Buffer.from(JSON.stringify(value) + "\n")); } finally { closeSync(fd); }
}
function statePresent(file: string, expected: Hello): boolean {
  try {
    if (!sameHello(readJson(file), expected)) throw new Error("invocation state conflict");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function installChildBridge(pi: ExtensionAPI, options: BridgeOptions = {}) {
  const env = { ...(options.env ?? process.env) };
  const now = options.now ?? Date.now;
  let fd: number | undefined;
  let hello: Hello | undefined;
  let pending: unknown;
  let accepted = false, closing = false;
  let ctxRef: ExtensionContext | undefined;
  let statePath = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let compacting = false, compactionFinished = false;
  let inFlight: { text?: string } | undefined;
  const executingAsks = new Set<string>();
  const runDir = env.CONDUCTOR_RUN_DIR ?? "";
  const updates = new Map<string, number>();
  const compactions = new Set<string>();
  const phaseOwner = {};
  let phase: TurnPhase | undefined, reloadSignal: AbortSignal | undefined;
  function forgetPhase() {
    if (phase?.owner === phaseOwner && processState[turnKey]?.get(runDir) === phase) processState[turnKey]?.delete(runDir);
  }
  function observePhase(type: unknown, signal: AbortSignal | undefined) {
    if (!phase || !signal || phase.signal !== signal || processState[turnKey]?.get(runDir) !== phase || processState[faultKey]?.has(phase.identity)) return;
    if (type === "turn_start") phase.active = true;
    if (type === "turn_end" || type === "agent_end") phase.active = false;
  }
  const dispose = (preservePhase = false) => {
    if (timer) clearInterval(timer);
    timer = undefined; compacting = false; compactionFinished = false; inFlight = undefined; executingAsks.clear();
    try { flush(); } finally {
      if (!preservePhase || (phase && processState[faultKey]?.has(phase.identity))) { reloadSignal = undefined; forgetPhase(); }
      if (fd !== undefined) { const owned = fd; fd = undefined; closeSync(owned); }
      hello = undefined; pending = undefined; updates.clear(); compactions.clear();
      ctxRef = undefined; accepted = false; closing = false;
    }
  };
  const write = (record: Record<string, unknown>) => {
    try {
      const buffer = Buffer.from(JSON.stringify({ ...record, _c: { n: hello!.launchNonce } }) + "\n", "utf8");
      writeAll(fd!, buffer);
    } catch (error) {
      if (hello) (processState[faultKey] ??= new Set()).add(faultIdentity(hello));
      throw error;
    }
  };
  function flush() {
    const message = pending; pending = undefined;
    if (message !== undefined && fd !== undefined) write({ type: "message_end", message });
  }
  function failed(ctx: ExtensionContext, error: unknown) {
    pending = undefined;
    dispose();
    ctx.ui.notify(`conductor child bridge inert: ${(error as Error).message}`, "warning");
  }
  function observe(event: Record<string, unknown>, ctx: ExtensionContext) {
    if (!hello) { observePhase(event.type, reloadSignal); return; }
    if (closing) return;
    try {
      flush();
      const type = event.type;
      const signal = ctx.signal;
      if (phase && (type === "agent_start" || type === "turn_start") && phase.signal !== signal) { phase.signal = signal; phase.active = false; }
      observePhase(type, signal);
      if (type === "session_before_compact") { compacting = true; compactionFinished = false; }
      if (type === "session_compact" || type === "session_compact_failed") compactionFinished = true;
      if (compactionFinished && (type === "turn_start" || type === "before_agent_start" || type === "agent_before_settle")) compacting = false;
      if (type === "tool_execution_start" && event.toolName === "ask_owner" && typeof event.toolCallId === "string") executingAsks.add(event.toolCallId);
      if (type === "turn_end") executingAsks.clear();
      if (inFlight?.text !== undefined && (type === "agent_start" || (type === "message_start" && isRecord(event.message) && event.message.role === "user" &&
          Array.isArray(event.message.content) && event.message.content.some(p => isRecord(p) && p.type === "text" && p.text === inFlight?.text)))) inFlight = undefined;
      if (type === "message_end") {
        if (isRecord(event.message) && event.message.role !== "compactionSummary") pending = event.message;
      } else if (type === "agent_start" || type === "agent_end" || type === "agent_settled") {
        write({ type });
        if (type === "agent_settled" && accepted) {
          exclusive(`${statePath}.closing.json`, hello);
          closing = true;
          forgetPhase();
          ctx.shutdown(); // Request only: the parent must separately prove process exit.
        }
      } else if (type === "turn_end" || type === "turn_start") write({ type, turnIndex: event.turnIndex });
      else if (type === "tool_execution_start") write({ type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      else if (type === "tool_execution_update" && typeof event.toolCallId === "string") {
        const at = now(), prior = updates.get(event.toolCallId);
        if (prior === undefined || at - prior >= 5000) {
          updates.set(event.toolCallId, at);
          write({ type, toolCallId: event.toolCallId, toolName: event.toolName });
        }
      } else if (type === "tool_execution_end") {
        let result: unknown;
        if (event.toolName === "ask_owner" && event.isError === false) {
          const details = isRecord(event.result) && event.result.details;
          if (!isRecord(details) || details.askId !== event.toolCallId || typeof details.question !== "string" || !details.question.trim() || typeof details.evidence !== "string" ||
              Buffer.byteLength(details.evidence) > 4 * 1048576) throw new Error("invalid ask_owner details or evidence cap");
          result = { details: { askId: details.askId, question: details.question, evidence: details.evidence } };
          if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1048576) throw new Error("ask_owner details exceed bridge cap; not accepted");
        }
        write({ type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, ...(result ? { result } : {}) });
        if (typeof event.toolCallId === "string") updates.delete(event.toolCallId);
      } else if (type === "ui_prompt_start" || type === "ui_prompt_end") {
        write({ type: "conductor_child", v: 1, event: "ui_prompt", state: type === "ui_prompt_start" ? "start" : "end", kind: event.kind, title: event.title });
      } else if (type === "session_compact" && isRecord(event.compactionEntry) && typeof event.compactionEntry.id === "string" && !compactions.has(event.compactionEntry.id)) {
        compactions.add(event.compactionEntry.id);
        write({ type: "message_end", message: { role: "compactionSummary" } });
      }
    } catch (error) { failed(ctx, error); }
  }
  // Pi 0.87 adds UI/context boundary events absent from the repo's older dev declarations.
  const on = pi.on.bind(pi) as unknown as (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void) => void;
  for (const name of ["agent_start", "agent_end", "agent_settled", "agent_before_settle", "turn_start", "turn_end", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_call", "tool_result", "ui_prompt_start", "ui_prompt_end",
    "session_compact", "session_compact_failed", "session_before_compact", "session_before_tree", "session_tree", "session_info_changed", "resources_discover",
    "context", "context_with_system", "before_agent_start", "before_provider_request", "before_provider_headers", "after_provider_response",
    "model_select", "thinking_level_select", "cache_warming_decision", "input", "user_bash"]) on(name, observe);
  pi.on("session_start", (event, ctx) => {
    dispose();
    const nonce = pi.getFlag("conductor-launch");
    if (env.CONDUCTOR_SUBAGENT !== "1" || env.CONDUCTOR_RUNTIME !== "herdr" || nonce === undefined) return;
    try {
      const runId = env.CONDUCTOR_RUN_ID, runDir = env.CONDUCTOR_RUN_DIR;
      const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile();
      if (!token(nonce) || !token(runId) || !path(runDir) || basename(runDir) !== runId || realpathSync(runDir) !== runDir ||
          !token(sessionId) || !path(sessionFile) || dirname(sessionFile) !== join(runDir, "session") ||
          realpathSync(dirname(sessionFile)) !== dirname(sessionFile)) throw new Error("invalid invocation paths or identity");
      // Parent-persisted H3 binding is authority; inherited pane variables alone cannot claim a run.
      const record = readJson(join(runDir, "record.json"));
      const b = isRecord(record) && record.herdr;
      if (!isRecord(record) || record.id !== runId || record.runtime !== "herdr" || !isRecord(b) ||
          b.runId !== runId || b.launchNonce !== nonce || b.sessionId !== sessionId || b.sessionFile !== sessionFile ||
          env.HERDR_ENV !== "1" || !path(b.socketPath) || b.socketPath !== env.HERDR_SOCKET_PATH ||
          !text(b.paneId) || b.paneId !== env.HERDR_PANE_ID || !text(b.tabId) || b.tabId !== env.HERDR_TAB_ID ||
          !text(b.workspaceId) || b.workspaceId !== env.HERDR_WORKSPACE_ID || !text(b.terminalId) ||
          typeof b.createdTab !== "boolean") throw new Error("run binding mismatch");
      try {
        const stat = lstatSync(sessionFile);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("invalid session file");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const pidStartTime = readProcessStartTime(process.pid);
      if ((b.childPid !== undefined && b.childPid !== process.pid) || (b.childStartTime !== undefined && b.childStartTime !== pidStartTime)) throw new Error("recorded process mismatch");
      if (process.pid <= 1 || (process.platform === "linux" && !pidStartTime)) throw new Error("missing process identity");
      const expected: Hello = { v: 1, bridgeProtocol: PROTOCOL, runId, launchNonce: nonce, pid: process.pid, pidStartTime,
        paneId: b.paneId, terminalId: b.terminalId, sessionId, sessionFile, piVersion: VERSION, conductorVersion: packageInfo.version, at: Date.now() };
      if (processState[faultKey]?.has(faultIdentity(expected))) throw new Error("invocation tee previously failed; reload cannot resume it; preserve evidence for the parent");
      const launchDir = join(runDir, "launch");
      mkdirSync(launchDir, { recursive: true });
      if (realpathSync(launchDir) !== launchDir) throw new Error("invalid launch directory");
      const claim = join(launchDir, `${nonce}.json`);
      let reload = false;
      try { exclusive(claim, expected); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = readJson(claim);
        if (event.reason !== "reload" || !isRecord(prior) || !Object.entries(expected).every(([key, value]) => key === "at" || prior[key] === value) ||
            typeof prior.at !== "number" || !Number.isFinite(prior.at) || prior.at < 0) throw new Error("launch claim conflict");
        expected.at = prior.at;
        reload = true;
      }
      statePath = join(launchDir, nonce);
      accepted = statePresent(`${statePath}.accepted.json`, expected) || readInbox(runDir, nonce).some(({ request }) =>
        (request.kind === "initial" || request.kind === "reply") && readInboxAck(runDir, request)?.accepted === true);
      closing = statePresent(`${statePath}.closing.json`, expected);
      if (closing && !accepted) throw new Error("closing without initial acceptance");
      hello = expected;
      ctxRef = ctx;
      if (closing) return;
      const phases = processState[turnKey] ??= new Map<string, TurnPhase>();
      const priorPhase = phases.get(runDir), identity = faultIdentity(expected), signal = ctx.signal;
      phase = reload && priorPhase && priorPhase.identity === identity ? priorPhase : { identity, owner: phaseOwner, active: false };
      if (phase.signal !== signal) phase.active = false;
      phase.signal = signal; phase.owner = phaseOwner;
      phases.set(runDir, phase);
      fd = openSync(join(runDir, "transcript.jsonl"), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) throw new Error("invalid transcript file");
      if (!reload) write({ type: "conductor_child", event: "launch", ...hello });
      timer = setInterval(pump, 250);
      timer.unref();
    } catch (error) {
      failed(ctx, error);
    }
  });
  function ownerAsk(ctx: ExtensionContext): { askId: string; question: string } | undefined {
    const messages = ctx.sessionManager.getBranch().filter(e => e.type === "message").map(e => e.message);
    const result = messages.at(-1), assistant = messages.at(-2);
    if (result?.role !== "toolResult" || result.toolName !== "ask_owner" || result.isError !== false || assistant?.role !== "assistant") return;
    const calls = assistant.content.filter(p => p.type === "toolCall");
    const details = result.details;
    if (calls.length !== 1 || calls[0].name !== "ask_owner" || calls[0].id !== result.toolCallId || !isRecord(details) ||
        details.askId !== result.toolCallId || typeof details.question !== "string" || !details.question.trim() || typeof details.evidence !== "string" ||
        Buffer.byteLength(details.evidence) > 4 * 1048576 || typeof calls[0].arguments.question !== "string" || calls[0].arguments.question.trim() !== details.question) return;
    return { askId: result.toolCallId, question: details.question };
  }
  function pump() {
    if (!hello || !ctxRef || closing || inFlight) return;
    if (compacting && compactionFinished && ctxRef.isIdle()) compacting = false;
    if (compacting) return;
    try {
      const entries = readInbox(runDir, hello.launchNonce);
      const unacked = entries.filter(e => !readInboxAck(runDir, e.request));
      // A void native call may have been lost before input. Preserve its renamed request;
      // neither a tick nor reload can infer rejection or automatically replay it.
      if (unacked.some(e => e.dispatched)) return;
      const next = unacked[0];
      if (!next) return;
      // isIdle includes native compaction before session_before_compact. A live
      // signal permits controls only inside a turn, not during between-turn auth.
      const signal = ctxRef.signal;
      if (!ctxRef.isIdle() && (!signal || signal.aborted || phase?.signal !== signal || !phase.active)) return;
      dispatchInboxRequest(runDir, next.request);
      inFlight = {};
      pi.sendUserMessage(inboxMarker(next.request), { deliverAs: next.request.kind === "steer" || next.request.kind === "grace" ? "steer" : "followUp" });
    } catch (error) { failed(ctxRef!, error); }
  }
  pi.on("input", (event, ctx) => {
    if (!event.text.startsWith(CONTROL_PREFIX) || env.CONDUCTOR_SUBAGENT !== "1" || env.CONDUCTOR_RUNTIME !== "herdr" || pi.getFlag("conductor-launch") === undefined) return;
    if (!hello || closing || compacting) return { action: "handled" };
    try {
      const entries = readInbox(runDir, hello.launchNonce);
      const entry = entries.find(e => e.dispatched && inboxMarker(e.request) === event.text);
      if (!entry || readInboxAck(runDir, entry.request)) return { action: "handled" };
      const r = entry.request, ask = ownerAsk(ctx);
      const busy = executingAsks.size > 0 || (r.kind === "reply" ? !ctx.isIdle() || ctx.hasPendingMessages() : !!ask);
      const duplicateReply = r.kind === "reply" && entries.some(e => e.request.kind === "reply" && e.request.askId === r.askId && readInboxAck(runDir, e.request)?.accepted);
      const code = busy ? "busy" : r.kind === "reply" && (!ask || ask.askId !== r.askId || duplicateReply) ? "stale-ask" : undefined;
      const transformed = r.kind === "reply" && ask ? formatOwnerAnswer(ask, r.text) : r.text;
      // Pi catches handler exceptions and continues with raw input. Catch locally, and
      // publish acceptance here, not in the pump or after returning transformed text.
      writeInboxAck(runDir, r, code);
      if (code) { inFlight = undefined; return { action: "handled" }; }
      inFlight = { text: transformed };
      if (r.kind === "initial" || r.kind === "reply") accepted = true;
      return { action: "transform", text: transformed };
    } catch (error) {
      if (hello) (processState[faultKey] ??= new Set()).add(faultIdentity(hello));
      try { failed(ctx, error); } catch { /* Even diagnostics must not let a marker escape. */ }
      return { action: "handled" };
    }
  });
  pi.on("session_before_switch", (event, ctx) => { observe({ ...event }, ctx); return hello ? { cancel: true } : undefined; });
  pi.on("session_before_fork", (event, ctx) => { observe({ ...event }, ctx); return hello ? { cancel: true } : undefined; });
  pi.on("session_shutdown", (event, ctx) => {
    const reload = event.reason === "reload" && !!hello && !closing;
    if (reload && phase) {
      reloadSignal = ctx.signal;
      if (phase.signal !== reloadSignal) phase.active = false;
      phase.signal = reloadSignal;
    }
    dispose(reload);
  });
  return { dispose, acceptInitial(nonce: string): boolean {
    if (!hello || !ctxRef || closing || nonce !== hello.launchNonce) return false;
    try {
      if (!accepted) exclusive(`${statePath}.accepted.json`, hello);
      accepted = true;
      return true;
    } catch (error) { failed(ctxRef, error); return false; }
  } };
}
