import { subprocessRuntime } from "./subprocess-runtime.ts";
import { HerdrRuntime } from "./herdr/runtime.ts";
import type { ChildProcess } from "node:child_process";
import type { Run } from "./types.ts";
import type { PiCoreArgsOptions } from "./runs.ts";
import type { HerdrBinding } from "./herdr/identity.ts";
import type { InboxRequest } from "./herdr/inbox.ts";

export type RuntimeKind = "subprocess" | "herdr";
export type RuntimeChoice = RuntimeKind | "auto";
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function parseRuntimeChoice(value: unknown): RuntimeChoice {
  if (value === "auto" || value === "subprocess" || value === "herdr") return value;
  throw new Error(`runtime must be auto, subprocess or herdr; got ${JSON.stringify(value)}`);
}

/** Pure selection: callers supply their environment at acceptance, never at import. */
export function resolveRuntime(input: {
  perCall?: RuntimeChoice; persona?: RuntimeChoice; project?: RuntimeChoice; user?: RuntimeChoice;
  env: RuntimeEnvironment;
}): { ok: true; kind: RuntimeKind; source: "per-call" | "persona" | "project" | "user" | "auto" }
  | { ok: false; reason: string } {
  const layers = [["per-call", input.perCall], ["persona", input.persona], ["project", input.project], ["user", input.user]] as const;
  const [source, value] = layers.find(([, value]) => value !== undefined) ?? ["auto", "auto"];
  let choice: RuntimeChoice;
  try { choice = parseRuntimeChoice(value); }
  catch (e) { return { ok: false, reason: (e as Error).message }; }
  const insideHerdr = input.env.HERDR_ENV === "1" && !!input.env.HERDR_SOCKET_PATH && !!input.env.HERDR_PANE_ID;
  if (choice === "herdr" && !insideHerdr) return { ok: false, reason: "runtime herdr requested but HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID are not all set" };
  return { ok: true, kind: choice === "auto" ? (insideHerdr ? "herdr" : "subprocess") : choice, source };
}

/** Missing persisted tags are legacy subprocesses, not a new auto selection. */
export function unsupportedRuntimeReason(kind: unknown): string | undefined {
  if (kind === undefined || kind === "subprocess") return;
  return `runtime ${String(kind)} backend is unavailable; use runtime: subprocess for a fresh spawn. Saved runs cannot migrate backends.`;
}

export function assertSupportedRuntime(kind: unknown): void {
  const reason = unsupportedRuntimeReason(kind);
  if (reason) throw new Error(reason);
}

/** Facts from the subprocess; only the pipeline decides whether they settle a run. */
export interface RunSink {
  line(raw: string): void;
  close(code: number | null): void;
  error(): void;
  initialDeliveryFailed(error: Error): void;
}

interface TransportLifecycle {
  readonly closed: Promise<void>;
  readonly stderr: string;
  drain(): string;
  stop(signal?: NodeJS.Signals): void | Promise<void>;
}
export interface SubprocessTransport extends TransportLifecycle {
  readonly kind: "subprocess";
  readonly proc: ChildProcess;
}
export interface HerdrTransport extends TransportLifecycle {
  readonly kind: "herdr";
  readonly cancelled: boolean;
  readonly ready: Promise<{ binding: HerdrBinding; request: InboxRequest; launchOffset: number }>;
  cancel(): Promise<void>;
}
export type RunTransport = SubprocessTransport | HerdrTransport;

export type Signaler = (pid: number, signal: NodeJS.Signals | number) => void;
export type Delivery =
  | { kind: "queued"; ack: Promise<{ delivered: boolean; deliveredAt: number }> }
  | { kind: "epipe"; reason: string };

export interface RunRuntime {
  launch(run: Run, args: string[], cwd: string, sink: RunSink, initialPrompt?: string, core?: PiCoreArgsOptions): RunTransport;
  capabilities(run: Run): { pause: boolean; liveSend: boolean };
  deliver(run: Run, type: "steer" | "follow_up", text: string): Delivery;
  stopProcess(run: Run): void | Promise<void>;
  terminate(run: Run, killGroup: (pid: number, signal: NodeJS.Signals) => void): void | Promise<void>;
  signal(run: Run, signal: NodeJS.Signals, signaler?: Signaler): void;
}

/** Readopted records have no event source owned by this module instance. */
export function isObservableHere(run: Run): boolean {
  return run.proc !== undefined;
}

/** Recorded-backend effects only; the H2 public-launch gate remains unchanged. */
export function runtimeFor(run: Run): RunRuntime {
  if (run.runtime === "herdr") return new HerdrRuntime();
  assertSupportedRuntime(run.runtime);
  return subprocessRuntime;
}
