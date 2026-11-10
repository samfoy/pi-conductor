import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding, type ExecFileException } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord } from "../herdr/cli.ts";

export type HcFailure = "configuration" | "spawn" | "nonzero" | "remote" | "protocol" | "output-limit" | "timeout" | "cancelled";
export const HC_REMOTE_KINDS = ["live", "name_taken", "not_found", "spawn_failed", "invalid_params", "usage", "unavailable"] as const;
export type HcRemoteKind = typeof HC_REMOTE_KINDS[number];
export class HcCliError extends Error {
  constructor(readonly kind: HcFailure, readonly exitCode?: number, readonly remoteKind?: HcRemoteKind) {
    super(`hc: ${kind}`);
    this.name = "HcCliError";
  }
}
export interface HcLimits { timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal }
type Execute = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => ChildProcess;

export interface HcRunSpec { name: string; cwd: string; parent?: string; labels: Readonly<Record<string, string>>; argv: readonly string[] }
export interface HcRunResult { address: string; name: string; parent: string | null; state: "live" | "finished" }
export interface HcStatus { state: string; app?: string; kind?: string; message?: string }
export interface HcTerminal {
  address: string; name: string | null; pid: number | null; parent: string | null;
  die_with_parent: boolean; notify: boolean; labels: Record<string, string>;
  state: "live" | "finished"; exit_code: number | null; signal: number | null;
  cwd: string; argv: string[]; status: HcStatus | null;
}

export function resolveHcBin(env: NodeJS.ProcessEnv): string {
  return env.CONDUCTOR_HC_BIN || "hc";
}

const clean = (v: unknown): v is string => typeof v === "string" && !v.includes("\0");
const line = (v: unknown): v is string => clean(v) && !/[\r\n]/.test(v);
const validName = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v) && !/^t[0-9]+[a-z]?$/.test(v);
const validAddress = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_/-]{0,127}$/.test(v);
const validLabel = ([key, value]: [string, unknown]) => /^[a-z][a-z0-9._-]{0,63}$/.test(key) &&
  line(value) && value.length > 0 && Buffer.byteLength(value) <= 512;
const integerOrNull = (v: unknown): v is number | null => v === null || Number.isSafeInteger(v);
const terminalState = (v: unknown): v is "live" | "finished" => v === "live" || v === "finished";

export function hcRunArgs(spec: HcRunSpec): string[] {
  const labels = isRecord(spec.labels) ? Object.entries(spec.labels) : undefined;
  if (!validName(spec.name) || !clean(spec.cwd) || !isAbsolute(spec.cwd) ||
      (spec.parent !== undefined && !validAddress(spec.parent)) || !labels?.every(validLabel) ||
      !Array.isArray(spec.argv) || !spec.argv.length || !spec.argv[0] || !spec.argv.every(clean)) throw new HcCliError("configuration");
  return ["run", "--bg", "--json", "--outlive-parent", "--no-notify", "--name", spec.name, "--cwd", spec.cwd,
    ...(spec.parent === undefined ? [] : ["--parent", spec.parent]),
    ...labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]), "--", ...spec.argv];
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
function envelope(text: string): string | undefined {
  const value = parse(text);
  return isRecord(value) && isRecord(value.error) && typeof value.error.kind === "string" &&
    typeof value.error.message === "string" ? value.error.kind : undefined;
}
const remote = (kind: string, exitCode?: number) =>
  new HcCliError("remote", exitCode, (HC_REMOTE_KINDS as readonly string[]).includes(kind) ? kind as HcRemoteKind : undefined);

function status(v: unknown): HcStatus | null {
  if (v === null) return null;
  if (!isRecord(v) || typeof v.state !== "string") throw new HcCliError("protocol");
  const optional = (key: "app" | "kind" | "message") => typeof v[key] === "string" ? { [key]: v[key] } : {};
  return { state: v.state, ...optional("app"), ...optional("kind"), ...optional("message") };
}
function terminal(v: Record<string, unknown>): HcTerminal {
  const labels = v.labels;
  if (!validAddress(v.address) || (v.name !== null && typeof v.name !== "string") ||
      !integerOrNull(v.pid) || (v.pid !== null && v.pid <= 0) || (v.parent !== null && typeof v.parent !== "string") ||
      typeof v.die_with_parent !== "boolean" || typeof v.notify !== "boolean" ||
      !isRecord(labels) || !Object.values(labels).every(x => typeof x === "string") ||
      !terminalState(v.state) || !integerOrNull(v.exit_code) || !integerOrNull(v.signal) ||
      typeof v.cwd !== "string" || !Array.isArray(v.argv) || !v.argv.every(x => typeof x === "string")) throw new HcCliError("protocol");
  return { address: v.address, name: v.name, pid: v.pid, parent: v.parent, die_with_parent: v.die_with_parent, notify: v.notify,
    labels: { ...labels as Record<string, string> }, state: v.state, exit_code: v.exit_code, signal: v.signal,
    cwd: v.cwd, argv: [...v.argv as string[]], status: status(v.status) };
}

