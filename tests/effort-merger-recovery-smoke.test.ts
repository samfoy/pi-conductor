/**
 * M6a crash recovery: a real lead process (tests/helpers/merger-crash-probe.ts) with the production
 * launcher and a native Pi 0.87.1 merger is SIGKILLed at a named durable boundary; a fresh registry
 * then runs startup reconcile and effort recovery. Private repositories only. The shared fixture
 * (tests/helpers/merger-crash.ts) signals only identities captured before the crash and keeps its
 * whole root as evidence whenever any owned process is unknown or not proven exited.
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
import { trailerCount } from "./helpers/effort-merger.ts";
import { crash, delay, gone, nativeCrashRoot, reap, type Identity } from "./helpers/merger-crash.ts";
import { readEffort } from "../src/effort/store.ts";
import { linuxProcesses } from "../src/effort/process-group.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { runsRoot, sendToRun } from "../src/runs.ts";

const root = nativeCrashRoot();
after(() => stop());

for (const phase of ["after-claim", "before-outcome", "after-proposal", "after-cas"] as const) test(`M6a crash ${phase}: recovery never relaunches, integrates at most once and dispatches at most once`, { timeout: 60000 }, async t => {
  const c = await crash(t, root, phase, phase === "after-proposal" ? "commit-hold" : "resolve");
  const { cwd, message, registry, cards } = c;
  assert.equal(c.wal.status, "integrating");
  assert.equal(c.wal.integration.merger?.outcome, phase === "after-cas" ? "accepted" : undefined, "durable outcome state matches the boundary");
  if (phase === "after-proposal") {
    assert.equal(c.owned.pi.length, 1); assert.ok(!gone(c.owned.pi[0]!), "the orphaned merger still holds after the lead died");
    assert.ok(c.owned.hold && !gone(c.owned.hold), "and so does its own bash hold group");
    const proposal = git(message.candidate!, "rev-parse", "HEAD");
    assert.notEqual(proposal, message.landed, "a valid-looking proposal is committed");
    await (await c.recover()).done;
    const held = registry.get("builder-crash")!;
    assert.equal(held.integration!.state, "resolving"); assert.match(held.integration!.reason!, /live or unknown.*no signal sent/);
    assert.equal(readEffort(cwd, "probe")!.status, "paused"); assert.ok(!gone(c.owned.pi[0]!) && !gone(c.owned.hold!), "recovery sent no signal"); assert.deepEqual(c.owned.signals, []); assert.equal(cards.length, 0);
    writeFileSync(join(c.fixture, "release"), "go");
    const end = Date.now() + 15000; while (!gone(c.owned.hold!) && Date.now() < end) await delay(25);
    assert.ok(gone(c.owned.hold!), "the released hold loop exited by itself");
    assert.equal(readFileSync(join(c.fixture, "hold-exit"), "utf8").trim(), "released", "a cooperative exit, not a signal");
    assert.deepEqual(await reap(c.fixture, c.owned), [], "the orphaned merger Pi is stopped by its captured identity");
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
  const c = await crash(t, root, "after-proposal", "commit-hold");
  assert.ok(c.owned.pi.length === 1 && c.owned.hold, "both identities were captured before the crash");
  assert.ok(!gone(c.owned.pi[0]!) && !gone(c.owned.hold), "without a release both outlive the lead's SIGKILL");
  // A failing test never writes the release file: its cleanup alone must stop what it started.
  assert.deepEqual(await reap(c.fixture, c.owned), []);
  assert.ok(gone(c.owned.pi[0]!) && gone(c.owned.hold));
  assert.equal(existsSync(join(c.fixture, "hold-exit")), false, "the hold group was stopped by its proven identity, not released");
  assert.deepEqual(linuxProcesses().filter(p => p.pgid === c.owned.hold!.pid && p.state !== "Z"), [], "no member of the hold group still executes");
});

test("M6a native reload with a blocked merger: the new owner's answer resumes it in its candidate and integrates once; a foreign session is refused", { timeout: 60000 }, async t => {
  const c = await crash(t, root, "blocked", "ask");
  const { cwd, message, registry, cards } = c;
  const merger = registry.get(message.merger!)!;
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
  // The resumed merger is this process's own unreaped child: the fixture cleanup owns its identity.
  if (merger.pid) c.owned.pi.push({ pid: merger.pid, startTime: readProcessStartTime(merger.pid)! });
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


const CHILD = fileURLToPath(new URL("./helpers/merger-cleanup-fault.ts", import.meta.url));
for (const fault of ["none", "leader", "no-barrier"] as const) test(fault === "none"
  ? "M6a crash cleanup with every identity proven stops them and removes its fixture root"
  : `M6a crash cleanup with an unproven ${fault} state keeps its fixture root after the test process exits and signals nothing unknown`, { timeout: 120000 }, async t => {
  // Not tmpDir: the parent removes this only after proving everything quiescent.
  const parent = mkdtempSync(join(tmpdir(), "m6a-cleanup-regression-")), fixture = join(parent, "fixture");
  const env: NodeJS.ProcessEnv = { ...process.env, M6A_CRASH_FIXTURE: fixture, M6A_CLEANUP_FAULT: fault };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", CHILD], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
  let output = ""; child.stdout!.on("data", d => { output += d; }); child.stderr!.on("data", d => { output += d; });
  const [code] = await exited;
  const retained = existsSync(fixture);
  let childRelease: string | undefined;
  try { childRelease = readFileSync(join(fixture, "release"), "utf8").trim(); } catch { /* Capture missing evidence without skipping safety cleanup. */ }
  let childReleasedHold = false;
  if (fault !== "none") {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      try { childReleasedHold = readFileSync(join(fixture, "hold-exit"), "utf8").trim() === "released"; } catch { /* The hold may still be exiting. */ }
      if (childReleasedHold) break;
      await delay(25);
    }
  }
  // Run the safety net before assertions, but never count it as the child's cleanup evidence.
  mkdirSync(fixture, { recursive: true }); writeFileSync(join(fixture, "release"), "parent");
  if (fault !== "none") { const end = Date.now() + 15000; while (!existsSync(join(fixture, "hold-exit")) && Date.now() < end) await delay(25); }
  if (fault !== "none") {
    assert.equal(retained, true, "the fixture root was retained after the child process exited");
    assert.equal(childRelease, "cleanup: unproven state", "the child's own cleanup wrote the release");
    assert.equal(childReleasedHold, true, "the hold exited cooperatively before the parent's safety release");
    assert.equal(readFileSync(join(fixture, "hold-exit"), "utf8").trim(), "released", "the hold ended cooperatively on its release file, never by a signal");
  }
  const report = JSON.parse(readFileSync(`${fixture}.cleanup.json`, "utf8")) as { problems: string[]; unknown: string[]; pi: Identity[]; hold?: Identity; signals: { target: number; signal: string }[] };
  t.diagnostic(`${fault}: child exit=${code} retained=${retained} unknown=${JSON.stringify(report.unknown)} signals=${JSON.stringify(report.signals)} pi=${JSON.stringify(report.pi)} hold=${JSON.stringify(report.hold)}`);
  const known = new Set([...report.pi.map(p => p.pid), ...(report.hold ? [-report.hold.pid] : [])]);
  assert.ok(report.signals.every(s => known.has(s.target)), `only proven identities were signalled: ${JSON.stringify(report.signals)}`);
  for (const pi of report.pi) assert.ok(gone(pi), `merger pi ${pi.pid} no longer executes`);
  if (fault === "none") {
    assert.equal(code, 0, output);
    assert.equal(retained, false, "a proven cleanup removed its whole fixture root");
    assert.deepEqual(report.problems, []); assert.ok(report.hold && gone(report.hold), "the hold group was stopped by its proven identity");
    assert.ok(report.signals.some(s => s.target === -report.hold!.pid), "the proven hold group was the one signalled");
  } else {
    assert.notEqual(code, 0, "the child test failed truthfully");
    assert.match(output, /fixture preserved as evidence/);
    assert.match(report.unknown.join("\n"), fault === "leader" ? /leadership unproven; not signalled/ : /barrier not reached/);
    assert.equal(report.hold, undefined, "the unproven hold was never treated as owned");
    const [pid, startTime] = readFileSync(join(fixture, "hold-pid"), "utf8").trim().split(" ").map(Number);
    assert.ok(gone({ pid: pid!, startTime: startTime! }), "the hold's self-recorded identity no longer executes");
    assert.ok(report.signals.every(s => s.target !== pid && s.target !== -pid!), "the unknown hold was never signalled");
    for (const name of ["probe.log", "cleanup.json", "repo", "hold-pid"]) assert.ok(existsSync(join(fixture, name)), `retained ${name}`);
  }
  rmSync(parent, { recursive: true, force: true });
});
