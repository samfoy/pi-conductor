// M6a crash fixture shared by tests/effort-merger-recovery-smoke.test.ts and its cleanup-fault
// child: a real lead (merger-crash-probe.ts) with a native merger, SIGKILLed at a durable barrier.
// Importers must import ./no-live-scope.ts first. Cleanup signals only identities proven before
// the crash; anything it cannot prove quiescent keeps the whole fixture root and fails the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "./effort-integration.ts";
import { fakeMergers } from "./effort-merger.ts";
import { bundleNativeMerger } from "./native-merger-bundle.ts";
import { gitTestEnv } from "./git-env.ts";
import { sandboxPi, tmpDir } from "./tmp.ts";
import { recoverEffort } from "../../src/effort/reconcile.ts";
import { readEffort } from "../../src/effort/store.ts";
import { linuxProcesses, stopOwnedProcessGroup, type GroupProcess } from "../../src/effort/process-group.ts";
import { reconcileOrphansAtStartup } from "../../src/reconcile-startup.ts";
import { RunRegistry, runsRoot } from "../../src/runs.ts";
import type { Run } from "../../src/types.ts";

export interface Identity { pid: number; startTime: number }
export interface Owned { pi: Identity[]; hold?: Identity; unknown: string[]; signals: { target: number; signal: string }[] }
interface Barrier { writer: string; merger?: string; mergerPid?: number; candidate?: string; landed: string }

export const BARRIER_PENDING = "barrier not reached: a launched merger or its bash hold may still be running";
export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const observed = (pid: number) => linuxProcesses().find(p => p.pid === pid);
/** The captured process no longer executes: absent, reused PID, or a zombie. */
export const gone = (id: Identity) => { const p = observed(id.pid); return !p || p.startTime !== id.startTime || p.state === "Z" || p.state === "X"; };
const leads = (p: GroupProcess) => p.pgid === p.pid && p.sid === p.pid;

/** Module-level setup for a file that runs crashes: private HOME, offline faux Pi settings. */
export function nativeCrashRoot(): string {
  sandboxPi();
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
  const root = tmpDir("m6a-crash-");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
  return root;
}

/** Cooperative release first when anything is unproven; signals only proven identities. Returns what is not proven quiescent. */
export async function reap(fixture: string, owned: Owned): Promise<string[]> {
  const problems = [...owned.unknown];
  // A fixture hold, known or not, ends itself on its own release file: no signal needed.
  if (problems.length) writeFileSync(join(fixture, "release"), "cleanup: unproven state");
  const signal = (pid: number, sig: NodeJS.Signals | 0) => { if (sig) owned.signals.push({ target: pid, signal: sig }); return process.kill(pid, sig); };
  if (owned.hold) {
    try { await stopOwnedProcessGroup(owned.hold, { signal }); }
    catch (error) { problems.push(`hold group ${owned.hold.pid}: ${(error as Error).message}`); }
  }
  for (const pi of owned.pi) {
    if (!gone(pi)) { try { signal(pi.pid, "SIGKILL"); } catch { /* exited between check and signal */ } }
    const end = Date.now() + 3000;
    while (!gone(pi) && Date.now() < end) await delay(25);
    if (!gone(pi)) problems.push(`merger pi ${pi.pid}/${pi.startTime} still executing`);
  }
  return problems;
}

/** Account for every launch and hold the barrier covers, before anything can throw. */
function classify(fixture: string, owned: Owned, message: Barrier, leader: (p: GroupProcess) => boolean): void {
  try {
    if (message.mergerPid && !owned.pi.some(p => p.pid === message.mergerPid)) owned.unknown.push(`merger pid ${message.mergerPid} has no launch report`);
    const file = join(fixture, "hold-pid");
    if (existsSync(`${file}.tmp`) && !existsSync(file)) owned.unknown.push("hold identity was still being written");
    if (existsSync(file)) {
      const [pid, startTime] = readFileSync(file, "utf8").trim().split(" ").map(Number);
      const p = Number.isSafeInteger(pid) && Number.isSafeInteger(startTime) ? observed(pid!) : undefined;
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startTime)) owned.unknown.push(`hold identity unreadable: ${readFileSync(file, "utf8")}`);
      // Absent or a different start time: the recorded hold no longer executes.
      else if (p && p.startTime === startTime && p.state !== "Z" && p.state !== "X") {
        if (leader(p)) owned.hold = { pid: pid!, startTime: startTime! };
        else owned.unknown.push(`hold ${pid}/${startTime}: own session/group leadership unproven; not signalled`);
      }
    }
    owned.unknown.splice(owned.unknown.indexOf(BARRIER_PENDING), 1);
  } catch (error) { owned.unknown.push(`classification failed: ${(error as Error).message}`); throw error; }
}

