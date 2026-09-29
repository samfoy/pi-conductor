import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrCli, resolveHerdrBin } from "../src/herdr/cli.js";
import { buildHerdrEnv, tabCreateArgs, createRunTab, closeEmptyPane } from "../src/herdr/placement.js";
import { tmpDir } from "./helpers/tmp.js";
import { invocation, pane } from "./fixtures/herdr-evidence.js";

const fakeBin = fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url));
const secret = "SENTINEL-secret-DO-NOT-LOG";
const proxy = `https://user:${secret}@proxy.invalid`;
const owned = {...invocation, runDir: "/private/fake/run", configCwd: "/requested/cwd", tmpDir: "/private/effort/tmp"};
const forwarded = buildHerdrEnv({AWS_PROFILE: "fake-profile", HTTPS_PROXY: proxy}, owned);
function fixture(extra: Record<string, unknown> = {}, execute?: Parameters<typeof createHerdrCli>[0]["execute"]) {
  const root = tmpDir("conductor-herdr-fake-");
  const statePath = join(root, "state.json");
  const initial = {calls: [], pane, sessionFile: invocation.sessionFile, ...extra};
  writeFileSync(statePath, JSON.stringify(initial));
  const env = {
    PATH: dirname(process.execPath), HOME: root, TMPDIR: root,
    CONDUCTOR_HERDR_BIN: fakeBin, FAKE_HERDR_STATE: statePath,
    HERDR_SOCKET_PATH: "/never-use-inherited", HERDR_PANE_ID: "never-use-inherited",
    HERDR_SESSION: "never-use-inherited", HERDR_BIN_PATH: "/never-use-inherited",
    SENTINEL_SECRET: secret,
  };
  const cli = createHerdrCli({env, socketPath: `${statePath}.socket`, execute});
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (p: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({...read(), ...p}));
  const create = () => createRunTab(cli, {workspaceId: "ws_fake", cwd: "/cwd with spaces/$(no-shell)", invocation, env: forwarded});
  return {cli, read, patch, create, env};
}

