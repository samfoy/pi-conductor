import { assertHerdrOwner, ownsHerdrRun, herdrEffectFence } from "./herdr/ownership.ts";
import { emptyUsage } from "./types.ts";
import { measureEffortFootprint } from "./effort/admit.ts";
import { effortGit } from "./effort/open.ts";
import { assertRunEffortOwner, readEffort } from "./effort/store.ts";
import { effortSummary, resolveEffortPolicy } from "./effort/policy.ts";
import { appendFile } from "node:fs/promises";
import type { RunRuntime, RunTransport } from "./runtime.ts";
import { runtimeFor } from "./runtime.ts";
import { applyEvent } from "./event-handler.ts";
import { classifyFailure } from "./failure-classify.ts";
import { contextRetirementNotice } from "./context-retirement.ts";
import { recordRunOutcome } from "./memory.ts";
import type { ConductorEventEmitter } from "./conductor-events.ts";
import { childExitUnconfirmed, isDelegatedLeaf, isTerminal, type Run, type RunStatus, type ResolvedHook } from "./types.ts";
import { settleOwnedChildren } from "./delegation.ts";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { buildOrphanRun } from "./reconcile-startup.ts";
import { sessionHeaderCwd } from "./session-seed.ts";
import type { RunRecord } from "./types.ts";
import {
  type RunRegistry, attachSpawnedProc, stampSpawnStreamingMode, forceTerminate, delegationObserver, resolveTimeoutMs,
  discoverSessionPathIfMissing, discoverContextRetirement, applyHookToTerminal,
  applyCloseHandlerTerminal, emitFinalizeEvent, applyRetryIfNeeded, applySubstanceCheck,
  failEffortLaunch, settleWorktree, writeRecord, writeFinal, getFinalText, applyChainIfPresent, applyCompactionLine, checkTurnLimit,
} from "./runs.ts";

export interface RunPipelineOpts {
  registry: RunRegistry;
  reattach?: boolean;
  runtime?: RunRuntime;
  /**
   * Invoked once per parsed event, before state application, including the decoded tail.
   * A reattach replays from the launch boundary, so pass only the idempotent delegation observer there.
   */
  onEvent?: (run: Run, event: unknown) => void;
  cwd: string;
  timeoutMs: number;
  onUpdate?: (run: Run) => void;
  onComplete?: (run: Run) => void;
  sessionDir?: string;
  /** Explicit steering opt-in, independent of automatic large-prompt RPC transport. */
  steerable: boolean;
  initialPrompt?: string;
  core?: import("./runs.ts").PiCoreArgsOptions;
  /** Launch is not acceptance: retain the same durable question until Pi acknowledges input. */
  answer?: { ask: NonNullable<Run["pendingAsk"]>; cwd: string };
  resolvedHook?: ResolvedHook;
  onChain?: (run: Run) => void;
  onRetry?: (run: Run) => void;
  events?: ConductorEventEmitter;
}

