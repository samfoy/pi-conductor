import { claimHerdrOwner, herdrModuleEpoch, ownsHerdrRun, readHerdrOwner } from "./ownership.ts";
import { readInbox } from "./inbox.ts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { hostPiVersion } from "../pi-host.ts";
import type { Delivery, DeliveryAck, HerdrTransport, RunRuntime, RunSink } from "../runtime.ts";
import { isTerminal, type Run } from "../types.ts";
import { HerdrTail } from "./tail.ts";
import { HerdrMonitor } from "./monitor.ts";
import { buildPiCoreArgs, validateSendable, writeRecord, type PiCoreArgsOptions } from "../runs.ts";
import { seedSessionFile } from "../session-seed.ts";
import { childToolScope } from "../personas.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { createLineDecoder, terminateHook } from "../subprocess-runtime.ts";
import { boundStallText, redactPaneEvidence } from "../stall-evidence.ts";
import { createHerdrCli, HerdrCliError, isRecord, type HerdrCli } from "./cli.ts";
import { sameHerdrBinding, proveChildProcess, provePaneOurs, type HerdrBinding, type HerdrInvocation, type LaunchHello } from "./identity.ts";
import { buildHerdrEnv, closeEmptyPane, createRunTab } from "./placement.ts";
import { hasPreparedInboxRequest, prepareInboxRequest, publishPreparedInboxRequest, readControlRecord, readInboxAck, writeInboxRequest, type InboxRequest } from "./inbox.ts";

