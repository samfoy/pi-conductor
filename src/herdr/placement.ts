import { HerdrCliError, isRecord, type HerdrCli, type CliLimits } from "./cli.js";
import { isHerdrPane, provePaneOurs, type HerdrBinding, type HerdrInvocation } from "./identity.js";
import { CHILD_SCOPE_ENV, childScopeEnv, type ChildToolScope } from "../types.js";

export const HERDR_FORWARD_ENV = [
  "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "PI_BEDROCK_PROFILE", "PI_CODING_AGENT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
] as const;
const ownedNames: readonly string[] = ["CONDUCTOR_SUBAGENT", "CONDUCTOR_RUNTIME", "CONDUCTOR_RUN_ID", "CONDUCTOR_CONFIG_CWD", ...CHILD_SCOPE_ENV, "TMPDIR"];

/** Only allowlisted names are forwarded; every conductor-owned name comes from the run's frozen scope. */
export function buildHerdrEnv(source: NodeJS.ProcessEnv, owned: {
  runId: string; runDir: string; configCwd: string; tmpDir?: string; scope: ChildToolScope;
}): Record<string, string> {
  return {
    ...Object.fromEntries(HERDR_FORWARD_ENV.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]])),
    CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: owned.runId,
    CONDUCTOR_CONFIG_CWD: owned.configCwd, ...childScopeEnv(owned.runDir, owned.scope),
    ...(owned.tmpDir === undefined ? {} : {TMPDIR: owned.tmpDir}),
  };
}
const validText = (value: unknown) => typeof value === "string" && value.trim() !== "" && !value.includes("\0");
function paneEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => {
    if (![...HERDR_FORWARD_ENV, ...ownedNames].includes(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("herdr: invalid pane environment");
    }
    return ["--env", `${key}=${value}`];
  });
}
export function tabCreateArgs(opts: {workspaceId: string; cwd: string; runId: string; env: Record<string, string>}): string[] {
  if (![opts.workspaceId, opts.cwd, opts.runId].every(validText)) throw new HerdrCliError("configuration");
  return ["tab", "create", "--workspace", opts.workspaceId, "--cwd", opts.cwd, "--label", opts.runId, ...paneEnvArgs(opts.env), "--no-focus"];
}
export function paneSplitArgs(opts: {paneId: string; direction: "right" | "down"; cwd: string; env: Record<string, string>}): string[] {
  if (![opts.paneId, opts.cwd].every(validText) || !["right", "down"].includes(opts.direction)) throw new HerdrCliError("configuration");
  return ["pane", "split", "--pane", opts.paneId, "--direction", opts.direction, "--cwd", opts.cwd, ...paneEnvArgs(opts.env), "--no-focus"];
}

export async function createRunTab(cli: HerdrCli, opts: {
  workspaceId: string; cwd: string; invocation: HerdrInvocation; env: Record<string, string>;
}, limits?: CliLimits): Promise<HerdrBinding> {
  const created = await cli.json(tabCreateArgs({...opts, runId: opts.invocation.runId}), limits);
  const root = created.root_pane;
  const tab = created.tab;
  if (!isHerdrPane(root) || !isRecord(tab) || root.workspace_id !== opts.workspaceId ||
      root.tab_id !== tab.tab_id || root.workspace_id !== tab.workspace_id || tab.pane_count !== 1 ||
      tab.label !== opts.invocation.runId) throw new HerdrCliError("protocol");
  const binding: HerdrBinding = {...opts.invocation, socketPath: cli.socketPath,
    workspaceId: root.workspace_id, tabId: root.tab_id, paneId: root.pane_id, terminalId: root.terminal_id, createdTab: true};
  const observed = await cli.json(["pane", "get", binding.paneId], limits);
  if (!provePaneOurs({binding, current: opts.invocation, socketPath: cli.socketPath, pane: observed.pane, requireNoAgent: true}).ok) {
    throw new HerdrCliError("protocol");
  }
  return binding;
}

