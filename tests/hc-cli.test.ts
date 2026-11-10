import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHcCli, hcRunArgs, resolveHcBin, HC_REMOTE_KINDS, type HcCliError, type HcRunSpec } from "../src/hc/cli.ts";
import { tmpDir } from "./helpers/tmp.ts";

const fakeBin = fileURLToPath(new URL("./fixtures/fake-hc.mjs", import.meta.url));
const samplesDir = fileURLToPath(new URL("./fixtures/hc-0.1.19/", import.meta.url));
const secret = "SENTINEL-secret-DO-NOT-LOG";
type Sample = { command: string[]; exit: number; stdout: unknown; stderr: unknown };
const sample = (name: string): Sample => JSON.parse(readFileSync(join(samplesDir, `${name}.json`), "utf8"));
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

async function listen(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  server.unref();
}
type Execute = Parameters<typeof createHcCli>[0]["execute"];
async function fixture(extra: Record<string, unknown> = {}, execute?: Execute) {
  const root = tmpDir("conductor-hc-fake-");
  const statePath = join(root, "state.json");
  const socketPath = join(root, "hc.sock");
  await listen(socketPath);
  writeFileSync(statePath, JSON.stringify({ calls: [], socket: socketPath, ...extra }));
  const env = {
    PATH: dirname(process.execPath), HOME: root, TMPDIR: root,
    CONDUCTOR_HC_BIN: fakeBin, FAKE_HC_STATE: statePath, SENTINEL_SECRET: secret,
    HC_TERMINAL_ID: "t17", HC_TERMINAL_SOCKET: "/never-use-inherited.sock", HC_SCOPE: "never-use-inherited",
    HC_SESSION: "never-use-inherited", HC_SOCKET: "/never-use-inherited.sock",
    HERDR_ENV: "1", HERDR_SOCKET_PATH: "/never-use-inherited", HERDR_PANE_ID: "never-use-inherited",
  };
  const cli = createHcCli({ env, socketPath, execute });
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (p: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...read(), ...p }));
  const fake = (args: string[]) => new Promise<string>((resolve, reject) =>
    execFile(fakeBin, args, { env: { ...env, HC_SOCKET: socketPath } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  return { cli, read, patch, fake, env, root, socketPath };
}
const spec = (over: Partial<HcRunSpec> = {}): HcRunSpec => ({
  name: "live1", cwd: "/tmp", labels: { "conductor.run": "r1", "herdr.tab": "tb1" },
  argv: ["sh", "-c", 'printf "line1\\nline2\\n"; exec sleep 300'], ...over,
});
const failure = (kind: string, extra: Partial<HcCliError> = {}) => (e: unknown) => {
  const error = e as HcCliError;
  assert.equal(error.name, "HcCliError");
  assert.equal(error.kind, kind);
  for (const [key, value] of Object.entries(extra)) assert.equal(error[key as keyof HcCliError], value, key);
  return true;
};
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, v]) => [`${prefix}${key}`, ...keyPaths(v, `${prefix}${key}.`)]).sort();
}

test("executable comes only from the injected environment", () => {
  assert.equal(resolveHcBin({ CONDUCTOR_HC_BIN: "/opt/hc" }), "/opt/hc");
  assert.equal(resolveHcBin({ CONDUCTOR_HC_BIN: "" }), "hc");
  assert.equal(resolveHcBin({}), "hc");
});

test("run argv is the captured conductor form, never interpreted by a shell", () => {
  assert.deepEqual(hcRunArgs(spec({ parent: "lead" })), sample("run").command);
  assert.deepEqual(hcRunArgs({ name: "orphan", cwd: "/tmp", labels: {}, argv: ["sleep", "300"] }), sample("run-noparent").command);
  assert.deepEqual(hcRunArgs({ name: "a", cwd: "/cwd space/$(false)", parent: "box/t7", labels: { "k.v": "x=y $(z)" }, argv: ["--", "", "a b"] }),
    ["run", "--bg", "--json", "--outlive-parent", "--no-notify", "--name", "a", "--cwd", "/cwd space/$(false)", "--parent", "box/t7",
      "--label", "k.v=x=y $(z)", "--", "--", "", "a b"]);
});

