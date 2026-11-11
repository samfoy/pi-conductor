import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertPrivateNetworkNamespace, fixtureEnv, listeningSockets, PRIVATE_NET, procStartTime, realEffects, refuseInheritedTarget, writePiFixture,
  type LiveEffects, type LiveIdentity, type ProcessIdentity } from "./herdr-live.ts";

export interface HcLiveIdentity { root: string; name: string; socketPath: string; stateDir: string }
export interface HcLiveEffects extends LiveEffects {
  parentPid(pid: number): number | undefined;
  cgroup(pid: number): string | undefined;
  isSocket(path: string): boolean;
}
export interface HcServerHandle { pid: number; startTime: number; exited(): boolean; wait(ms: number): Promise<boolean> }
export interface CoreEvidence {
  serverPid: number; serverAlive: boolean; parentIsTest: boolean; sameCgroup: boolean;
  socketPresent: boolean; holdsSocket: boolean; privateNetwork: boolean; coreId?: string; status?: unknown;
}
type Proof = { ok: true } | { ok: false; reason: string };
const refused = (reason: string): Proof => ({ ok: false, reason });

export function refuseInheritedHc(env: NodeJS.ProcessEnv): void {
  const inherited = Object.keys(env).filter(key => key.startsWith("HC_") || key.startsWith("HERDR_"));
  if (inherited.length) throw new Error(`hc live refuses an inherited herdr-core or herdr target (${inherited.sort().join(",")}); run under the env -u test wrapper`);
  refuseInheritedTarget(env);
}

export function planHcLiveIdentity(root: string, unique: string, real: { home: string; runtime: string } = { home: userInfo().homedir, runtime: `/run/user/${userInfo().uid}` }): HcLiveIdentity {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw new Error("hc live fixture root must be a canonical absolute path");
  const name = `conductor-hc5-${unique}`;
  if (!/^conductor-hc5-[a-z0-9]{8,16}$/.test(name)) throw new Error(`hc live refuses session name ${JSON.stringify(name)}`);
  const socketPath = join(root, "r", "herdr-core", `${name}.sock`), stateDir = join(root, "s", "herdr-core", name);
  if (Buffer.byteLength(join(root, "r", "herdr-core", `${name}.holder.00000000.sock`)) > 107) throw new Error("hc live socket path exceeds the unix socket limit");
  if ([stateDir, socketPath, join(real.runtime, "herdr-core", `${name}.sock`), join(real.home, ".local", "state", "herdr-core", name)].some(p => existsSync(p))) {
    throw new Error(`hc live session name collision: ${name}`);
  }
  return { root, name, socketPath, stateDir };
}

export function hcFixtureEnv(id: HcLiveIdentity): Record<string, string> {
  const { HERDR_CONFIG_PATH: _herdrOnly, ...env } = fixtureEnv({ root: id.root } as LiveIdentity);
  return { ...env, HC_SESSION: id.name };
}

export function proveOwnedCore(ev: CoreEvidence): Proof {
  if (!ev.serverAlive) return refused("owned core process identity changed");
  if (!ev.parentIsTest) return refused("owned core is not this test's child");
  if (!ev.sameCgroup) return refused("owned core runs in another cgroup (a service manager started it)");
  if (!ev.socketPresent) return refused("private socket missing");
  if (!ev.holdsSocket) return refused("socket not held by owned core");
  if (!ev.privateNetwork) return refused("owned core is not in a private network namespace");
  if (ev.status === undefined) return { ok: true };
  const status = ev.status as { pid?: unknown; core?: { id?: unknown } } | null;
  if (typeof status !== "object" || status === null || status.pid !== ev.serverPid) return refused("server status pid mismatch");
  if (typeof status.core?.id !== "string" || !status.core.id || (ev.coreId !== undefined && status.core.id !== ev.coreId)) return refused("core id changed");
  return { ok: true };
}

export interface HcTeardownReport { clean: boolean; server: { pid: number; startTime: number }; captured: ProcessIdentity[]; leftovers: ProcessIdentity[]; notes: string[]; preserved?: string }

export class HcLiveFixture {
  readonly env: Record<string, string>;
  coreId?: string;
  constructor(readonly id: HcLiveIdentity, readonly server: HcServerHandle, private readonly effects: HcLiveEffects) { this.env = hcFixtureEnv(id); }

