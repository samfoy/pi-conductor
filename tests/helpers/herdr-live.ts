// H11 isolated real-herdr fixture. Every control and cleanup call first proves the
// private socket is served by the exact test-owned server process; nothing falls
// back to an inherited or ambient herdr session.
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface LiveIdentity { root: string; name: string; sessionDir: string; socketPath: string }
export interface ProcessIdentity { pid: number; startTime: number; argv: string }
export interface ProcFact { ppid: number; startTime: number; marked: boolean; argv: string }
export interface LiveEffects {
  exec(args: string[], env: Record<string, string>, timeoutMs: number): Promise<string>;
  startTime(pid: number): number | undefined;
  holdsSocket(pid: number, socketPath: string): boolean;
  /** Network namespace identity of a process, or undefined if unreadable. */
  netns(pid: number): string | undefined;
  processes(root: string, server: { pid: number; startTime: number }): ProcessIdentity[];
  signal(pid: number, signal: NodeJS.Signals): void;
  remove(path: string): void;
}
export interface ServerHandle { pid: number; startTime: number; exited(): boolean; wait(ms: number): Promise<boolean> }
type Proof = { ok: true } | { ok: false; reason: string };

export const liveEnabled = (env: NodeJS.ProcessEnv): boolean => env.CONDUCTOR_LIVE_TESTS === "1";

export function refuseInheritedTarget(env: NodeJS.ProcessEnv): void {
  const inherited = Object.keys(env).filter(key => key.startsWith("HERDR_"));
  if (inherited.length) throw new Error(`H11 refuses inherited herdr target (${inherited.sort().join(",")}); run under the env -u test wrapper`);
  // The private network namespace is part of the approved isolation; there is no opt-out.
  if (env.CONDUCTOR_H11_NETNS !== undefined) throw new Error("H11 refuses CONDUCTOR_H11_NETNS: the private network namespace is mandatory");
}

/**
 * The live fixture root. Deliberately not tmpDir(): its exit hook would delete a
 * failed teardown's preserved evidence. Only a clean teardown removes this root.
 */
export function liveParentRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "h")));
}

export function planLiveIdentity(root: string, unique: string, realHome = userInfo().homedir): LiveIdentity {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw new Error("H11 fixture root must be a canonical absolute path");
  const name = `conductor-h11-${unique}`;
  if (!/^conductor-h11-[a-z0-9]{8,16}$/.test(name)) throw new Error(`H11 refuses session name ${JSON.stringify(name)}`);
  const sessionDir = join(root, "c", "herdr", "sessions", name), socketPath = join(sessionDir, "herdr.sock");
  if (Buffer.byteLength(socketPath) > 100) throw new Error("H11 socket path exceeds the unix socket limit");
  if (existsSync(sessionDir) || existsSync(join(realHome, ".config", "herdr", "sessions", name))) throw new Error(`H11 session name collision: ${name}`);
  return { root, name, sessionDir, socketPath };
}