const invalidSpecs: [string, Partial<HcRunSpec>][] = [
  ...["", "Bad", "_lead", "-lead", "a b", "lead.x", "t7", "t1b", "a".repeat(33), "na\0me"].map(name => [`name ${JSON.stringify(name)}`, { name }] as [string, Partial<HcRunSpec>]),
  ...["", "relative/dir", "/a\0b"].map(cwd => [`cwd ${JSON.stringify(cwd)}`, { cwd }] as [string, Partial<HcRunSpec>]),
  ...["", "-x", "a b", "a\0", `t${"1".repeat(128)}`].map(parent => [`parent ${JSON.stringify(parent)}`, { parent }] as [string, Partial<HcRunSpec>]),
  ...[{ Bad: "x" }, { "1a": "x" }, { "a=b": "x" }, { ["a".repeat(65)]: "x" }, { k: "" }, { k: "a\nb" }, { k: "a\rb" }, { k: "a\0b" },
    { k: "x".repeat(513) }, { k: "é".repeat(257) }].map(labels => [`labels ${JSON.stringify(labels).slice(0, 40)}`, { labels }] as [string, Partial<HcRunSpec>]),
  ...[[], [""], ["sleep", "a\0"]].map(argv => [`argv ${JSON.stringify(argv)}`, { argv }] as [string, Partial<HcRunSpec>]),
];
for (const [name, over] of invalidSpecs) {
  test(`run refuses ${name} before any spawn`, { timeout: 5000 }, async () => {
    assert.throws(() => hcRunArgs(spec(over)), failure("configuration"));
    let spawned = 0;
    const f = await fixture({}, (...a) => { spawned++; return execFile(...a); });
    await assert.rejects(() => f.cli.run(spec(over)), failure("configuration"));
    assert.equal(spawned, 0);
  });
}
test("boundary values are accepted", () => {
  assert.doesNotThrow(() => hcRunArgs(spec({ name: "t12abc", labels: { k: "x".repeat(512), ["a".repeat(64)]: "é".repeat(256) } })));
  assert.doesNotThrow(() => hcRunArgs(spec({ name: "a".repeat(32), parent: `t${"1".repeat(127)}` })));
});

test("child env drops every inherited HC_* and HERDR_* name and pins HC_SOCKET to the bound socket", { timeout: 5000 }, async () => {
  const f = await fixture();
  const before = structuredClone(f.env);
  await f.cli.run(spec());
  await f.cli.get("live1");
  await f.cli.serverStatus();
  const { calls } = f.read();
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.routingNames, ["HC_SOCKET"]);
    assert.equal(call.socket, f.socketPath);
  }
  assert.deepEqual(f.env, before, "caller env is not mutated");
});

test("configuration: socket must be absolute without NUL", () => {
  for (const socketPath of ["", "relative.sock", "/a\0b.sock"]) {
    assert.throws(() => createHcCli({ env: {}, socketPath }), failure("configuration"));
  }
});
test("a missing or non-socket path never reaches hc, which would start a fresh core there", { timeout: 5000 }, async () => {
  let spawned = 0;
  const execute: Execute = (...a) => { spawned++; return execFile(...a); };
  const f = await fixture();
  const regular = join(f.root, "state.json");
  for (const socketPath of [join(f.root, "absent.sock"), regular, f.root]) {
    const cli = createHcCli({ env: f.env, socketPath, execute });
    await assert.rejects(() => cli.serverStatus(), failure("remote", { remoteKind: "unavailable" }));
    await assert.rejects(() => cli.get("t1"), failure("remote", { remoteKind: "unavailable" }));
  }
  assert.equal(spawned, 0);
});