  private evidence(status?: unknown): CoreEvidence {
    const serverNet = this.effects.netns(this.server.pid), ownNet = this.effects.netns(process.pid), cgroup = this.effects.cgroup(this.server.pid);
    return { serverPid: this.server.pid, coreId: this.coreId, status,
      serverAlive: !this.server.exited() && this.effects.startTime(this.server.pid) === this.server.startTime,
      parentIsTest: this.effects.parentPid(this.server.pid) === process.pid,
      sameCgroup: !!cgroup && cgroup === this.effects.cgroup(process.pid),
      socketPresent: this.effects.isSocket(this.id.socketPath),
      holdsSocket: this.effects.holdsSocket(this.server.pid, this.id.socketPath),
      privateNetwork: !!serverNet && !!ownNet && serverNet !== ownNet };
  }
  get callEnv(): Record<string, string> { return { ...this.env, HC_SOCKET: this.id.socketPath }; }
  async prove(): Promise<void> {
    const before = proveOwnedCore(this.evidence());
    if (!before.ok) throw new Error(`hc live socket ownership refused: ${before.reason}`);
    let status: unknown;
    try { status = JSON.parse(await this.effects.exec(["server", "status", "--json"], this.callEnv, 10000)); } catch { status = null; }
    const after = proveOwnedCore(this.evidence(status));
    if (!after.ok) throw new Error(`hc live socket ownership refused: ${after.reason}`);
    this.coreId ??= (status as { core: { id: string } }).core.id;
  }
  async hc(args: string[], timeoutMs = 10000): Promise<Record<string, any>> {
    await this.prove();
    const out = await this.effects.exec(args, this.callEnv, timeoutMs);
    try { return JSON.parse(out); } catch { return { text: out }; }
  }
  async signalOwned(target: { pid: number; startTime: number }, signal: NodeJS.Signals): Promise<void> {
    await this.prove();
    const owned = this.effects.processes(this.id.root, { pid: this.server.pid, startTime: this.server.startTime });
    if (!owned.some(p => p.pid === target.pid && p.startTime === target.startTime)) throw new Error(`hc live refuses to signal pid ${target.pid}: not an owned fixture process with that start identity`);
    if (target.pid === this.server.pid) throw new Error("hc live refuses to signal the fixture core directly");
    const net = this.effects.netns(target.pid);
    if (!net || net !== this.effects.netns(this.server.pid) || net === this.effects.netns(process.pid)) throw new Error(`hc live refuses to signal pid ${target.pid}: outside the fixture's private network namespace`);
    if (this.effects.startTime(target.pid) !== target.startTime) throw new Error(`hc live refuses to signal pid ${target.pid}: its start identity changed`);
    this.effects.signal(target.pid, signal);
  }
  async teardown(waitMs = 10000): Promise<HcTeardownReport> {
    const notes: string[] = [];
    const server = { pid: this.server.pid, startTime: this.server.startTime };
    let proven = true;
    try { await this.prove(); } catch (e) { proven = false; notes.push((e as Error).message); }
    const captured = this.effects.processes(this.id.root, server);
    if (proven) {
      try {
        const stopped = JSON.parse(await this.effects.exec(["server", "stop", "--json"], this.callEnv, 15000));
        if (stopped.stopped !== true) notes.push("core stop not confirmed");
      } catch (e) { notes.push(`core stop failed: ${(e as Error).message}`); }
    }
    if (!await this.server.wait(waitMs)) notes.push("owned core did not exit");
    const alive = () => captured.filter(p => this.effects.startTime(p.pid) === p.startTime);
    for (let i = 0; i < waitMs / 50 && alive().length; i++) await delay(50);
    let leftovers = alive();
    if (leftovers.length) {
      notes.push("fixture processes survived core stop; exact identities signalled");
      for (const p of leftovers) if (this.effects.startTime(p.pid) === p.startTime) this.effects.signal(p.pid, "SIGTERM");
      for (let i = 0; i < Math.max(2, waitMs / 250) && alive().length; i++) await delay(50);
      leftovers = alive();
    }
    const late = this.effects.processes(this.id.root, server).filter(p => !captured.some(c => c.pid === p.pid && c.startTime === p.startTime));
    if (late.length) { notes.push("unexpected late fixture processes"); leftovers = [...leftovers, ...late]; }
    const clean = notes.length === 0 && leftovers.length === 0 && this.server.exited();
    if (clean) this.effects.remove(this.id.root);
    return { clean, server, captured, leftovers, notes, ...(clean ? {} : { preserved: this.id.root }) };
  }
}

const procField = (pid: number, index: number): number | undefined => {
  try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[index]) || undefined; } catch { return undefined; }
};
export function hcRealEffects(hcBin: string): HcLiveEffects {
  return { ...realEffects(hcBin),
    exec: (args, env, timeoutMs) => new Promise((resolvePromise, reject) => {
      const started = Date.now();
      execFile(hcBin, args, { env, timeout: timeoutMs, maxBuffer: 1 << 22, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (!error) { resolvePromise(stdout); return; }
        const how = error.killed ? `killed after ${Date.now() - started}ms` : `exit ${String(error.code)}${error.signal ? ` signal ${error.signal}` : ""}`;
        reject(new Error(`hc ${args.slice(0, 2).join(" ")} failed (${how}): ${String(stderr || stdout).slice(0, 400)}`));
      });
    }),
    parentPid: pid => procField(pid, 1),
    cgroup: pid => { try { return readFileSync(`/proc/${pid}/cgroup`, "utf8"); } catch { return undefined; } },
    isSocket: path => { try { return lstatSync(path).isSocket(); } catch { return false; } } };
}

