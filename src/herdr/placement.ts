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
export function tabCreateArgs(opts: {workspaceId: string; cwd: string; runId: string; env: Record<string, string>}): string[] {
  if (![opts.workspaceId, opts.cwd, opts.runId].every(value => typeof value === "string" && value.trim() && !value.includes("\0"))) {
    throw new HerdrCliError("configuration");
  }
  const envArgs = Object.entries(opts.env).flatMap(([key, value]) => {
    if (![...HERDR_FORWARD_ENV, ...ownedNames].includes(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("herdr: invalid pane environment");
    }
    return ["--env", `${key}=${value}`];
  });
  return ["tab", "create", "--workspace", opts.workspaceId, "--cwd", opts.cwd, "--label", opts.runId, ...envArgs, "--no-focus"];
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
