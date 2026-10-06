/**
 * M6a crash recovery: a real lead process (tests/helpers/merger-crash-probe.ts) with the production
 * launcher and a native Pi 0.87.1 merger is SIGKILLed at a named durable boundary; a fresh registry
 * then runs startup reconcile and effort recovery. Private repositories only. Cleanup signals only
 * identities captured before the crash: the probe's own handle, the merger Pi PID/start and the
 * merger's bash group (its own session); unproven exits keep the fixture as evidence.
 */
// First import: throws on an inherited herdr scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { git } from "./helpers/effort-integration.ts";
import { fakeMergers, trailerCount } from "./helpers/effort-merger.ts";
import { bundleNativeMerger } from "./helpers/native-merger-bundle.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { readEffort } from "../src/effort/store.ts";
import { linuxProcesses, stopOwnedProcessGroup } from "../src/effort/process-group.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { RunRegistry, runsRoot, sendToRun } from "../src/runs.ts";
import type { Run } from "../src/types.ts";

sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("m6a-crash-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());
let bundled: Promise<string> | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Identity { pid: number; startTime: number }
const observed = (pid: number) => linuxProcesses().find(p => p.pid === pid);
/** The captured process no longer executes: absent, reused PID, or a zombie. */
const gone = (id: Identity) => { const p = observed(id.pid); return !p || p.startTime !== id.startTime || p.state === "Z" || p.state === "X"; };
function identify(pid: number | undefined): Identity | undefined {
  const p = pid ? observed(pid) : undefined;
  return p && p.state !== "Z" && p.state !== "X" ? { pid: p.pid, startTime: p.startTime } : undefined;
}

/** Signals only the captured identities; returns what it could not prove exited. */
async function reap(owned: { pi?: Identity; hold?: Identity }): Promise<string[]> {
  const unproven: string[] = [];
  if (owned.hold) {
    try { await stopOwnedProcessGroup(owned.hold); }
    catch (error) { unproven.push(`hold group ${owned.hold.pid}: ${(error as Error).message}`); }
  }
  if (owned.pi) {
    if (!gone(owned.pi)) { try { process.kill(owned.pi.pid, "SIGKILL"); } catch { /* exited between check and signal */ } }
    const end = Date.now() + 3000;
    while (!gone(owned.pi) && Date.now() < end) await delay(25);
    if (!gone(owned.pi)) unproven.push(`merger pi ${owned.pi.pid}/${owned.pi.startTime} still executing`);
  }
  return unproven;
}

interface Barrier { writer: string; merger?: string; mergerPid?: number; candidate?: string; landed: string }
async function crash(t: test.TestContext, phase: string, scenario: string) {
  process.env.PI_BIN = await (bundled ??= bundleNativeMerger(root, line => t.diagnostic(line)));
  const cwd = tmpDir("m6a-crash-repo-");
  // Not tmpDir: removed only once every owned process is proven gone.
  const fixture = mkdtempSync(join(tmpdir(), "m6a-crash-fixture-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "original\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD"), index = readFileSync(join(cwd, ".git", "index")), delivery = join(cwd, ".git", "probe-delivery");
  const probe = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/merger-crash-probe.ts", import.meta.url)), cwd, phase, delivery], {
    env: gitTestEnv({ M6A_FIXTURE: fixture, M6A_MERGER_SCENARIO: scenario }), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exit = once(probe, "exit"); let stderr = ""; probe.stderr!.on("data", d => { stderr += d; });
  const owned: { pi?: Identity; hold?: Identity } = {};
  t.after(async () => {
    if (probe.exitCode === null && probe.signalCode === null) { probe.kill("SIGKILL"); await exit; }
    const unproven = await reap(owned);
    if (unproven.length) { t.diagnostic(`fixture preserved as evidence: ${fixture}`); throw new Error(`owned fixture processes not proven exited: ${unproven.join("; ")}`); }
    rmSync(fixture, { recursive: true, force: true });
  });
  const [message] = await Promise.race([once(probe, "message"), exit.then(() => { throw new Error(`probe exited before its barrier: ${stderr}`); })]) as [Barrier];
  // Identities are captured while the lead still holds its children, before the crash.
  owned.pi = identify(message.mergerPid);
  if (existsSync(join(fixture, "hold-pid"))) {
    const pid = Number(readFileSync(join(fixture, "hold-pid"), "utf8")), p = observed(pid);
    assert.ok(p && p.pgid === pid && p.sid === pid, "the merger's bash hold runs as its own session and group leader");
    owned.hold = { pid, startTime: p.startTime };
  }
  probe.kill("SIGKILL"); await exit; assert.equal(probe.signalCode, "SIGKILL");
  const registry = new RunRegistry(), relaunch = fakeMergers(registry), cards: Run[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, selfSessionId: "recovered", now: Date.now() });
  const recover = (resume = false) => recoverEffort(readEffort(cwd, "probe")!, { registry, sessionId: "recovered", onComplete: r => cards.push(r), resume });
  const untouched = () => { assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index, "main checkout untouched"); };
  return { cwd, fixture, delivery, message, owned, registry, relaunch, cards, recover, untouched, wal: JSON.parse(readFileSync(message.writer, "utf8")) };
}

for (const phase of ["after-claim", "before-outcome", "after-proposal", "after-cas"] as const) test(`M6a crash ${phase}: recovery never relaunches, integrates at most once and dispatches at most once`, { timeout: 60000 }, async t => {
  const c = await crash(t, phase, phase === "after-proposal" ? "commit-hold" : "resolve");
  const { cwd, message, registry, cards } = c;
  assert.equal(c.wal.status, "integrating");
  assert.equal(c.wal.integration.merger?.outcome, phase === "after-cas" ? "accepted" : undefined, "durable outcome state matches the boundary");
  if (phase === "after-proposal") {
    assert.ok(c.owned.pi && !gone(c.owned.pi), "the orphaned merger still holds after the lead died");
    assert.ok(c.owned.hold && !gone(c.owned.hold), "and so does its own bash hold group");
    const proposal = git(message.candidate!, "rev-parse", "HEAD");
    assert.notEqual(proposal, message.landed, "a valid-looking proposal is committed");
    await (await c.recover()).done;
    const held = registry.get("builder-crash")!;
    assert.equal(held.integration!.state, "resolving"); assert.match(held.integration!.reason!, /live or unknown.*no signal sent/);
    assert.equal(readEffort(cwd, "probe")!.status, "paused"); assert.ok(!gone(c.owned.pi!) && !gone(c.owned.hold!), "recovery sent no signal"); assert.equal(cards.length, 0);
    writeFileSync(join(c.fixture, "release"), "go");
    const end = Date.now() + 15000; while (!gone(c.owned.hold!) && Date.now() < end) await delay(25);
    assert.ok(gone(c.owned.hold!), "the released hold loop exited by itself");
    assert.deepEqual(await reap(c.owned), [], "the orphaned merger Pi is stopped by its captured identity");
    await (await c.recover(true)).done;
    const writer = registry.get("builder-crash")!;
    assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /merger killed/);
    assert.match(JSON.parse(readFileSync(join(runsRoot(), message.merger!, "record.json"), "utf8")).errorMessage, /lost merger/);
    assert.equal(git(cwd, "rev-parse", "conductor-int/probe"), message.landed, "a lost merger's proposal is never authority");
    assert.equal(git(message.candidate!, "rev-parse", "HEAD"), proposal, "its proposal is preserved");
  } else {
    await (await c.recover()).done;
    const writer = registry.get("builder-crash")!;
    const tip = git(cwd, "rev-parse", "conductor-int/probe");
    if (phase === "after-claim") {
      assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /launch uncertain/);
      assert.equal(tip, message.landed);
    } else {
      assert.equal(writer.status, "completed", writer.errorMessage);
      assert.equal(git(cwd, "rev-list", "--count", `${message.landed}..${tip}`), "1", "exactly one integration");
      assert.equal(trailerCount(cwd, tip, `Conductor-Merger: ${message.merger}`), 1);
      assert.equal(writer.integration!.merger!.cost, 0.02);
    }
    await (await c.recover()).done;
  }
  assert.equal(cards.length, 1, "one callback across repeated recovery"); assert.equal(c.relaunch.calls.length, 0, "no second merger launch");
  assert.equal(existsSync(c.delivery), false, "the crashed lead dispatched nothing");
  c.untouched();
});