/** Built from an allowlist: no credentials, proxies, AWS profiles or caller herdr context. */
export function fixtureEnv(id: LiveIdentity): Record<string, string> {
  const r = id.root;
  return {
    HOME: join(r, "home"), XDG_CONFIG_HOME: join(r, "c"), XDG_DATA_HOME: join(r, "d"), XDG_STATE_HOME: join(r, "s"),
    XDG_CACHE_HOME: join(r, "k"), XDG_RUNTIME_DIR: join(r, "r"), TMPDIR: join(r, "tmp"), PATH: `${join(r, "bin")}:/usr/bin:/bin`,
    SHELL: "/bin/sh", TERM: "xterm-256color", LANG: "C.UTF-8", HERDR_CONFIG_PATH: join(r, "c", "herdr", "config.toml"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(r, "home", ".pi", "agent"),
    CONDUCTOR_MEMORY_PATH: join(r, "memory.jsonl"), GIT_CONFIG_NOSYSTEM: "1", H11_FIXTURE: r,
  };
}

export function proveOwnedSocket(id: LiveIdentity, ev: { sessions: unknown; status: unknown; serverAlive: boolean; holdsSocket: boolean; privateNetwork: boolean }): Proof {
  const sessions = (ev.sessions as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return { ok: false, reason: "session list unavailable" };
  const mine = sessions.filter(s => s?.name === id.name);
  if (mine.length !== 1) return { ok: false, reason: "session name not unique" };
  if (mine[0].running !== true || mine[0].socket_path !== id.socketPath || mine[0].session_dir !== id.sessionDir) return { ok: false, reason: "session socket mismatch" };
  const status = ev.status as { running?: unknown; socket?: unknown } | undefined;
  if (status?.running !== true || status.socket !== id.socketPath) return { ok: false, reason: "server status socket mismatch" };
  if (!ev.serverAlive) return { ok: false, reason: "owned server process identity changed" };
  if (!ev.holdsSocket) return { ok: false, reason: "socket not held by owned server" };
  if (!ev.privateNetwork) return { ok: false, reason: "owned server is not in a private network namespace" };
  return { ok: true };
}

export interface TeardownReport { clean: boolean; server: ProcessIdentity | { pid: number; startTime: number }; captured: ProcessIdentity[]; leftovers: ProcessIdentity[]; notes: string[]; preserved?: string }

export class HerdrLiveFixture {
  readonly env: Record<string, string>;
  readonly panes = new Set<string>();
  constructor(readonly id: LiveIdentity, readonly server: ServerHandle, private readonly effects: LiveEffects) { this.env = fixtureEnv(id); }

  private async session(args: string[]): Promise<Record<string, unknown>> {
    return JSON.parse(await this.effects.exec(args, this.env, 10000));
  }
  async prove(): Promise<void> {
    const sessions = await this.session(["session", "list", "--json"]);
    const status = JSON.parse(await this.effects.exec(["status", "server", "--json"], { ...this.env, HERDR_SOCKET_PATH: this.id.socketPath }, 10000));
    const serverNet = this.effects.netns(this.server.pid), ownNet = this.effects.netns(process.pid);
    const proof = proveOwnedSocket(this.id, { sessions, status,
      serverAlive: !this.server.exited() && this.effects.startTime(this.server.pid) === this.server.startTime,
      holdsSocket: this.effects.holdsSocket(this.server.pid, this.id.socketPath),
      privateNetwork: !!serverNet && !!ownNet && serverNet !== ownNet });
    if (!proof.ok) throw new Error(`H11 socket ownership refused: ${proof.reason}`);
  }
  /** Proves ownership immediately before each API call. */
  async cli(args: string[], timeoutMs = 10000): Promise<Record<string, any>> {
    await this.prove();
    const out = await this.effects.exec(args, { ...this.env, HERDR_SOCKET_PATH: this.id.socketPath }, timeoutMs);
    try { return JSON.parse(out); } catch { return { text: out }; }
  }
  /** Conductor-created panes are adopted only from bindings naming this exact socket. */
  adopt(binding: { socketPath?: unknown; paneId?: unknown }): void {
    if (binding.socketPath !== this.id.socketPath || typeof binding.paneId !== "string") throw new Error("H11 refuses to adopt a pane from another socket");
    this.panes.add(binding.paneId);
  }
  async createWorkspace(cwd: string, label: string, env: Record<string, string> = {}): Promise<string> {
    const created = (await this.cli(["workspace", "create", "--cwd", cwd, "--label", label, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--no-focus"])).result;
    this.panes.add(created.root_pane.pane_id);
    return created.root_pane.pane_id;
  }
  async closeOwnedPane(paneId: string): Promise<void> {
    if (!this.panes.has(paneId)) throw new Error(`H11 refuses to close unowned pane ${paneId}`);
    const pane = (await this.cli(["pane", "get", paneId])).result?.pane;
    if (pane?.pane_id !== paneId || pane.agent) throw new Error(`H11 refuses to close pane ${paneId}: not an idle fixture shell`);
    await this.cli(["pane", "close", paneId]);
  }
  async teardown(waitMs = 10000): Promise<TeardownReport> {
    const notes: string[] = [];
    const server = { pid: this.server.pid, startTime: this.server.startTime };
    let proven = true;
    try { await this.prove(); } catch (e) { proven = false; notes.push((e as Error).message); }
    const captured = this.effects.processes(this.id.root, server);
    if (proven) {
      try {
        const stopped = await this.session(["session", "stop", this.id.name, "--json"]);
        const s = stopped.session as { socket_path?: unknown } | undefined;
        if (stopped.stopped !== true || s?.socket_path !== this.id.socketPath) notes.push("session stop not confirmed");
      } catch (e) { notes.push(`session stop failed: ${(e as Error).message}`); }
    }
    if (!await this.server.wait(waitMs)) notes.push("owned server did not exit");
    const alive = () => captured.filter(p => this.effects.startTime(p.pid) === p.startTime);
    for (let i = 0; i < waitMs / 50 && alive().length; i++) await delay(50);
    let leftovers = alive();
    if (leftovers.length) {
      notes.push("fixture processes survived server stop; exact identities signalled");
      for (const p of leftovers) if (this.effects.startTime(p.pid) === p.startTime) this.effects.signal(p.pid, "SIGTERM");
      for (let i = 0; i < Math.max(2, waitMs / 250) && alive().length; i++) await delay(50);
      leftovers = alive();
    }
    const late = this.effects.processes(this.id.root, server).filter(p => !captured.some(c => c.pid === p.pid && c.startTime === p.startTime));
    if (late.length) { notes.push("unexpected late fixture processes"); leftovers = [...leftovers, ...late]; }
    if (this.server.exited() && !leftovers.length) {
      try {
        const deleted = await this.session(["session", "delete", this.id.name, "--json"]);
        if (deleted.deleted !== true) notes.push("session delete not confirmed");
      } catch (e) { notes.push(`session delete failed: ${(e as Error).message}`); }
    }
    const clean = notes.length === 0 && leftovers.length === 0 && this.server.exited();
    if (clean) this.effects.remove(this.id.root);
    return { clean, server, captured, leftovers, notes, ...(clean ? {} : { preserved: this.id.root }) };
  }
}

// ── Real effects (procfs, execFile) ──────────────────────────────────────────

export function procStartTime(pid: number): number | undefined {
  try { return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]) || undefined; } catch { return undefined; }
}
function holdsSocket(pid: number, socketPath: string): boolean {
  try {
    // The server's own netns view: the fixture runs in a private network namespace.
    const inodes = new Set(readFileSync(`/proc/${pid}/net/unix`, "utf8").split("\n").slice(1).map(line => line.trim().split(/\s+/))
      .filter(f => f[7] === socketPath && f[5] === "01").map(f => f[6]));
    return readdirSync(`/proc/${pid}/fd`).some(fd => { try { return inodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1] ?? ""); } catch { return false; } });
  } catch { return false; }
}
/**
 * Exact inventory from one procfs snapshot: processes carrying this fixture's unique
 * marker, plus the server and its descendants. The server PID seeds only while it still
 * has its original start identity; a descendant cannot predate its parent. A reused PID
 * therefore never pulls an unrelated process tree into teardown.
 */
export function ownedProcesses(table: ReadonlyMap<number, ProcFact>, server: { pid: number; startTime: number }): ProcessIdentity[] {
  const owned = new Set<number>([...table].filter(([pid, p]) => p.marked || (pid === server.pid && server.startTime > 0 && p.startTime === server.startTime)).map(([pid]) => pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of table) if (!owned.has(pid) && owned.has(p.ppid) && p.startTime >= table.get(p.ppid)!.startTime) { owned.add(pid); grew = true; }
  }
  return [...owned].map(pid => ({ pid, startTime: table.get(pid)!.startTime, argv: table.get(pid)!.argv }));
}
function fixtureProcesses(root: string, server: { pid: number; startTime: number }): ProcessIdentity[] {
  const table = new Map<number, ProcFact>();
  for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    const pid = Number(name);
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
      let marked = false;
      try { marked = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`H11_FIXTURE=${root}`); } catch { /* not ours */ }
      table.set(pid, { ppid: Number(fields[1]), startTime: Number(fields[19]), marked, argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").slice(0, 200) });
    } catch { /* exited during scan */ }
  }
  return ownedProcesses(table, server);
}
export function realEffects(herdrBin: string): LiveEffects {
  return {
    exec: (args, env, timeoutMs) => new Promise((resolvePromise, reject) => {
      execFile(herdrBin, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout, stderr) => {
        if (error) reject(new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${String(stderr || stdout).slice(0, 400)}`)); else resolvePromise(stdout);
      });
    }),
    startTime: procStartTime, holdsSocket, processes: fixtureProcesses,
    netns: pid => { try { return readlinkSync(`/proc/${pid}/ns/net`); } catch { return undefined; } },
    signal: (pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } },
    remove: path => rmSync(path, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** Ambient herdr servers and the real session registry, compared read-only (clients such as remote bridges come and go). */
export function ambientSnapshot(root: string): string {
  const procs = readdirSync("/proc").filter(n => /^\d+$/.test(n)).flatMap(name => {
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (!/(^|\/)herdr$/.test(argv[0] ?? "") || !argv.slice(1).includes("server") || readFileSync(`/proc/${name}/environ`, "utf8").includes(`H11_FIXTURE=${root}`)) return [];
      return [`${name}:${procStartTime(Number(name))}:${argv.join(" ")}`];
    } catch { return []; }
  }).sort();
  let sessions: string[] = [];
  try { sessions = readdirSync(join(userInfo().homedir, ".config", "herdr", "sessions")).sort(); } catch { /* none */ }
  return JSON.stringify({ procs, sessions });
}

export interface LiveConfig { piRoot: string; worktree: string; herdrBin: string; integration: string }
const PRIVATE_NET = ["unshare", "--user", "--map-root-user", "--net"];
/** Fails as blocked, never skipped, when unprivileged user+network namespaces are unavailable. */
export function assertPrivateNetworkNamespace(): void {
  try { execFileSync(PRIVATE_NET[0], [...PRIVATE_NET.slice(1), "true"], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000, stdio: "pipe" }); }
  catch (e) { throw new Error(`H11 blocked: private network namespace unavailable (${PRIVATE_NET.join(" ")}): ${String((e as { stderr?: unknown }).stderr ?? e).slice(0, 300)}`); }
}
/** The package's declared CLI, exactly what an installed `pi` executes. */
export function piEntry(piRoot: string): string {
  const bin = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).bin;
  return realpathSync(join(piRoot, typeof bin === "string" ? bin : bin.pi));
}
export function writePiWrapper(binDir: string, piRoot: string): void {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(binDir, "pi"), `#!/bin/sh\nexec ${process.execPath} ${piEntry(piRoot)} "$@"\n`); chmodSync(join(binDir, "pi"), 0o755);
}
/** Private settings: worktree package once, faux fixture, read-only installed herdr integration. */
export function writeFixtureFiles(id: LiveIdentity, cfg: LiveConfig): void {
  const r = id.root;
  for (const d of ["home/.pi/agent/extensions/conductor", "c/herdr", "d", "s", "k", "r", "tmp", "bin", "work", "script", "obs", "pads"]) mkdirSync(join(r, d), { recursive: true, mode: 0o700 });
  writeFileSync(join(r, "c/herdr/config.toml"), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
  writePiWrapper(join(r, "bin"), cfg.piRoot);
  symlinkSync(process.execPath, join(r, "bin/node"));
  symlinkSync(cfg.herdrBin, join(r, "bin/herdr"));
  writeFileSync(join(r, "home/.gitconfig"), "[user]\n\tname = H11 Fixture\n\temail = h11@example.invalid\n[init]\n\tdefaultBranch = main\n");
  writeFileSync(join(r, "home/.pi/agent/settings.json"), JSON.stringify({
    defaultProvider: "faux", defaultModel: "h11-offline", quietStartup: true, enableInstallTelemetry: false,
    cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 1024 },
    packages: [cfg.worktree], extensions: [join(cfg.worktree, "tests/fixtures/herdr-faux-provider.ts"), cfg.integration],
  }, null, 2));
  writeFileSync(join(r, "home/.pi/agent/extensions/conductor/config.json"), JSON.stringify({
    contextRetirement: true, chains: { builder: { then: "" }, simplifier: { then: "" } },
    // N5: the only delegator, opted in by override; no builtin persona declares agents.
    personaOverrides: { analyst: { model: "faux/h11-small" }, investigator: { agents: ["inspector", "critic"] } },
    efforts: { verify: "sh verify.sh", verifyTimeoutSeconds: 60, verifyRetries: 0, generated: { paths: ["gen/**"], command: "sh gen.sh" }, maxParallel: 1 },
  }, null, 2));
}

export async function startLiveFixture(cfg: LiveConfig, unique: string, parent: string): Promise<HerdrLiveFixture> {
  refuseInheritedTarget(process.env);
  assertPrivateNetworkNamespace();
  const id = planLiveIdentity(realpathSync(parent), unique);
  writeFixtureFiles(id, cfg);
  const effects = realEffects(cfg.herdrBin), env = fixtureEnv(id);
  const log = openSync(join(id.root, "server.log"), "a");
  const argv = [...PRIVATE_NET, cfg.herdrBin, "--session", id.name, "server"];
  const child = spawn(argv[0], argv.slice(1), { env, cwd: join(id.root, "work"), stdio: ["ignore", log, log] });
  let done = false;
  const exited = new Promise<void>(res => child.once("exit", () => { done = true; res(); }));
  const server: ServerHandle = { pid: child.pid!, startTime: 0, exited: () => done,
    wait: async ms => done || await Promise.race([exited.then(() => true), delay(ms).then(() => false)]) };
  for (let i = 0; i < 100 && !server.startTime; i++) { server.startTime = procStartTime(child.pid!) ?? 0; if (!server.startTime) await delay(10); }
  const fixture = new HerdrLiveFixture(id, server, effects);
  for (let i = 0; i < 200; i++) {
    if (done) break;
    if (existsSync(id.socketPath)) { try { await fixture.prove(); return fixture; } catch { /* not ready */ } }
    await delay(50);
  }
  const report = await fixture.teardown(5000);
  throw new Error(`H11 private herdr server did not become ready; evidence ${report.preserved ?? "removed"}: ${report.notes.join("; ")}`);
}