export function createRunPipeline(
  run: Run,
  piArgs: string[],
  opts: RunPipelineOpts,
): Promise<Run> {
  if (opts.reattach && run.integration) throw new Error("durable integration belongs to M5 recovery, not stream attachment");
  if (run.runtime === "herdr" && !opts.registry.herdrAdmissionOpen) throw new Error("herdr runtime shutting down; launch/attach refused");
  const runtime = opts.runtime ?? runtimeFor(run);
  // N4: this invocation's leaves are the ones started from here on. A reattached launch's leaves
  // predate this pipeline; its gate covers the run's still-unanswered leaves instead (N5).
  const launchedAt = opts.reattach ? run.startTime : Date.now();
  if (run.runtime === "herdr") run.herdrResultUnavailable = true;
  if (opts.reattach) {
    run.messages = []; run.usage = { ...(run.herdrUsageBaseline?.launchNonce === run.herdr?.launchNonce ? run.herdrUsageBaseline!.usage : emptyUsage()) };
    run.herdrEffortAuthorized = !run.effort;
  }
  const messageOffset = run.messages.length;
  let suspended = false;
  let pipeline: Run["herdrPipeline"];
  let finalizing: Promise<void> | undefined;
  const current = () => run.runtime !== "herdr" || (!suspended && (!pipeline || run.herdrPipeline === pipeline) && opts.registry.get(run.id) === run && ownsHerdrRun(run));
  const check = () => { if (!current()) throw new Error("herdr pipeline fenced"); };

  // The argv builder owns transport selection; steering remains an independent opt-in.
  const rpc = piArgs[1] === "rpc";
  run.onComplete = opts.onComplete;
  const recoveredAnswer = !!opts.answer && !!run.reconciledAtStartup && !!run.effort && run.effort.gate !== undefined;
  if (!opts.reattach && run.effort && (!run.reconciledAtStartup || run.effort.gate !== undefined)) run.effort.gate = opts.resolvedHook ?? null;

  let awaitingAnswer = opts.answer !== undefined;
  let answerRecord = Promise.resolve();
  const restoreAnswer = async (reason: string): Promise<Run> => {
    await answerRecord;
    check();
    if (isTerminal(run.status)) return run;
    run.rejectAnswerDelivery = undefined;
    run.pendingAsk = opts.answer!.ask;
    run.cwd = opts.answer!.cwd;
    run.status = "blocked";
    run.finishedAt = Date.now();
    run.proc = undefined;
    run.pid = undefined;
    run.failureClass = undefined;
    run.errorMessage = `Owner answer delivery failed before acceptance: ${reason}. Question ${run.pendingAsk.askId} remains outstanding; retry ensemble_send.`;
    await writeRecord(run);
    opts.registry.notify(run);
    try { opts.onComplete?.(run); } catch { /* notification errors cannot lose the question */ }
    return run;
  };
  let transport: RunTransport;
  // Stream parsing.
  let finalized = false;
  let donePromiseResolve: (r: Run) => void;
  const done = new Promise<Run>((resolve) => {
    donePromiseResolve = resolve;
  });

  const finalize = (terminal: RunStatus, exitCode?: number) => {
    if (!current() || finalized) return;
    if (opts.reattach && run.effort && !run.herdrEffortAuthorized) {
      run.herdrResumeSettlement = () => { run.herdrResumeSettlement = undefined; finalize(terminal, exitCode); };
      return;
    }
    finalizing = finalizeEffects(terminal, exitCode).catch(error => {
      if (!current()) return;
      if (replaced()) { donePromiseResolve(run); return; }
      run.errorMessage = `herdr settlement preserved: ${(error as Error).message}`;
      opts.registry.notify(run);
    });
  };
  const finalizeEffects = async (terminal: RunStatus, exitCode?: number) => {
    if (finalized) return;
    finalized = true;
    run.rpcStdinQueue?.destroy("settled");
    for (const ack of run.pendingAcks?.values() ?? []) {
      clearTimeout(ack.timer);
      ack.reject(new Error("sub-agent settled before acknowledgement"));
    }
    run.pendingAcks?.clear();
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = undefined;
    }
    if (transport.kind === "herdr") {
      const exited = await transport.waitForExit();
      check();
      if (!exited) {
        run.herdrExitUnconfirmed = true;
        run.errorMessage = "herdr: child exit unconfirmed; pane/worktree preserved";
        if (awaitingAnswer && !isTerminal(run.status)) { await restoreAnswer(run.errorMessage); donePromiseResolve(run); return; }
        await settle("failed", 1);
        return;
      }
      run.herdrExitUnconfirmed = undefined;
    }
    const rest = transport.drain();
    if (rest.trim()) processLine(rest);
    if (transport.kind === "herdr") run.herdrResultUnavailable = !getFinalText(run.messages.slice(messageOffset)) || undefined;
    if (opts.answer) await answerRecord;
    check();
    // N4: leaves stop and exit first, before any blocked or terminal hook, merge, footprint, integration, final, record or card.
    if (!replaced()) await settleOwnedChildren(run, opts.registry, launchedAt, opts.reattach === true);
    check();
    // A resume of the killed run replaced this invocation before or during the gate: the run, its
    // record and callbacks are the new invocation's. Only this one's process is still ours.
    if (replaced()) {
      try { transport.stop(); } catch { /* already exited */ }
      escalate();
      donePromiseResolve(run);
      return;
    }
    if (childExitUnconfirmed(run) && !isTerminal(run.status) && !awaitingAnswer) {
      // Nothing of this invocation is published; a withdrawn owner question is named, not lost.
      const ask = run.pendingAsk, ids = run.abandonedChildren!.filter(c => c.exit === "unconfirmed").map(c => c.id).join(", ");
      run.pendingAsk = undefined;
      terminal = "failed";
      run.errorMessage = [run.errorMessage, `delegated child ${ids} exit unconfirmed after cancellation; hook, merge, integration and final result withheld; worktree preserved` +
        (ask ? `; owner question ${ask.askId} withdrawn: ${ask.question}` : "")].filter(Boolean).join("\n");
    }
    discoverSessionPathIfMissing(run, opts.sessionDir);
    discoverContextRetirement(run, opts.sessionDir);
    if ((awaitingAnswer || run.pendingAsk) && !isTerminal(run.status)) {
      if (awaitingAnswer || (terminal === "completed" && run.sessionPath && !contextRetirementNotice(run))) {
        try { transport.stop(); } catch { /* already exited */ }
        const killFallback = setTimeout(() => { try { transport.stop("SIGKILL"); } catch { /* already exited */ } }, 2000);
        await transport.closed;
        check();
        clearTimeout(killFallback);
        // A user kill during teardown abandons the ask and owns its notification.
        if (isTerminal(run.status)) { donePromiseResolve(run); return; }
        if (awaitingAnswer) {
          await restoreAnswer(run.errorMessage || transport.stderr.trim() || `subprocess exited with code ${exitCode} before accepting the answer`);
          donePromiseResolve(run);
          return;
        }
        if (run.effort) {
          try {
            const policy = readEffort(run.effort.gitRoot, run.effort.name)!.policy;
            const measured = measureEffortFootprint(run, effortGit(run.worktreePath!, "rev-parse", "HEAD"), policy);
            Object.assign(run.effort, measured, { footprintUnknown: !!effortGit(run.worktreePath!, "status", "--porcelain", "--untracked-files=all") });
          } catch { run.effort.footprintUnknown = true; }
        }
        run.status = "blocked";
        run.finishedAt = Date.now();
        run.exitCode = exitCode;
        run.proc = undefined;
        run.pid = undefined;
        run.failureClass = undefined;
        await writeRecord(run);
        check();
        opts.registry.notify(run);
        if (run.runtime === "herdr" && !run.effort) await dispatchHerdrSettlement(run, () => opts.onComplete?.(run));
        else if (!opts.reattach) { try { opts.onComplete?.(run); } catch { /* listener errors cannot wedge settlement */ } }
        donePromiseResolve(run);
        return;
      }
      run.pendingAsk = undefined;
      terminal = "failed";
      run.errorMessage = "Owner question cannot be resumed: session missing, retired, or subprocess failed. Use a fresh child with the transcript.";
    }
    if (run.effort && transport.kind === "subprocess") {
      try { transport.stop(); } catch { /* already exited */ }
      const escalation = setTimeout(() => { try { transport.stop("SIGKILL"); } catch { /* already exited */ } }, 2000);
      await transport.closed;
      clearTimeout(escalation);
      await answerRecord;
    }
    const resolvedHook = opts.resolvedHook ?? (opts.reattach ? run.effort?.gate ?? undefined : undefined);
    if (
      terminal === "completed" &&
      exitCode === 0 &&
      resolvedHook &&
      !isTerminal(run.status)
    ) {
      try {
        terminal = await applyHookToTerminal(
          run,
          resolvedHook,
          terminal,
          { events: opts.events },
        );
      } catch (e) {
        // Defensive: applyHookToTerminal's own try/finally clears the
        // hook flags even on throw, but a thrown helper means the
        // hook helper itself blew up unexpectedly. Surface as
        // hook_failed so the lifecycle terminates cleanly.
        run.hookResult = {
          passed: false,
          command: resolvedHook.command,
          exitCode: null,
          durationMs: 0,
          logPath: "",
          tailText: `(applyHookToTerminal threw) ${(e as Error).message}`,
          tailBytes: 0,
          tailLines: 0,
          failureKind: "spawn_error",
        };
        terminal = "hook_failed";
      }
    }
    check();
    if (run.effort && terminal === "completed" && !isTerminal(run.status)) {
      run.proc = undefined;
      run.pid = undefined;
      try {
        const record = readEffort(run.effort.gitRoot, run.effort.name);
        if (!record) throw new Error("effort record missing; integration refused");
        assertRunEffortOwner(run);
        if (opts.reattach && run.effort.gate === undefined) throw new Error("original hook is unknown; integration refused");
        const policy = resolveEffortPolicy(record.policy);
        if (!run.worktreePath || !run.worktreeBranch) throw new Error("effort assignment workspace missing");
        if (effortGit(run.worktreePath, "status", "--porcelain", "--untracked-files=all")) throw new Error("writer has uncommitted work; integration refused and workspace preserved");
        const branchHead = effortGit(run.effort.gitRoot, "rev-parse", "--verify", `refs/heads/${run.worktreeBranch}^{commit}`);
        const measured = measureEffortFootprint(run, branchHead, policy);
        run.status = "integrating";
        run.integration = { ...measured, resultText: getFinalText(run.messages), state: "queued", enqueuedAt: Date.now(), branchHead, attempts: 0,
          verifyIdentity: { command: policy.verify, timeoutSeconds: policy.verifyTimeoutSeconds, retries: policy.verifyRetries } };
        if (run.integrationSuspended) {
          run.integration.state = "paused";
          run.integration.reason = "owner runtime shut down; work preserved for fenced recovery";
          await writeRecord(run, () => assertRunEffortOwner(run));
          opts.registry.notify(run);
          return;
        }
        const outcome = await opts.registry.integrations.enqueue(run, () => opts.registry.notify(run), recoveredAnswer || opts.reattach);
        check();
        terminal = outcome.terminal;
        run.mergeResult = outcome.mergeResult;
        run.landedCommit = outcome.landedCommit;
        if (!outcome.mergeResult.success) run.errorMessage = `effort integration failed: ${outcome.mergeResult.reason ?? "error"}. ${outcome.mergeResult.errorMessage ?? "Work and evidence preserved."}`;
      } catch (e) {
        terminal = "merge_conflict";
        run.errorMessage = `effort integration refused: ${(e as Error).message}`;
        run.mergeResult = { success: false, reason: "error", errorMessage: run.errorMessage };
      }
    }
    check();
    await settle(terminal, exitCode);
  };

  /** N4 invocation fence: a subprocess resume launches a new transport on the same run. */
  const replaced = () => run.transport !== transport;
  /** An ignored SIGTERM ends in SIGKILL on this invocation's own handle, never `run.proc`. */
  const escalate = () => {
    if (transport.kind !== "subprocess") return;
    const launched = transport;
    const kill = setTimeout(() => { try { launched.stop("SIGKILL"); } catch { /* already exited */ } }, 2000);
    kill.unref();
    void launched.closed.then(() => clearTimeout(kill));
  };
  let settled = false;
  const settle = async (terminal: RunStatus, exitCode?: number) => {
    if (!current() || settled) return;
    settled = true;
    try { await settleRun(run, terminal, exitCode, opts, transport, donePromiseResolve); }
    catch (error) {
      if (!run.integration) throw error;
      run.status = "integrating"; run.integration.state = "paused";
      run.integration.reason = `terminal persistence uncertain: ${(error as Error).message}`;
      opts.registry.notify(run);
    } finally {
      // Settlement sent SIGTERM. The reservation lasts until close, which waits for stdio:
      // a descendant holding an inherited pipe can extend it past 2 s.
      escalate();
    }
  };

  const processLine = (line: string) => {
    if (!current()) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    // Append every parseable JSON line to the transcript (fire-and-forget I/O).
    if (run.runtime !== "herdr") void appendFile(run.transcriptPath, line + "\n").catch(() => {});

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    opts.onEvent?.(run, event);

    if (run.runtime !== "herdr" && !finalized && awaitingAnswer && ((!rpc && event.type === "agent_start") ||
        (rpc && event.type === "response" && event.command === "prompt" && event.id === `init-${run.id}` && event.success === true))) {
      // Pi 0.87.1 emits agent_start only after print prompt preflight; RPC has an explicit ack.
      awaitingAnswer = false;
      run.rejectAnswerDelivery = undefined;
      run.pendingAsk = undefined;
      answerRecord = answerRecord.then(() => writeRecord(run));
    }
    if (event.type === "response" && event.command === "prompt" && event.id === `init-${run.id}` && event.success === false) {
      run.errorMessage = `initial prompt rejected: ${event.error ?? "unknown error"}`;
      void finalize("failed", 1);
      return;
    }

    // Pure state-machine logic lives in applyEvent (see src/event-handler.ts).
    // This wrapper handles I/O (transcript append) and listener notification.
    const effect = applyEvent(run, event);
    if (effect.kind === "finalize") {
      void finalize(effect.status, effect.exitCode);
      return;
    }
    if (effect.kind === "compacted") {
      // v0.16-S4: delegate to the exported helper (also used by unit tests).
      if (!opts.reattach) applyCompactionLine(run, opts.events);
      opts.registry.notify(run);
      return;
    }
    if (effect.kind === "updated") {
      opts.registry.notify(run);
      if (opts.onUpdate) opts.onUpdate(run);
    }

    // v0.17-S4: turn-limit enforcement — checked after every event.
    if (!opts.reattach) checkTurnLimit(run, opts.registry, (r, reason) =>
      forceTerminate(r, reason, opts.registry, opts.onComplete),
    );
  };

  const early: (() => void)[] = [];
  let launching = true;
  const receive = (callback: () => void) => { if (!current()) return; if (launching) early.push(callback); else callback(); };
  try {
    const sink: import("./runtime.ts").RunSink = {
      line: line => receive(() => processLine(line)),
      gone: reason => receive(() => {
        if (finalized) return;
        run.errorMessage = reason;
        void finalize("failed", 1);
      }),
      close: code => receive(() => {
        if (finalized) return;
        if ((code ?? 0) === 0) void finalize("completed", 0);
        else void finalize("failed", code ?? 0);
      }),
      error: () => receive(() => {
        run.errorMessage = "failed to spawn pi process";
        void finalize("failed", 1);
      }),
      initialDeliveryFailed: error => receive(() => {
        if (finalized) return;
        run.errorMessage = `initial prompt delivery failed: ${error.message}`;
        void finalize("failed", 1);
      }),
    };
    // Provisional for the launch env (a delegator's child bounds its waits by it); re-stamped when armed.
    if (!opts.reattach) run.deadlineAt = Date.now() + opts.timeoutMs;
    if (opts.reattach) {
      if (!runtime.attach) throw new Error("runtime attachment unavailable");
      transport = runtime.attach(run, sink);
    } else transport = runtime.launch(run, piArgs, opts.cwd, sink, opts.initialPrompt, opts.core);
  } catch (e) {
    if (opts.reattach) throw e;
    if (awaitingAnswer) return restoreAnswer(`spawn failed: ${(e as Error).message}`);
    run.status = "failed";
    run.errorMessage = `spawn failed: ${(e as Error).message}`;
    run.finishedAt = Date.now();
    // v0.18: classify the in-process spawn failure (e.g. `spawn pi
    // ENOENT` → environment) before persistence, same as the finalize
    // and forceTerminate stamp sites.
    run.failureClass = classifyFailure({
      terminal: "failed",
      errorMessage: run.errorMessage,
    });
    opts.registry.notify(run);
    void writeRecord(run);
    void writeFinal(run);
    if (opts.onComplete) opts.onComplete(run);
    return Promise.resolve(run);
  }
  run.transport = transport;
  if (transport.kind === "subprocess") {
    answerRecord = attachSpawnedProc(run, transport.proc);
    stampSpawnStreamingMode(run, opts.steerable === true);
    run.streamingMode = rpc ? "rpc" : "print";
    // N3: the admission slot is held until this process closes, not merely until the run settles.
    const launched = transport;
    run.processOpen = true;
    void launched.closed.then(() => {
      if (run.transport !== launched) return;
      run.processOpen = undefined;
      opts.registry.notify(run);
    });
  } else {
    run.proc = undefined; run.pid = undefined; run.streamingMode = undefined;
    const launch = transport;
    if (isDelegatedLeaf(run)) {
      // N3 on herdr: a leaf has no process handle, so its slot is held until its pane child's exit is proven.
      run.processOpen = true;
      const exited = () => { if (run.transport !== launch || !launch.childExited) return; run.processOpen = undefined; opts.registry.notify(run); };
      void launch.closed.then(exited);
      void launch.ready.then(undefined, exited);
    }
    const launchFailed = async (error: Error) => {
      if (!current() || finalized || run.transport !== launch) return;
      finalized = true;
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
      run.timeoutTimer = undefined;
      run.rejectAnswerDelivery = undefined;
      if (opts.reattach) {
        run.errorMessage = error.message; run.herdrResultUnavailable = true;
        if (error.cause === "herdr-gone-before-start") {
          const complete = () => settle("failed", 1);
          if (run.effort && !run.herdrEffortAuthorized) run.herdrResumeSettlement = () => { void complete(); };
          else await complete();
        } else {
          run.herdrExitUnconfirmed = true;
          opts.registry.notify(run); // Observe uncertainty; never publish a guessed terminal record.
        }
        donePromiseResolve(run); return;
      }
      if (isTerminal(run.status)) {
        if (launch.stderr) run.errorMessage = [run.errorMessage, launch.stderr].filter(Boolean).join("\n");
        await writeRecord(run);
      } else if (awaitingAnswer && !launch.initialAccepted) {
        run.herdrExitUnconfirmed = !launch.childExited || undefined;
        await restoreAnswer(error.message);
      }
      else {
        if (launch.initialAccepted) { awaitingAnswer = false; run.pendingAsk = undefined; }
        run.herdrExitUnconfirmed = !launch.childExited || undefined;
        await failEffortLaunch(run, opts.registry, error.message, opts.onComplete).done;
      }
      donePromiseResolve(run);
    };
    void launch.ready.then(async () => {
      if (!current()) return;
      if (launch.cancelled) { await launch.cancel(); await launchFailed(new Error("herdr: launch cancelled")); return; }
      if (finalized || isTerminal(run.status) || run.transport !== launch) return;
      run.herdrResultUnavailable = undefined;
      if (awaitingAnswer) {
        awaitingAnswer = false; run.pendingAsk = undefined; run.rejectAnswerDelivery = undefined;
        answerRecord = answerRecord.then(() => writeRecord(run));
        await answerRecord;
        if (!current()) return;
      }
      launch.observe();
    }, launchFailed);
    if (awaitingAnswer) run.rejectAnswerDelivery = reason => {
      void launch.cancel().then(() => launchFailed(new Error(reason)));
    };
  }

  if (transport.kind === "herdr") {
    const ownedTransport = transport;
    run.herdrPipeline = pipeline = {
      suspend() { opts.registry.herdrAdmissionOpen = false; suspended = true; clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; },
      async quiesce() {
        await ownedTransport.detach?.();
        await Promise.allSettled([run.integration ? run.integrationSettlement : finalizing, answerRecord, run.recordWrite, run.herdrDelivery].filter((p): p is Promise<void> => !!p));
      },
    };
  }

  // Hard timeout; deadlineAt is when this timer actually fires.
  run.deadlineAt = Date.now() + opts.timeoutMs;
  run.timeoutTimer = setTimeout(() => {
    if (current() && (run.status === "running" || run.status === "paused")) {
      forceTerminate(run, "timeout", opts.registry, opts.onComplete);
    }
  }, opts.timeoutMs);

  launching = false;
  for (const callback of early) callback();

  if (transport.kind === "subprocess" && awaitingAnswer) run.rejectAnswerDelivery = reason => {
    run.errorMessage = reason;
    void finalize("failed", 1);
  };
  return done;
}

