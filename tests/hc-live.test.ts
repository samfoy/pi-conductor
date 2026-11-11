import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";
import { liveEnabled, liveParentRoot, listeningSockets, piEntry, procStartTime, type ProcessIdentity } from "./helpers/herdr-live.ts";
import { ambientHcSnapshot, HcLiveFixture, hcFixtureEnv, hcGateScript, planHcLiveIdentity, proveOwnedCore, refuseInheritedHc, startHcLiveFixture,
  type CoreEvidence, type HcLiveEffects, type HcLiveIdentity } from "./helpers/hc-live.ts";
import { hcTab } from "../src/hc/host.ts";
import { isTerminal, type RunStatus } from "../src/types.ts";

const scratch = realpathSync(tmpDir("c"));
let n = 0;
function identity(): HcLiveIdentity {
  const root = join(scratch, `f${n++}`); mkdirSync(root);
  return planHcLiveIdentity(root, `unit${String(n).padStart(4, "0")}`, { home: join(scratch, "no-home"), runtime: join(scratch, "no-runtime") });
}
const CORE = { pid: 4242, startTime: 77 };
function fake(id: HcLiveIdentity, over: { status?: unknown; holds?: boolean; socket?: boolean; ppid?: number; cgroup?: string; net?: string;
  procs?: ProcessIdentity[]; survive?: boolean; start?: Record<number, number | undefined> } = {}) {
  const log: string[][] = [];
  let alive = true;
  const effects: HcLiveEffects = {
    async exec(args) {
      log.push(args);
      if (args[0] === "server" && args[1] === "status") return JSON.stringify(over.status ?? { pid: CORE.pid, core: { id: "core0" }, version: "0.1.19" });
      if (args[0] === "server" && args[1] === "stop") { alive = false; return JSON.stringify({ stopped: true }); }
      return JSON.stringify({ terminals: [] });
    },
    startTime: pid => over.start && pid in over.start ? over.start[pid] : pid === CORE.pid ? (alive ? CORE.startTime : undefined)
      : over.procs?.find(p => p.pid === pid && over.survive)?.startTime,
    parentPid: pid => pid === CORE.pid ? over.ppid ?? process.pid : undefined,
    cgroup: pid => pid === CORE.pid ? over.cgroup ?? "0::/test.scope\n" : "0::/test.scope\n",
    isSocket: () => over.socket ?? true,
    holdsSocket: () => over.holds ?? true,
    netns: pid => pid === process.pid ? "net:[host]" : over.net ?? "net:[private]",
    processes: () => over.procs ?? [],
    signal: (pid, signal) => { log.push(["signal", String(pid), signal]); },
    remove: path => { log.push(["remove", path]); },
  };
  const server = { ...CORE, exited: () => !alive, wait: async () => !alive };
  return { fixture: new HcLiveFixture(id, server, effects), log };
}

test("hc live harness refuses inherited herdr-core and herdr targets before any control", () => {
  for (const key of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_SOCKET", "HC_SESSION", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) {
    assert.throws(() => refuseInheritedHc({ PATH: "/usr/bin", [key]: "ambient" }), new RegExp(`refuses an inherited .*${key}`), key);
  }
  assert.throws(() => refuseInheritedHc({ PATH: "/usr/bin", CONDUCTOR_H11_NETNS: "0" }), /private network namespace is mandatory/);
  refuseInheritedHc({ PATH: "/usr/bin" });
  assert.equal(liveEnabled({}), false, "the default suite never starts a live core");
});

test("hc live identity: a conductor-hc5 name, the socket and state under the fixture root, no shadowing of a real core", () => {
  const root = join(scratch, "names"); mkdirSync(root);
  const real = { home: join(scratch, "home"), runtime: join(scratch, "run") };
  for (const unique of ["", "short1", "Upper1234", "has space1", "a".repeat(17), "../../x1234"]) assert.throws(() => planHcLiveIdentity(root, unique, real), /refuses session name/);
  const id = planHcLiveIdentity(root, "abcd1234", real);
  assert.deepEqual([id.name, id.socketPath, id.stateDir], ["conductor-hc5-abcd1234", join(root, "r", "herdr-core", "conductor-hc5-abcd1234.sock"), join(root, "s", "herdr-core", "conductor-hc5-abcd1234")]);
  mkdirSync(id.stateDir, { recursive: true });
  assert.throws(() => planHcLiveIdentity(root, "abcd1234", real), /collision/);
  mkdirSync(join(real.runtime, "herdr-core"), { recursive: true }); writeFileSync(join(real.runtime, "herdr-core", "conductor-hc5-efgh5678.sock"), "");
  assert.throws(() => planHcLiveIdentity(root, "efgh5678", real), /collision/, "a same-named real core socket is never shadowed");
  mkdirSync(join(real.home, ".local", "state", "herdr-core", "conductor-hc5-ijkl9012"), { recursive: true });
  assert.throws(() => planHcLiveIdentity(root, "ijkl9012", real), /collision/, "a same-named real core state is never shadowed");
  assert.throws(() => planHcLiveIdentity("relative/root", "abcd9999", real), /canonical absolute/);
  const deep = join(scratch, "d".repeat(60)); mkdirSync(deep);
  assert.throws(() => planHcLiveIdentity(deep, "abcd1234abcd1234", real), /unix socket limit/);
});

test("hc live fixture env is an allowlist with a private runtime dir and the private session name", () => {
  const id = identity();
  const env = hcFixtureEnv(id);
  assert.equal(env.XDG_RUNTIME_DIR, join(id.root, "r"), "hc finds no systemd user manager and puts its socket under the fixture root");
  assert.equal(env.HC_SESSION, id.name);
  assert.deepEqual(Object.keys(env).filter(k => k.startsWith("HERDR_") || (k.startsWith("HC_") && k !== "HC_SESSION")), []);
  for (const key of ["DBUS_SESSION_BUS_ADDRESS", "AWS_PROFILE", "SSH_AUTH_SOCK", "XDG_SESSION_ID"]) assert.equal(env[key], undefined, key);
  assert.equal(env.H11_FIXTURE, id.root, "every fixture process carries the inventory marker");
});

