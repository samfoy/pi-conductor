import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { HerdrTransport, RunRuntime, RunSink } from "../runtime.ts";
import type { Run } from "../types.ts";
import { buildPiCoreArgs, writeRecord, type PiCoreArgsOptions } from "../runs.ts";
import { seedSessionFile } from "../session-seed.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { createLineDecoder } from "../subprocess-runtime.ts";
import { boundStallText } from "../stall-evidence.ts";
import { HerdrCliError, isRecord, type HerdrCli } from "./cli.ts";
import { proveChildProcess, provePaneOurs, type HerdrBinding, type HerdrInvocation, type LaunchHello } from "./identity.ts";
import { buildHerdrEnv, closeEmptyPane, createRunTab } from "./placement.ts";
import { readControlRecord, readInboxAck, writeInboxRequest, type InboxRequest } from "./inbox.ts";

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
  cli: HerdrCli; workspaceId: string; env: NodeJS.ProcessEnv;
  trustArgs?: (cwd: string, agentDir?: string) => string[];
  piVersion?: string; platform?: string; now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  probe?: (pid: number) => ProcessEvidence;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}
const failure = (message: string) => new Error(`herdr: ${message}`);

/** H6 observes readiness only. H7 will own the sole event tail and post-ready monitor. */
export class HerdrRuntime implements RunRuntime {
  constructor(private readonly options?: Options) {}
  capabilities() { return { pause: false, liveSend: false }; }
  deliver() { return { kind: "epipe" as const, reason: "herdr live delivery is unavailable" }; }
  signal(): never { throw failure("pause is subprocess-only"); }
  stopProcess(run: Run) { return run.transport?.kind === "herdr" ? run.transport.stop() : undefined; }
  terminate(run: Run) { return this.stopProcess(run); }

