import { isRecord } from "./cli.js";

export interface HerdrInvocation {
  runId: string;
  launchNonce: string;
  sessionId: string;
  sessionFile: string;
}
export interface HerdrBinding extends HerdrInvocation {
  ownerGeneration?: number;
  settlement?: { launchNonce: string; delivery: "intent" | "attempted" | "uncertain" };
  socketPath: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  createdTab: boolean;
  childPid?: number;
  childStartTime?: number;
}
export interface LaunchHello extends HerdrInvocation {
  v: 1;
  bridgeProtocol: number;
  pid: number;
  pidStartTime?: number;
  paneId: string;
  piVersion: string;
  conductorVersion: string;
  at: number;
}
export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  // Optional in herdr 0.9.1's schema and omitted when absent: omission means none.
  agent?: string | null;
  agent_session?: {kind: "path" | "id"; value: string; agent: string; source: string} | null;
}
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
const positiveInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function isHerdrPane(value: unknown): value is HerdrPane {
  if (!isRecord(value) || ![value.pane_id, value.terminal_id, value.workspace_id, value.tab_id].every(text)) return false;
  const session = value.agent_session;
  return (value.agent == null || text(value.agent)) && (session == null || (isRecord(session) &&
    (session.kind === "path" || session.kind === "id") && [session.value, session.agent, session.source].every(text)));
}
interface PaneEvidence {
  binding: unknown;
  current: unknown;
  socketPath: string;
  pane: unknown;
  requireNoAgent: boolean;
}
type Refusal = {ok: false; state: "unknown" | "gone"; reason: string};
const unknown = (reason: string): Refusal => ({ok: false, state: "unknown", reason});

export function sameHerdrBinding(a: HerdrBinding | undefined, b: HerdrBinding | undefined): boolean {
  return !!a && !!b && (["runId", "launchNonce", "sessionId", "sessionFile", "socketPath", "workspaceId", "tabId", "paneId", "terminalId", "childPid", "childStartTime", "ownerGeneration"] as const).every(key => a[key] === b[key]);
}

export function provePaneOurs(ev: PaneEvidence): {ok: true} | Refusal {
  const {binding: b, current, pane} = ev;
  if (!isRecord(b) || !isRecord(current) || !isHerdrPane(pane)) return unknown("missing pane evidence");
  for (const key of ["runId", "launchNonce", "sessionId", "sessionFile"] as const) {
    if (!text(b[key]) || b[key] !== current[key]) return unknown("invocation mismatch");
  }
  if (!text(b.socketPath) || b.socketPath !== ev.socketPath) return unknown("socket mismatch");
  if (pane.pane_id !== b.paneId || pane.terminal_id !== b.terminalId ||
      pane.workspace_id !== b.workspaceId || pane.tab_id !== b.tabId) return unknown("pane identity mismatch");
  if (ev.requireNoAgent && (pane.agent != null || pane.agent_session != null)) return unknown("pane not empty");
  return {ok: true};
}

export function proveChildProcess(ev: Omit<PaneEvidence, "requireNoAgent"> & {
  hello: unknown;
  platform: string;
  bridgeProtocol: number;
  process: unknown;
}): {ok: true; pid: number} | Refusal {
  const paneProof = provePaneOurs({...ev, requireNoAgent: false});
  if (!paneProof.ok) return paneProof;
  const {binding: b, hello: h, pane, process: proc} = ev;
  if (!isRecord(b) || !isRecord(h) || !isHerdrPane(pane) || !isRecord(proc)) return unknown("missing child evidence");
  if (h.v !== 1 || !positiveInteger(ev.bridgeProtocol) || h.bridgeProtocol !== ev.bridgeProtocol ||
      !text(h.piVersion) || !text(h.conductorVersion) || typeof h.at !== "number" || !Number.isFinite(h.at) || h.at < 0) return unknown("malformed hello");
  for (const key of ["runId", "launchNonce", "sessionId", "sessionFile"] as const) {
    if (h[key] !== b[key]) return unknown("hello invocation mismatch");
  }
  if (h.paneId !== b.paneId || !positiveInteger(h.pid) || h.pid <= 1 || h.pid !== b.childPid || proc.pid !== h.pid) return unknown("child pid mismatch");
  if (pane.agent !== "pi" || pane.agent_session?.kind !== "path" || pane.agent_session.agent !== "pi" ||
      pane.agent_session.value !== h.sessionFile) return unknown("Pi session mismatch");
  if (!text(ev.platform) || (h.pidStartTime !== undefined && !positiveInteger(h.pidStartTime)) ||
      h.pidStartTime !== b.childStartTime) return unknown("malformed start identity");
  if (ev.platform === "linux" && !positiveInteger(h.pidStartTime)) return unknown("missing start identity");
  if (proc.state === "gone") return {ok: false, state: "gone", reason: "child absent"};
  if (proc.state !== "alive") return unknown("child liveness unknown");
  if (ev.platform === "linux" && proc.startTime !== h.pidStartTime) return unknown("child start mismatch");
  return {ok: true, pid: h.pid};
}
