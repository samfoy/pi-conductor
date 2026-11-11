import { isAbsolute } from "node:path";

export type HerdrHost = "tui" | "hc";
export type HerdrEnvironment = { ok: true; host: HerdrHost } | { ok: false; conflict: boolean; reason: string };
type Env = Readonly<Record<string, string | undefined>>;

const TUI_ROUTING = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"] as const;
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);

export function hcTerminalEnv(env: Env): { address: string; socketPath: string } | undefined {
  const address = env.HC_TERMINAL_ID, socketPath = env.HC_TERMINAL_SOCKET;
  return token(address) && typeof socketPath === "string" && isAbsolute(socketPath) && !socketPath.includes("\0") ? { address, socketPath } : undefined;
}

export function herdrEnvironment(env: Env): HerdrEnvironment {
  if (env.HC_TERMINAL_ID !== undefined) {
    const tui = TUI_ROUTING.filter(key => env[key] !== undefined);
    if (tui.length) return { ok: false, conflict: true, reason: `both Herdr 2 (HC_TERMINAL_ID, HC_TERMINAL_SOCKET) and herdr TUI (HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID) variables are set (${["HC_TERMINAL_ID", ...tui].join(", ")}); refusing to guess which one runs this pi` };
    return hcTerminalEnv(env) ? { ok: true, host: "hc" }
      : { ok: false, conflict: false, reason: "HC_TERMINAL_ID/HC_TERMINAL_SOCKET are malformed (a token terminal id and an absolute socket path are required)" };
  }
  if (env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH && !!env.HERDR_PANE_ID) return { ok: true, host: "tui" };
  return { ok: false, conflict: false, reason: "HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID are not all set and this is not a Herdr 2 terminal (HC_TERMINAL_ID, HC_TERMINAL_SOCKET)" };
}