export function createHcCli(opts: { env: NodeJS.ProcessEnv; socketPath: string; execute?: Execute }) {
  if (!clean(opts.socketPath) || !isAbsolute(opts.socketPath)) throw new HcCliError("configuration");
  const socketPath = opts.socketPath;
  const bin = resolveHcBin(opts.env);
  const env = Object.fromEntries(Object.entries(opts.env).filter(([key]) => !key.startsWith("HC_") && !key.startsWith("HERDR_")));
  env.HC_SOCKET = socketPath;
  const execute = opts.execute ?? execFile;

  function socketPresent(): boolean {
    try { return lstatSync(socketPath).isSocket(); } catch { return false; }
  }
  async function exec(args: readonly string[], limits: HcLimits = {}): Promise<string> {
    const timeoutMs = limits.timeoutMs ?? 5000;
    const maxBuffer = limits.maxBuffer ?? 65536;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 65000 ||
        !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > 1048576) throw new HcCliError("configuration");
    if (limits.signal?.aborted) throw new HcCliError("cancelled");
    // hc starts a new core at HC_SOCKET when nothing listens there; never let a stale binding do that.
    if (!socketPresent()) throw new HcCliError("remote", undefined, "unavailable");
    return new Promise((resolve, reject) => {
      let outcome: { error: ExecFileException | null; stdout: string; stderr: string } | undefined;
      try {
        const child = execute(bin, [...args], { env: { ...env }, encoding: "utf8", shell: false,
          timeout: timeoutMs, maxBuffer, killSignal: "SIGKILL" },
        (error, stdout, stderr) => { outcome = { error, stdout, stderr }; });
        const abort = () => { child.kill("SIGKILL"); };
        limits.signal?.addEventListener("abort", abort, { once: true });
        if (limits.signal?.aborted) abort();
        child.once("close", () => {
          limits.signal?.removeEventListener("abort", abort);
          if (limits.signal?.aborted) { reject(new HcCliError("cancelled")); return; }
          if (!outcome) { reject(new HcCliError("spawn")); return; }
          const { error, stdout, stderr } = outcome;
          if (!error) { resolve(stdout); return; }
          const code = error.code;
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reject(new HcCliError("output-limit"));
          else if (error.killed) reject(new HcCliError("timeout"));
          else if (typeof code !== "number") reject(new HcCliError("spawn"));
          else {
            const kind = envelope(stderr) ?? envelope(stdout);
            reject(kind === undefined ? new HcCliError("nonzero", code) : remote(kind, code));
          }
        });
      } catch { reject(new HcCliError("spawn")); }
    });
  }
  async function json(args: readonly string[], limits?: HcLimits): Promise<Record<string, unknown>> {
    const stdout = await exec(args, limits);
    const kind = envelope(stdout);
    if (kind !== undefined) throw remote(kind, 0);
    const value = parse(stdout);
    if (!isRecord(value)) throw new HcCliError("protocol");
    return value;
  }
  function address(value: string): string {
    if (!validAddress(value)) throw new HcCliError("configuration");
    return value;
  }
  return {
    socketPath,
    async run(spec: HcRunSpec, limits?: HcLimits): Promise<HcRunResult> {
      const v = await json(hcRunArgs(spec), limits);
      if (!validAddress(v.address) || typeof v.name !== "string" || !terminalState(v.state) ||
          (v.parent !== undefined && typeof v.parent !== "string")) throw new HcCliError("protocol");
      return { address: v.address, name: v.name, parent: v.parent ?? null, state: v.state };
    },
    async get(target: string, limits?: HcLimits): Promise<HcTerminal> {
      return terminal(await json(["get", address(target), "--json"], limits));
    },
    async read(target: string, lines: number, limits?: HcLimits): Promise<string> {
      if (!Number.isSafeInteger(lines) || lines < 0 || lines > 100000) throw new HcCliError("configuration");
      return exec(["read", address(target), "--lines", String(lines)], limits);
    },
    async rm(target: string, limits?: HcLimits): Promise<{ removed: string }> {
      const v = await json(["rm", address(target), "--json"], limits);
      if (!validAddress(v.removed)) throw new HcCliError("protocol");
      return { removed: v.removed };
    },
    async serverStatus(limits?: HcLimits): Promise<{ coreId: string; version: string }> {
      const v = await json(["server", "status", "--json"], limits);
      if (!isRecord(v.core) || !line(v.core.id) || !v.core.id || !line(v.version) || !v.version) throw new HcCliError("protocol");
      return { coreId: v.core.id, version: v.version };
    },
  };
}
export type HcCli = ReturnType<typeof createHcCli>;