/**
 * H10 readopt of a herdr record by this lead. N5: a delegator's replay from the launch
 * boundary also reaches this instance's broker, with the parent's effective cwd (its
 * session header), so claimed calls are rebound rather than re-spawned.
 */
export function readoptHerdrRun(record: RunRecord, deps: Pick<RunPipelineOpts, "registry" | "runtime" | "onComplete" | "events"> & { sessionId?: string }): { run: Run; done: Promise<Run> } {
  const run = buildOrphanRun(record, "running");
  run.parentPid = process.pid; run.parentSessionId = deps.sessionId;
  let cwd: string | undefined;
  try { cwd = record.herdr ? sessionHeaderCwd(readFileSync(record.herdr.sessionFile, "utf8")) : undefined; } catch { /* the pipeline refuses a missing session */ }
  const done = createRunPipeline(run, [], { registry: deps.registry, runtime: deps.runtime, reattach: true, cwd: run.cwd,
    timeoutMs: resolveTimeoutMs(undefined, undefined, loadConfig(run.cwd)), steerable: false, onEvent: delegationObserver(run, deps.registry, cwd ?? run.cwd),
    onComplete: deps.onComplete, events: deps.events });
  deps.registry.register(run);
  return { run, done };
}

/** Track the terminal I/O tail, never the lifetime of a still-running child or verifier. */
export function settleRun(...args: Parameters<typeof settleRunEffects>): Promise<void> {
  const run = args[0];
  if (!run.effort || !run.integration) return settleRunEffects(...args);
  if (run.integrationSettlement) return run.integrationSettlement;
  const settling = Promise.resolve().then(() => settleRunEffects(...args));
  run.integrationSettlement = settling;
  const clear = () => { if (run.integrationSettlement === settling) run.integrationSettlement = undefined; };
  void settling.then(clear, clear);
  return settling;
}

