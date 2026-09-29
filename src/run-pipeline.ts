import { measureEffortFootprint } from "./effort/admit.ts";
import { effortGit } from "./effort/open.ts";
import { assertRunEffortOwner, readEffort } from "./effort/store.ts";
import { effortSummary, resolveEffortPolicy } from "./effort/policy.ts";
import { appendFile } from "node:fs/promises";
import type { RunRuntime, RunTransport } from "./runtime.ts";
import { subprocessRuntime } from "./subprocess-runtime.ts";
import { applyEvent } from "./event-handler.ts";
import { classifyFailure } from "./failure-classify.ts";
import { contextRetirementNotice } from "./context-retirement.ts";
import { recordRunOutcome } from "./memory.ts";
import type { ConductorEventEmitter } from "./conductor-events.ts";
import { isTerminal, type Run, type RunStatus, type ResolvedHook } from "./types.ts";
import {
  type RunRegistry, attachSpawnedProc, stampSpawnStreamingMode, forceTerminate,
  discoverSessionPathIfMissing, discoverContextRetirement, applyHookToTerminal,
  applyCloseHandlerTerminal, emitFinalizeEvent, applyRetryIfNeeded, applySubstanceCheck,
  settleWorktree, writeRecord, writeFinal, getFinalText, applyChainIfPresent, applyCompactionLine, checkTurnLimit,
} from "./runs.ts";

export interface RunPipelineOpts {
  registry: RunRegistry;
  runtime?: RunRuntime;
  /** Invoked once per parsed event, before state application, including the decoded tail. */
  onEvent?: (run: Run, event: unknown) => void;
  cwd: string;
  timeoutMs: number;
  onUpdate?: (run: Run) => void;
  onComplete?: (run: Run) => void;
  sessionDir?: string;
  /** Explicit steering opt-in, independent of automatic large-prompt RPC transport. */
  steerable: boolean;
  initialPrompt?: string;
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
  const runtime = opts.runtime ?? subprocessRuntime;

  // The argv builder owns transport selection; steering remains an independent opt-in.
  const rpc = piArgs[1] === "rpc";
  run.onComplete = opts.onComplete;
  const recoveredAnswer = !!opts.answer && !!run.reconciledAtStartup && !!run.effort && run.effort.gate !== undefined;
  if (run.effort && (!run.reconciledAtStartup || run.effort.gate !== undefined)) run.effort.gate = opts.resolvedHook ?? null;

