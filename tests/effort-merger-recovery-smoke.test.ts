/**
 * M6a crash recovery: a real lead process (tests/helpers/merger-crash-probe.ts) with the production
 * launcher and a native Pi 0.87.1 merger is SIGKILLed at a named durable boundary; a fresh registry
 * then runs startup reconcile and effort recovery. Private repositories only.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { git } from "./helpers/effort-integration.ts";
import { fakeMergers, trailerCount } from "./helpers/effort-merger.ts";
import { assertNoLiveScope, bundleNativeMerger } from "./helpers/native-merger-bundle.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { readEffort } from "../src/effort/store.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { RunRegistry, runsRoot } from "../src/runs.ts";
import type { Run } from "../src/types.ts";

assertNoLiveScope();
sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("m6a-crash-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());
let bundled: Promise<string> | undefined;
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

for (const phase of ["after-claim", "before-outcome", "after-proposal", "after-cas"] as const) test(`M6a crash ${phase}: recovery never relaunches, integrates at most once and dispatches at most once`, { timeout: 60000 }, async t => {
  process.env.PI_BIN = await (bundled ??= bundleNativeMerger(root, line => t.diagnostic(line)));
  const cwd = tmpDir("m6a-crash-repo-"), fixture = tmpDir("m6a-crash-fixture-");
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "original\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  const base = git(cwd, "rev-parse", "HEAD"), index = readFileSync(join(cwd, ".git", "index")), delivery = join(cwd, ".git", "probe-delivery");
  const probe = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/merger-crash-probe.ts", import.meta.url)), cwd, phase, delivery], {
    env: gitTestEnv({ M6A_FIXTURE: fixture, M6A_MERGER_SCENARIO: phase === "after-proposal" ? "commit-hold" : "resolve" }), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exit = once(probe, "exit"); let stderr = ""; probe.stderr!.on("data", d => { stderr += d; });
  let mergerPid: number | undefined;
  t.after(async () => {
    if (probe.exitCode === null && probe.signalCode === null) { probe.kill("SIGKILL"); await exit; }
    if (alive(mergerPid)) process.kill(mergerPid!, "SIGKILL");
  });
  const [message] = await Promise.race([once(probe, "message"), exit.then(() => { throw new Error(`probe exited before its barrier: ${stderr}`); })]) as [{ writer: string; merger?: string; mergerPid?: number; candidate?: string; landed: string }];
  mergerPid = message.mergerPid;
  probe.kill("SIGKILL"); await exit; assert.equal(probe.signalCode, "SIGKILL");
  const wal = JSON.parse(readFileSync(message.writer, "utf8"));
  assert.equal(wal.status, "integrating");
  assert.equal(wal.integration.merger?.outcome, phase === "after-cas" ? "accepted" : undefined, "durable outcome state matches the boundary");

  const registry = new RunRegistry(), relaunch = fakeMergers(registry), cards: Run[] = [];
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: pid => alive(pid), selfSessionId: "recovered", now: Date.now() });
  const recover = async (resume = false) => (await recoverEffort(readEffort(cwd, "probe")!, { registry, sessionId: "recovered", onComplete: r => cards.push(r), resume })).done;
  if (phase === "after-proposal") {
    assert.ok(alive(mergerPid), "the orphaned merger still holds after the lead died");
    const proposal = git(message.candidate!, "rev-parse", "HEAD");
    assert.notEqual(proposal, message.landed, "a valid-looking proposal is committed");
    await recover();
    const held = registry.get("builder-crash")!;
    assert.equal(held.integration!.state, "resolving"); assert.match(held.integration!.reason!, /live or unknown.*no signal sent/);
    assert.equal(readEffort(cwd, "probe")!.status, "paused"); assert.ok(alive(mergerPid), "recovery sent no signal"); assert.equal(cards.length, 0);
    writeFileSync(join(fixture, "release"), "go");
    const end = Date.now() + 15000; while (alive(mergerPid) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
    if (alive(mergerPid)) process.kill(mergerPid!, "SIGKILL");
    await recover(true);
    const writer = registry.get("builder-crash")!;
    assert.equal(writer.status, "merge_conflict"); assert.match(writer.integration!.merger!.reason!, /merger killed/);
    assert.match(JSON.parse(readFileSync(join(runsRoot(), message.merger!, "record.json"), "utf8")).errorMessage, /lost merger/);
    assert.equal(git(cwd, "rev-parse", "conductor-int/probe"), message.landed, "a lost merger's proposal is never authority");
    assert.equal(git(message.candidate!, "rev-parse", "HEAD"), proposal, "its proposal is preserved");
  } else {
    await recover();
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
    await recover();
  }
  assert.equal(cards.length, 1, "one callback across repeated recovery"); assert.equal(relaunch.calls.length, 0, "no second merger launch");
  assert.equal(existsSync(delivery), false, "the crashed lead dispatched nothing");
  assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index, "main checkout untouched");
});