export const HERDR_LAUNCH_BUDGET = { start: 65000, hello: 15000, ack: 30000, agentStart: 30000, busy: 2000, diagnostic: 2000 } as const;
export function projectTrustArgs(cwd: string, agentDir = getAgentDir()): string[] {
  return hasTrustRequiringProjectResources(cwd) && new ProjectTrustStore(agentDir).get(cwd) === null &&
    (SettingsManager.create(cwd, agentDir).getGlobalSettings().defaultProjectTrust ?? "ask") === "ask" ? ["--no-approve"] : [];
}
interface ProcessEvidence { pid: number; state: "alive" | "gone" | "unknown"; startTime?: number }
function probeProcess(pid: number): ProcessEvidence {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { pid, state: "unknown" };
  try { process.kill(pid, 0); return { pid, state: "alive", startTime: readProcessStartTime(pid) }; }
  catch (e) { return { pid, state: (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" }; }
}
interface Options {
  cli: HerdrCli; workspaceId?: string; env: NodeJS.ProcessEnv;
  trustArgs?: (cwd: string, agentDir?: string) => string[];
  piVersion?: string; platform?: string; now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  probe?: (pid: number) => ProcessEvidence;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}
const failure = (message: string) => new Error(`herdr: ${message}`);
/** Fresh physical name per launch: herdr keeps an exited agent's name on its terminal. */
export function herdrAgentName(runId: string, launchNonce: string): string {
  const base = /^[a-z][a-z0-9_-]{0,22}$/.test(runId) ? runId : `c${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`;
  return `${base}-${createHash("sha256").update(launchNonce).digest("hex").slice(0, 8)}`;
}
/** Advisory: an unprovable host version is reported, never treated as a match. */
export function piVersionWarning(lead: string, child: string): string | undefined {
  if (lead === "unknown" || child === "unknown") return `Pi version unverified: lead ${lead}, child ${child}`;
  return lead === child ? undefined : `Pi version mismatch: lead ${lead}, child ${child}`;
}

/** Gone is independently provable without a server; cached pane metadata never proves a live signal target. */
export function herdrChildAbsent(run: Pick<Run, "id" | "herdr" | "recordPath">): boolean {
  const b = run.herdr;
  if (!b || b.runId !== run.id || typeof b.sessionFile !== "string" || typeof b.socketPath !== "string" || !isAbsolute(b.socketPath) || !/^[A-Za-z0-9_-]+$/.test(b.launchNonce) ||
      dirname(b.sessionFile) !== join(dirname(run.recordPath), "session")) return false;
  try {
    const owner = readHerdrOwner(dirname(run.recordPath));
    if (owner && (owner.generation !== b.ownerGeneration || owner.launchNonce !== b.launchNonce || owner.runId !== run.id || owner.socketPath !== b.socketPath)) return false;
    const hello = readControlRecord(join(dirname(run.recordPath), "launch", `${b.launchNonce}.json`));
    const proof = proveChildProcess({ binding: b, current: b, socketPath: b.socketPath, hello,
      pane: { pane_id: b.paneId, terminal_id: b.terminalId, tab_id: b.tabId, workspace_id: b.workspaceId,
        agent: "pi", agent_session: { kind: "path", value: b.sessionFile, agent: "pi", source: "launch" } },
      platform: process.platform, bridgeProtocol: 1, process: probeProcess(b.childPid!) });
    return !proof.ok && proof.state === "gone";
  } catch { return false; }
}

export async function releaseRecordedPane(run: Pick<Run, "id" | "herdr" | "recordPath">,
  current: () => HerdrBinding | undefined, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<boolean> {
  const binding = run.herdr && { ...run.herdr };
  if (!binding || !sameHerdrBinding(binding, current()) || !herdrChildAbsent(run) || signal?.aborted) return false;
  try {
    const cli = createHerdrCli({ env, socketPath: binding.socketPath });
    const result = await closeEmptyPane(cli, binding, () =>
      !signal?.aborted && sameHerdrBinding(binding, current()) && herdrChildAbsent(run) ? binding : undefined, { timeoutMs: 2000, signal });
    return result.ok;
  } catch { return false; }
}

/** Readiness correlates input; only the attached tail delivers pipeline events. */
export class HerdrRuntime implements RunRuntime {
  constructor(private readonly options?: Options) {}
  capabilities(run: Run) { return { pause: false, liveSend: run.transport?.kind === "herdr" && run.transport.liveSend?.() === true }; }
  deliver(run: Run, type: "steer" | "follow_up" | "grace", text: string, sessionId?: string): Delivery {
    return run.transport?.kind === "herdr" && run.transport.deliver
      ? run.transport.deliver(type, text, sessionId) : { kind: "epipe", reason: "herdr child is not attached and ready" };
  }
  signal(): never { throw failure("pause is subprocess-only"); }
  stopProcess(run: Run) { return run.transport?.kind === "herdr" ? run.transport.stop() : undefined; }
  terminate(run: Run, killGroup: (pid: number, signal: NodeJS.Signals) => void) {
    terminateHook(run, killGroup);
    return this.stopProcess(run);
  }

  launch(run: Run, _args: string[], cwd: string, sink: RunSink, initialPrompt?: string, core?: PiCoreArgsOptions): HerdrTransport {
    return this.connect(run, cwd, sink, false, initialPrompt, core);
  }
  attach(run: Run, sink: RunSink): HerdrTransport { return this.connect(run, run.cwd, sink, true); }
  async inspect(run: Run) {
    if (!this.options || !run.herdr || run.herdr.socketPath !== this.options.cli.socketPath) throw failure("other-socket");
    const { cli } = this.options, probe = this.options.probe ?? probeProcess;
    const binding = { ...run.herdr }, nonce = binding.launchNonce, dir = dirname(run.recordPath);
    if (binding.runId !== run.id || !/^[A-Za-z0-9_-]+$/.test(nonce) || dirname(binding.sessionFile) !== join(dir, "session")) throw failure("reattach binding mismatch");
    const claim = readControlRecord(join(dir, "launch", `${nonce}.json`));
    if (!isRecord(claim)) throw failure("reattach missing child hello");
    const hello = claim as unknown as LaunchHello;
    binding.childPid ??= hello.pid; binding.childStartTime ??= hello.pidStartTime;
    const pane = (await cli.json(["pane", "get", binding.paneId], { timeoutMs: 2000 })).pane;
    const proof = (pane: unknown) => proveChildProcess({ binding, current: binding, socketPath: cli.socketPath, pane, hello, platform: this.options?.platform ?? process.platform, bridgeProtocol: 1, process: probe(hello.pid) });
    const recordedPane = { pane_id: binding.paneId, terminal_id: binding.terminalId, tab_id: binding.tabId, workspace_id: binding.workspaceId,
      agent: "pi", agent_session: { kind: "path", value: binding.sessionFile, agent: "pi", source: "launch" } };
    let state = proof(pane);
    if (!state.ok && probe(hello.pid).state === "gone") state = proof(recordedPane);
    if (!state.ok && state.state !== "gone") throw failure(`reattach identity unknown: ${state.reason}`);
    const provenPane = state.ok ? pane : recordedPane;
    try {
      const requests = readInbox(dir, nonce).filter(entry => entry.request.kind === "initial" || entry.request.kind === "reply");
      if (!requests.length && hasPreparedInboxRequest(dir, nonce)) throw failure("reattach: initial request prepared but never published; the child never received its task; preserved, not replayed");
      if (requests.length !== 1) throw failure("reattach initial request missing/ambiguous");
      const request = requests[0].request;
      if (!readInboxAck(dir, request)?.accepted) throw failure("reattach initial input acceptance unknown");
      // Find the exact launch boundary within the bounded, LF-aligned history window.
      let launchOffset = -1, cursor = 0, boundary = false, nativeStart = false, settled = false;
      const fd = openSync(run.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw failure("invalid recovery transcript");
        const start = Math.max(0, stat.size - 32 * 1048576), buffer = Buffer.alloc(stat.size - start);
        let bytes = 0;
        while (bytes < buffer.length) { const n = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes); if (!n) throw failure("recovery transcript changed"); bytes += n; }
        cursor = start ? buffer.indexOf(10) + 1 : 0;
        if (start && !cursor) throw failure("recovery transcript has no complete boundary");
        for (;;) {
          const end = buffer.indexOf(10, cursor); if (end < 0) break;
          let event: unknown; try { event = JSON.parse(buffer.subarray(cursor, end).toString("utf8")); } catch { cursor = end + 1; continue; }
          if (isRecord(event) && isRecord(event._c) && event._c.n === nonce) {
            if (!boundary && event.type === "conductor_child" && event.event === "launch" && Object.entries(hello).every(([key, value]) => event[key] === value)) { boundary = true; launchOffset = start + cursor; }
            if (boundary && event.type === "agent_start" && event.initialRequestId === request.requestId) nativeStart = true;
            if (nativeStart && event.type === "agent_settled") settled = true;
          }
          cursor = end + 1;
        }
      } finally { closeSync(fd); }
      if (!nativeStart || launchOffset < 0) throw failure("reattach accepted native launch boundary unavailable");
      return { binding, hello, provenPane, request, launchOffset, state: state.ok ? "alive" as const : "gone" as const, settled };
    } catch (error) {
      if (!state.ok && state.state === "gone") throw new Error("herdr: pi exited before accepted native launch evidence was complete; resources preserved", { cause: "herdr-gone-before-start" });
      throw error;
    }
  }
  async probeRecord(run: Run): Promise<"alive" | "settled" | "gone" | "unknown" | "other-socket"> {
    if (!this.options || run.herdr?.socketPath !== this.options.cli.socketPath) return "other-socket";
    try { const result = await this.inspect(run); return result.settled ? "settled" : result.state; }
    catch (error) { return error instanceof Error && error.cause === "herdr-gone-before-start" ? "gone" : "unknown"; }
  }
  private connect(run: Run, cwd: string, sink: RunSink, reattach: boolean, initialPrompt?: string, core?: PiCoreArgsOptions): HerdrTransport {
    if (!this.options) throw failure("launch requires an explicitly injected CLI");
    const options = this.options;
    const { cli, env, workspaceId } = options;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    const probe = options.probe ?? probeProcess;
    const signal = options.signal ?? process.kill;
    const abort = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const nonce = reattach ? run.herdr!.launchNonce : randomUUID(), dir = dirname(run.recordPath);
    if (!reattach) run.herdrUsageBaseline = { launchNonce: nonce, usage: { ...run.usage } };
    let detached = false;
    let ownership: import("./ownership.ts").HerdrOwnership | undefined;
    const claimOwnership = () => {
      if (run.herdrOwnership) run.herdrOwnership.release();
      ownership = claimHerdrOwner(dir, { epoch: herdrModuleEpoch, sessionId: run.parentSessionId ?? herdrModuleEpoch,
        pid: process.pid, startTime: readProcessStartTime(process.pid), socketPath: cli.socketPath, runId: run.id, launchNonce: nonce, at: Date.now() });
      run.herdrOwnership = ownership;
    };
    if (reattach) claimOwnership();
    const owned = () => !detached && !!ownership && run.herdrOwnership === ownership && ownsHerdrRun(run);
    const previous = run.herdr;
    run.herdrPrompts = undefined;
    const alias = herdrAgentName(run.id, nonce);
    let binding: HerdrBinding | undefined, hello: LaunchHello | undefined, provenPane: unknown;
    let fresh = false, accepted = false, initialAccepted = false, startAttempted = false, stderr = "", stopWork: Promise<void> | undefined;
    let tail: HerdrTail | undefined, monitor: HerdrMonitor | undefined;
    let childExited = false, observing = false, nativeSettled = false;
    let observation: { launchOffset: number; requestId: string } | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const diagnostic = (message: string) => { stderr = boundStallText(`${stderr}${stderr ? "\n" : ""}${message}`, 4096); };
    const current = (): HerdrInvocation | undefined => owned() && run.herdr === binding ? run.herdr : undefined;
    const check = () => {
      if (!owned()) throw failure("owner fenced");
      if (abort.signal.aborted) throw failure("launch cancelled");
      if (binding && run.herdr !== binding) throw failure("launch binding replaced; preserving resources");
    };
    const proof = (pane: unknown) => !owned() || cleanupSignal?.aborted
      ? { ok: false as const, state: "unknown" as const, reason: "current invocation changed or cleanup cancelled" }
      : proveChildProcess({ binding: binding && { ...binding, childPid: binding.childPid ?? hello?.pid, childStartTime: binding.childStartTime ?? hello?.pidStartTime }, current: current(), socketPath: cli.socketPath, pane, hello,
      platform: options.platform ?? process.platform, bridgeProtocol: 1, process: hello ? probe(hello.pid) : undefined });
    const getPane = async (signal?: AbortSignal) => (await cli.json(["pane", "get", binding!.paneId], { timeoutMs: 2000, signal: signal ?? cleanupSignal })).pane;
    const finishObservation = () => { tail?.close(); monitor?.close(); observing = false; if (run.herdr === binding) run.herdrPrompts = undefined; };
    const gone = () => {
      if (!owned()) return;
      tail?.drain();
      childExited = true; resolveClosed();
      tail?.drain();
      const wasObserving = observing;
      finishObservation();
      if (wasObserving && !nativeSettled) sink.gone?.(`herdr: pi exited before settling (pane ${binding?.paneId})`);
    };
    const readHello = () => {
      try { return readControlRecord(join(dir, "launch", `${nonce}.json`)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw failure("invalid launch hello"); }
    };
    const stopOwned = (rollback: boolean): Promise<void> => stopWork ??= (async () => {
      if (!owned()) return;
      if (binding && !hello) {
        try { hello = readHello() as LaunchHello | undefined; } catch { /* Preserve invalid claim evidence. */ }
      }
      if (!binding || !hello) { diagnostic("pane/worktree preserved: no proven child hello"); return; }
      try {
        let pane = await getPane();
        let state = proof(pane);
        // A previously proven child can disappear after its pane returns to the shell.
        if (!state.ok && provenPane && probe(hello.pid).state === "gone") state = proof(provenPane);
        if (!state.ok && state.state !== "gone") { diagnostic(`pane/worktree preserved: ${state.reason}`); return; }
        if (state.ok) {
          signal(state.pid, "SIGTERM"); provenPane = pane;
          const end = now() + 2000;
          while (now() < end && proof(provenPane).ok) await sleep(50, cleanupSignal);
          state = proof(provenPane);
          if (state.ok) {
            pane = await getPane(); state = proof(pane);
            if (state.ok) {
              signal(state.pid, "SIGKILL");
              const end = now() + 2000;
              while (now() < end && proof(pane).ok) await sleep(50, cleanupSignal);
              state = proof(pane);
            }
          }
        }
        if (state.ok || state.state !== "gone") { diagnostic("pane/worktree preserved: child exit unconfirmed"); return; }
        gone();
        if (rollback && fresh) {
          const result = await closeEmptyPane(cli, binding, () => current()!, { timeoutMs: 2000, signal: cleanupSignal });
          if (!result.ok) diagnostic(`pane/worktree preserved: ${result.reason}`);
        }
      } catch { diagnostic("pane/worktree preserved: child stop unconfirmed"); }
    })();
    const readStallEvidence = async () => {
      if (!owned() || !binding?.agentName || run.herdr !== binding || cleanupSignal?.aborted) return "Live pane diagnostic unavailable.";
      try {
        const text = await cli.text(["agent", "read", binding.agentName, "--source", "recent-unwrapped", "--lines", "40"],
          { timeoutMs: HERDR_LAUNCH_BUDGET.diagnostic, maxBuffer: 4096, signal: cleanupSignal });
        return redactPaneEvidence(text.split("\n").slice(-40).join("\n"), env);
      } catch { return "Live pane diagnostic unavailable; unknown dialogs are not answered automatically."; }
    };
    const ready = Promise.resolve().then(async () => {
      if (detached) throw failure("owner detached");
      if (!ownership) claimOwnership();
      check();
      if (reattach) {
        const evidence = await this.inspect(run); check();
        binding = { ...evidence.binding, ownerGeneration: ownership!.identity.generation };
        run.herdr = binding; hello = evidence.hello; provenPane = evidence.provenPane;
        const { launchOffset, request } = evidence;
        accepted = initialAccepted = true;
        observation = { launchOffset, requestId: request.requestId };
        if (request.kind === "reply") run.pendingAsk = undefined;
        if (evidence.state === "gone") { childExited = true; resolveClosed(); }
        return { binding, request, launchOffset };
      }
      if (run.runtime !== "herdr" || !core || !initialPrompt?.trim()) throw failure("missing typed launch specification");
      // The run's frozen scope, not the caller's core, decides both pane env and argv.
      const scope = childToolScope(run);
      if (run.pendingAsk && (core.kind !== "resume" || core.sessionPath !== run.sessionPath)) throw failure("answer requires the original session");
      if (core.kind === "resume" && run.sessionPath && core.sessionPath !== run.sessionPath) throw failure("resume session mismatch");
      const sessionDir = join(dir, "session");
      const sessionFile = core.kind === "resume" ? core.sessionPath : join(sessionDir, `${nonce}.jsonl`);
      if (dirname(sessionFile) !== sessionDir) throw failure("session outside run directory");
      if (core.kind === "fresh") seedSessionFile(sessionFile, [], cwd);
      const session = SessionManager.open(sessionFile, sessionDir);
      if (session.getCwd() !== cwd) throw failure("session cwd mismatch");
      const invocation = { runId: run.id, launchNonce: nonce, sessionId: session.getSessionId(), sessionFile };
      const promptPath = join(dir, `system-prompt-${nonce}.md`);
      writeFileSync(promptPath, core.systemPrompt ?? "", { flag: "wx", mode: 0o600 });
      const args = [...buildPiCoreArgs({ ...core, scope, kind: "resume", sessionPath: sessionFile, systemPrompt: promptPath }),
        ...(options.trustArgs ?? projectTrustArgs)(cwd, env.PI_CODING_AGENT_DIR), "--conductor-launch", nonce];
      if (previous) {
        try {
          const observed = await cli.json(["pane", "get", previous.paneId], { timeoutMs: 2000, signal: abort.signal });
          check();
          if (run.herdr === previous && provePaneOurs({ binding: previous, current: previous, socketPath: cli.socketPath, pane: observed.pane, requireNoAgent: true }).ok) {
            binding = { ...previous, ...invocation, createdTab: false, childPid: undefined, childStartTime: undefined };
          }
        } catch { check(); }
      }
      if (run.herdr !== previous) throw failure("launch binding replaced; preserving resources");
      if (run.effort) mkdirSync(join(dir, "tmp"), { recursive: true });
      if (!binding) {
        const workspace = workspaceId ?? (await cli.json(["pane", "get", env.HERDR_PANE_ID!], { timeoutMs: 2000, signal: abort.signal })).pane;
        const targetWorkspace = typeof workspace === "string" ? workspace : isRecord(workspace) ? workspace.workspace_id : undefined;
        if (typeof targetWorkspace !== "string") throw failure("parent workspace unavailable");
        check();
        binding = await createRunTab(cli, { workspaceId: targetWorkspace, cwd, invocation, env: buildHerdrEnv(env, { runId: run.id, runDir: dir, configCwd: run.cwd, scope,
          ...(run.effort ? { tmpDir: join(dir, "tmp") } : {}) }) }, { timeoutMs: 5000, signal: abort.signal });
        fresh = true;
      }
      if (run.herdr !== previous) throw failure("launch binding replaced; preserving resources");
      binding.ownerGeneration = ownership!.identity.generation;
      binding.agentName = alias; delete binding.versionWarning;
      delete binding.settlement; run.herdrDelivery = undefined;
      run.herdr = binding; run.sessionPath = sessionFile;
      check(); await writeRecord(run, check); check();
      const request: InboxRequest = { v: 1, launchNonce: nonce, requestId: randomUUID(), sequence: 1,
        kind: run.pendingAsk ? "reply" : "initial", text: initialPrompt, ...(run.pendingAsk ? { askId: run.pendingAsk.askId } : {}) };
      // Durable but invisible to the pump: real herdr registers only an idle child.
      prepareInboxRequest(dir, request);
      let launchOffset = 0;
      try { launchOffset = statSync(run.transcriptPath).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const startArgs = ["agent", "start", alias, "--kind", "pi", "--pane", binding.paneId, "--timeout", "60000", "--", ...args];
      let started: Record<string, unknown>;
      startAttempted = true;
      try { started = await cli.json(startArgs, { timeoutMs: HERDR_LAUNCH_BUDGET.start, signal: abort.signal }); }
      catch (e) {
        check();
        if (!(e instanceof HerdrCliError) || e.remoteCode !== "agent_pane_busy") throw failure("agent start outcome unconfirmed; no blind retry");
        await sleep(HERDR_LAUNCH_BUDGET.busy, abort.signal); check();
        const pane = await getPane(abort.signal); check();
        if (!provePaneOurs({ binding, current: current(), socketPath: cli.socketPath, pane, requireNoAgent: true }).ok) throw failure("busy retry refused: pane no longer empty and owned");
        started = await cli.json(startArgs, { timeoutMs: HERDR_LAUNCH_BUDGET.start, signal: abort.signal });
      }
      check();
      if (!isRecord(started.agent) || started.agent.name !== alias || started.agent.pane_id !== binding.paneId) throw failure("agent start registered a different agent or pane");
      const until = async <T>(budget: number, name: string, observe: () => T | undefined): Promise<T> => {
        const deadline = now() + budget;
        for (;;) {
          check(); const result = observe(); if (result !== undefined) return result;
          if (hello && provenPane) { const state = proof(provenPane); if (!state.ok) throw failure(`${name}: child ${state.state}`); }
          if (now() >= deadline) throw failure(`${name} timeout`);
          await sleep(Math.min(250, deadline - now()), abort.signal);
        }
      };
      const claim = await until(HERDR_LAUNCH_BUDGET.hello, "child hello", readHello);
      if (!isRecord(claim) || claim.bridgeProtocol !== 1) throw failure("bridge protocol mismatch");
      hello = claim as unknown as LaunchHello;
      let pane = await getPane(abort.signal); check();
      let identity = proof(pane);
      if (!identity.ok && probe(hello.pid).state === "gone") { pane = started.agent; identity = proof(pane); }
      if (!identity.ok && identity.state !== "gone") throw failure(`child identity refused: ${identity.reason}`);
      binding.childPid = hello.pid; binding.childStartTime = hello.pidStartTime;
      provenPane = pane;
      const versionWarning = piVersionWarning(options.piVersion ?? hostPiVersion(), hello.piVersion);
      if (versionWarning) { binding.versionWarning = versionWarning; diagnostic(versionWarning); }
      await writeRecord(run, check); check();
      // Publish only to the proven, registered child; a gone child never gets the task.
      if (!identity.ok) throw failure(`child ${identity.state} before its task was published; prepared request preserved, not replayed`);
      publishPreparedInboxRequest(dir, request);
      let offset = launchOffset, boundary = false, nativeStart = false;
      const decoder = createLineDecoder(line => {
        let event: unknown; try { event = JSON.parse(line); } catch { return; }
        if (!isRecord(event) || !isRecord(event._c) || event._c.n !== nonce) return;
        if (!boundary) {
          boundary = event.type === "conductor_child" && event.event === "launch" && Object.entries(hello!).every(([key, value]) => event[key] === value);
          return;
        }
        if (event.type === "agent_start" && event.initialRequestId === request.requestId) nativeStart = true;
      });
      const scan = () => {
        let fd: number;
        try { fd = openSync(run.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size < offset || stat.size - launchOffset > 32 * 1048576) throw failure("invalid or oversized launch transcript");
          const buffer = Buffer.alloc(65536);
          while (offset < stat.size) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            if (!count) throw failure("launch transcript changed during read");
            offset += count; decoder.write(buffer.subarray(0, count));
          }
        } finally { closeSync(fd); }
      };
      await until(HERDR_LAUNCH_BUDGET.ack, "initial ack", () => {
        scan(); const ack = readInboxAck(dir, request);
        if (ack && !ack.accepted) throw failure(`initial request rejected: ${ack.code}`);
        return ack;
      });
      await until(HERDR_LAUNCH_BUDGET.agentStart, "accepted task native agent_start", () => { scan(); return nativeStart ? true : undefined; });
      initialAccepted = true;
      check();
      const finalPane = await getPane(abort.signal); check();
      let finalIdentity = proof(finalPane);
      if (!finalIdentity.ok && probe(hello.pid).state === "gone") finalIdentity = proof(provenPane);
      if (!finalIdentity.ok && finalIdentity.state !== "gone") throw failure("child identity changed before readiness");
      accepted = true;
      observation = { launchOffset, requestId: request.requestId };
      if (!finalIdentity.ok && finalIdentity.state === "gone") { childExited = true; resolveClosed(); }
      return { binding, request, launchOffset };
    }).catch(async (e: unknown) => {
      diagnostic(e instanceof Error && e.message.startsWith("herdr:") ? e.message : "herdr: launch failed");
      if (!startAttempted) childExited = true;
      if (!detached && !reattach) await stopOwned(true);
      finishObservation(); if (!detached) diagnostic(await readStallEvidence());
      throw new Error(`herdr: ${stderr}`, { cause: e instanceof Error ? e.cause : undefined });
    });
    const stop = async () => {
      // Cancellation before the launch microtask claims ownership must still abort readiness.
      if (detached || (ownership && !owned())) return;
      abort.abort();
      if (!accepted) { await ready.catch(() => {}); return; }
      if (childExited) { finishObservation(); return; }
      await stopOwned(false); finishObservation();
      if (!childExited) sink.gone?.("herdr: child exit unconfirmed; pane/worktree preserved");
    };
    const waitForExit = async (): Promise<boolean> => {
      monitor?.close();
      if (!owned() || !accepted || run.herdr !== binding) return false;
      const end = now() + 10000;
      while (!childExited && now() < end) {
        tail?.drain();
        const state = proof(provenPane);
        if (!state.ok) { if (state.state === "gone") gone(); break; }
        await sleep(50);
        if (!owned()) return false;
      }
      if (!childExited && owned()) await stopOwned(false);
      tail?.drain(); finishObservation();
      return childExited;
    };
    const observe = () => {
      if (!owned() || observing || !accepted || !observation) return;
      observing = true;
      let started = false;
      tail = new HerdrTail({ path: run.transcriptPath, offset: observation.launchOffset, nonce,
        line: line => {
          if (!owned()) return;
          const event = JSON.parse(line);
          if (!started) {
            if (event.type !== "agent_start" || event.initialRequestId !== observation!.requestId) return;
            started = true;
          }
          if (event.type === "agent_settled") nativeSettled = true;
          sink.line(line);
        }, error: error => { diagnostic(error.message); sink.gone?.(error.message); } });
      monitor = new HerdrMonitor({ now, active: () => owned() && run.herdr === binding && !nativeSettled && !isTerminal(run.status) && run.status !== "integrating" && run.status !== "blocked",
        probe: () => { const state = proof(provenPane); return state.ok ? "alive" : state.state; },
        scan: async () => {
          try {
            const pane = await getPane();
            if (!owned() || run.herdr !== binding || nativeSettled || isTerminal(run.status) || run.status === "integrating" || run.status === "blocked") return;
            const state = proof(pane);
            if (state.ok) provenPane = pane;
            else diagnostic(`pane observation: ${state.reason}; evidence retained`);
          } catch { diagnostic("pane observation unavailable; evidence retained"); }
        }, drain: () => tail?.drain(), gone });
      tail.start();
      if (childExited) gone(); else if (!nativeSettled) monitor.start();
    };
    let sequence = reattach ? Math.max(1, ...readInbox(dir, nonce).map(entry => entry.request.sequence)) : 1;
    let deliveryTail: Promise<unknown> = Promise.resolve();
    const liveSend = () => owned() && run.runtime === "herdr" && run.herdr === binding && binding?.launchNonce === nonce &&
      accepted && observing && !abort.signal.aborted && !nativeSettled && !childExited && run.status === "running" &&
      (run.parentPid === undefined || run.parentPid === process.pid) && !run.pendingAsk && !run.askExecution && proof(provenPane).ok;
    const deliver = (type: "steer" | "follow_up" | "grace", text: string, sessionId?: string): Delivery => {
      tail?.drain();
      if (!liveSend()) return { kind: "epipe", reason: "herdr child is not owned, attached, ready and running" };
      const request: InboxRequest = { v: 1, launchNonce: nonce, requestId: randomUUID(), sequence: ++sequence, kind: type, text };
      const rejected = (reason: string, definite: boolean): DeliveryAck => ({ delivered: false, deliveredAt: 0, reason, definite });
      const ack = deliveryTail.then(async (): Promise<DeliveryAck> => {
        // CLI readiness is not authority. Reprove the current child, drain its tail,
        // then repeat the shared policy gate immediately before publishing input.
        let pane: unknown;
        try { pane = await getPane(abort.signal); }
        catch { return rejected("pane observation unavailable; no input written", true); }
        const policy = validateSendable(run, type === "grace" ? "steer" : type, sessionId);
        if (!liveSend() || !proof(pane).ok || !policy.ok) return rejected(policy.ok ? "child identity or readiness changed; no input written" : policy.reason, true);
        try {
          writeInboxRequest(dir, request);
          const deadline = now() + HERDR_LAUNCH_BUDGET.ack;
          for (;;) {
            if (!owned() || run.herdr !== binding || binding?.launchNonce !== nonce) return rejected("invocation changed; do not resend blindly", false);
            tail?.drain();
            const response = readInboxAck(dir, request);
            if (response) return response.accepted ? { delivered: true, deliveredAt: response.at } : rejected(response.code!, true);
            if (childExited) return rejected("child exited without acknowledgement", true);
            if (abort.signal.aborted || !proof(provenPane).ok) return rejected("child unavailable; do not resend blindly", false);
            if (now() >= deadline) return rejected("ack timeout; do not resend blindly", false);
            await sleep(250);
          }
        } catch { return rejected("delivery unconfirmed; do not resend blindly", false); }
      });
      deliveryTail = ack;
      return { kind: "queued", ack };
    };
    let paneReleased = false;
    const releasePane = async (signal?: AbortSignal, isCurrent: () => boolean = () => true) => {
      cleanupSignal = signal;
      if (!owned() || !isCurrent() || !childExited || !binding || run.herdr !== binding || signal?.aborted) return false;
      if (paneReleased) return true;
      const state = proof(provenPane);
      if (state.ok || state.state !== "gone") { diagnostic("pane/worktree preserved: child exit unconfirmed"); return false; }
      const status = run.status;
      const result = await closeEmptyPane(cli, binding, () => isCurrent() && run.status === status ? current() : undefined, { timeoutMs: 2000, signal });
      if (!result.ok) diagnostic(`worktree kept: ${result.reason}`);
      paneReleased = result.ok;
      return result.ok;
    };
    const shutdown = async (signal: AbortSignal) => {
      cleanupSignal = signal;
      await stop();
      if (!signal.aborted) await releasePane(signal);
      if (!paneReleased) diagnostic("pane shutdown incomplete; ownership evidence preserved");
    };
    const detach = async () => {
      detached = true; abort.abort(); finishObservation();
      await Promise.allSettled([ready, deliveryTail]);
    };
    return { kind: "herdr", runtime: this, detach, shutdown, readStallEvidence, liveSend, deliver, ready, closed, observe, waitForExit, releasePane,
      get paneReleased() { return paneReleased && run.herdr === binding; },
      get observable() { return owned() && observing && run.herdr === binding && !childExited && !abort.signal.aborted && (run.parentPid === undefined || run.parentPid === process.pid); }, get initialAccepted() { return initialAccepted && run.herdr === binding; },
      get childExited() { return childExited && (!binding || run.herdr === binding); },
      get cancelled() { return abort.signal.aborted; }, get stderr() { return stderr; }, drain: () => { tail?.drain(); return ""; }, stop, cancel: stop };
  }
}