/** Shared terminal effects for live pipelines and Git-proven recovery, never a second finalizer. */
async function settleRunEffects(
  run: Run, terminal: RunStatus, exitCode: number | undefined,
  opts: Pick<RunPipelineOpts, "registry" | "onComplete" | "onChain" | "onRetry" | "events" | "sessionDir">,
  transport: Pick<RunTransport, "stderr" | "stop"> = { stderr: "", stop() {} },
  donePromiseResolve: (run: Run) => void = () => {},
): Promise<void> {
    if (!ownsHerdrRun(run)) return;
    const fence = herdrEffectFence(run);
    // Forced termination already published its state; retain discovery without notifying twice.
    if (!applyCloseHandlerTerminal(run, terminal, exitCode)) {
      discoverSessionPathIfMissing(run, opts.sessionDir);
      if (run.runtime === "herdr" && !run.herdrExitUnconfirmed) await writeFinal(run);
      await writeRecord(run); fence();
      run.proc = undefined;
      try {
        transport.stop();
      } catch {
        // already dead
      }
      // v0.16-S3: emit lifecycle event for force-terminated runs (run.status
      // already set by forceTerminate; emit before resolving done).
      const dispatch = () => {
        fence();
        emitFinalizeEvent(run, opts.events);
        if (!run.reconciledAtStartup) applyRetryIfNeeded(run, opts.onRetry);
        fence(); recordRunOutcome(run);
      };
      if (run.runtime === "herdr" && !run.effort) await dispatchHerdrSettlement(run, dispatch);
      else dispatch();
      donePromiseResolve(run);
      return;
    }
    if (terminal === "failed" && !run.errorMessage) {
      run.errorMessage = transport.stderr.trim() || `pi subprocess exited with code ${exitCode}`;
    }
    if (!run.reconciledAtStartup) applySubstanceCheck(run, terminal);
    discoverSessionPathIfMissing(run, opts.sessionDir);
    run.proc = undefined;
    if (!run.effort) terminal = await settleWorktree(run, terminal);
    else run.worktreeKept = `${effortSummary(run)}. Branch ${run.worktreeBranch} and worktree ${run.worktreePath} preserved.`;
    fence();
    // Re-apply the terminal to the run record now that merge may have flipped it.
    if (terminal === "merge_conflict") run.status = terminal;
    if (terminal !== "completed") {
      // hook_failed diagnostics live in run.hookResult.tailText, not the
      // subprocess stderr (the subprocess exited 0 before the hook ran).
      const tail =
        terminal === "hook_failed" ? run.hookResult?.tailText ?? transport.stderr : transport.stderr;
      run.failureClass = classifyFailure({
        terminal,
        exitCode,
        stderrTail: tail,
        errorMessage: run.errorMessage,
      });
    }
    if (run.mergeResult?.reason === "verify_timeout") run.failureClass = "timeout";
    opts.registry.notify(run);
    try {
      transport.stop();
    } catch {
      // already dead
    }
    const dispatch = () => {
      fence();
      if (run.effort && run.reconciledAtStartup && !run.integration) return;
      try { opts.onComplete?.(run); } catch { /* local dispatch attempted, not receiver acknowledgement */ }
      if (!run.reconciledAtStartup) {
        applyChainIfPresent(run, run.status as RunStatus, opts.onChain);
        applyRetryIfNeeded(run, opts.onRetry);
      }
      recordRunOutcome(run);
      emitFinalizeEvent(run, opts.events);
    };
    if (run.effort && run.integration) {
      const persist = () => writeRecord(run, () => assertRunEffortOwner(run));
      await persist();
      await writeFinal(run, true); fence();
      if (!run.integration.delivery) {
        run.integration.delivery = "intent";
        await persist();
        assertRunEffortOwner(run);
        dispatch();
        run.integration.delivery = "attempted";
        await persist();
      }
      donePromiseResolve(run);
    } else if (run.runtime === "herdr" && run.herdr) {
      await writeRecord(run, () => assertHerdrOwner(run));
      await writeFinal(run, true); fence();
      await dispatchHerdrSettlement(run, dispatch);
      donePromiseResolve(run);
    } else {
      await Promise.all([writeRecord(run), writeFinal(run)]).catch(() => {}).finally(() => {
        dispatch(); donePromiseResolve(run);
      });
    }
}

