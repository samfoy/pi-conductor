import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding, type ExecFileException } from "node:child_process";
import { isAbsolute } from "node:path";

export type HerdrFailure = "configuration" | "spawn" | "nonzero" | "remote" | "protocol" | "output-limit" | "timeout" | "cancelled";
export class HerdrCliError extends Error {
  constructor(readonly kind: HerdrFailure, readonly exitCode?: number, readonly remoteCode?: string) {
    // Never retain argv, raw output, native errors or their causes: proxies can contain credentials.
    super(`herdr: ${kind}`);
    this.name = "HerdrCliError";
  }
}
export interface CliLimits { timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal }
type Execute = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => ChildProcess;

export function resolveHerdrBin(env: NodeJS.ProcessEnv): string {
  return env.CONDUCTOR_HERDR_BIN || env.HERDR_BIN_PATH || "herdr";
}
const jsonCommands: Record<string, string> = {
  "tab create": "tab_created", "pane get": "pane_info", "pane close": "ok", "agent start": "agent_started",
};
const remoteCodes = new Set(["agent_pane_busy", "agent_not_ready", "pane_not_found", "tab_not_found", "workspace_not_found"]);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function envelope(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isRecord(value) && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
}

export function createHerdrCli(opts: {env: NodeJS.ProcessEnv; socketPath: string; execute?: Execute}) {
  if (!isAbsolute(opts.socketPath) || opts.socketPath.includes("\0")) throw new HerdrCliError("configuration");
  const socketPath = opts.socketPath;
  const bin = resolveHerdrBin(opts.env);
  const env = Object.fromEntries(Object.entries(opts.env).filter(([key]) => !key.startsWith("HERDR_")));
  env.HERDR_SOCKET_PATH = socketPath;
  const execute = opts.execute ?? execFile;

  async function run(args: readonly string[], json: boolean, limits: CliLimits = {}): Promise<string> {
    const timeoutMs = limits.timeoutMs ?? 5000;
    const maxBuffer = limits.maxBuffer ?? 65536;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 65000 ||
        !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > 1048576) throw new HerdrCliError("configuration");
    if (limits.signal?.aborted) throw new HerdrCliError("cancelled");
    return new Promise((resolve, reject) => {
      let outcome: {error: ExecFileException | null; stdout: string; stderr: string} | undefined;
      try {
        const child = execute(bin, [...args], {env: {...env}, encoding: "utf8", shell: false,
          timeout: timeoutMs, maxBuffer, killSignal: "SIGKILL"},
        (error, stdout, stderr) => { outcome = {error, stdout, stderr}; });
        // execFile does not forward killSignal to spawn's AbortSignal handler (which uses TERM).
        const abort = () => { child.kill("SIGKILL"); };
        limits.signal?.addEventListener("abort", abort, {once: true});
        if (limits.signal?.aborted) abort();
        child.once("close", () => {
          limits.signal?.removeEventListener("abort", abort);
          if (limits.signal?.aborted) { reject(new HerdrCliError("cancelled")); return; }
          if (!outcome) { reject(new HerdrCliError("spawn")); return; }
          const {error, stdout, stderr} = outcome;
          if (error) {
            const code = error.code;
            const kind: HerdrFailure = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
              : error.killed ? "timeout" : typeof code === "number" ? "nonzero" : "spawn";
            const body = json ? (envelope(stdout)?.error ?? envelope(stderr)?.error) : undefined;
            const remoteCode = isRecord(body) && typeof body.code === "string" && remoteCodes.has(body.code) ? body.code : undefined;
            reject(new HerdrCliError(kind, typeof code === "number" ? code : undefined, remoteCode));
          } else resolve(stdout);
        });
      } catch { reject(new HerdrCliError("spawn")); }
    });
  }
  return {
    socketPath,
    text: (args: readonly string[], limits?: CliLimits) => run(args, false, limits),
    async json(args: readonly string[], limits?: CliLimits): Promise<Record<string, unknown>> {
      const expected = jsonCommands[args.slice(0, 2).join(" ")];
      if (!expected || args.includes("--help")) throw new HerdrCliError("protocol");
      const value = envelope(await run(args, true, limits));
      if (!value || ("error" in value && "result" in value)) throw new HerdrCliError("protocol");
      if (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
        throw new HerdrCliError("remote", undefined, remoteCodes.has(value.error.code) ? value.error.code : undefined);
      }
      if (!isRecord(value.result) || value.result.type !== expected) throw new HerdrCliError("protocol");
      return value.result;
    },
  };
}
export type HerdrCli = ReturnType<typeof createHerdrCli>;
