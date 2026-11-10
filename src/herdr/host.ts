import { HerdrCliError, isRecord, type CliLimits, type HerdrCli } from "./cli.ts";
import { isTuiBinding, proveChildProcess, provePaneOurs, type HerdrBinding, type HerdrInvocation, type TuiBinding } from "./identity.ts";
import { closeEmptyPane, createRunTab, createSplitPane, leafPlacement } from "./placement.ts";

export const herdrFailure = (message: string) => new Error(`herdr: ${message}`);

type Refusal = { ok: false; state: "unknown" | "gone"; reason: string };
export type ChildProof = { ok: true; pid: number } | Refusal;
export type ReleaseResult = { ok: true } | Refusal;

export interface ChildEvidence {
  binding: unknown;
  current: unknown;
  socketPath: string;
  observation: unknown;
  hello: unknown;
  platform: string;
  bridgeProtocol: number;
  process: unknown;
}
export interface TerminalIdentity {
  proveChild(evidence: ChildEvidence): ChildProof;
  recorded(binding: HerdrBinding): unknown;
  helloFields(binding: HerdrBinding, hello: unknown): Partial<HerdrBinding>;
}
export interface PlaceSpec { cwd: string; invocation: HerdrInvocation; env: Record<string, string> }
export interface LeafSpec extends PlaceSpec {
  parentId: string;
  parentRuntime: string;
  parent?: HerdrBinding;
  previous?: HerdrBinding;
  current: () => boolean;
  known: readonly (HerdrBinding | undefined)[];
}
export interface LaunchSpec { alias: string; args: readonly string[]; cwd: string; env: Record<string, string> }
export interface LaunchFence {
  check(): void;
  current(): HerdrInvocation | undefined;
  backoff(): Promise<void>;
}

export interface TerminalHost {
  readonly socketPath: string;
  readonly identity: TerminalIdentity;
  reuse(previous: HerdrBinding, invocation: HerdrInvocation, signal?: AbortSignal): Promise<HerdrBinding | undefined>;
  placeLeaf(spec: LeafSpec, fence: LaunchFence, signal?: AbortSignal): Promise<{ binding: HerdrBinding } | { warning: string }>;
  placeRun(spec: PlaceSpec, fence: LaunchFence, signal?: AbortSignal): Promise<HerdrBinding>;
  start(binding: HerdrBinding, launch: LaunchSpec, limits: CliLimits, fence: LaunchFence): Promise<unknown>;
  observe(binding: HerdrBinding, limits?: CliLimits): Promise<unknown>;
  readScreen(binding: HerdrBinding, lines: number, limits?: CliLimits): Promise<string>;
  release(binding: HerdrBinding, current: () => HerdrInvocation | undefined, limits?: CliLimits): Promise<ReleaseResult>;
}

export const tuiIdentity: TerminalIdentity = {
  proveChild: ({ observation, ...evidence }) => proveChildProcess({ ...evidence, pane: observation }),
  recorded: binding => isTuiBinding(binding) ? { pane_id: binding.paneId, terminal_id: binding.terminalId, tab_id: binding.tabId, workspace_id: binding.workspaceId,
    agent: "pi", agent_session: { kind: "path", value: binding.sessionFile, agent: "pi", source: "launch" } } : undefined,
  helloFields: () => ({}),
};
const refusal = (reason: string): Refusal => ({ ok: false, state: "unknown", reason });
function tuiOnly(binding: HerdrBinding): TuiBinding {
  if (!isTuiBinding(binding)) throw herdrFailure("not a herdr TUI binding");
  return binding;
}

export class HerdrTuiHost implements TerminalHost {
  readonly identity = tuiIdentity;
  constructor(private readonly options: { cli: HerdrCli; workspaceId?: string; leadPaneId?: string }) {}
  get socketPath() { return this.options.cli.socketPath; }

