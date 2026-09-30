import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { RpcStdinQueue } from "./rpc-stdin.ts";
import type { Run } from "./types.ts";
import { assertSupportedRuntime, unsupportedRuntimeReason, runtimeFor } from "./runtime.ts";
import type { RunRuntime, RunSink, SubprocessTransport, Signaler, Delivery } from "./runtime.ts";

export class SubprocessRuntime implements RunRuntime {
  launch(run: Run, args: string[], cwd: string, sink: RunSink, initialPrompt?: string): SubprocessTransport {
    assertSupportedRuntime(run.runtime);
    const invocation = getPiInvocation(args);
    const tmp = run.effort ? join(dirname(run.recordPath), "tmp") : undefined;
    if (tmp) mkdirSync(tmp, { recursive: true });
    const rpc = args[1] === "rpc";
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"],
      // Worktrees may not contain the spawning project's untracked config.
      env: { ...buildSubagentEnv(), CONDUCTOR_CONFIG_CWD: run.cwd, CONDUCTOR_RUN_ID: run.id, ...(tmp ? { TMPDIR: tmp } : {}) },
    });
    const closed = new Promise<void>(resolve => proc.once("close", () => resolve()));
    const stdoutLines = createLineDecoder(line => sink.line(line));
    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => stdoutLines.write(data));
    proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", code => sink.close(code));
    proc.on("error", () => sink.error());
    if (rpc && proc.stdin) {
      const queue = new RpcStdinQueue(proc.stdin);
      // Writable emits error even when its write callback observes early-exit EPIPE.
      proc.stdin.on("error", (e: Error) => queue.destroy(e.message));
      run.rpcStdinQueue = queue;
      if (typeof initialPrompt === "string" && initialPrompt.length > 0) {
        void queue.enqueue({ id: `init-${run.id}`, type: "prompt", message: initialPrompt })
          .catch((error: Error) => sink.initialDeliveryFailed(error));
      }
    }
    proc.unref();
    return { kind: "subprocess", proc, closed, get stderr() { return stderr; }, drain: () => stdoutLines.end(), stop: signal => { proc.kill(signal); } };
  }

  capabilities(run: Run) {
    if (unsupportedRuntimeReason(run.runtime)) return { pause: false, liveSend: false };
    const exited = run.proc?.exitCode != null || run.proc?.signalCode != null;
    return {
      pause: !!run.proc?.pid && !exited,
      liveSend: run.streamingMode === "rpc" && run.steerable !== false && !!run.rpcStdinQueue?.writable && !exited,
    };
  }

  deliver(run: Run, type: "steer" | "follow_up" | "grace", message: string) {
    const reason = unsupportedRuntimeReason(run.runtime);
    return reason ? { kind: "epipe" as const, reason } : enqueueRpcSendWithAck(run, type === "grace" ? "follow_up" : type, message);
  }

  stopProcess(run: Run): void {
    assertSupportedRuntime(run.runtime);
    run.proc?.kill("SIGTERM");
  }

  signal(run: Run, signal: NodeJS.Signals, signaler: Signaler = process.kill): void {
    assertSupportedRuntime(run.runtime);
    signaler(run.proc!.pid!, signal);
  }

  terminate(run: Run, killGroup: (pid: number, signal: NodeJS.Signals) => void): void {
    assertSupportedRuntime(run.runtime);
    if (run.proc) {
      try {
        run.proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      // Force-kill after 2s if it hasn't exited.
      setTimeout(() => {
        try {
          run.proc?.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 2000).unref();
    }
    terminateHook(run, killGroup);
  }
}

export function terminateHook(run: Run, killGroup: (pid: number, signal: NodeJS.Signals) => void): void {
  if (run.hookProc?.pid !== undefined) {
    const hookPid = run.hookProc.pid;
    try {
      killGroup(hookPid, "SIGTERM");
    } catch {
      // defaultKillGroup already swallows ESRCH/EPERM; this guards
      // against test stubs that throw unexpectedly.
    }
    setTimeout(() => {
      try {
        killGroup(hookPid, "SIGKILL");
      } catch {
        // already dead / test stub
      }
    }, 2000).unref();
    // Clear immediately so the close handler's `finally` block in
    // `applyHookToTerminal` is a no-op and W5's assertion holds.
    run.hookProc = undefined;
  }
}

export const subprocessRuntime = new SubprocessRuntime();

export function capabilitiesFor(run: Run) {
  return run.runtime !== "herdr" && unsupportedRuntimeReason(run.runtime) ? { pause: false, liveSend: false } : runtimeFor(run).capabilities(run);
}

export function buildSubagentEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...baseEnv, CONDUCTOR_SUBAGENT: "1" };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Test-friendly override: PI_BIN=<path-to-pi-cli.js> forces a specific
  // pi CLI invocation regardless of how the parent was started.
  const piBinEnv = process.env.PI_BIN;
  if (piBinEnv && existsSync(piBinEnv)) {
    return { command: process.execPath, args: [piBinEnv, ...args] };
  }

  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    const looksLikePi =
      /(^|\/)(pi|cli\.js)$/.test(currentScript) &&
      currentScript.includes("pi-coding-agent");
    if (looksLikePi) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/** Split only on LF; retain split UTF-8 bytes and return the unterminated tail on drain. */
export function createLineDecoder(onLine: (line: string) => void): {
  write(chunk: Buffer): void;
  end(): string;
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    end() {
      const rest = buffer + decoder.end();
      buffer = "";
      return rest;
    },
  };
}

// Preserve the native RPC acknowledgement deadline across extraction.
export const RPC_ACK_TIMEOUT_MS = 30_000;

let rpcSendCounter = 0;

function enqueueRpcSendWithAck(
  run: Run,
  type: "steer" | "follow_up",
  message: string,
): Delivery {
  const queue = run.rpcStdinQueue;
  if (!queue) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered (stdin queue gone).`,
    };
  }
  // Lazy-init the correlation Map.
  if (!run.pendingAcks) run.pendingAcks = new Map();
  rpcSendCounter += 1;
  const id = `send-${run.id}-${rpcSendCounter}`;
  const ackPromise = new Promise<{ delivered: boolean; deliveredAt: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        // Self-removal from the Map: the timeout fires and the entry
        // must clean itself up so a late-arriving `response` no-ops in
        // routeRpcResponse instead of double-firing.
        run.pendingAcks?.delete(id);
        reject(
          new Error(
            `ack timeout — sub-agent may have received the message; check via ensemble_status`,
          ),
        );
      }, RPC_ACK_TIMEOUT_MS);
      run.pendingAcks!.set(id, {
        resolve: (delivered: boolean) =>
          resolve({ delivered, deliveredAt: Date.now() }),
        reject,
        timer,
      });
    },
  );
  // Fire-and-forget: the enqueue Promise resolves on kernel-write; if
  // the pipe died (EPIPE), the queue rejects. Either way we surface
  // through the ack promise (timeout) or via this catch (EPIPE).
  let epipeFlag: { msg: string } | null = null;
  void queue.enqueue({ id, type, message }).catch((err: Error) => {
    // Sub-agent finished before steer was delivered. Clean up the
    // pendingAcks entry and reject the ack promise with the Q3 lock
    // wording.
    const entry = run.pendingAcks?.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      run.pendingAcks?.delete(id);
      entry.reject(
        new Error(
          `sub-agent ${run.id} finished before steer was delivered (${err.message}).`,
        ),
      );
    }
    epipeFlag = { msg: err.message };
  });
  if (epipeFlag) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered.`,
    };
  }
  return { kind: "queued", ack: ackPromise };
}