test("executable cascade uses only injected environment", () => {
  assert.equal(resolveHerdrBin({CONDUCTOR_HERDR_BIN: "override", HERDR_BIN_PATH: "injected"}), "override");
  assert.equal(resolveHerdrBin({HERDR_BIN_PATH: "injected"}), "injected");
  assert.equal(resolveHerdrBin({}), "herdr");
});
test("env forwards only set allowlist names and conductor-owned identifiers", () => {
  const names = ["AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "PI_BEDROCK_PROFILE", "PI_CODING_AGENT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const source = Object.fromEntries(names.map(n => [n, n === "NO_PROXY" ? "" : proxy]));
  Object.assign(source, {
    AWS_ACCESS_KEY_ID: secret, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: secret,
    API_TOKEN: secret, HERDR_SOCKET_PATH: secret, HERDR_ENV: secret, HERDR_BIN_PATH: secret,
    PI_CONDUCTOR_MODE: "1", PI_CONDUCTOR_FORCE_MODE: "1", CONDUCTOR_DEPTH: "9", TMPDIR: "/ambient",
  });
  const before = structuredClone(source);
  const env = buildHerdrEnv(source, owned);
  assert.equal(env.PI_CODING_AGENT_DIR, proxy, "provider discovery must stay available");
  assert.deepEqual(env, {...Object.fromEntries(names.map(n => [n, source[n]])),
    CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: invocation.runId,
    CONDUCTOR_RUN_DIR: owned.runDir, CONDUCTOR_CONFIG_CWD: owned.configCwd, CONDUCTOR_DEPTH: "1", TMPDIR: owned.tmpDir,
  });
  assert.deepEqual(source, before);
  assert.equal(buildHerdrEnv({}, {...owned, tmpDir: undefined}).TMPDIR, undefined);
});
test("subtree argv is exact and never interpreted by a shell", () => {
  assert.deepEqual(tabCreateArgs({workspaceId: "ws_fake", cwd: "/cwd space/$(false)", runId: "run", env: {AWS_PROFILE: "a=b c"}}),
    ["tab", "create", "--workspace", "ws_fake", "--cwd", "/cwd space/$(false)", "--label", "run", "--env", "AWS_PROFILE=a=b c", "--no-focus"]);
  for (const key of ["HERDR_SOCKET_PATH", "AWS_SECRET_ACCESS_KEY", "PI_CONDUCTOR_MODE", "BAD=KEY"]) {
    assert.throws(() => tabCreateArgs({workspaceId: "ws", cwd: "/cwd", runId: "run", env: {[key]: secret}}), /environment/);
  }
});

test("fake create -> inspect -> persisted binding -> proof -> empty cleanup", {timeout: 5000}, async () => {
  const f = fixture();
  const binding = JSON.parse(JSON.stringify(await f.create()));
  assert.deepEqual(binding, {...invocation, socketPath: f.cli.socketPath, paneId: "pane_fake", terminalId: "term_fake", workspaceId: "ws_fake", tabId: "tab_fake", createdTab: true});
  assert.deepEqual(await closeEmptyPane(f.cli, binding, () => invocation), {ok: true});
  const state = f.read();
  assert.equal(state.closed, true);
  assert.deepEqual(state.calls.map((c: {args: string[]}) => c.args.slice(0, 2)), [["tab", "create"], ["pane", "get"], ["pane", "get"], ["pane", "close"]]);
  assert.deepEqual(state.calls[0].args, tabCreateArgs({workspaceId: "ws_fake", cwd: "/cwd with spaces/$(no-shell)", runId: invocation.runId, env: forwarded}));
  for (const call of state.calls) {
    assert.equal(call.socket, f.cli.socketPath);
    assert.deepEqual(call.routingNames, ["HERDR_SOCKET_PATH"]);
  }
});
for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent", "agent_session"]) {
  test(`cleanup zero destructive calls on changed ${field}`, {timeout: 5000}, async () => {
    const f = fixture();
    const binding = await f.create();
    f.patch({pane: {...f.read().pane, [field]: "foreign"}});
    const result = await closeEmptyPane(f.cli, binding, () => invocation);
    assert.deepEqual(f.read().calls.filter((c: {args: string[]}) => c.args[1] === "close"), [], "zero destructive calls");
    assert.equal(result.ok, false);
  });
}
for (const field of ["runId", "launchNonce", "sessionId", "sessionFile"]) {
  test(`cleanup zero destructive calls on stale ${field}`, {timeout: 5000}, async () => {
    const f = fixture();
    const binding = await f.create();
    const result = await closeEmptyPane(f.cli, binding, () => ({...invocation, [field]: "new"}));
    assert.deepEqual(f.read().calls.filter((c: {args: string[]}) => c.args[1] === "close"), [], "zero destructive calls");
    assert.equal(result.ok, false);
  });
}
test("cleanup re-reads current invocation after async pane observation", {timeout: 5000}, async () => {
  const f = fixture();
  const binding = await f.create();
  await closeEmptyPane(f.cli, binding, () => {
    assert.equal(f.read().calls.length, 3);
    return {...invocation, launchNonce: "new"};
  });
  assert.equal(f.read().closed, undefined);
});
test("empty placement targets fail before a CLI can choose ambient focus", () => {
  for (const field of ["workspaceId", "cwd", "runId"]) {
    assert.throws(() => tabCreateArgs({workspaceId: "ws", cwd: "/cwd", runId: "run", env: {}, [field]: ""}));
  }
});
test("creation refuses relocated or malformed observations without destructive rollback", {timeout: 5000}, async () => {
  for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent", "agent_session"]) {
    const f = fixture({getPane: {...pane, [field]: "foreign"}});
    await assert.rejects(() => f.create(), {kind: "protocol"});
    assert.equal(f.read().closed, undefined);
  }
});
test("cleanup preserves pane on missing evidence, CLI failure or socket mismatch", {timeout: 5000}, async () => {
  const f = fixture();
  const binding = await f.create();
  for (const patch of [{getPane: {...pane, agent: undefined}}, {fault: "invalid"}, {fault: "nonzero"}]) {
    f.patch(patch);
    assert.equal((await closeEmptyPane(f.cli, binding, () => invocation)).ok, false);
  }
  f.patch({fault: undefined, getPane: pane});
  assert.equal((await closeEmptyPane(f.cli, {...binding, socketPath: "/foreign"}, () => invocation)).ok, false);
  assert.equal(f.read().closed, undefined);
});
test("fake agent start shape and text read; a live agent forbids cleanup", {timeout: 5000}, async () => {
  const f = fixture();
  const binding = await f.create();
  const result = await f.cli.json(["agent", "start", "fake", "--kind", "pi", "--pane", binding.paneId, "--timeout", "60000", "--", "--session", invocation.sessionFile]);
  assert.equal(result.type, "agent_started");
  assert.equal((result.agent as Record<string, unknown>).agent, "pi");
  assert.match(await f.cli.text(["agent", "read", "fake", "--lines", "40"]), /fake terminal scrollback/);
  assert.equal((await closeEmptyPane(f.cli, binding, () => invocation)).ok, false);
  assert.equal(f.read().closed, undefined);
});
for (const [fault, kind] of [["invalid", "protocol"], ["overflow", "output-limit"], ["stderr-overflow", "output-limit"], ["nonzero", "nonzero"], ["stderr-error", "nonzero"], ["error-success", "remote"]]) {
  test(`bounded sanitized CLI ${fault}`, {timeout: 5000}, async () => {
    const f = fixture({fault});
    await assert.rejects(() => f.create(), (e: unknown) => {
      const error = e as Error & {kind: string; remoteCode?: string; exitCode?: number};
      assert.equal(error.kind, kind);
      const diagnostic = String(error) + JSON.stringify(error) + error.stack;
      for (const value of [secret, proxy, "fake-profile"]) assert.ok(!diagnostic.includes(value), "no env value in diagnostics");
      if (fault === "nonzero" || fault === "stderr-error") { assert.equal(error.exitCode, 7); assert.equal(error.remoteCode, "agent_pane_busy"); }
      return true;
    });
  });
}
test("hostile error code is not a diagnostic escape hatch", {timeout: 5000}, async () => {
  const f = fixture({fault: "nonzero", code: secret});
  await assert.rejects(() => f.create(), (e: unknown) => !String(e).includes(secret) && !JSON.stringify(e).includes(secret));
});
for (const response of [null, [], {}, {id: "fake", result: null}, {id: "fake", result: {type: "ok"}}, {result: {type: "pane_info", pane}}, {id: "fake", result: {type: "pane_info", pane}, error: {code: "x", message: "x"}}]) {
  test(`malformed/misrouted envelope ${JSON.stringify(response)}`, {timeout: 5000}, async () => {
    const f = fixture({fault: "response", response});
    await assert.rejects(() => f.cli.json(["pane", "get", "pane_fake"]), {kind: "protocol"});
  });
}
test("help and integration status are text, not universal JSON", {timeout: 5000}, async () => {
  const f = fixture();
  for (const args of [["--help"], ["integration", "status"]]) {
    assert.match(await f.cli.text(args), /plain text/);
    await assert.rejects(() => f.cli.json(args), {kind: "protocol"});
  }
});
test("deadline and cancellation kill only the fake CLI and await close", {timeout: 5000}, async () => {
  const children: {child: ChildProcess; exited: boolean}[] = [];
  const f = fixture({fault: "hang"}, (file, args, options, callback) => {
    assert.equal(file, fakeBin);
    assert.equal(options.shell, false);
    assert.equal(options.killSignal, "SIGKILL");
    const child = execFile(file, args, options, callback);
    const entry = {child, exited: false};
    child.once("exit", () => { entry.exited = true; });
    children.push(entry);
    return child;
  });
  await assert.rejects(() => f.cli.json(["pane", "get", "pane_fake"], {timeoutMs: 50}), {kind: "timeout"});
  const controller = new AbortController();
  const request = f.cli.json(["pane", "get", "pane_fake"], {signal: controller.signal});
  controller.abort();
  await assert.rejects(() => request, {kind: "cancelled"});
  await assert.rejects(() => f.cli.json(["pane", "get", "pane_fake"], {signal: controller.signal}), {kind: "cancelled"});
  assert.equal(children.length, 2, "pre-cancelled requests never spawn");
  for (const {child, exited} of children) {
    assert.equal(exited, true, "adapter must await actual child exit");
    assert.equal(child.signalCode, "SIGKILL");
  }
});
test("missing executable and invalid budgets are sanitized", {timeout: 5000}, async () => {
  const f = fixture();
  const cli = createHerdrCli({env: {...f.env, CONDUCTOR_HERDR_BIN: `/nonexistent/${secret}`}, socketPath: f.cli.socketPath});
  await assert.rejects(() => cli.json(["pane", "get", "pane_fake"]), (e: unknown) => !String(e).includes(secret) && !JSON.stringify(e).includes(secret));
  for (const timeoutMs of [0, -1, Infinity, NaN]) await assert.rejects(() => f.cli.json(["pane", "get", "pane_fake"], {timeoutMs}), {kind: "configuration"});
});