  let awaitingAnswer = opts.answer !== undefined;
  let answerRecord = Promise.resolve();
  const restoreAnswer = async (reason: string): Promise<Run> => {
    await answerRecord;
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
  try {
    transport = runtime.launch(run, piArgs, opts.cwd, {
      line: line => processLine(line),
      close: code => {
        if (finalized) return;
        if ((code ?? 0) === 0) void finalize("completed", 0);
        else void finalize("failed", code ?? 0);
      },
      error: () => {
        run.errorMessage = "failed to spawn pi process";
        void finalize("failed", 1);
      },
      initialDeliveryFailed: error => {
        if (finalized) return;
        run.errorMessage = `initial prompt delivery failed: ${error.message}`;
        void finalize("failed", 1);
      },
    }, opts.initialPrompt);
  } catch (e) {
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
  answerRecord = attachSpawnedProc(run, transport.proc);
  stampSpawnStreamingMode(run, opts.steerable === true);
  run.streamingMode = rpc ? "rpc" : "print";

  // Hard timeout.
  run.timeoutTimer = setTimeout(() => {
    if (run.status === "running" || run.status === "paused") {
      forceTerminate(run, "timeout", opts.registry, opts.onComplete);
    }
  }, opts.timeoutMs);

  // Stream parsing.
  let finalized = false;
  let donePromiseResolve: (r: Run) => void;
  const done = new Promise<Run>((resolve) => {
    donePromiseResolve = resolve;
  });

  const finalize = async (terminal: RunStatus, exitCode?: number) => {
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
    const rest = transport.drain();
    if (rest.trim()) processLine(rest);
    if (opts.answer) await answerRecord;
    discoverSessionPathIfMissing(run, opts.sessionDir);
    discoverContextRetirement(run, opts.sessionDir);
    if ((awaitingAnswer || run.pendingAsk) && !isTerminal(run.status)) {
      if (awaitingAnswer || (terminal === "completed" && run.sessionPath && !contextRetirementNotice(run))) {
        try { transport.stop(); } catch { /* already exited */ }
        const killFallback = setTimeout(() => { try { transport.stop("SIGKILL"); } catch { /* already exited */ } }, 2000);
        await transport.closed;
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
        opts.registry.notify(run);
        try { opts.onComplete?.(run); } catch { /* listener errors cannot wedge settlement */ }
        donePromiseResolve(run);
        return;
      }
      run.pendingAsk = undefined;
      terminal = "failed";
      run.errorMessage = "Owner question cannot be resumed: session missing, retired, or subprocess failed. Use a fresh child with the transcript.";
    }
    if (run.effort) {
      try { transport.stop(); } catch { /* already exited */ }
      const escalation = setTimeout(() => { try { transport.stop("SIGKILL"); } catch { /* already exited */ } }, 2000);
      await transport.closed;
      clearTimeout(escalation);
      await answerRecord;
    }
    if (
      terminal === "completed" &&
      exitCode === 0 &&
      opts.resolvedHook &&
      !isTerminal(run.status)
    ) {
      try {
        terminal = await applyHookToTerminal(
          run,
          opts.resolvedHook,
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
          command: opts.resolvedHook.command,
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
    if (run.effort && terminal === "completed" && !isTerminal(run.status)) {
      run.proc = undefined;
      run.pid = undefined;
      try {
        const record = readEffort(run.effort.gitRoot, run.effort.name);
        if (!record) throw new Error("effort record missing; integration refused");
        assertRunEffortOwner(run);
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
        const outcome = await opts.registry.integrations.enqueue(run, () => opts.registry.notify(run), recoveredAnswer);
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
    await settle(terminal, exitCode);
  };

  let settled = false;
  const settle = async (terminal: RunStatus, exitCode?: number) => {
    if (settled) return;
    settled = true;
    try { await settleRun(run, terminal, exitCode, opts, transport, donePromiseResolve); }
    catch (error) {
      if (!run.integration) throw error;
      run.status = "integrating"; run.integration.state = "paused";
      run.integration.reason = `terminal persistence uncertain: ${(error as Error).message}`;
      opts.registry.notify(run);
    }
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Append every parseable JSON line to the transcript (fire-and-forget I/O).
    void appendFile(run.transcriptPath, line + "\n").catch(() => {});

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    opts.onEvent?.(run, event);

    if (!finalized && awaitingAnswer && ((!rpc && event.type === "agent_start") ||
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
      applyCompactionLine(run, opts.events);
      opts.registry.notify(run);
      return;
    }
    if (effect.kind === "updated") {
      opts.registry.notify(run);
      if (opts.onUpdate) opts.onUpdate(run);
    }

    // v0.17-S4: turn-limit enforcement — checked after every event.
    checkTurnLimit(run, opts.registry, (r, reason) =>
      forceTerminate(r, reason, opts.registry, opts.onComplete),
    );
  };

  if (awaitingAnswer) run.rejectAnswerDelivery = reason => {
    run.errorMessage = reason;
    void finalize("failed", 1);
  };
  return done;
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
    // Forced termination already published its state; retain discovery without notifying twice.
    if (!applyCloseHandlerTerminal(run, terminal, exitCode)) {
      discoverSessionPathIfMissing(run, opts.sessionDir);
      await writeRecord(run);
      run.proc = undefined;
      try {
        transport.stop();
      } catch {
        // already dead
      }
      // v0.16-S3: emit lifecycle event for force-terminated runs (run.status
      // already set by forceTerminate; emit before resolving done).
      emitFinalizeEvent(run, opts.events);
      // v0.18 classified retry: forceTerminate-settled runs (stall/timeout/
      // abort) never reach the normal `.finally` below, so dispatch retry
      // here. failureClass was stamped by forceTerminate; retryPolicy at
      // spawn. shouldRetry gates non-retryable classes (e.g. user kill).
      applyRetryIfNeeded(run, opts.onRetry);
      // v0.18 memory: record the (forceTerminate) outcome too.
      recordRunOutcome(run);
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
      try { opts.onComplete?.(run); } catch { /* local dispatch attempted, not receiver acknowledgement */ }
      applyChainIfPresent(run, run.status as RunStatus, opts.onChain);
      applyRetryIfNeeded(run, opts.onRetry);
      recordRunOutcome(run);
      emitFinalizeEvent(run, opts.events);
    };
    if (run.effort && run.integration) {
      const persist = () => writeRecord(run, () => assertRunEffortOwner(run));
      await persist();
      await writeFinal(run, true);
      if (!run.integration.delivery) {
        run.integration.delivery = "intent";
        await persist();
        assertRunEffortOwner(run);
        dispatch();
        run.integration.delivery = "attempted";
        await persist();
      }
      donePromiseResolve(run);
    } else {
      await Promise.all([writeRecord(run), writeFinal(run)]).catch(() => {}).finally(() => {
        dispatch(); donePromiseResolve(run);
      });
    }
}