test("lifecycle on the fake: run, get live, read, refused rm, finished get, rm", { timeout: 5000 }, async () => {
  const f = await fixture({ pids: { live1: 787544 }, screens: { t2: "line1\nline2\n" }, next: 2 });
  assert.deepEqual(await f.cli.run(spec({ parent: undefined })), { address: "t2", name: "live1", parent: null, state: "live" });
  const live = await f.cli.get("live1");
  assert.deepEqual({ ...live }, { address: "t2", name: "live1", pid: 787544, parent: null, die_with_parent: false, notify: false,
    labels: { "conductor.run": "r1", "herdr.tab": "tb1" }, state: "live", exit_code: null, signal: null, cwd: "/tmp",
    argv: spec().argv, status: null });
  assert.equal(await f.cli.read("t2", 40), "line1\nline2\n");
  await assert.rejects(() => f.cli.rm("t2"), failure("remote", { remoteKind: "live", exitCode: 1 }));
  await f.fake(["kill", "t2", "--json"]);
  const finished = await f.cli.get("t2");
  assert.equal(finished.state, "finished");
  assert.equal(finished.signal, 1);
  assert.deepEqual(await f.cli.rm("t2"), { removed: "t2" });
  await assert.rejects(() => f.cli.get("t2"), failure("remote", { remoteKind: "not_found", exitCode: 3 }));
  assert.deepEqual(f.read().calls.map((c: { args: string[] }) => c.args), [
    hcRunArgs(spec({ parent: undefined })), ["get", "live1", "--json"], ["read", "t2", "--lines", "40"], ["rm", "t2", "--json"],
    ["kill", "t2", "--json"], ["get", "t2", "--json"], ["rm", "t2", "--json"], ["get", "t2", "--json"]]);
});
test("run reports the parent address and name collisions", { timeout: 5000 }, async () => {
  const f = await fixture();
  const lead = await f.cli.run(spec({ name: "lead", labels: {} }));
  assert.equal((await f.cli.run(spec({ parent: "lead" }))).parent, lead.address);
  await assert.rejects(() => f.cli.run(spec()), failure("remote", { remoteKind: "name_taken", exitCode: 1 }));
  await assert.rejects(() => f.cli.run(spec({ name: "kid", parent: "t999" })), failure("remote", { remoteKind: "not_found", exitCode: 3 }));
  await assert.rejects(() => f.cli.run(spec({ name: "kid", argv: ["/nonexistent/prog"] })), failure("remote", { remoteKind: "spawn_failed", exitCode: 1 }));
});

test("real 0.1.19 stdout parses to the typed results", { timeout: 5000 }, async () => {
  const f = await fixture();
  const respond = (name: string) => f.patch({ fault: "response", response: sample(name).stdout });
  respond("run");
  assert.deepEqual(await f.cli.run(spec({ parent: "lead" })), { address: "t2", name: "live1", parent: "t1", state: "live" });
  respond("run-noparent");
  assert.deepEqual(await f.cli.run(spec({ name: "orphan" })), { address: "t3", name: "orphan", parent: null, state: "live" });
  respond("get-live");
  assert.deepEqual({ ...await f.cli.get("live1") }, { address: "t2", name: "live1", pid: 787544, parent: "t1", die_with_parent: false,
    notify: false, labels: { "conductor.run": "r1", "herdr.tab": "tb1" }, state: "live", exit_code: null, signal: null, cwd: "/tmp",
    argv: spec().argv, status: null });
  respond("get-finished-signal");
  assert.deepEqual([(await f.cli.get("live1")).state, (await f.cli.get("live1")).signal], ["finished", 1]);
  respond("get-finished-exit");
  const exited = await f.cli.get("exit3");
  assert.deepEqual([exited.state, exited.exit_code, exited.signal, exited.labels], ["finished", 3, null, {}]);
  respond("rm");
  assert.deepEqual(await f.cli.rm("exit3"), { removed: "t8" });
  respond("server-status");
  assert.deepEqual(await f.cli.serverStatus(), { coreId: "3ec6adf9b1db50c60491c76abd2c0ff3", version: "0.1.19" });
  f.patch({ fault: "response", response: sample("read").stdout });
  assert.equal(await f.cli.read("live1", 40), "line1\nline2\n");
  f.patch({ fault: "response", response: { ...sample("get-live").stdout as object, status: { app: "pi", state: "blocked", kind: "question", message: "m", extra: 1 } } });
  assert.deepEqual((await f.cli.get("live1")).status, { app: "pi", state: "blocked", kind: "question", message: "m" });
});

