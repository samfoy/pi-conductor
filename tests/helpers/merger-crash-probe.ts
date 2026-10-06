// M6a crash probe child: one effort, one conflicting writer and the production merger launcher
// (native 0.87.1 merger via PI_BIN). It parks at a named durable boundary and waits to be SIGKILLed.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { openEffort } from "../../src/effort/open.ts";
import { createMergerLauncher } from "../../src/effort/merger.ts";
import { RunRegistry, runDir } from "../../src/runs.ts";
import { SpawnQueue } from "../../src/queue.ts";
import { settleRun } from "../../src/run-pipeline.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import { gitTestEnv } from "./git-env.ts";

const [cwd, phase, delivery] = process.argv.slice(2) as [string, string, string];
const git = (dir: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: dir, env: gitTestEnv(), encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim();
const effort = openEffort(cwd, "probe", "probe-owner", { verify: "git rev-parse HEAD" });
const id = "builder-crash", worktree = join(cwd, ".worktrees", id), branch = `conductor-wt/${id}`;
git(cwd, "worktree", "add", "-b", branch, worktree, effort.baseOid);
fs.writeFileSync(join(worktree, "base"), "writer\n"); git(worktree, "add", "--", "base"); git(worktree, "commit", "-m", "test: writer");
const landing = join(cwd, ".worktrees", "land");
git(cwd, "worktree", "add", "--detach", landing, effort.baseOid);
fs.writeFileSync(join(landing, "base"), "landed\n"); git(landing, "add", "--", "base"); git(landing, "commit", "-m", "test: landed");
const landed = git(landing, "rev-parse", "HEAD");
git(cwd, "update-ref", effort.intRef, landed, effort.baseOid); git(cwd, "worktree", "remove", landing);
const dir = runDir(id); fs.mkdirSync(dir, { recursive: true });
const run: Run = { id, persona: "builder", task: "Implement the crash writer", mode: "background", status: "integrating", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: { ...emptyUsage(), cost: 0.01 }, cwd,
  parentSessionId: effort.owner.sessionId, parentPid: effort.owner.pid, parentStartTime: effort.owner.startTime,
  effort: { name: effort.name, gitRoot: cwd, role: "writer", spawnBase: effort.baseOid, cwd: worktree, owner: effort.owner, gate: null },
  integration: { state: "queued", branchHead: git(worktree, "rev-parse", "HEAD"), enqueuedAt: Date.now(), attempts: 0, resultText: "crash writer report",
    verifyIdentity: { command: effort.policy.verify, timeoutSeconds: effort.policy.verifyTimeoutSeconds, retries: effort.policy.verifyRetries } },
  worktreePath: worktree, worktreeBranch: branch, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
const registry = new RunRegistry(); registry.register(run);
registry.integrations.configureMerger(createMergerLauncher({ queue: new SpawnQueue(registry, 4, 1), timeoutMs: 30000 }));

let merger: Run | undefined, parked = false;
const barrier = () => {
  if (parked) return; parked = true;
  process.send!({ writer: run.recordPath, merger: merger?.id, mergerPid: merger?.pid, candidate: run.integration?.merger?.candidatePath, landed });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const text = String(to) === run.recordPath ? fs.readFileSync(from, "utf8") : "";
  rename(from, to);
  // The claim is durable; workspace setup, persona resolution and spawn have not happened.
  if (phase === "after-claim" && text && JSON.parse(text).integration?.merger && !JSON.parse(text).integration.merger.contextDir) barrier();
};
const spawnSync = cp.spawnSync;
cp.spawnSync = ((command: string, args: string[], options: cp.SpawnSyncOptions) => {
  // The merger is terminal, closed and recorded; the driver has not persisted its outcome.
  if (phase === "before-outcome" && command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor" && args[2] === run.integration?.merger?.setupOid) barrier();
  return spawnSync(command, args, options);
}) as typeof cp.spawnSync;
const exec = cp.execFileSync;
cp.execFileSync = ((command: string, args: string[], options: cp.ExecFileSyncOptions) => {
  const result = exec(command, args, options);
  if (phase === "after-cas" && command === "git" && args[0] === "update-ref" && args[1] === effort.intRef && args[3]) barrier();
  return result;
}) as typeof cp.execFileSync;
syncBuiltinESMExports();
registry.onChange(r => { if (r.mergerFor) merger = r; });
// The proposal is committed and the merger holds in a silent command, so its stdout stays quiet
// after this lead dies; parking earlier would race the merger's own EPIPE on the closed pipe.
if (phase === "after-proposal") {
  const holding = setInterval(() => { if (fs.existsSync(join(process.env.M6A_FIXTURE!, "hold-pid"))) { clearInterval(holding); barrier(); } }, 20);
}
// The merger asked its owner, exited and recorded itself blocked; the answer never arrives here.
if (phase === "blocked") {
  const asking = setInterval(() => {
    if (merger?.status !== "blocked" || merger.processOpen || !fs.existsSync(merger.recordPath) || JSON.parse(fs.readFileSync(merger.recordPath, "utf8")).status !== "blocked") return;
    clearInterval(asking); barrier();
  }, 20);
}
const outcome = await registry.integrations.enqueue(run, () => registry.notify(run));
run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit;
await settleRun(run, outcome.terminal, 0, { registry, onComplete: r => fs.appendFileSync(delivery, `${r.id}\n`) });
process.send!({ done: run.status });