  async reuse(previous: HerdrBinding, invocation: HerdrInvocation, signal?: AbortSignal): Promise<HerdrBinding | undefined> {
    if (!isTuiBinding(previous)) return undefined;
    try {
      const observed = await this.options.cli.json(["pane", "get", previous.paneId], { timeoutMs: 2000, signal });
      return provePaneOurs({ binding: previous, current: previous, socketPath: this.socketPath, pane: observed.pane, requireNoAgent: true }).ok
        ? { ...previous, ...invocation, createdTab: false, childPid: undefined, childStartTime: undefined } : undefined;
    } catch { return undefined; }
  }

  async placeLeaf({ cwd, invocation, env, known, parent, previous, ...leaf }: LeafSpec, fence: LaunchFence, signal?: AbortSignal) {
    if (parent && !isTuiBinding(parent)) return { warning: `parent ${leaf.parentId} is a Herdr 2 terminal; leaf placed in its own tab` };
    const placement = await leafPlacement(this.options.cli, { ...leaf, parent, previous: isTuiBinding(previous) ? previous : undefined }, { timeoutMs: 2000, signal });
    fence.check();
    if (!("anchor" in placement)) return placement;
    return { binding: await createSplitPane(this.options.cli, { ...placement, cwd, invocation, env, known: known.filter(isTuiBinding) }, { timeoutMs: 5000, signal }) };
  }

  async placeRun(spec: PlaceSpec, fence: LaunchFence, signal?: AbortSignal): Promise<HerdrBinding> {
    const { cli, workspaceId, leadPaneId } = this.options;
    const workspace = workspaceId ?? (await cli.json(["pane", "get", leadPaneId!], { timeoutMs: 2000, signal })).pane;
    const targetWorkspace = typeof workspace === "string" ? workspace : isRecord(workspace) ? workspace.workspace_id : undefined;
    if (typeof targetWorkspace !== "string") throw herdrFailure("parent workspace unavailable");
    fence.check();
    return createRunTab(cli, { workspaceId: targetWorkspace, ...spec }, { timeoutMs: 5000, signal });
  }

  async start(target: HerdrBinding, launch: LaunchSpec, limits: CliLimits, fence: LaunchFence): Promise<unknown> {
    const { cli } = this.options, binding = tuiOnly(target);
    const args = ["agent", "start", launch.alias, "--kind", "pi", "--pane", binding.paneId, "--timeout", "60000", "--", ...launch.args];
    let started: Record<string, unknown>;
    try { started = await cli.json(args, limits); }
    catch (e) {
      fence.check();
      if (!(e instanceof HerdrCliError) || e.remoteCode !== "agent_pane_busy") throw herdrFailure("agent start outcome unconfirmed; no blind retry");
      await fence.backoff(); fence.check();
      const pane = await this.observe(binding, { timeoutMs: 2000, signal: limits.signal }); fence.check();
      if (!provePaneOurs({ binding, current: fence.current(), socketPath: this.socketPath, pane, requireNoAgent: true }).ok) throw herdrFailure("busy retry refused: pane no longer empty and owned");
      started = await cli.json(args, limits);
    }
    fence.check();
    if (!isRecord(started.agent) || started.agent.name !== launch.alias || started.agent.pane_id !== binding.paneId) throw herdrFailure("agent start registered a different agent or pane");
    return started.agent;
  }

  async observe(binding: HerdrBinding, limits?: CliLimits): Promise<unknown> {
    return (await this.options.cli.json(["pane", "get", tuiOnly(binding).paneId], limits)).pane;
  }

  async readScreen(binding: HerdrBinding, lines: number, limits?: CliLimits): Promise<string> {
    return this.options.cli.text(["agent", "read", tuiOnly(binding).agentName!, "--source", "recent-unwrapped", "--lines", String(lines)], limits);
  }

  async release(binding: HerdrBinding, current: () => HerdrInvocation | undefined, limits?: CliLimits): Promise<ReleaseResult> {
    return isTuiBinding(binding) ? closeEmptyPane(this.options.cli, binding, current, limits) : refusal("not a herdr TUI binding");
  }
}
