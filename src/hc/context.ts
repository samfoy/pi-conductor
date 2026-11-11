import { createHcCli, HcCliError, type HcLimits } from "./cli.ts";
import { HcHost, hcIdentity, hcLabel } from "./host.ts";
import { herdrFailure, type LaunchFence, type LaunchSpec, type LeafSpec, type PlaceSpec, type ReleaseResult, type TerminalHost, type TerminalIdentity } from "../herdr/host.ts";
import type { HerdrBinding, HerdrInvocation } from "../herdr/identity.ts";
import { hostPiCommand } from "../pi-host.ts";
import { hcTerminalEnv } from "../herdr/environment.ts";

export interface HcContext {
  socketPath: string;
  coreId: string;
  lead: { address: string; space?: string };
  piCommand?: readonly [string, string];
}
type Env = Readonly<Record<string, string | undefined>>;

const contexts = new Map<string, HcContext>();
const pending = new Map<string, Promise<HcContext>>();
const failures = new Map<string, string>();
const keyOf = (env: Env) => `${env.HC_TERMINAL_SOCKET ?? ""}\0${env.HC_TERMINAL_ID ?? ""}`;
const why = (e: unknown) => e instanceof HcCliError ? e.remoteKind ?? e.kind : "error";

export function cachedHcContext(env: Env): HcContext | undefined {
  return contexts.get(keyOf(env));
}

export function hcContextStatus(env: Env): { context: HcContext } | { reason: string } {
  const context = cachedHcContext(env);
  if (context) return { context };
  return { reason: failures.get(keyOf(env)) ?? (pending.has(keyOf(env)) ? "resolving" : "not resolved yet") };
}

export function resolveHcContext(env: Env, piCommand: readonly [string, string] | undefined = hostPiCommand()): Promise<HcContext> {
  const key = keyOf(env), known = contexts.get(key);
  if (known) return Promise.resolve(known);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const resolving = (async () => {
    const terminal = hcTerminalEnv(env);
    if (!terminal) throw herdrFailure("not a Herdr 2 terminal: HC_TERMINAL_ID/HC_TERMINAL_SOCKET unset or malformed");
    const cli = createHcCli({ env: { ...env }, socketPath: terminal.socketPath });
    let coreId: string;
    try { coreId = (await cli.serverStatus()).coreId; } catch (e) { throw herdrFailure(`herdr-core id unresolved (${why(e)})`); }
    let observed: Awaited<ReturnType<typeof cli.get>>;
    try { observed = await cli.get(terminal.address); } catch (e) { throw herdrFailure(`lead terminal ${terminal.address} unobservable (${why(e)})`); }
    if (observed.state !== "live") throw herdrFailure(`lead terminal ${terminal.address} is not live`);
    const space = observed.labels["herdr.space"];
    if (space !== undefined && !hcLabel(space)) throw herdrFailure(`lead terminal ${terminal.address} has a malformed herdr.space label`);
    const context: HcContext = { socketPath: terminal.socketPath, coreId, lead: { address: terminal.address, ...(space === undefined ? {} : { space }) }, ...(piCommand ? { piCommand } : {}) };
    contexts.set(key, context);
    failures.delete(key);
    return context;
  })();
  pending.set(key, resolving);
  resolving.catch((e: unknown) => { failures.set(key, e instanceof Error ? e.message : String(e)); }).finally(() => pending.delete(key));
  return resolving;
}

function hostOf(env: Env, context: HcContext): HcHost {
  return new HcHost({ cli: createHcCli({ env: { ...env }, socketPath: context.socketPath }), coreId: context.coreId, lead: context.lead,
    ...(context.piCommand ? { piCommand: context.piCommand } : {}) });
}

const unresolved: TerminalIdentity = {
  ...hcIdentity(""),
  proveChild: () => ({ ok: false, state: "unknown", reason: "herdr-core id unresolved" }),
};

class LeadHcHost implements TerminalHost {
  private host?: HcHost;
  constructor(private readonly env: Env) {
    const context = cachedHcContext(env);
    if (context) this.host = hostOf(env, context);
  }
  get socketPath() { return this.env.HC_TERMINAL_SOCKET ?? ""; }
  get identity() { return this.host?.identity ?? unresolved; }
  private async ready(): Promise<HcHost> {
    try { return this.host ??= hostOf(this.env, await resolveHcContext(this.env)); }
    catch (e) { throw herdrFailure(`hc launch refused: ${e instanceof Error ? e.message.replace(/^herdr: /, "") : "herdr-core context unavailable"}`); }
  }
  owns(binding: HerdrBinding | undefined) { return this.host?.owns(binding) ?? false; }
  async retire(previous: HerdrBinding, signal?: AbortSignal): Promise<ReleaseResult> { return (await this.ready()).retire(previous, signal); }
  async reuse() { return (await this.ready()).reuse(); }
  async placeLeaf(spec: LeafSpec, fence: LaunchFence, signal?: AbortSignal) { return (await this.ready()).placeLeaf(spec, fence, signal); }
  async placeRun(spec: PlaceSpec) { return (await this.ready()).placeRun(spec); }
  async start(binding: HerdrBinding, launch: LaunchSpec, limits: HcLimits, fence: LaunchFence) { return (await this.ready()).start(binding, launch, limits, fence); }
  async observe(binding: HerdrBinding, limits?: HcLimits) { return (await this.ready()).observe(binding, limits); }
  async readScreen(binding: HerdrBinding, lines: number, limits?: HcLimits) { return (await this.ready()).readScreen(binding, lines, limits); }
  async release(binding: HerdrBinding, current: () => HerdrInvocation | undefined, limits?: HcLimits) { return (await this.ready()).release(binding, current, limits); }
}

export function hcHostFor(env: Env): TerminalHost {
  return new LeadHcHost(env);
}
