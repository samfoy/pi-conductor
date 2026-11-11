import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isRecord } from "../herdr/cli.ts";
import { herdrFailure, type ChildEvidence, type ChildProof, type LaunchFence, type LaunchSpec, type LeafSpec, type PlaceSpec, type ReleaseResult,
  type TerminalHost, type TerminalIdentity } from "../herdr/host.ts";
import { isHcBinding, type HcBinding, type HerdrBinding, type HerdrInvocation } from "../herdr/identity.ts";
import { HcCliError, type HcCli, type HcLimits, type HcRunResult, type HcTerminal } from "./cli.ts";

export const HC_UNSET_HERDR_ENV = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION", "HERDR_BIN_PATH"] as const;
export const hcTab = (runId: string): string => `tb${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;

type Refusal = { ok: false; state: "unknown" | "gone"; reason: string };
const unknown = (reason: string): Refusal => ({ ok: false, state: "unknown", reason });
const INVOCATION = ["runId", "launchNonce", "sessionId", "sessionFile"] as const;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
export const hcLabel = (v: unknown): v is string => text(v) && !/[\r\n]/.test(v) && Buffer.byteLength(v) <= 512;
const positiveInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const address = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_/-]{0,127}$/.test(v);
const localAddress = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const envName = (v: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && !v.startsWith("HC_") && !v.startsWith("HERDR_");

function hcOnly(binding: HerdrBinding): HcBinding {
  if (!isHcBinding(binding)) throw herdrFailure("not a Herdr 2 binding");
  return binding;
}
function addressOf(binding: HerdrBinding): string {
  const hc = hcOnly(binding);
  if (!hc.address) throw herdrFailure("hc terminal address unknown");
  return hc.address;
}

function sameInvocation(b: HcBinding, current: HerdrInvocation | undefined): boolean {
  return !!current && INVOCATION.every(key => text(b[key]) && b[key] === current[key]);
}

function terminalOurs(ev: { binding: unknown; current: unknown; socketPath: string; coreId: string; observation: unknown }): { ok: true } | Refusal {
  const { binding: b, current, observation: t } = ev;
  if (!isRecord(b) || !isRecord(current) || !isRecord(t)) return unknown("missing terminal evidence");
  if (b.host !== "hc") return unknown("not a Herdr 2 binding");
  for (const key of INVOCATION) if (!text(b[key]) || b[key] !== current[key]) return unknown("invocation mismatch");
  if (!text(b.socketPath) || b.socketPath !== ev.socketPath) return unknown("socket mismatch");
  if (b.coreId !== ev.coreId) return unknown("core mismatch");
  if (!address(b.address) || t.address !== b.address) return unknown("terminal address mismatch");
  if (!text(b.agentName) || t.name !== b.agentName) return unknown("terminal name mismatch");
  if (!isRecord(t.labels) || t.labels["conductor.run"] !== b.runId || t.labels["conductor.nonce"] !== b.launchNonce) return unknown("terminal labels mismatch");
  return { ok: true };
}

function proveHcChild(coreId: string, ev: ChildEvidence): ChildProof {
  const ours = terminalOurs({ ...ev, coreId });
  if (!ours.ok) return ours;
  const { binding: b, hello: h, observation: t, process: proc } = ev;
  if (!isRecord(b) || !isRecord(h) || !isRecord(t) || !isRecord(proc)) return unknown("missing child evidence");
  if (h.v !== 1 || !positiveInteger(ev.bridgeProtocol) || h.bridgeProtocol !== ev.bridgeProtocol ||
      !text(h.piVersion) || !text(h.conductorVersion) || typeof h.at !== "number" || !Number.isFinite(h.at) || h.at < 0) return unknown("malformed hello");
  for (const key of INVOCATION) if (h[key] !== b[key]) return unknown("hello invocation mismatch");
  if (h.paneId !== b.address) return unknown("hello terminal mismatch");
  if (!positiveInteger(h.pid) || h.pid <= 1 || h.pid !== b.childPid || proc.pid !== h.pid || t.pid !== h.pid) return unknown("child pid mismatch");
  if (!text(ev.platform) || (h.pidStartTime !== undefined && !positiveInteger(h.pidStartTime)) ||
      h.pidStartTime !== b.childStartTime) return unknown("malformed start identity");
  if (ev.platform === "linux" && !positiveInteger(h.pidStartTime)) return unknown("missing start identity");
  if (proc.state === "gone") return { ok: false, state: "gone", reason: "child absent" };
  if (proc.state !== "alive") return unknown("child liveness unknown");
  if (t.state !== "live") return unknown("terminal finished while its child pid is alive");
  if (ev.platform === "linux" && proc.startTime !== h.pidStartTime) return unknown("child start mismatch");
  return { ok: true, pid: h.pid };
}

export function hcIdentity(coreId: string): TerminalIdentity {
  return {
    proveChild: evidence => proveHcChild(coreId, evidence),
    recorded: binding => isHcBinding(binding) ? { address: binding.address, name: binding.agentName, pid: binding.childPid, state: "live",
      labels: { "conductor.run": binding.runId, "conductor.nonce": binding.launchNonce } } : undefined,
    helloFields: (binding, hello) => isHcBinding(binding) && binding.address === undefined && isRecord(hello) && localAddress(hello.paneId)
      ? { address: hello.paneId } : {},
  };
}

export interface HcHostOptions { cli: HcCli; coreId: string; lead?: { address: string; space?: string }; piCommand?: readonly [string, string] }

export class HcHost implements TerminalHost {
  readonly identity: TerminalIdentity;
  constructor(private readonly options: HcHostOptions) {
    const { coreId, lead, piCommand } = options;
    if (!hcLabel(coreId) || (lead !== undefined && (!address(lead.address) || (lead.space !== undefined && !hcLabel(lead.space)))) ||
        (piCommand !== undefined && (piCommand.length !== 2 || !piCommand.every(p => text(p) && isAbsolute(p) && !p.includes("="))))) throw new HcCliError("configuration");
    this.identity = hcIdentity(coreId);
  }
  get socketPath() { return this.options.cli.socketPath; }
  owns(binding: HerdrBinding | undefined): boolean {
    return isHcBinding(binding) && binding.socketPath === this.socketPath && binding.coreId === this.options.coreId;
  }

  async retire(previous: HerdrBinding, signal?: AbortSignal): Promise<ReleaseResult> {
    if (!this.owns(previous)) return unknown("previous invocation is not a terminal on this herdr-core");
    return this.release(previous, () => previous, { timeoutMs: 2000, signal });
  }

  private binding(invocation: HerdrInvocation, parentAddress: string, space: string | undefined, tab: string, createdTab: boolean): HcBinding {
    return { ...invocation, host: "hc", socketPath: this.socketPath, coreId: this.options.coreId, parentAddress, ...(space === undefined ? {} : { space }), tab, createdTab };
  }

  async reuse(): Promise<HerdrBinding | undefined> { return undefined; }

  async placeRun(spec: PlaceSpec): Promise<HerdrBinding> {
    const { lead } = this.options;
    if (!lead) throw herdrFailure("hc launch refused: lead terminal unknown");
    return this.binding(spec.invocation, lead.address, lead.space, hcTab(spec.invocation.runId), true);
  }

  async placeLeaf({ parentId, parentRuntime, parent, current, invocation }: LeafSpec, fence: LaunchFence, signal?: AbortSignal) {
    const own = (why: string) => ({ warning: `${why}; leaf placed in its own tab` });
    if (parentRuntime !== "herdr" || !parent) return own(`parent ${parentId} has no Herdr 2 terminal (${parentRuntime} runtime)`);
    if (!isHcBinding(parent)) return own(`parent ${parentId} is a herdr TUI pane`);
    if (parent.socketPath !== this.socketPath || parent.coreId !== this.options.coreId) return own(`parent ${parentId} terminal is on another herdr-core`);
    if (!parent.address) return own(`parent ${parentId} terminal address unknown`);
    const fenced = own(`parent ${parentId} is no longer this lead's current owned run`);
    if (!current()) return fenced;
    let observed: Awaited<ReturnType<HcCli["get"]>>;
    try { observed = await this.options.cli.get(parent.address, { timeoutMs: 2000, signal }); }
    catch { return current() ? own(`parent ${parentId} terminal observation unavailable`) : fenced; }
    if (!current()) return fenced;
    fence.check();
    const ours = terminalOurs({ binding: parent, current: parent, socketPath: this.socketPath, coreId: this.options.coreId, observation: observed });
    if (!ours.ok) return own(`parent terminal unproven (${ours.reason})`);
    if (observed.state !== "live") return own("parent terminal unproven (terminal finished)");
    if (!positiveInteger(parent.childPid) || observed.pid !== parent.childPid) return own("parent terminal unproven (child pid mismatch)");
    return { binding: this.binding(invocation, parent.address, parent.space, parent.tab, false) };
  }

  async start(target: HerdrBinding, launch: LaunchSpec, limits: HcLimits, fence: LaunchFence): Promise<unknown> {
    const binding = hcOnly(target), piCommand = this.options.piCommand;
    if (!piCommand) throw herdrFailure("hc launch refused: the host Pi entry is not Pi's declared bin, and hc never runs a bare pi from the core's PATH");
    const [node, entry] = piCommand, env = Object.entries(launch.env);
    if (binding.agentName !== launch.alias) throw herdrFailure("launch alias is not the binding's agent name");
    if (!env.every(([key]) => envName(key))) throw herdrFailure("invalid terminal environment");
    const labels = { "conductor.run": binding.runId, "conductor.nonce": binding.launchNonce, "herdr.tab": binding.tab,
      ...(binding.space === undefined ? {} : { "herdr.space": binding.space }) };
    const argv = ["env", ...HC_UNSET_HERDR_ENV.flatMap(name => ["-u", name]), ...env.map(([key, value]) => `${key}=${value}`), node, entry, ...launch.args];
    let result: HcRunResult;
    try {
      result = await this.options.cli.run({ name: launch.alias, cwd: launch.cwd, labels, argv,
        ...(binding.parentAddress === undefined ? {} : { parent: binding.parentAddress }) }, limits);
    } catch {
      fence.check();
      throw herdrFailure("hc start outcome unconfirmed; no blind retry");
    }
    fence.check();
    if (result.name !== launch.alias || result.state !== "live" || result.parent !== (binding.parentAddress ?? null)) throw herdrFailure("hc run registered a different terminal");
    binding.address = result.address;
    return this.options.cli.get(result.address, { timeoutMs: 2000, signal: limits.signal }).catch(() => ({ ...result, labels, pid: null }));
  }

  async observe(binding: HerdrBinding, limits?: HcLimits): Promise<unknown> {
    return this.options.cli.get(addressOf(binding), limits);
  }

  async readScreen(binding: HerdrBinding, lines: number, limits?: HcLimits): Promise<string> {
    return this.options.cli.read(addressOf(binding), lines, limits);
  }

  async release(target: HerdrBinding, current: () => HerdrInvocation | undefined, limits?: HcLimits): Promise<ReleaseResult> {
    if (!isHcBinding(target) || !target.address) return unknown("no Herdr 2 terminal to release");
    let observed: HcTerminal;
    try { observed = await this.options.cli.get(target.address, limits); }
    catch (e) {
      return e instanceof HcCliError && e.remoteKind === "not_found" && this.owns(target) && sameInvocation(target, current()) ? { ok: true } : unknown("terminal cleanup unconfirmed");
    }
    try {
      const ours = terminalOurs({ binding: target, current: current(), socketPath: this.socketPath, coreId: this.options.coreId, observation: observed });
      if (!ours.ok) return ours;
      if (observed.state !== "finished") return unknown("terminal still live");
      if (limits?.signal?.aborted) return unknown("terminal cleanup cancelled");
      await this.options.cli.rm(target.address, limits);
      return { ok: true };
    } catch { return unknown("terminal cleanup unconfirmed"); }
  }
}
