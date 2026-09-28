import type { ChildProcess } from "node:child_process";
import type { Run } from "./types.ts";

/** Facts from the subprocess; only the pipeline decides whether they settle a run. */
export interface RunSink {
  line(raw: string): void;
  close(code: number | null): void;
  error(): void;
  initialDeliveryFailed(error: Error): void;
}

export interface RunTransport {
  readonly proc: ChildProcess;
  readonly closed: Promise<void>;
  readonly stderr: string;
  drain(): string;
  stop(signal?: NodeJS.Signals): void;
}

export type Signaler = (pid: number, signal: NodeJS.Signals | number) => void;
export type Delivery =
  | { kind: "queued"; ack: Promise<{ delivered: boolean; deliveredAt: number }> }
  | { kind: "epipe"; reason: string };

export interface RunRuntime {
  launch(run: Run, args: string[], cwd: string, sink: RunSink, initialPrompt?: string): RunTransport;
  capabilities(run: Run): { pause: boolean; liveSend: boolean };
  deliver(run: Run, type: "steer" | "follow_up", text: string): Delivery;
  stopProcess(run: Run): void;
  terminate(run: Run, killGroup: (pid: number, signal: NodeJS.Signals) => void): void;
  signal(run: Run, signal: NodeJS.Signals, signaler?: Signaler): void;
}

/** Readopted records have no event source owned by this module instance. */
export function isObservableHere(run: Run): boolean {
  return run.proc !== undefined;
}