/** A local dispatch attempt, never a consumer acknowledgement. Ambiguous intents are not replayed. */
export function dispatchHerdrSettlement(run: Run, dispatch: () => void): Promise<void> {
  if (run.effort || !run.herdr) throw new Error("ordinary herdr settlement required");
  const binding = run.herdr, fence = herdrEffectFence(run);
  return run.herdrDelivery ??= Promise.resolve().then(async () => {
    fence();
    const persist = () => writeRecord(run, () => { fence(); if (run.herdr !== binding) throw new Error("herdr invocation replaced"); });
    if (binding.settlement && binding.settlement.launchNonce !== binding.launchNonce) throw new Error("herdr settlement nonce mismatch; preserve for inspection");
    if (binding.settlement?.delivery === "intent") {
      binding.settlement.delivery = "uncertain";
      run.errorMessage = [run.errorMessage, "delivery uncertain: notification/events/memory may be missing; automatic replay suppressed"].filter(Boolean).join("\n");
      await persist();
    }
    if (binding.settlement) return;
    binding.settlement = { launchNonce: binding.launchNonce, delivery: "intent" };
    await persist(); fence();
    try { dispatch(); } catch { /* attempted locally; no consumer delivery acknowledgement */ }
    fence(); binding.settlement.delivery = "attempted"; await persist();
  });
}