test("hc live core ownership proof refuses each single-field mismatch", () => {
  const good: CoreEvidence = { serverPid: 4242, serverAlive: true, parentIsTest: true, sameCgroup: true, socketPresent: true, holdsSocket: true, privateNetwork: true,
    coreId: "core0", status: { pid: 4242, core: { id: "core0" } } };
  assert.deepEqual(proveOwnedCore(good), { ok: true });
  assert.deepEqual(proveOwnedCore({ ...good, status: undefined }), { ok: true }, "the pre-call gate needs no status");
  assert.deepEqual(proveOwnedCore({ ...good, coreId: undefined }), { ok: true }, "the first proof captures the core id");
  const variants: Array<[string, CoreEvidence]> = [
    ["owned core process identity changed", { ...good, serverAlive: false }],
    ["owned core is not this test's child", { ...good, parentIsTest: false }],
    ["owned core runs in another cgroup (a service manager started it)", { ...good, sameCgroup: false }],
    ["private socket missing", { ...good, socketPresent: false }],
    ["socket not held by owned core", { ...good, holdsSocket: false }],
    ["owned core is not in a private network namespace", { ...good, privateNetwork: false }],
    ["server status pid mismatch", { ...good, status: { pid: 1, core: { id: "core0" } } }],
    ["server status pid mismatch", { ...good, status: null }],
    ["core id changed", { ...good, status: { pid: 4242, core: { id: "other" } } }],
    ["core id changed", { ...good, status: { pid: 4242 } }],
  ];
  for (const [reason, ev] of variants) assert.deepEqual(proveOwnedCore(ev), { ok: false, reason }, reason);
});

test("hc live control refuses before any hc call when the core is unproven, and refuses the control call on a wrong status", async () => {
  for (const [over, why] of [[{ holds: false }, /socket not held/], [{ socket: false }, /private socket missing/], [{ ppid: 1 }, /not this test's child/],
    [{ cgroup: "0::/user.slice/app.slice/hc-core.service\n" }, /another cgroup/], [{ net: "net:[host]" }, /private network namespace/]] as const) {
    const { fixture, log } = fake(identity(), over);
    await assert.rejects(fixture.hc(["ls", "--all", "--json"]), why);
    assert.deepEqual(log, [], "no hc process ran: an unproven socket could reach or start another core");
  }
  const { fixture, log } = fake(identity(), { status: { pid: 999, core: { id: "core0" } } });
  await assert.rejects(fixture.hc(["ls", "--all", "--json"]), /server status pid mismatch/);
  assert.deepEqual(log, [["server", "status", "--json"]], "only the read-only proof call ran");
  const ok = fake(identity());
  assert.deepEqual(await ok.fixture.hc(["ls", "--all", "--json"]), { terminals: [] });
  assert.equal(ok.fixture.coreId, "core0");
});

test("hc live crash injection signals only an owned fixture process by exact start identity inside the private namespace", async () => {
  const procs = [{ pid: 5001, startTime: 90, argv: "node pi" }];
  const ok = fake(identity(), { procs, start: { 5001: 90 } });
  await ok.fixture.signalOwned({ pid: 5001, startTime: 90 }, "SIGKILL");
  assert.deepEqual(ok.log.filter(a => a[0] === "signal"), [["signal", "5001", "SIGKILL"]]);
  const cases: Array<[string, Parameters<typeof fake>[1], { pid: number; startTime: number }, RegExp]> = [
    ["unowned", { procs, start: { 6001: 90 } }, { pid: 6001, startTime: 90 }, /not an owned fixture process/],
    ["reused", { procs, start: { 5001: 95 } }, { pid: 5001, startTime: 90 }, /start identity changed/],
    ["the core", { procs: [{ pid: 4242, startTime: 77, argv: "herdr-core serve" }] }, { pid: 4242, startTime: 77 }, /refuses to signal the fixture core/],
    ["host namespace", { procs, start: { 5001: 90 }, net: "net:[host]" }, { pid: 5001, startTime: 90 }, /private network namespace|outside the fixture/],
  ];
  for (const [label, over, target, why] of cases) {
    const { fixture, log } = fake(identity(), over);
    await assert.rejects(fixture.signalOwned(target, "SIGKILL"), why, label);
    assert.deepEqual(log.filter(a => a[0] === "signal"), [], `${label}: nothing signalled`);
  }
});

test("hc live teardown: no stop or removal without proof; survivors preserve evidence; a clean stop removes only the fixture root", async () => {
  const unproven = fake(identity(), { holds: false });
  const r1 = await unproven.fixture.teardown(50);
  assert.equal(r1.clean, false); assert.equal(r1.preserved, unproven.fixture.id.root);
  assert.ok(!unproven.log.some(a => a[1] === "stop" || a[0] === "remove"), JSON.stringify(unproven.log));
  const survivor = fake(identity(), { procs: [{ pid: 999, startTime: 5, argv: "pi" }], survive: true });
  const r2 = await survivor.fixture.teardown(100);
  assert.equal(r2.clean, false); assert.deepEqual(r2.leftovers.map(p => p.pid), [999]);
  assert.deepEqual(survivor.log.filter(a => a[0] === "signal"), [["signal", "999", "SIGTERM"]]);
  assert.ok(!survivor.log.some(a => a[0] === "remove"));
  const clean = fake(identity(), { procs: [{ pid: 999, startTime: 5, argv: "pi" }] });
  const r3 = await clean.fixture.teardown(100);
  assert.equal(r3.clean, true, r3.notes.join("; "));
  assert.deepEqual(clean.log.map(a => a.slice(0, 2).join(" ")), ["server status", "server stop", `remove ${clean.fixture.id.root}`]);
});

const sh = (script: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile("/bin/sh", [script, ...args], { env, timeout: 10000, encoding: "utf8" }, (e, out) => e ? reject(Object.assign(e, { stdout: out })) : resolve(out));
});
test("hc live gate passes every call through, logs it, and holds exactly one armed run after the real run returns", { timeout: 20000 }, async () => {
  const root = join(scratch, "gate"); mkdirSync(join(root, "obs"), { recursive: true }); mkdirSync(join(root, "script"));
  const realHc = join(root, "real.sh");
  writeFileSync(realHc, "#!/bin/sh\nprintf '{\"argv\":\"%s\"}' \"$*\"\nexit 3\n", { mode: 0o755 });
  writeFileSync(join(root, "gate.sh"), hcGateScript(root, realHc));
  await assert.rejects(sh(join(root, "gate.sh"), ["get", "t1", "--json"], { PATH: "/usr/bin:/bin" }), (e: { code?: number; stdout?: string }) => e.code === 3 && e.stdout === '{"argv":"get t1 --json"}');
  writeFileSync(join(root, "script", "hc-gate-run"), "arm");
  const held = sh(join(root, "gate.sh"), ["run", "--bg", "--name", "x"], { PATH: "/usr/bin:/bin", HC_SOCKET: "/s.sock" }).catch(e => e);
  for (let i = 0; i < 200 && !existsSync(join(root, "obs", "hc-gate-held.json")); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(readFileSync(join(root, "obs", "hc-gate-held.json"), "utf8"), '{"argv":"run --bg --name x"}', "the real run already returned");
  assert.equal(existsSync(join(root, "script", "hc-gate-run")), false, "the arm is consumed once");
  writeFileSync(join(root, "script", "release-hc-gate"), "go");
  const result = await held;
  assert.equal(result.code, 3); assert.equal(result.stdout, '{"argv":"run --bg --name x"}\n');
  const calls = readFileSync(join(root, "obs", "hc-calls.log"), "utf8").trim().split("\n").map(l => l.split("\t").slice(1));
  assert.deepEqual(calls, [["", "get", "t1", "--json"], ["/s.sock", "run", "--bg", "--name", "x"]], "each line names the socket the caller targeted");
});

const LIVE = liveEnabled(process.env);
const piRoots = (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean);
const worktree = realpathSync(new URL("..", import.meta.url).pathname);
const jsonLines = (path: string): Record<string, any>[] => !existsSync(path) ? [] : readFileSync(path, "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const flat = (s: string) => s.replace(/\s+/g, " ");

async function until<T>(label: string, ms: number, probe: () => T | undefined | false | Promise<T | undefined | false>, why: () => string = () => ""): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`hc live ${label} not observed within ${ms}ms ${why()}`.trim());
    await new Promise(r => setTimeout(r, 50));
  }
}