const errorSamples = readdirSync(samplesDir).filter(n => n.startsWith("error-")).map(n => n.replace(/\.json$/, ""));
test("every captured error kind is allowlisted", () => {
  assert.deepEqual(errorSamples.map(n => ((sample(n).stderr as { error: { kind: string } }).error.kind)).sort(), [...HC_REMOTE_KINDS].sort());
});
for (const name of errorSamples) {
  test(`real ${name} envelope classifies as remote with its kind and exit code`, { timeout: 5000 }, async () => {
    const s = sample(name);
    const kind = (s.stderr as { error: { kind: string } }).error.kind;
    const f = await fixture({ fault: "envelope", envelope: s.stderr, exit: s.exit });
    await assert.rejects(() => f.cli.get("t1"), failure("remote", { remoteKind: kind as HcCliError["remoteKind"], exitCode: s.exit }));
  });
}
test("unknown remote kinds and secret-bearing messages are not retained", { timeout: 5000 }, async () => {
  const f = await fixture({ fault: "envelope", envelope: { error: { kind: secret, message: secret, hint: secret } }, exit: 4 });
  await assert.rejects(() => f.cli.get("t1"), (e: unknown) => {
    failure("remote", { exitCode: 4, remoteKind: undefined })(e);
    assert.ok(!(String(e) + JSON.stringify(e) + (e as Error).stack).includes(secret));
    return true;
  });
  f.patch({ envelope: { error: { kind: "live", message: "m" } }, stream: "stdout", exit: 0 });
  await assert.rejects(() => f.cli.rm("t1"), failure("remote", { remoteKind: "live", exitCode: 0 }));
});
for (const [fault, kind] of [["garbage", "protocol"], ["plain-nonzero", "nonzero"], ["overflow", "output-limit"], ["stderr-overflow", "output-limit"]]) {
  test(`bounded sanitized ${fault}`, { timeout: 5000 }, async () => {
    const f = await fixture({ fault });
    await assert.rejects(() => f.cli.serverStatus(), (e: unknown) => {
      failure(kind)(e);
      const fields = String(e) + JSON.stringify(e);
      for (const value of [secret, f.socketPath]) assert.ok(!(fields + (e as Error).stack).includes(value), `no ${value} in diagnostics`);
      assert.ok(!/server|status|x{8}|not json/.test(fields), "no argv or output retained");
      return true;
    });
  });
}
const live = sample("get-live").stdout as Record<string, unknown>;
const drift: [string, unknown][] = [
  ["run array", []], ["run without address", { name: "live1", state: "live" }], ["run bad state", { address: "t2", name: "live1", state: "zombie" }],
  ["run numeric parent", { address: "t2", name: "live1", state: "live", parent: 1 }],
  ...Object.entries({ address: "", name: 1, pid: "1", parent: 2, die_with_parent: "no", notify: null, labels: null, state: "gone",
    exit_code: 1.5, signal: "HUP", cwd: null, argv: "sleep", status: "working" }).map(([key, value]) => [`get ${key}=${JSON.stringify(value)}`, { ...live, [key]: value }] as [string, unknown]),
  ["get pid 0", { ...live, pid: 0 }], ["get label number", { ...live, labels: { a: 1 } }], ["get argv number", { ...live, argv: [1] }],
  ["get status without state", { ...live, status: { app: "pi" } }],
  ["rm without removed", {}], ["status without core", { version: "0.1.19" }], ["status empty id", { core: { id: "" }, version: "0.1.19" }],
];
for (const [name, response] of drift) {
  test(`shape drift is a protocol error: ${name}`, { timeout: 5000 }, async () => {
    const f = await fixture({ fault: "response", response });
    const call = name.startsWith("run") ? () => f.cli.run(spec()) : name.startsWith("get") ? () => f.cli.get("t2")
      : name.startsWith("rm") ? () => f.cli.rm("t2") : () => f.cli.serverStatus();
    await assert.rejects(call, failure("protocol"));
  });
}
test("targets and line counts are validated before any spawn", { timeout: 5000 }, async () => {
  let spawned = 0;
  const f = await fixture({}, (...a) => { spawned++; return execFile(...a); });
  for (const target of ["", "-x", "--json", "a b", "a\0"]) {
    await assert.rejects(() => f.cli.get(target), failure("configuration"));
    await assert.rejects(() => f.cli.rm(target), failure("configuration"));
    await assert.rejects(() => f.cli.read(target, 40), failure("configuration"));
  }
  for (const lines of [-1, 1.5, NaN, 100001]) await assert.rejects(() => f.cli.read("t1", lines), failure("configuration"));
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 65001 }, { timeoutMs: NaN }, { maxBuffer: 0 }, { maxBuffer: 1048577 }]) {
    await assert.rejects(() => f.cli.serverStatus(limits), failure("configuration"));
  }
  assert.equal(spawned, 0);
});
test("deadline and cancellation SIGKILL the CLI and await its close", { timeout: 5000 }, async () => {
  const children: { child: ChildProcess; exited: boolean }[] = [];
  const f = await fixture({ fault: "hang" }, (file, args, options, callback) => {
    assert.equal(file, fakeBin);
    assert.equal(options.shell, false);
    assert.equal(options.killSignal, "SIGKILL");
    const child = execFile(file, args, options, callback);
    const entry = { child, exited: false };
    child.once("exit", () => { entry.exited = true; });
    children.push(entry);
    return child;
  });
  await assert.rejects(() => f.cli.serverStatus({ timeoutMs: 100 }), failure("timeout"));
  const controller = new AbortController();
  const request = f.cli.get("t1", { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => request, failure("cancelled"));
  await assert.rejects(() => f.cli.get("t1", { signal: controller.signal }), failure("cancelled"));
  assert.equal(children.length, 2, "a pre-cancelled request never spawns");
  for (const { child, exited } of children) {
    assert.equal(exited, true);
    assert.equal(child.signalCode, "SIGKILL");
  }
});
test("a missing executable is a sanitized spawn failure", { timeout: 5000 }, async () => {
  const f = await fixture();
  const cli = createHcCli({ env: { ...f.env, CONDUCTOR_HC_BIN: `/nonexistent/${secret}` }, socketPath: f.socketPath });
  await assert.rejects(() => cli.serverStatus(), (e: unknown) => {
    failure("spawn")(e);
    assert.ok(!(String(e) + JSON.stringify(e)).includes(secret));
    return true;
  });
});

test("the fake's output keys match captured hc 0.1.19 output", { timeout: 5000 }, async () => {
  const f = await fixture({ next: 1 });
  const lead = JSON.parse(await f.fake(["run", "--bg", "--json", "--no-parent", "--name", "lead", "--", "sleep", "300"]));
  assert.equal(lead.address, "t1");
  const compare = async (args: string[], name: string, stream: "stdout" | "stderr" = "stdout") => {
    const s = sample(name);
    const out = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve =>
      execFile(fakeBin, args, { env: { ...f.env, HC_SOCKET: f.socketPath } }, (error, stdout, stderr) =>
        resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 })));
    assert.deepEqual(keyPaths(JSON.parse(out[stream])), keyPaths(s[stream]), `${name} keys`);
    assert.equal(out.code, s.exit, `${name} exit code`);
  };
  await compare(sample("run").command, "run");
  await compare(sample("run-noparent").command, "run-noparent");
  await compare(["get", "live1", "--json"], "get-live");
  await compare(sample("error-live").command, "error-live", "stderr");
  await compare(sample("error-name-taken").command, "error-name-taken", "stderr");
  await compare(sample("error-not-found").command, "error-not-found", "stderr");
  await compare(sample("error-spawn-failed").command, "error-spawn-failed", "stderr");
  await compare(["kill", "live1", "--json"], "kill");
  await compare(["get", "live1", "--json"], "get-finished-signal");
  await compare(["rm", "live1", "--json"], "rm");
  await compare(["server", "status", "--json"], "server-status");
});
