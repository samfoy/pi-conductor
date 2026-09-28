import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { RunRegistry, spawnRun, forceTerminate, runsRoot, applyMergeToTerminal } from "../src/runs.ts";
import { reconcileOrphansAtStartup, defaultLivenessProbe } from "../src/reconcile-startup.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import type { Persona } from "../src/types.ts";

const { piBin } = sandboxPi();
writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});\n`);
const persona: Persona = { name: "inspector", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" };

test("H1 native reload: original child and pipeline survive; readoption neither writes nor bypasses original gate", { timeout: 30000 }, async t => {
  const cwd = tmpDir("h1-reload-");
  const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitTestEnv(), timeout: 5000, stdio: "pipe" });
  git(cwd, "init", "-b", "master"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "base"), "base"); git(cwd, "add", "base"); git(cwd, "commit", "-m", "test: base");
  const registry = new RunRegistry();
  let completions = 0;
  const result = spawnRun({ registry, persona, cwd, task: "CONTROL H1_RELOAD", mode: "background", worktree: true, mergeStrategy: "squash", timeoutMs: 20000,
    onCompleteHook: `printf hook >> "${join(cwd, "hook-count")}"`, onComplete: () => completions++ });
  const run = result.run;
  const child = run.proc!;
  let exited = false;
  child.once("exit", () => { exited = true; });
  const closed = once(child, "close");
  t.after(async () => { if (!exited) { forceTerminate(run, "killed", registry); child.kill("SIGKILL"); } await closed; });
  const events: string[] = [];
  await new Promise<void>(resolve => {
    let buffer = "";
    child.stdout!.on("data", chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const e = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        events.push(e.type);
        if (e.type === "probe" && e.point === "before-settle") resolve();
      }
    });
  });
  assert.notEqual(run.timeoutTimer, undefined, "native agent_end must not start finalization or disarm the timeout");
  assert.equal(run.hookExecuting, undefined, "no hook before native settlement");
  writeFileSync(join(run.worktreePath!, "change"), "preserved work");
  git(run.worktreePath!, "add", "change"); git(run.worktreePath!, "commit", "-m", "feat: change");
  const before = readFileSync(run.recordPath, "utf8");
  assert.ok(events.includes("agent_end"));
  assert.ok(!events.includes("agent_settled"));
  assert.equal(run.status, "running", "native agent_end cannot finalize");
  assert.equal(completions, 0);
  assert.equal(existsSync(join(cwd, "hook-count")), false);
  await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer: () => assert.fail("reload reset"), reconcileRunning: () => assert.fail("reload reconciled") });
  assert.equal(exited, false); assert.equal(child.signalCode, null); assert.equal(defaultLivenessProbe(child.pid!), true);
  const restarted = new RunRegistry();
  const recovered = await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry: restarted, isAlive: defaultLivenessProbe, now: Date.now() });
  assert.deepEqual(recovered.readopted, [run.id]);
  assert.equal(readFileSync(run.recordPath, "utf8"), before, "reconcile leaves original pipeline's record intact");
  const adopted = restarted.get(run.id)!;
  assert.equal(await applyMergeToTerminal(adopted, cwd, "completed"), "merge_conflict");
  assert.match(adopted.errorMessage!, /gate.*could not be rebuilt/);
  assert.equal(existsSync(join(cwd, "change")), false);
  child.kill("SIGUSR2");
  await result.done;
  await closed;
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(completions, 1);
  assert.ok(events.includes("agent_settled"), "original stdout subscription keeps observing after reload");
  assert.equal(readFileSync(join(cwd, "hook-count"), "utf8"), "hook");
  assert.equal(readFileSync(join(cwd, "change"), "utf8"), "preserved work");
  assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "completed");
});