test("M6a crash after-proposal forced failure: cleanup stops the merger Pi and its bash hold group by captured identity", { timeout: 60000 }, async t => {
  const c = await crash(t, "after-proposal", "commit-hold");
  assert.ok(c.owned.pi && c.owned.hold, "both identities were captured before the crash");
  assert.ok(!gone(c.owned.pi) && !gone(c.owned.hold), "without a release both outlive the lead's SIGKILL");
  // A failing test never writes the release file: its cleanup alone must stop what it started.
  assert.deepEqual(await reap(c.owned), []);
  assert.ok(gone(c.owned.pi) && gone(c.owned.hold));
  assert.deepEqual(linuxProcesses().filter(p => p.pgid === c.owned.hold!.pid && p.state !== "Z"), [], "no member of the hold group still executes");
});

test("M6a native reload with a blocked merger: the new owner's answer resumes it in its candidate and integrates once; a foreign session is refused", { timeout: 60000 }, async t => {
  const c = await crash(t, "blocked", "ask");
  const { cwd, message, registry, cards } = c;
  const merger = registry.get(message.merger!)!;
  // The resumed merger is this process's own child: stop it by its handle if the test fails early.
  t.after(() => { if (merger.proc && merger.proc.exitCode === null && merger.proc.signalCode === null) merger.proc.kill("SIGKILL"); });
  assert.equal(merger.status, "blocked", "startup reconcile restored the blocked merger");
  const { done } = await c.recover();
  const writer = registry.get("builder-crash")!;
  const end = Date.now() + 10000; while (merger.mergerFor?.owner.sessionId !== "recovered" && Date.now() < end) await delay(20);
  assert.equal(writer.integration!.state, "resolving"); assert.equal(merger.mergerFor!.owner.sessionId, "recovered", "recovery handed the merger to the new owner");
  const foreign = sendToRun(merger, "Keep writer first.", { registry, timeoutMs: 30000, sessionId: "intruder" });
  assert.equal(foreign.kind, "rejected"); assert.match((foreign as { reason: string }).reason, /cannot send to effort probe/);
  const saved = { fixture: process.env.M6A_FIXTURE, scenario: process.env.M6A_MERGER_SCENARIO };
  process.env.M6A_FIXTURE = c.fixture; process.env.M6A_MERGER_SCENARIO = "ask";
  t.after(() => { for (const [k, v] of [["M6A_FIXTURE", saved.fixture], ["M6A_MERGER_SCENARIO", saved.scenario]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const turnsBefore = readdirSync(c.fixture).filter(x => x.startsWith("merger-turn-")).length;
  const answered = sendToRun(merger, "Keep writer first.", { registry, timeoutMs: 30000, sessionId: "recovered" });
  assert.equal(answered.kind, "started", (answered as { reason?: string }).reason);
  await done;
  assert.equal(writer.status, "completed", `${writer.errorMessage} merger=${merger.status}: ${merger.errorMessage}`);
  const tip = git(cwd, "rev-parse", "conductor-int/probe");
  assert.equal(git(cwd, "rev-list", "--count", `${message.landed}..${tip}`), "1", "exactly one integration");
  assert.equal(git(cwd, "show", `${tip}:base`), "writer\nlanded", "the new owner's answer reached the resumed merger");
  for (const trailer of ["Conductor-Effort: probe", "Conductor-Run: builder-crash", `Conductor-Merger: ${merger.id}`]) assert.equal(trailerCount(cwd, tip, trailer), 1, trailer);
  const resumed = readdirSync(c.fixture).filter(x => x.startsWith("merger-turn-")).slice(turnsBefore);
  assert.ok(resumed.length > 0 && resumed.every(x => readFileSync(join(c.fixture, x), "utf8").endsWith(message.candidate!)), "resumed in its preserved candidate");
  await (await c.recover()).done;
  assert.equal(cards.length, 1, "one writer callback across repeated recovery, no merger card");
  assert.equal(c.relaunch.calls.length, 0, "no second merger");
  assert.equal(existsSync(c.delivery), false);
  c.untouched();
});
