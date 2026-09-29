// Diagnostic checkpoint, not an M5 recovery implementation or an acceptance test.
import test from "node:test";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openEffort } from "../src/effort/open.ts";
import { readEffort } from "../src/effort/store.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import { gitTestEnv } from "../tests/helpers/git-env.ts";
import { sandboxPi, tmpDir } from "../tests/helpers/tmp.ts";
import type { Persona } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe", timeout: 5000,
}).trim();
const self = fileURLToPath(import.meta.url);
const persona: Persona = {
  name: "builder", description: "probe", defaultReads: [], systemPrompt: "Probe",
  inheritContext: "none", inheritSkills: false, worktree: true, timeoutMinutes: 1,
  readOnly: false, source: "builtin", sourcePath: "test",
};

if (process.argv[2] === "--child") {
  const [cwd, phase, deliveryPath] = process.argv.slice(3) as [string, string, string];
  const counter = join(cwd, ".git", "recovery-counter"), release = join(cwd, ".git", "recovery-release");
  const verify = `echo verify >> '${counter}'; ${phase === "verifying" ? `if test -f a && ! test -f '${release}'; then sleep 60; fi; ` : ""}test -f base`;
  const effort = openEffort(cwd, "receipt", "probe-owner", { verify,
    ...(phase === "generating" ? { generated: { paths: ["a"], command: `echo generate >> '${counter}'; if ! test -f '${release}'; then sleep 60; fi; echo built > a` } } : {}),
  });
  let run: import("../src/types.ts").Run;
  const barrier = () => {
    process.send!({ id: run.id, recordPath: run.recordPath, intRef: effort.intRef });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const crashState = (phase === "queued-order" || phase === "resolving") ? "queued" : phase === "changed-source" || phase === "dirty-candidate" || phase === "checked-out" ? "verified" : phase;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    const text = readFileSync(from, "utf8");
    const isRun = run && String(to) === run.recordPath;
    const entry = isRun ? JSON.parse(text).integration : undefined;
    if (phase === "before-intent" && entry?.delivery === "intent") barrier();
    if (phase === "record-write" && entry?.state === "merging") barrier();
    if (phase === "queue-write" && String(to).endsWith("effort.json") && JSON.parse(text).queue?.includes(run?.id)) barrier();
    rename(from, to);
    if ((["queued", "merging", "verified"].includes(crashState) && entry?.state === crashState) ||
        (["generating", "verifying"].includes(phase) && entry?.state === phase && entry?.process && entry.commandPending) ||
        (phase === "unknown-process" && entry?.commandPending && !entry.process) ||
        ((phase === "attempted" || phase === "legacy") && entry?.delivery === "attempted")) barrier();
  };
  const exec = cp.execFileSync;
  cp.execFileSync = ((command: string, args: string[], options: cp.ExecFileSyncOptions) => {
    const result = exec(command, args, options);
    if (phase === "after-cas" && command === "git" && args[0] === "update-ref" && args[1] === effort.intRef && args[3]) barrier();
    return result;
  }) as typeof cp.execFileSync;
  syncBuiltinESMExports();
  const spawned = spawnRun({
    registry: new RunRegistry(), persona, cwd, effort: effort.name,
    parentSessionId: "probe-owner", mode: "background", timeoutMs: 20000,
    task: "CONTROL M4_FILE=a Complete and commit this native faux-provider assignment.",
    onComplete: completed => {
      if (completed.status !== "completed") { console.error(completed.errorMessage ?? completed.status); process.exit(2); }
      if (phase === "after" || phase === "attempted" || phase === "legacy") appendFileSync(deliveryPath, completed.id + "\n");
      if (phase === "before" || phase === "after") barrier();
    },
  });
  run = spawned.run;
} else {
  const { piBin } = sandboxPi();
  writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("../tests/helpers/native-owner-child.ts", import.meta.url).href)});\n`);
  test("diagnostic: native settlement has indistinguishable delivery windows in run/queue/git facts", { timeout: 60000 }, async t => {
    for (const phase of ["before", "after"] as const) {
      const cwd = tmpDir(`m5-receipt-${phase}-`);
      git(cwd, "init", "-b", "main");
      git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
      writeFileSync(join(cwd, "base"), "base\n");
      writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
      git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
      const base = git(cwd, "rev-parse", "HEAD");
      const deliveryPath = join(cwd, ".git", "external-consumer-receipt");
      const child = spawn(process.execPath, ["--import", "tsx", self, "--child", cwd, phase, deliveryPath], {
        env: gitTestEnv(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let exited = false;
      child.once("exit", () => { exited = true; });
      const exit = once(child, "exit");
      let stderr = "";
      child.stderr!.on("data", data => { stderr += data; });
      try {
        const barrier = once(child, "message");
        const message = await Promise.race([
          barrier.then(([value]) => value as { id: string; recordPath: string; intRef: string }),
          exit.then(([code, signal]) => { throw new Error(`probe exited before barrier ${code}/${signal}: ${stderr}`); }),
        ]);
        const rawBefore = readFileSync(message.recordPath, "utf8");
        const record = JSON.parse(rawBefore);
        const effortBefore = readEffort(cwd, "receipt")!;
        assert.deepEqual(effortBefore.queue, []);
        assert.equal(record.status, "completed");
        assert.equal(record.integration.state, "accepted");
        const tip = git(cwd, "rev-parse", message.intRef);
        assert.equal(record.landedCommit, tip);
        assert.equal(git(cwd, "rev-list", "--count", `${base}..${tip}`), "1");
        assert.equal(git(cwd, "show", "-s", "--format=%B", tip).split("\n").filter(line => line === `Conductor-Run: ${message.id}`).length, 1);
        assert.equal(git(cwd, "show", "-s", "--format=%B", tip).split("\n").filter(line => line === "Conductor-Effort: receipt").length, 1);
        const delivered = existsSync(deliveryPath) ? readFileSync(deliveryPath, "utf8").trim().split("\n").length : 0;
        assert.equal(delivered, phase === "before" ? 0 : 1);
        child.kill("SIGKILL");
        await exit;
        assert.equal(child.signalCode, "SIGKILL");
        assert.equal(readFileSync(message.recordPath, "utf8"), rawBefore);
        assert.deepEqual(readEffort(cwd, "receipt"), effortBefore);
        assert.equal(git(cwd, "rev-parse", message.intRef), tip);
        assert.equal(git(cwd, "rev-parse", "HEAD"), base);
        t.diagnostic(JSON.stringify({ phase, status: record.status, integration: record.integration.state, commits: 1, queue: effortBefore.queue, delivered, exitSignal: child.signalCode, recordUnchangedAfterCrash: true }));
      } finally {
        if (!exited) { child.kill("SIGKILL"); await exit; }
      }
    }
  });
}