type Lead = { name: string; address: string; pid: number; startTime: number; sessionFile: string; version: string };
type Terminal = { address: string; name: string | null; state: "live" | "finished"; parent?: string | null };

for (const piRoot of LIVE ? (piRoots.length ? piRoots : [""]) : ["(gated)"]) {
  const version = LIVE && piRoot ? JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version : piRoot;
  test(`hc live: real herdr-core with Pi ${version} leads and children on a private core`, { skip: LIVE ? false : "set CONDUCTOR_LIVE_TESTS=1 and CONDUCTOR_H11_PI_ROOTS for an isolated real herdr-core", timeout: 1500000 }, async t => {
    assert.ok(piRoot, "CONDUCTOR_H11_PI_ROOTS must name explicit Pi package roots; a missing prerequisite is a failure, not a skip");
    const hcBin = realpathSync(process.env.CONDUCTOR_HC5_BIN ?? execFileSync("sh", ["-c", "command -v herdr-core"], { encoding: "utf8" }).trim());
    const hcVersion = execFileSync(hcBin, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
    const reportsStatus = existsSync(join(piRoot, "dist", "modes", "interactive", "program-status-reporter.js"));
    const parent = liveParentRoot();
    const ambient = ambientHcSnapshot(parent);
    const alt = process.env.CONDUCTOR_H11_ALT_PI_ROOT ?? piRoots.find(r => r !== piRoot);
    t.diagnostic(`hc live versions ${JSON.stringify({ pi: version, piCli: piEntry(piRoot), reportsStatus, hc: hcVersion, hcBin, conductor: join(worktree, "dist", "index.js"), alt: alt ?? null })}`);
    t.diagnostic(`hc live ambient cores before ${ambient}`);
    const fx = await startHcLiveFixture({ piRoot, worktree, hcBin }, randomUUID().replace(/-/g, "").slice(0, 12), parent);
    const root = fx.id.root, runs = join(root, "home", ".pi", "agent", "conductor", "runs"), work = join(root, "work"), obsDir = join(root, "obs");
    const config = join(root, "home", ".pi", "agent", "extensions", "conductor", "config.json");
    let report: Awaited<ReturnType<typeof fx.teardown>> | undefined;
    const tokens = ["b2", "s3", "s3-2", "k5", "l6", "c7", "x7", "d8a", "d8b", "u8", "u8a", "u8b", "g9"];
    try {
      const space = `sp${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const record = (id: string) => JSON.parse(readFileSync(join(runs, id, "record.json"), "utf8"));
      const obs = (name: string) => join(obsDir, `${name}.json`);
      const leadStarts = () => readdirSync(obsDir).filter(f => f.startsWith("lead-") && f.includes("-start-"))
        .sort((a, b) => Number(a.split("-").at(-1)!.slice(0, -5)) - Number(b.split("-").at(-1)!.slice(0, -5))).map(f => JSON.parse(readFileSync(join(obsDir, f), "utf8")));
      const get = (address: string) => fx.hc(["get", address, "--json"]);
      const absent = (address: string) => get(address).then(() => false, e => /not_found/.test(String(e)));
      const terminals = async () => (await fx.hc(["ls", "--all", "--json"])).terminals as Terminal[];
      const addresses = async () => new Set((await terminals()).map(x => x.address));
      const screen = async (address: string) => (await fx.hc(["read", address, "--lines", "400"], 60000)).text as string;
      const environ = (pid: number) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const hcLog = () => existsSync(join(obsDir, "hc-calls.log")) ? readFileSync(join(obsDir, "hc-calls.log"), "utf8").split("\n").filter(Boolean).map(l => l.split("\t")) : [];
      const hcCalls = () => hcLog().map(([pid, , ...args]) => [pid, ...args]);
      const pad = (g: number) => String(g).padStart(6, "0");

      let lead: Lead;
      const startLead = async (name: string, opts: { pi?: string; env?: string[] } = {}): Promise<Lead> => {
        const before = leadStarts().length;
        const argv = [...(opts.env?.length ? ["env", ...opts.env] : []), process.execPath, piEntry(opts.pi ?? piRoot), "--session-dir", join(root, "lead-sessions")];
        const run = await fx.hc(["run", "--bg", "--json", "--no-parent", "--name", name, "--cwd", work, "--label", `herdr.space=${space}`, "--", ...argv], 30000);
        assert.equal(run.state, "live", JSON.stringify(run));
        const start = await until(`${name} session_start`, 60000, () => leadStarts().length > before && leadStarts().at(-1));
        assert.equal((await get(run.address)).pid, start.pid, "the lead terminal's program is the lead Pi");
        return { name, address: run.address, pid: start.pid, startTime: start.startTime, sessionFile: start.sessionFile, version: start.version };
      };
      const leadEnds = () => readdirSync(obsDir).filter(f => f.startsWith(`lead-${lead.pid}-end-`)).length;
      const send = (text: string) => fx.hc(["send", lead.address, text, "--json"], 30000);
      let step = 0;
      const leadTool = async (tool: string, args: Record<string, unknown>) => {
        const name = `s${++step}`;
        writeFileSync(join(root, "script", `${name}.json`), JSON.stringify({ tool, args }));
        const ends = leadEnds();
        await send(`H11 ${name}`);
        const result = await until(`lead ${tool} result`, 60000, () => existsSync(obs(`lead-tool-h11_${name}`)) && JSON.parse(readFileSync(obs(`lead-tool-h11_${name}`), "utf8")));
        await until(`lead idle after ${name}`, 30000, () => leadEnds() > ends);
        return result;
      };
      const command = async (text: string, marker: string) => {
        const seen = (await screen(lead.address)).split(marker).length;
        await send(text);
        return until(`${text} output`, 90000, async () => { const s = await screen(lead.address); return s.split(marker).length > seen && s.slice(s.lastIndexOf(marker)); });
      };
      const doctorRuntime = async () => {
        await command("/conductor doctor", "## Runtime");
        const s = await until("doctor runtime section complete", 60000, async () => { const x = await screen(lead.address); return x.indexOf("total tracked", x.lastIndexOf("## Runtime")) > 0 && x; });
        const at = s.lastIndexOf("## Runtime");
        return flat(s.slice(at, s.indexOf("total tracked", at) + 40));
      };
      const spawnChild = async (task: string, extra: Record<string, unknown> = {}) => {
        const r = await leadTool("ensemble_spawn", { persona: "oracle", task, foreground: false, ...extra });
        assert.equal(r.isError, false, JSON.stringify(r.result));
        return r.result.details.agent_id as string;
      };
      const status = (id: string, ...want: string[]) => until(`${id} status ${want.join("|")}`, 90000, () => {
        if (!existsSync(join(runs, id, "record.json"))) return false;
        const r = record(id);
        return want.includes(r.status) && (r.status !== "completed" || existsSync(join(runs, id, "final.md"))) && r;
      }, () => JSON.stringify(existsSync(join(runs, id, "record.json")) ? { status: record(id).status, error: record(id).errorMessage } : {}));
      const hello = (id: string) => JSON.parse(readFileSync(join(runs, id, "launch", `${record(id).herdr.launchNonce}.json`), "utf8"));
      const cards = (id: string, file = lead.sessionFile) => jsonLines(file).filter(e => e.type === "custom_message" && JSON.stringify(e).includes("<sub-agent-completed>") && JSON.stringify(e).includes(`<agent-id>${id}</agent-id>`)).length;
      const gone = (h: { pid: number; pidStartTime: number }) => procStartTime(h.pid) !== h.pidStartTime;
      const release = (token: string) => writeFileSync(join(root, "script", `release-${token}`), "go");
      const held = (token: string, id: string) => until(`child ${token} held`, 60000, () => {
        if (existsSync(join(runs, id, "record.json")) && ["failed", "killed", "completed"].includes(record(id).status)) throw new Error(`hc live ${id} ended before its barrier: ${record(id).status} ${record(id).errorMessage}`);
        return existsSync(obs(`child-${token}-held`)) && JSON.parse(readFileSync(obs(`child-${token}-held`), "utf8"));
      });
      const leavesOf = (id: string) => existsSync(runs) ? readdirSync(runs).filter(r => existsSync(join(runs, r, "record.json")) && record(r).parentRunId === id).sort() : [];
      const crashLead = async () => {
        const term = await get(lead.address);
        assert.equal(term.pid, lead.pid);
        await fx.signalOwned({ pid: lead.pid, startTime: lead.startTime }, "SIGKILL");
        await until("lead exit", 15000, () => procStartTime(lead.pid) !== lead.startTime);
        return until("lead terminal finished", 15000, async () => { const x = await get(lead.address); return x.state === "finished" && x; });
      };
      const quitLead = async () => {
        await fx.hc(["keys", lead.address, "ctrl+c", "ctrl+c", "--json"]);
        return until(`${lead.name} quit`, 30000, async () => { const x = await get(lead.address); return x.state === "finished" && x; });
      };

      await t.test("0. the private core is this test's own child, holds its own socket, outside any service manager and in its own network namespace", async () => {
        const stat = readFileSync(`/proc/${fx.server.pid}/stat`, "utf8").split(") ").pop()!.split(" ");
        const core = { pid: fx.server.pid, ppid: Number(stat[1]), start: Number(stat[19]), sockets: listeningSockets(fx.server.pid),
          net: readlinkSync(`/proc/${fx.server.pid}/ns/net`), testNet: readlinkSync("/proc/self/ns/net"),
          cgroup: readFileSync(`/proc/${fx.server.pid}/cgroup`, "utf8").trim(), testCgroup: readFileSync("/proc/self/cgroup", "utf8").trim(),
          argv: readFileSync(`/proc/${fx.server.pid}/cmdline`, "utf8").split("\0").filter(Boolean) };
        const st = await fx.hc(["server", "status", "--json"]);
        t.diagnostic(`hc live core ${JSON.stringify({ ...core, status: { pid: st.pid, core: st.core, version: st.version }, socket: fx.id.socketPath })}`);
        assert.deepEqual([core.ppid, core.start, core.argv.slice(1)], [process.pid, fx.server.startTime, ["serve"]]);
        assert.ok(core.sockets.includes(fx.id.socketPath), "the owned core holds the private socket inode");
        assert.notEqual(core.net, core.testNet); assert.equal(core.cgroup, core.testCgroup, "not a systemd transient service");
        assert.equal(st.pid, fx.server.pid); assert.equal(st.core.id, fx.coreId); assert.equal(st.live, 0);
      });

      lead = await startLead("lead");
      await t.test("1. selection: auto picks herdr on hc; doctor names the private socket, core, lead and space", async () => {
        assert.equal(lead.version, version);
        const env = environ(lead.pid);
        assert.ok(env.includes(`HC_TERMINAL_ID=${lead.address}`) && env.includes(`HC_TERMINAL_SOCKET=${fx.id.socketPath}`), "the core gave the lead its own terminal identity");
        assert.deepEqual(env.filter(e => e.startsWith("HERDR_")), []);
        assert.deepEqual((await get(lead.address)).labels, { "herdr.space": space });
        const runtime = await doctorRuntime();
        t.diagnostic(`hc live doctor ${runtime}`);
        assert.match(runtime, /selected: herdr on hc \[auto\]/);
        assert.match(runtime, /environment: Herdr 2 terminal \(hc\)/);
        assert.ok(runtime.includes(`hc: socket=${fx.id.socketPath} core=${fx.coreId} lead=${lead.address} space=${space}`), runtime);
        assert.match(runtime, /oracle: herdr on hc \[auto\]/);
        assert.doesNotMatch(runtime, /⚠/);
      });

      let b2 = "";
      await t.test("2. spawn: exactly one new terminal under the lead, labelled, outliving it, silent, running the hello pid", async () => {
        const before = await addresses();
        const id = b2 = await spawnChild("H11-CHILD hold b2");
        await held("b2", id);
        const r = record(id), h = hello(id), address = r.herdr.address;
        assert.deepEqual([r.runtime, r.herdr.host, r.herdr.socketPath, r.herdr.coreId], ["herdr", "hc", fx.id.socketPath, fx.coreId]);
        assert.deepEqual([...await addresses()].filter(a => !before.has(a)), [address], "exactly one new terminal");
        const term = await get(address);
        t.diagnostic(`hc live child terminal ${JSON.stringify({ address, name: term.name, parent: term.parent, labels: term.labels, die_with_parent: term.die_with_parent, notify: term.notify, pid: term.pid, foreground: term.foreground?.pid, status: term.status, argv0: term.argv.slice(0, 1) })}`);
        assert.deepEqual([term.parent, term.name, term.state], [lead.address, r.herdr.agentName, "live"]);
        assert.deepEqual(term.labels, { "conductor.run": id, "conductor.nonce": r.herdr.launchNonce, "herdr.tab": hcTab(id), "herdr.space": space });
        assert.deepEqual([r.herdr.parentAddress, r.herdr.tab, r.herdr.space], [lead.address, hcTab(id), space]);
        assert.deepEqual([term.die_with_parent, term.notify], [false, false]);
        assert.deepEqual([term.pid, term.foreground?.pid], [h.pid, h.pid], "the terminal's program and foreground process are the hello pid");
        const env = environ(h.pid);
        assert.ok(env.includes("CONDUCTOR_SUBAGENT=1"));
        assert.deepEqual(env.filter(e => e.startsWith("HERDR_")), []);
        assert.ok(env.includes(`HC_TERMINAL_ID=${address}`) && env.includes(`HC_TERMINAL_SOCKET=${fx.id.socketPath}`));
        if (reportsStatus) {
          const st = await until("child OSC 7501 status", 20000, async () => (await get(address)).status);
          t.diagnostic(`hc live child status ${JSON.stringify(st)}`);
          assert.equal(st.app, "pi"); assert.equal(st.state, "working");
        } else {
          assert.equal(term.status, null, `Pi ${version} has no OSC 7501 program status reporter`);
          t.diagnostic(`hc live child status null: Pi ${version} ships no program-status-reporter`);
        }
        release("b2");
        const done = await status(id, "completed", "failed", "killed");
        assert.equal(done.status, "completed", done.errorMessage);
        await until("child pid exit", 15000, () => gone(h));
        const fin = await until("child terminal finished", 15000, async () => { const x = await get(address); return x.state === "finished" && x; });
        t.diagnostic(`hc live finished child ${JSON.stringify({ reason: fin.reason, exit_code: fin.exit_code, signal: fin.signal, status: fin.status })}`);
        await until("single completion card", 20000, () => cards(id) === 1);
      });

      await t.test("3. delivery: live steer and follow_up are acked through the inbox and run in order; one card", async () => {
        const id = await spawnChild("H11-CHILD hold2 s3");
        await held("s3", id);
        const steer = await leadTool("ensemble_send", { agent_id: id, message: "H11 steer s3", streaming_behavior: "steer", foreground: false });
        assert.equal(steer.result.details.status, "accepted-input", `steer: ${JSON.stringify(steer.result)}`);
        release("s3");
        await held("s3-2", id);
        const follow = await leadTool("ensemble_send", { agent_id: id, message: "H11 follow s3", streaming_behavior: "follow_up", foreground: false });
        assert.equal(follow.result.details.status, "accepted-input", `follow_up: ${JSON.stringify(follow.result)}`);
        release("s3-2");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        const final = readFileSync(join(runs, id, "final.md"), "utf8");
        assert.ok(final.indexOf("H11 steer s3") >= 0 && final.indexOf("H11 steer s3") < final.indexOf("H11 follow s3"), final);
        const inbox = join(runs, id, "inbox", r.herdr.launchNonce), acks = readdirSync(inbox).filter(f => f.endsWith(".ack.json"));
        t.diagnostic(`hc live inbox ${JSON.stringify(readdirSync(inbox).sort())}`);
        assert.ok(acks.length >= 3, "initial, steer and follow_up each acked");
        await until("single completion card", 20000, () => cards(id) === 1);
      });

      await t.test("4. resume: send on the finished run gets a new terminal and removes the previous one", async () => {
        const before = record(b2).herdr;
        assert.equal((await get(before.address)).state, "finished");
        const sent = await leadTool("ensemble_send", { agent_id: b2, message: "H11 resume r4", foreground: false });
        assert.equal(sent.isError, false, JSON.stringify(sent.result));
        const r = await until("resumed completion", 90000, () => { const x = record(b2); return x.status === "completed" && x.herdr.launchNonce !== before.launchNonce && existsSync(join(runs, b2, "final.md")) && /H11 saw b2: H11 resume r4/.test(readFileSync(join(runs, b2, "final.md"), "utf8")) && x; });
        assert.notEqual(r.herdr.address, before.address);
        assert.equal(r.herdr.sessionFile, before.sessionFile, "the same Pi session continues");
        assert.equal(await absent(before.address), true, "hc get: the previous terminal is gone");
        const all = await terminals();
        assert.ok(!all.some(x => x.address === before.address) && all.some(x => x.address === r.herdr.address), JSON.stringify(all));
        const rm = hcCalls().filter(c => c[1] === "rm");
        assert.deepEqual(rm.map(c => c[2]), [before.address], "one rm, of the previous terminal");
        t.diagnostic(`hc live resume ${before.address} -> ${r.herdr.address}; rm calls ${JSON.stringify(rm)}`);
        await until("resume completion card", 20000, () => cards(b2) === 2);
      });

      await t.test("5. kill: SIGTERM to the proven pid ends the terminal's program; no hc kill", async () => {
        const id = await spawnChild("H11-CHILD hold k5");
        await held("k5", id);
        const r0 = record(id), h = hello(id);
        assert.equal((await get(r0.herdr.address)).pid, h.pid);
        const killed = await leadTool("ensemble_kill", { agent_id: id });
        assert.equal(killed.isError, false, JSON.stringify(killed.result));
        assert.equal((await status(id, "killed", "failed", "completed")).status, "killed");
        await until("killed child exit", 15000, () => gone(h));
        const term = await until("terminal finished", 15000, async () => { const x = await get(r0.herdr.address); return x.state === "finished" && x; });
        t.diagnostic(`hc live killed terminal ${JSON.stringify({ reason: term.reason, signal: term.signal, exit_code: term.exit_code })}`);
        assert.equal(term.reason, "exited", "the core's record: the program ended on its own signal; hc kill would record reason killed");
        assert.deepEqual(hcCalls().filter(c => c[1] === "kill"), [], "no lead ever ran hc kill");
        release("k5");
      });

      await t.test("6. reload: the child keeps running, the new instance readopts it, it completes with one card", async () => {
        const id = await spawnChild("H11-CHILD hold l6");
        const h = await held("l6", id);
        const reloads = leadStarts().filter(s => s.pid === lead.pid && s.reason === "reload").length;
        await send("/reload");
        await until("reload session_start", 30000, () => leadStarts().filter(s => s.pid === lead.pid && s.reason === "reload").length > reloads);
        const owner = join(runs, id, "owner");
        await until("reload owner handoff", 30000, () => existsSync(join(owner, "000000.json.released")) && existsSync(join(owner, "000001.json")));
        assert.equal(procStartTime(h.pid), h.startTime, "the child survived the reload");
        assert.equal((await get(record(id).herdr.address)).state, "live");
        release("l6");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        assert.equal(r.herdr.ownerGeneration, 1);
        await until("post-reload card", 20000, () => cards(id) >= 1);
        assert.equal(cards(id), 1, "old-module callbacks stayed inert");
      });

      let x7 = "", g9 = "";
      await t.test("7. crash: SIGKILL the lead; a new lead in a new terminal proves the old owner dead, readopts and settles once", async () => {
        const id = await spawnChild("H11-CHILD hold c7");
        await held("c7", id);
        const gen = record(id).herdr.ownerGeneration;
        const claim = JSON.parse(readFileSync(join(runs, id, "owner", `${pad(gen)}.json`), "utf8"));
        assert.deepEqual([claim.pid, claim.startTime], [lead.pid, lead.startTime], "the crash target is the proven owning lead");
        const oldSession = lead.sessionFile, oldLead = lead.address;
        await crashLead();
        assert.equal((await get(record(id).herdr.address)).state, "live", "the child outlives its parent terminal");
        lead = await startLead("lead2");
        assert.notEqual(lead.address, oldLead);
        const next = join(runs, id, "owner", `${pad(gen + 1)}.json`);
        await until("takeover claim", 30000, () => existsSync(next) && JSON.parse(readFileSync(next, "utf8")).pid === lead.pid);
        release("c7");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        await until("single post-crash card", 20000, () => cards(id) === 1);
        assert.equal(cards(id, oldSession), 0, "the crashed lead published nothing for it");
        const term = await get(r.herdr.address);
        assert.equal(term.parent, oldLead, "hc keeps the original parent address");
      });

      await t.test("7b. crash between hc run and the address write: the new lead observes the hello's terminal and preserves the run, never replaying it", async () => {
        writeFileSync(join(root, "script", "hc-gate-run"), "arm");
        const id = x7 = await spawnChild("H11-CHILD hold x7");
        const gated = await until("gated hc run returned", 60000, () => existsSync(obs("hc-gate-held")) && JSON.parse(readFileSync(obs("hc-gate-held"), "utf8")));
        const persisted = record(id).herdr;
        assert.deepEqual([persisted.host, persisted.address, persisted.childPid], ["hc", undefined, undefined], "the crash window: the record names no terminal yet");
        const helloPath = join(runs, id, "launch", `${persisted.launchNonce}.json`);
        const h = await until("child hello", 30000, () => existsSync(helloPath) && JSON.parse(readFileSync(helloPath, "utf8")));
        assert.equal(h.paneId, gated.address);
        await crashLead();
        const calls = hcCalls().length;
        lead = await startLead("lead3");
        await until("lead3 observed the hello's terminal by address", 30000, () => hcCalls().slice(calls).some(c => Number(c[0]) === lead.pid && c[1] === "get" && c[2] === gated.address));
        const runtime = await doctorRuntime();
        t.diagnostic(`hc live doctor after 7b ${runtime}`);
        assert.match(runtime, /hc records with an unprovable terminal: 1 /);
        const after = record(id);
        assert.deepEqual([after.status, after.herdr.address, after.herdr.ownerGeneration], ["running", undefined, persisted.ownerGeneration], "preserved as written; nothing replayed or claimed");
        assert.deepEqual(readdirSync(join(runs, id, "owner")).sort(), [`${pad(persisted.ownerGeneration)}.json`]);
        const term = await get(gated.address);
        assert.deepEqual([term.state, term.pid], ["live", h.pid], "the never-tasked child is kept running");
        assert.ok(!existsSync(obs("child-x7-held")), "the child never received its task");
        const inbox = join(runs, id, "inbox", persisted.launchNonce);
        t.diagnostic(`hc live 7b inbox ${JSON.stringify(existsSync(inbox) ? readdirSync(inbox).sort() : [])}`);
        assert.deepEqual(existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith(".ack.json")) : [], [], "no request was ever acknowledged");
      });

      await t.test("8. delegation: leaves sit under their delegator's terminal in its tab; an unproven delegator gives own tabs plus the warning", async () => {
        const sp = await leadTool("ensemble_spawn", { persona: "investigator", task: "H11-CHILD n5 d8", foreground: false });
        assert.equal(sp.isError, false, JSON.stringify(sp.result));
        const id = sp.result.details.agent_id as string;
        await held("d8a", id); await held("d8b", id);
        const pb = record(id).herdr;
        const leaves = leavesOf(id).map(record);
        assert.equal(leaves.length, 2);
        for (const leaf of leaves) {
          assert.deepEqual([leaf.runtime, leaf.depth, leaf.parentRunId, leaf.herdr.host, leaf.herdr.parentAddress, leaf.herdr.tab, leaf.herdr.space, leaf.herdr.createdTab, leaf.herdr.placementWarning],
            ["herdr", 2, id, "hc", pb.address, pb.tab, space, false, undefined], leaf.id);
          const term = await get(leaf.herdr.address);
          t.diagnostic(`hc live leaf ${leaf.id} ${JSON.stringify({ address: leaf.herdr.address, parent: term.parent, labels: term.labels })}`);
          assert.deepEqual([term.parent, term.labels["herdr.tab"], term.labels["herdr.space"], term.labels["conductor.run"]], [pb.address, pb.tab, space, leaf.id]);
        }
        release("d8a"); release("d8b");
        const done = await status(id, "completed", "failed", "killed");
        assert.equal(done.status, "completed", done.errorMessage);
        assert.match(readFileSync(join(runs, id, "final.md"), "utf8"), /H11 n5 parent d8 saw 2/);
        await until("one delegator card", 20000, () => cards(id) === 1);
        assert.equal(cards(leaves[0].id) + cards(leaves[1].id), 0, "no leaf card");

        const un = await leadTool("ensemble_spawn", { persona: "investigator", task: "H11-CHILD n5hold u8", foreground: false });
        const uid = un.result.details.agent_id as string;
        await held("u8", uid);
        await until("u8 delegator accepted for live send", 30000, async () => JSON.stringify((await leadTool("ensemble_status", { agent_id: uid })).result?.details ?? {}).includes('"steer"'));
        const ub = record(uid).herdr;
        await fx.hc(["label", ub.address, "conductor.nonce=forged", "--json"]);
        release("u8");
        await held("u8a", uid); await held("u8b", uid);
        const own = leavesOf(uid).map(record);
        assert.equal(own.length, 2);
        for (const leaf of own) {
          assert.match(leaf.herdr.placementWarning ?? "", /parent terminal unproven \(terminal labels mismatch\); leaf placed in its own tab/);
          assert.deepEqual([leaf.herdr.parentAddress, leaf.herdr.tab, leaf.herdr.space, leaf.herdr.createdTab], [lead.address, hcTab(leaf.id), space, true]);
          const term = await get(leaf.herdr.address);
          assert.deepEqual([term.parent, term.labels["herdr.tab"]], [lead.address, hcTab(leaf.id)]);
          assert.notEqual(term.labels["herdr.tab"], ub.tab);
        }
        await fx.hc(["label", ub.address, `conductor.nonce=${ub.launchNonce}`, "--json"]);
        release("u8a"); release("u8b");
        const udone = await status(uid, "completed", "failed", "killed");
        assert.equal(udone.status, "completed", udone.errorMessage);
        for (const leaf of own) {
          const answer = JSON.parse(readFileSync(join(runs, uid, "delegate", `${leaf.delegateToolCallId}.json`), "utf8"));
          assert.match(answer.envelope, /<warning reason="placement">parent terminal unproven \(terminal labels mismatch\)/);
        }
      });

      await t.test("9. gc: /conductor gc removes exactly the finished terminals it owns; live and foreign terminals stay", async () => {
        const gid = g9 = await spawnChild("H11-CHILD hold g9");
        await held("g9", gid);
        const foreignDone = await fx.hc(["run", "--bg", "--json", "--no-parent", "--name", "foreign-done", "--cwd", work, "--label", `conductor.run=${b2}`, "--", "sh", "-c", "exit 0"]);
        const foreignLive = await fx.hc(["run", "--bg", "--json", "--no-parent", "--name", "foreign-live", "--cwd", work, "--", "sh", "-c", "exec sleep 600"]);
        await until("foreign terminal finished", 15000, async () => (await get(foreignDone.address)).state === "finished");
        const before = await terminals();
        const settled = readdirSync(runs).map(record).filter(r => r.runtime === "herdr" && r.herdr?.host === "hc" && r.herdr.address && isTerminal(r.status as RunStatus));
        const state = (a: string) => before.find(x => x.address === a)?.state;
        const expected = settled.map(r => r.herdr.address).filter(a => state(a) === "finished").sort();
        const preservedLive = settled.map(r => r.herdr.address).filter(a => state(a) === "live");
        const kept = [lead.address, record(gid).herdr.address, hello(x7).paneId, foreignDone.address, foreignLive.address, ...preservedLive].sort();
        t.diagnostic(`hc live gc expects removal of ${JSON.stringify(expected)}; keeps ${JSON.stringify(kept)}`);
        writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), gc: { autoOnSessionStart: false, transcriptSizeCapBytes: 1 } }, null, 2));
        const calls = hcCalls().length, rms = () => hcCalls().slice(calls).filter(c => c[1] === "rm").map(c => c[2]).sort();
        await send("/conductor gc");
        await until("gc removals", 60000, () => rms().length >= expected.length, () => JSON.stringify(rms()));
        const during = await terminals();
        assert.equal(during.find(x => x.address === record(gid).herdr.address)?.state, "live", "the attached running child stayed live through gc");
        release("g9");
        assert.equal((await status(gid, "completed", "failed")).status, "completed");
        const out = await until("gc output", 120000, async () => { const x = await screen(lead.address); return x.includes("GC plan") && x.slice(x.lastIndexOf("GC plan")); });
        t.diagnostic(`hc live gc ${flat(out).slice(0, 400)}`);
        assert.ok(flat(out).includes(`(${expected.length} archived, 0 deleted, 0 failed)`), flat(out));
        writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), gc: { autoOnSessionStart: false } }, null, 2));
        const after = await terminals();
        const removed = before.filter(x => !after.some(y => y.address === x.address)).map(x => x.address).sort();
        t.diagnostic(`hc live gc removed ${JSON.stringify(removed)} kept ${JSON.stringify(after.map(x => `${x.address}:${x.name}:${x.state}`))}`);
        assert.deepEqual(removed, expected, "exactly the finished terminals of terminal conductor runs");
        assert.deepEqual(rms(), expected, "the lead ran one hc rm per removed terminal and no other");
        for (const a of kept) assert.ok(after.some(x => x.address === a), `${a} kept`);
        await until("gc-time child card", 20000, () => cards(gid) === 1);
      });

      await t.test("10. conflict: a lead that also carries HERDR_ENV=1 picks subprocess, doctor names the conflict, no hc terminal is created", async () => {
        const quitter = lead.pid, quitCalls = hcCalls().length;
        await quitLead();
        const quitRm = hcCalls().slice(quitCalls).filter(c => Number(c[0]) === quitter && c[1] === "rm").map(c => c[2]);
        t.diagnostic(`hc live quit of ${quitter} removed ${JSON.stringify(quitRm)}`);
        assert.deepEqual(quitRm, [record(g9).herdr.address], "quit removes the lead's own finished terminal that gc left (g9 finished after gc)");
        const before = await addresses();
        lead = await startLead("leadc", { env: ["HERDR_ENV=1"] });
        assert.ok(environ(lead.pid).includes("HERDR_ENV=1"));
        const runtime = await doctorRuntime();
        t.diagnostic(`hc live doctor conflict ${runtime}`);
        assert.match(runtime, /⚠ environment conflict: both Herdr 2 \(HC_TERMINAL_ID, HC_TERMINAL_SOCKET\) and herdr TUI \(HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID\) variables are set \(HC_TERMINAL_ID, HERDR_ENV\); refusing to guess/);
        assert.match(runtime, /selected: subprocess \[auto\]/);
        const mid = await addresses();
        assert.deepEqual([...mid].filter(a => !before.has(a)), [lead.address]);
        const id = await spawnChild("H11-CHILD basic m10");
        const r = await status(id, "completed", "failed", "killed");
        assert.deepEqual([r.status, r.runtime, r.herdr], ["completed", "subprocess", undefined], r.errorMessage);
        assert.deepEqual([...await addresses()].sort(), [...mid].sort(), "no hc terminal was created");
        await until("conflict lead card", 20000, () => cards(id) === 1);
        t.diagnostic(`hc live conflict lead hc calls ${JSON.stringify(hcCalls().filter(c => Number(c[0]) === lead.pid).map(c => c.slice(1, 3).join(" ")))}`);
        await quitLead();
      });

      await t.test("11. version: the hc child runs the lead's own Pi entry, so a lead on another Pi root gets a child of that version and no warning", { skip: alt ? false : "needs a second explicit Pi root in CONDUCTOR_H11_ALT_PI_ROOT or CONDUCTOR_H11_PI_ROOTS" }, async () => {
        const altVersion = JSON.parse(readFileSync(join(alt!, "package.json"), "utf8")).version;
        lead = await startLead("leadm", { pi: alt! });
        assert.equal(lead.version, altVersion, "the lead runs the other Pi version");
        const id = await spawnChild("H11-CHILD basic m11");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        const term = await get(r.herdr.address);
        t.diagnostic(`hc live version ${JSON.stringify({ lead: altVersion, matrix: version, child: hello(id).piVersion, argv: term.argv.filter((a: string) => a.includes("pi-coding-agent") || a === process.execPath), warning: r.herdr.versionWarning ?? null })}`);
        assert.equal(hello(id).piVersion, altVersion, "the child runs the lead's Pi, not the matrix root");
        assert.ok(term.argv.includes(piEntry(alt!)) && !term.argv.includes(piEntry(piRoot)));
        assert.equal(r.herdr.versionWarning, undefined);
        await until("version card", 20000, () => cards(id) === 1);
        assert.ok(!jsonLines(lead.sessionFile).some(e => JSON.stringify(e).includes('reason=\\"pi-version\\"')));
      });
      await t.test("every hc call a lead made reached the private core's socket", async () => {
        const sockets = [...new Set(hcLog().map(l => l[1]))];
        t.diagnostic(`hc live lead hc calls ${hcLog().length} to ${JSON.stringify(sockets)}; by verb ${JSON.stringify(Object.entries(hcLog().reduce((m: Record<string, number>, l) => ({ ...m, [l[2]]: (m[l[2]] ?? 0) + 1 }), {})))}`);
        assert.deepEqual(sockets, [fx.id.socketPath]);
      });
    } finally {
      if (existsSync(join(root, "script"))) for (const f of [...tokens, "hc-gate"]) writeFileSync(join(root, "script", `release-${f}`), "teardown");
      report = await fx.teardown();
      t.diagnostic(`hc live teardown ${JSON.stringify({ clean: report.clean, server: report.server, captured: report.captured.length, leftovers: report.leftovers, notes: report.notes, preserved: report.preserved })}`);
      t.diagnostic(`hc live captured ${JSON.stringify(report.captured.map(p => `${p.pid}:${p.startTime}:${p.argv.slice(0, 60)}`))}`);
    }
    await t.test("12. teardown: core stopped, no owned process survives, the root removed, the ambient cores untouched", async () => {
      assert.equal(report!.clean, true, `teardown preserved evidence at ${report!.preserved}: ${report!.notes.join("; ")}`);
      assert.equal(existsSync(root), false);
      const after = ambientHcSnapshot(parent);
      t.diagnostic(`hc live ambient cores after ${after}`);
      assert.equal(after, ambient, "ambient herdr-core processes and their sockets unchanged");
    });
  });
}
