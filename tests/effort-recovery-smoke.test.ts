import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { git } from "./helpers/effort-integration.ts";
import { effortDir, readEffort } from "../src/effort/store.ts";
import { RunRegistry } from "../src/runs.ts";

const { piBin } = sandboxPi();
writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});\n`);
for (const phase of ["legacy", "unknown-process", "resolving", "queued-order", "changed-source", "dirty-candidate", "checked-out", "queued", "merging", "record-write", "queue-write", "generating", "verifying", "verified", "after-cas", "before-intent", "before", "after", "attempted"] as const) test(`M5 native ${phase} crash: repeated recovery preserves Git and dispatch safety`, { timeout: 30000 }, async () => {
  const cwd = tmpDir("m5-native-recovery-");
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, "base"), "base\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "base", ".gitignore"); git(cwd, "commit", "-m", "base");
  process.env.CONDUCTOR_MEMORY_PATH = join(cwd, ".git", "outcomes.jsonl");
  const base = git(cwd, "rev-parse", "HEAD"), receipt = join(cwd, ".git", "receipt");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../docs/m5-settlement-crash-probe.mts", import.meta.url)), "--child", cwd, phase, receipt], { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let exited = false; child.once("exit", () => { exited = true; }); const exit = once(child, "exit");
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  try {
    const [message] = await Promise.race([once(child, "message"), exit.then(() => { throw new Error(`fixture exited: ${stderr}`); })]);
    const path = (message as { recordPath: string }).recordPath;
    const wal = JSON.parse(readFileSync(path, "utf8"));
    const uncertain = phase === "before" || phase === "after" || phase === "legacy";
    const dispatched = phase === "attempted" || phase === "legacy";
    assert.equal(wal.integration.delivery, dispatched ? "attempted" : uncertain ? "intent" : undefined, "durable dispatch state must match the actual boundary");
    child.kill("SIGKILL"); await exit; assert.equal(child.signalCode, "SIGKILL");
    writeFileSync(join(cwd, ".git", "recovery-release"), "resume");
    const counterBefore = (existsSync(join(cwd, ".git", "recovery-counter")) ? readFileSync(join(cwd, ".git", "recovery-counter"), "utf8") : "").split("\n").filter(Boolean);
    const { recoverEffort } = await import("../src/effort/reconcile.ts");
    const registry = new RunRegistry(); let callbacks = 0; const callbackIds: string[] = [];
    let changedHead: string | undefined;
    if (phase === "resolving") writeFileSync(path, JSON.stringify({ ...wal, integration: { ...wal.integration, state: "resolving" } }));
    if (phase === "changed-source") {
      writeFileSync(join(wal.worktreePath, "a"), "human change"); git(wal.worktreePath, "add", "a"); git(wal.worktreePath, "commit", "-m", "test: retained human change");
      changedHead = git(wal.worktreePath, "rev-parse", "HEAD");
    }
    if (phase === "dirty-candidate") writeFileSync(join(wal.integration.candidatePath, "human-note"), "preserve dirty evidence");
    if (phase === "queued-order") {
      const id = "builder-second", worktree = join(cwd, ".worktrees", id), branch = `conductor-wt/${id}`;
      git(cwd, "worktree", "add", "-b", branch, worktree, base);
      writeFileSync(join(worktree, "b"), "b"); git(worktree, "add", "b"); git(worktree, "commit", "-m", "test: second durable writer");
      const dir = join(dirname(dirname(path)), id); mkdirSync(dir);
      const second = { ...wal, id, worktreePath: worktree, worktreeBranch: branch,
        recordPath: join(dir, "record.json"), finalPath: join(dir, "final.md"), transcriptPath: join(dir, "transcript.jsonl"),
        effort: { ...wal.effort, cwd: worktree }, integration: { ...wal.integration, enqueuedAt: wal.integration.enqueuedAt + 1, branchHead: git(worktree, "rev-parse", "HEAD") } };
      writeFileSync(second.recordPath, JSON.stringify(second));
      const effort = readEffort(cwd, "receipt")!;
      writeFileSync(join(effortDir(cwd, "receipt"), "effort.json"), JSON.stringify({ ...effort, members: [...effort.members, id], queue: [id] }));
    }
    if (phase === "legacy") {
      const legacy = structuredClone(wal); delete legacy.integration.delivery; delete legacy.integration.deliveryProtocol;
      writeFileSync(path, JSON.stringify(legacy));
    }
    const recoveryOpts = { registry, sessionId: "recovered", onComplete: (run: import("../src/types.ts").Run) => { callbacks++; callbackIds.push(run.id); } };
    if (phase === "checked-out") {
      const checkout = join(cwd, ".worktrees", "checked-out"); git(cwd, "worktree", "add", checkout, "conductor-int/receipt");
      const result = await recoverEffort(readEffort(cwd, "receipt")!, recoveryOpts);
      const { until } = await import("./helpers/effort-integration.ts");
      await until(registry, result.runs[0]!, run => run.integration?.state === "paused");
      assert.equal(git(cwd, "rev-parse", "conductor-int/receipt"), base);
      git(cwd, "worktree", "remove", checkout);
      const resumed = await recoverEffort(readEffort(cwd, "receipt")!, { ...recoveryOpts, resume: true });
      await resumed.done;
    }
    for (let restart = 0; restart < 2; restart++) {
      const result = await recoverEffort(readEffort(cwd, "receipt")!, recoveryOpts);
      await result.done;
    }
    if (phase === "changed-source" || phase === "unknown-process" || phase === "resolving") {
      const recovered = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(recovered.integration.state, "paused"); assert.match(recovered.integration.reason, phase === "changed-source" ? /source branch head changed/ : phase === "unknown-process" ? /unknown process identity/ : /resolving entry has no merger claim/);
      assert.equal(recovered.integration.branchHead, wal.integration.branchHead);
      assert.equal(git(cwd, "rev-parse", wal.worktreeBranch), changedHead ?? wal.integration.branchHead);
      assert.equal(git(cwd, "rev-parse", "conductor-int/receipt"), base);
      assert.equal(callbacks, 0); return;
    }
    if (phase === "dirty-candidate") assert.equal(readFileSync(join(wal.integration.candidatePath, "human-note"), "utf8"), "preserve dirty evidence");
    if (phase === "queued-order") assert.deepEqual(callbackIds, ["builder-second", wal.id], "durable queue order wins; WAL-only member is retained deterministically");
    assert.equal(callbacks, uncertain || dispatched ? 0 : phase === "queued-order" ? 2 : 1, "recovery dispatches once only before any durable intent");
    const recovered = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.integration.delivery, uncertain ? "uncertain" : "attempted");
    if (uncertain) assert.match(recovered.integration.reason, /delivery.*uncertain/);
    const counterAfter = readFileSync(join(cwd, ".git", "recovery-counter"), "utf8").split("\n").filter(Boolean);
    if (["queued", "merging", "record-write", "queue-write", "generating", "verifying", "verified"].includes(phase)) assert.ok(counterAfter.length > counterBefore.length, "interrupted validation must be rerun before CAS");
    if (phase === "generating") assert.equal(counterAfter.filter(x => x === "generate").length, 2, "generation must run again, not reuse interrupted output");
    assert.equal(git(cwd, "rev-list", "--count", `${base}..conductor-int/receipt`), phase === "queued-order" ? "2" : "1");
    assert.equal(existsSync(receipt), phase === "after" || dispatched);
    assert.notEqual(readFileSync(recovered.finalPath, "utf8"), "(no output)", "recovery retains native result text");
    assert.equal(git(cwd, "rev-parse", "HEAD"), base);
    const memory = process.env.CONDUCTOR_MEMORY_PATH!;
    const outcomes = existsSync(memory) ? readFileSync(memory, "utf8").trim().split("\n").filter(Boolean).length : 0;
    assert.equal(outcomes, phase === "legacy" ? 1 : uncertain ? 0 : phase === "queued-order" ? 2 : 1, "local outcomes participate in at-most-once dispatch, never restart appends");
    if (wal.integration.process) {
      const { linuxProcesses } = await import("../src/effort/process-group.ts");
      assert.ok(linuxProcesses().filter(p => p.pgid === wal.integration.process.pid).every(p => p.state === "Z" || p.state === "X"), "recorded old verification group cannot still execute");
    }
  } finally { if (!exited) { child.kill("SIGKILL"); await exit; } }
});