  launch(run: Run, _args: string[], cwd: string, _sink: RunSink, initialPrompt?: string, core?: PiCoreArgsOptions): HerdrTransport {
    if (!this.options) throw failure("launch requires an explicitly injected CLI");
    const options = this.options;
    const { cli, env, workspaceId } = options;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    const probe = options.probe ?? probeProcess;
    const signal = options.signal ?? process.kill;
    const abort = new AbortController();
    const nonce = randomUUID(), dir = dirname(run.recordPath);
    const previous = run.herdr;
    const alias = /^[a-z][a-z0-9_-]{0,31}$/.test(run.id) ? run.id : `c${createHash("sha256").update(run.id).digest("hex").slice(0, 16)}`;
    let binding: HerdrBinding | undefined, hello: LaunchHello | undefined, provenPane: unknown;
    let fresh = false, accepted = false, stderr = "", stopWork: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const diagnostic = (message: string) => { stderr = boundStallText(`${stderr}${stderr ? "\n" : ""}${message}`, 4096); };
    const current = (): HerdrInvocation | undefined => run.herdr;
    const check = () => {
      if (abort.signal.aborted) throw failure("launch cancelled");
      if (binding && run.herdr !== binding) throw failure("launch binding replaced; preserving resources");
    };
    const proof = (pane: unknown) => proveChildProcess({ binding: binding && { ...binding, childPid: binding.childPid ?? hello?.pid, childStartTime: binding.childStartTime ?? hello?.pidStartTime }, current: current(), socketPath: cli.socketPath, pane, hello,
      platform: options.platform ?? process.platform, bridgeProtocol: 1, process: hello ? probe(hello.pid) : undefined });
    const getPane = async (signal?: AbortSignal) => (await cli.json(["pane", "get", binding!.paneId], { timeoutMs: 2000, signal })).pane;
    const readHello = () => {
      try { return readControlRecord(join(dir, "launch", `${nonce}.json`)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw failure("invalid launch hello"); }
    };
    const stopOwned = (rollback: boolean): Promise<void> => stopWork ??= (async () => {
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
          while (now() < end && proof(provenPane).ok) await sleep(50);
          state = proof(provenPane);
          if (state.ok) {
            pane = await getPane(); state = proof(pane);
            if (state.ok) {
              signal(state.pid, "SIGKILL");
              const end = now() + 2000;
              while (now() < end && proof(pane).ok) await sleep(50);
              state = proof(pane);
            }
          }
        }
        if (state.ok || state.state !== "gone") { diagnostic("pane/worktree preserved: child exit unconfirmed"); return; }
        resolveClosed();
        if (rollback && fresh) {
          const result = await closeEmptyPane(cli, binding, () => current()!, { timeoutMs: 2000 });
          if (!result.ok) diagnostic(`pane/worktree preserved: ${result.reason}`);
        }
      } catch { diagnostic("pane/worktree preserved: child stop unconfirmed"); }
    })();
    const capture = async () => {
      if (!binding) return;
      try {
        let text = await cli.text(["agent", "read", alias, "--source", "recent-unwrapped", "--lines", "40"], { timeoutMs: HERDR_LAUNCH_BUDGET.diagnostic, maxBuffer: 4096 });
        for (const value of Object.values(env)) if (value) text = text.split(value).join("[redacted]");
        text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
          .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
          .replace(/((?:password|secret|token|api[_-]?key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]");
        diagnostic(text.split("\n").slice(-40).join("\n"));
      } catch { diagnostic("startup diagnostic unavailable; unknown dialogs are not answered automatically"); }
    };
    const ready = Promise.resolve().then(async () => {
      check();
      if (run.runtime !== "herdr" || !core || !initialPrompt?.trim()) throw failure("missing typed launch specification");
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
      const args = [...buildPiCoreArgs({ ...core, kind: "resume", sessionPath: sessionFile, systemPrompt: promptPath }),
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
        binding = await createRunTab(cli, { workspaceId, cwd, invocation, env: buildHerdrEnv(env, { runId: run.id, runDir: dir, configCwd: run.cwd,
          ...(run.effort ? { tmpDir: join(dir, "tmp") } : {}) }) }, { timeoutMs: 5000, signal: abort.signal });
        fresh = true;
      }
      if (run.herdr !== previous) throw failure("launch binding replaced; preserving resources");
      run.herdr = binding; run.sessionPath = sessionFile;
      check(); await writeRecord(run, check); check();
      const request: InboxRequest = { v: 1, launchNonce: nonce, requestId: randomUUID(), sequence: 1,
        kind: run.pendingAsk ? "reply" : "initial", text: initialPrompt, ...(run.pendingAsk ? { askId: run.pendingAsk.askId } : {}) };
      writeInboxRequest(dir, request);
      let launchOffset = 0;
      try { launchOffset = statSync(run.transcriptPath).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const startArgs = ["agent", "start", alias, "--kind", "pi", "--pane", binding.paneId, "--timeout", "60000", "--", ...args];
      let started: Record<string, unknown>;
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
      if (hello.piVersion !== (options.piVersion ?? VERSION)) diagnostic(`Pi version mismatch: expected ${options.piVersion ?? VERSION}; child differs`);
      await writeRecord(run, check); check();
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
      check();
      const finalPane = await getPane(abort.signal); check();
      let finalIdentity = proof(finalPane);
      if (!finalIdentity.ok && probe(hello.pid).state === "gone") finalIdentity = proof(provenPane);
      if (!finalIdentity.ok && finalIdentity.state !== "gone") throw failure("child identity changed before readiness");
      accepted = true;
      if (!finalIdentity.ok && finalIdentity.state === "gone") resolveClosed();
      return { binding, request, launchOffset };
    }).catch(async (e: unknown) => {
      diagnostic(e instanceof Error && e.message.startsWith("herdr:") ? e.message : "herdr: launch failed");
      await stopOwned(true); await capture();
      throw failure(stderr);
    });
    const stop = async () => {
      abort.abort();
      if (!accepted) { await ready.catch(() => {}); return; }
      await stopOwned(false);
    };
    return { kind: "herdr", ready, closed, get cancelled() { return abort.signal.aborted; }, get stderr() { return stderr; }, drain: () => "", stop, cancel: stop };
  }
}