export function ambientHcSnapshot(root: string, runtime = `/run/user/${userInfo().uid}`): string {
  const ambient = join(runtime, "herdr-core") + "/";
  const procs = readdirSync("/proc").filter(n => /^\d+$/.test(n)).flatMap(name => {
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!/(^|\/)(herdr-core|hc)$/.test(argv[0] ?? "") || !["serve", "hold"].includes(argv[1] ?? "") ||
          readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`H11_FIXTURE=${root}`)) return [];
      const sockets = listeningSockets(Number(name)).filter(p => p.startsWith(ambient)).sort();
      return sockets.length ? [`${name}:${procStartTime(Number(name))}:${argv.join(" ")}:${sockets.join(",")}`] : [];
    } catch { return []; }
  }).sort();
  return JSON.stringify(procs);
}

export function hcGateScript(root: string, hcBin: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return [
    "#!/bin/sh",
    `real=${q(hcBin)}; root=${q(root)}`,
    "line=\"$PPID\t${HC_SOCKET:-}\"; for a in \"$@\"; do line=\"$line\t$a\"; done; printf '%s\\n' \"$line\" >> \"$root/obs/hc-calls.log\"",
    "if [ \"$1\" = run ] && mv \"$root/script/hc-gate-run\" \"$root/script/hc-gate-run.taken\" 2>/dev/null; then",
    "  out=$(\"$real\" \"$@\"); code=$?",
    "  printf '%s' \"$out\" > \"$root/obs/hc-gate-held.tmp\" && mv \"$root/obs/hc-gate-held.tmp\" \"$root/obs/hc-gate-held.json\"",
    "  while [ ! -e \"$root/script/release-hc-gate\" ] && kill -0 \"$PPID\" 2>/dev/null; do sleep 0.05; done",
    "  printf '%s\\n' \"$out\"; exit \"$code\"",
    "fi",
    "exec \"$real\" \"$@\"",
    "",
  ].join("\n");
}

export interface HcLiveConfig { piRoot: string; worktree: string; hcBin: string }
export function writeHcFixtureFiles(id: HcLiveIdentity, cfg: HcLiveConfig): void {
  writePiFixture(id.root, { piRoot: cfg.piRoot, worktree: cfg.worktree, extensions: [] });
  writeFileSync(join(id.root, "bin", "hc"), hcGateScript(id.root, cfg.hcBin), { mode: 0o755 });
  const config = join(id.root, "home", ".pi", "agent", "extensions", "conductor", "config.json");
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), gc: { autoOnSessionStart: false } }, null, 2));
}

export async function startHcLiveFixture(cfg: HcLiveConfig, unique: string, parent: string): Promise<HcLiveFixture> {
  refuseInheritedHc(process.env);
  assertPrivateNetworkNamespace();
  const id = planHcLiveIdentity(realpathSync(parent), unique);
  writeHcFixtureFiles(id, cfg);
  const effects = hcRealEffects(cfg.hcBin), env = hcFixtureEnv(id);
  const log = openSync(join(id.root, "core.log"), "a");
  const child = spawn(PRIVATE_NET[0], [...PRIVATE_NET.slice(1), cfg.hcBin, "serve"], { env, cwd: join(id.root, "work"), stdio: ["ignore", log, log] });
  let done = false;
  const exited = new Promise<void>(res => child.once("exit", () => { done = true; res(); }));
  const server: HcServerHandle = { pid: child.pid!, startTime: 0, exited: () => done,
    wait: async ms => done || await Promise.race([exited.then(() => true), delay(ms).then(() => false)]) };
  for (let i = 0; i < 100 && !server.startTime; i++) { server.startTime = procStartTime(child.pid!) ?? 0; if (!server.startTime) await delay(10); }
  const fixture = new HcLiveFixture(id, server, effects);
  for (let i = 0; i < 200; i++) {
    if (done) break;
    if (effects.isSocket(id.socketPath)) { try { await fixture.prove(); return fixture; } catch { /* not ready */ } }
    await delay(50);
  }
  const report = await fixture.teardown(5000);
  throw new Error(`hc live private core did not become ready; evidence ${report.preserved ?? "removed"}: ${report.notes.join("; ")}`);
}