let bundled: Promise<string> | undefined;
export async function crash(t: TestContext, root: string, phase: string, scenario: string, opts: { leader?: (p: GroupProcess) => boolean; failBeforeBarrier?: boolean } = {}) {
  process.env.PI_BIN = await (bundled ??= bundleNativeMerger(root, line => t.diagnostic(line)));
  // The whole root (repo, probe log, hold files) is retained unless cleanup proves it quiescent.
  const exact = process.env.M6A_CRASH_FIXTURE;
  const fixture = exact ? (mkdirSync(exact), exact) : mkdtempSync(join(tmpdir(), "m6a-crash-fixture-"));
  const owned: Owned = { pi: [], unknown: [BARRIER_PENDING], signals: [] };
  const cwd = join(fixture, "repo"); mkdirSync(cwd);
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "original\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD"), index = readFileSync(join(cwd, ".git", "index")), delivery = join(cwd, ".git", "probe-delivery");
  const probe = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./merger-crash-probe.ts", import.meta.url)), cwd, phase, delivery], {
    env: gitTestEnv({ M6A_FIXTURE: fixture, M6A_MERGER_SCENARIO: scenario }), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exit = once(probe, "exit");
  writeFileSync(join(fixture, "probe.log"), "");
  probe.stderr!.on("data", d => appendFileSync(join(fixture, "probe.log"), d));
  let arrived!: (message: Barrier) => void;
  const barrier = new Promise<Barrier>(resolve => { arrived = resolve; });
  probe.on("message", (m: { launched?: Identity } & Partial<Barrier>) => { if (m.launched) owned.pi.push(m.launched); else if (m.writer) arrived(m as Barrier); });
  t.after(async () => {
    if (probe.exitCode === null && probe.signalCode === null) { probe.kill("SIGKILL"); await exit; }
    const problems = await reap(fixture, owned);
    const report = JSON.stringify({ fixture, problems, unknown: owned.unknown, pi: owned.pi, hold: owned.hold, signals: owned.signals }, null, 2);
    writeFileSync(join(fixture, "cleanup.json"), report);
    if (exact) writeFileSync(`${exact}.cleanup.json`, report);
    if (problems.length) {
      t.diagnostic(`fixture preserved as evidence: ${fixture}`);
      throw new Error(`owned fixture state not proven quiescent; fixture preserved at ${fixture}: ${problems.join("; ")}`);
    }
    rmSync(fixture, { recursive: true, force: true });
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`barrier ${phase} not reached within 45 s`)), 45000); });
  const injected = opts.failBeforeBarrier
    ? (async () => { while (!existsSync(join(fixture, "hold-pid")) || !owned.pi.length) await delay(20); throw new Error("injected: the test failed before the barrier arrived; a merger and its bash hold are running"); })()
    : new Promise<never>(() => {});
  const message = await Promise.race([barrier, late, injected,
    exit.then(() => { throw new Error(`probe exited before its barrier: ${existsSync(join(fixture, "probe.log")) ? readFileSync(join(fixture, "probe.log"), "utf8") : ""}`); })]).finally(() => clearTimeout(timer));
  classify(fixture, owned, message, opts.leader ?? leads);
  if (existsSync(join(fixture, "hold-pid"))) assert.ok(owned.hold, "the merger's bash hold runs as its own session and group leader");
  probe.kill("SIGKILL"); await exit; assert.equal(probe.signalCode, "SIGKILL");
  const registry = new RunRegistry(), relaunch = fakeMergers(registry), cards: Run[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, selfSessionId: "recovered", now: Date.now() });
  const recover = (resume = false) => recoverEffort(readEffort(cwd, "probe")!, { registry, sessionId: "recovered", onComplete: r => cards.push(r), resume });
  const untouched = () => { assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index, "main checkout untouched"); };
  return { cwd, fixture, delivery, message, owned, registry, relaunch, cards, recover, untouched, wal: JSON.parse(readFileSync(message.writer, "utf8")) };
}