/** N5: a fresh pane in the anchor's tab, proven empty before anything runs in it. Never a tab. */
export async function createSplitPane(cli: HerdrCli, opts: {
  anchor: HerdrBinding; direction: "right" | "down"; cwd: string; invocation: HerdrInvocation; env: Record<string, string>; known: readonly (HerdrBinding | undefined)[];
}, limits?: CliLimits): Promise<HerdrBinding> {
  const created = (await cli.json(paneSplitArgs({paneId: opts.anchor.paneId, direction: opts.direction, cwd: opts.cwd, env: opts.env}), limits)).pane;
  const known = [opts.anchor, ...opts.known].filter((b): b is HerdrBinding => !!b);
  if (!isHerdrPane(created) || created.workspace_id !== opts.anchor.workspaceId || created.tab_id !== opts.anchor.tabId ||
      known.some(b => b.paneId === created.pane_id || b.terminalId === created.terminal_id)) throw new HerdrCliError("protocol");
  const binding: HerdrBinding = {...opts.invocation, socketPath: cli.socketPath,
    workspaceId: created.workspace_id, tabId: created.tab_id, paneId: created.pane_id, terminalId: created.terminal_id, createdTab: false};
  const observed = await cli.json(["pane", "get", binding.paneId], limits);
  if (!provePaneOurs({binding, current: opts.invocation, socketPath: cli.socketPath, pane: observed.pane, requireNoAgent: true}).ok) {
    throw new HerdrCliError("protocol");
  }
  return binding;
}

export type LeafPlacement = {anchor: HerdrBinding; direction: "right" | "down"} | {warning: string};
/**
 * N5: split only from a pane whose pane, terminal, workspace and tab match its binding
 * right now. The parent first (right); a later leaf splits down from the previous
 * leaf while that pane is proven in the parent's tab. Otherwise the caller opens an
 * own tab: a split target is never guessed. `current` fences the parent after each await.
 */
export async function leafPlacement(cli: HerdrCli, opts: {
  parentId: string; parentRuntime: string; parent?: HerdrBinding; previous?: HerdrBinding; current: () => boolean;
}, limits?: CliLimits): Promise<LeafPlacement> {
  const own = (why: string) => ({warning: `${why}; leaf placed in its own tab`});
  const parent = opts.parent;
  if (opts.parentRuntime !== "herdr" || !parent) return own(`parent ${opts.parentId} has no herdr pane (${opts.parentRuntime} runtime)`);
  if (parent.socketPath !== cli.socketPath) return own(`parent ${opts.parentId} pane is on another herdr socket`);
  const prove = async (binding: HerdrBinding) => {
    try {
      const pane = (await cli.json(["pane", "get", binding.paneId], limits)).pane;
      return provePaneOurs({binding, current: binding, socketPath: cli.socketPath, pane, requireNoAgent: false});
    } catch { return {ok: false as const, reason: "pane observation unavailable"}; }
  };
  const fenced = own(`parent ${opts.parentId} is no longer this lead's current owned run`);
  if (!opts.current()) return fenced;
  const proof = await prove(parent);
  if (!opts.current()) return fenced;
  if (!proof.ok) return own(`parent pane unproven (${proof.reason})`);
  const previous = opts.previous;
  if (previous && previous.socketPath === parent.socketPath && previous.workspaceId === parent.workspaceId && previous.tabId === parent.tabId) {
    const ok = (await prove(previous)).ok;
    if (!opts.current()) return fenced;
    if (ok) return {anchor: previous, direction: "down"};
  }
  return {anchor: parent, direction: "right"};
}

export async function closeEmptyPane(cli: HerdrCli, binding: HerdrBinding,
  current: () => HerdrInvocation | undefined, limits?: CliLimits) {
  try {
    const observed = await cli.json(["pane", "get", binding.paneId], limits);
    const proof = provePaneOurs({binding, current: current(), socketPath: cli.socketPath, pane: observed.pane, requireNoAgent: true});
    if (!proof.ok) return proof;
    if (limits?.signal?.aborted) return { ok: false as const, state: "unknown" as const, reason: "pane cleanup cancelled" };
    // Close only this pane, never its tab: siblings may have been added since creation.
    await cli.json(["pane", "close", binding.paneId], limits);
    return {ok: true as const};
  } catch {
    return {ok: false as const, state: "unknown" as const, reason: "pane cleanup unconfirmed"};
  }
}
